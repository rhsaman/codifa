import { focusChatInput } from '../../lib/chatFocus'
import { copyToClipboard } from '../../lib/clipboard'
import { CommentSpan, buildCommentSpans, commentSyntax, splitCommentSegments } from '../../lib/diffComments'
import { countOccurrences } from '../../lib/diffSearch'
import { commentFileSelection } from '../../lib/fileComments'
import { highlightSideLines, languageOfPath } from '../../lib/highlight'
import { DiffPopPos, diffPopupPos } from '../../lib/hoverCardPos'
import { markVimRegion } from '../../lib/panePointer'
import { parseDiffRows, parseSideBySide } from '../../lib/reviewDiff'
import { selectionBarPos } from '../../lib/selectionBar'
import { useStore } from '../../lib/store'
import { useDiffScrollbars } from '../../lib/useDiffScrollbars'
import { useDragScroll } from '../../lib/useDragScroll'
import { useVimScroll } from '../../lib/useVimScroll'
import { KeyboardEvent, memo, useCallback, useEffect, useMemo, useRef, useState, type UIEvent as ReactUIEvent } from 'react'
import { createPortal } from 'react-dom'

export function TomlLine({ text }: { text: string }) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("#")) return <span className="toml-comment">{text}</span>;
  const eq = text.indexOf("=");
  if (eq < 0) return <>{text}</>;
  const key = text.slice(0, eq).trimEnd();
  const rest = text.slice(eq);
  const value = rest.slice(1).trimStart();
  const isString = value.startsWith('"') || value.startsWith("'");
  return (
    <>
      <span className="toml-key">{key}</span>
      <span className="toml-eq"> = </span>
      <span className={isString ? "toml-string" : "toml-value"}>
        {rest.slice(1).trimStart()}
      </span>
    </>
  );
}

/** یک خط دیف: سینتکس‌هایلایتِ همان زبان فایل (با رنگ‌های تم فعال)،
 *  و اگر زبانی برایش ثبت نشده باشد فقط کامنت‌هایش کم‌رنگ می‌شوند.
 *  وقتی کوئری جست‌وجو فعال است، رخدادها با <mark> هایلایت می‌شوند و
 *  رخداد فعال (`activeHit`) کلاس متمایز می‌گیرد تا با دکمه‌های عقب/جلو دیده شود. */
export function DiffLineText({
  text,
  path,
  html,
  commentSpans,
  query,
  hitBase = 0,
  activeHit = -1,
  activeRef,
}: {
  text: string;
  path?: string;
  /** HTML سینتکس‌هایلایت‌شدهٔ همین خط — متنِ کاملِ یک سمت با هم هایلایت
   *  می‌شود تا توکن‌های چندخطی رنگشان را از دست ندهند. */
  html?: string;
  commentSpans?: CommentSpan[];
  query?: string;
  hitBase?: number;
  activeHit?: number;
  activeRef?: { current: HTMLElement | null };
}) {
  const q = (query ?? "").trim();
  if (q)
    return (
      <>{highlightParts(text, q, hitBase, activeHit, activeRef)}</>
    );
  if (path && path.split("?")[0].toLowerCase().endsWith(".toml")) {
    return <TomlLine text={text} />;
  }
  // highlight.js already colours comments (--text-dim) and keeps a block
  // comment coloured across every line it spans, so the manual splitter below
  // is only the fallback for extensions it has no grammar for.
  if (html != null) {
    return (
      <span
        className="diff-code"
        dir="auto"
        dangerouslySetInnerHTML={{ __html: html === "" ? "\n" : html }}
      />
    );
  }
  const segments = splitCommentSegments(text, commentSpans);
  if (segments.length === 1 && !segments[0].comment) return <>{text}</>;
  return (
    <>
      {segments.map((seg, i) =>
        seg.comment ? (
          <span key={i} className="diff-comment">
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** متن را به تکه‌های عادی/هایلایت می‌شکند (case-insensitive).
 *  `base` ایندکس سراسری اولین رخداد این خط است؛ رخدادی که ایندکسش با
 *  `active` برابر شود کلاس فعال می‌گیرد و `activeRef` رویش ست می‌شود. */
export function highlightParts(
  text: string,
  query: string,
  base: number,
  active: number,
  activeRef?: { current: HTMLElement | null },
) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  let ordinal = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      if (i < text.length) out.push(<span key={k++}>{text.slice(i)}</span>);
      break;
    }
    if (j > i) out.push(<span key={k++}>{text.slice(i, j)}</span>);
    const idx = base + ordinal;
    ordinal++;
    const isActive = idx === active;
    out.push(
      <mark
        key={k++}
        className={isActive ? "diff-hit diff-hit-active" : "diff-hit"}
        {...(isActive ? { "aria-current": "true" as const } : {})}
        ref={
          isActive && activeRef
            ? (el: HTMLElement | null) => {
                activeRef.current = el;
              }
            : undefined
        }
      >
        {text.slice(j, j + q.length)}
      </mark>,
    );
    i = j + q.length;
  }
  return out;
}

/** آستانه‌ی پیش‌فرض عرض (پیکسل) برای سوییچ خودکار دیف به دوستونی. */
export const DIFF_SIDE_BY_SIDE_THRESHOLD = 768;

/** حالت نمای دیف: خودکار (بر اساس عرض)، تک‌ستونی اجباری، یا دوستونی اجباری. */
export type DiffLayoutMode = "auto" | "unified" | "side-by-side";

/** تصمیم خالص برای نمایش دوستونی — جدا نگه داشته شده تا مستقیم تست شود. */
export function shouldShowSideBySide(
  width: number,
  threshold: number = DIFF_SIDE_BY_SIDE_THRESHOLD,
): boolean {
  return width >= threshold;
}

/** Build the quoted string for a diff highlight, embedding line info
 *  directly so no API change is needed. Falls back to `[path] text` when
 *  no line number is found in the DOM. */
export function diffQuoteForSelection(
  container: HTMLElement,
  sel: Selection,
  path: string,
  text: string,
): string {
  const nums: number[] = [];
  const collect = (node: Node | null) => {
    if (!node) return;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el || typeof el.closest !== "function") return;
    const lined = el.closest("[data-lineno]");
    if (lined) {
      const n = parseInt(lined.getAttribute("data-lineno") ?? "", 10);
      if (Number.isFinite(n)) {
        nums.push(n);
        return;
      }
    }
    const row = el.closest(".diff-u-row, .diff-line");
    if (row) {
      const numText = row.querySelector(".diff-u-num")?.textContent?.trim() ?? "";
      const n = parseInt(numText, 10);
      if (numText !== "" && Number.isFinite(n)) {
        nums.push(n);
        return;
      }
      const all = Array.from(container.querySelectorAll(".diff-u-row, .diff-line"));
      const idx = all.indexOf(row);
      if (idx >= 0) nums.push(idx + 1);
    }
  };
  collect(sel.anchorNode);
  if (sel.focusNode && sel.focusNode !== sel.anchorNode) collect(sel.focusNode);
  if (nums.length === 0) return `[${path}] ${text}`;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) return `[${path} line ${min}] ${text}`;
  return `[${path} lines ${min}-${max}] ${text}`;
}

/** دیف به سبک کدکس — واکنش‌گرا: در عرض کم تک‌ستونی، در عرض زیاد دوستونی.
 *  هر جفت delete+add به دو خط جدا (قرمز سپس سبز) باز می‌شود.
 *  `query` رخدادهای جست‌وجو را هایلایت می‌کند؛ `activeHit` ایندکس محلی
 *  رخداد فعال داخل همین دیف است (‎-1‎ یعنی هیچ‌کدام) که خودکار اسکرول می‌شود.
 *  `layout` حالت نما را اجبار می‌کند (`auto` عرض کانتینر را با ناظر تغییراندازه
 *  می‌سنجد) و `threshold` آستانه‌ی سوییچ خودکار است. */
/** Click-opened preview of an edit/write diff, floating over the chat.
 *
 *  The diff never opens inline (Codex-style: the card stays one quiet line), so
 *  the `Review ↗` pill on each row opens this card instead — the change can be
 *  read without leaving the transcript — while a click on the row itself still
 *  sends the whole turn to the side Review panel. It renders the very same
 *  `DiffView` the Review panel uses, so colours and layout match.
 *
 *  Deliberately click-only. An earlier version followed the pointer and could
 *  not work: the card lands exactly where the cursor already is, so the row
 *  underneath reported `pointerleave` the moment the card appeared and closed
 *  the thing that had just opened.
 */
export const DiffPreview = memo(function DiffPreview({
  diff,
  path,
  pos,
  onClose,
  onPress,
}: {
  diff: string;
  path?: string;
  pos: DiffPopPos;
  onClose: () => void;
  /** Keeps a press inside the card from counting as an outside press. */
  onPress?: () => void;
}) {
  const basename = path ? path.split("/").pop() ?? path : "";
  // Bare vim keys (j/k scroll, h/l horizontal) drive the diff body like the
  // docked Review diff. The card is portaled to document.body — OUTSIDE every
  // registered vim region — so without this it never scrolls: panePointer
  // resolves the caret/last click against the chat pane and the keys either
  // type or go nowhere (bug: "در پاپاپ دیف با lkjh اسکرول نمیشه").
  const cardRef = useRef<HTMLDivElement>(null);
  useVimScroll(cardRef);
  // The card body owns BOTH axes (the diff inside is unified and wraps), so it
  // gets the theme-coloured bars that ease wider on bar-hover.
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  useDiffScrollbars(previewBodyRef, diff);
  // The drawn bar runs down the card's inner edge: keep the head clear of it
  // (the body's own inset is CSS, see `.sp-scroll`).
  // The portal opens over the chat while the caret still sits in the composer;
  // useVimScroll treats a caret in an editable field as TYPING and never
  // scrolls. Same fix as the Review popup: take the caret into the card on
  // open (it is tabbable via tabindex=-1) and hand it back to the chat when
  // the card closes.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
    markVimRegion(el);
    return () => {
      const a = document.activeElement;
      if (a && a !== document.body) return; // focus already moved somewhere real
      const id = useStore.getState().activeChatId;
      if (id) requestAnimationFrame(() => focusChatInput(id));
    };
  }, []);
  return (
    <div
      ref={cardRef}
      className="diff-preview-card"
      style={{
        position: "fixed",
        ...(pos.bottom !== undefined ? { bottom: pos.bottom } : { top: pos.top }),
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
        zIndex: 9998,
      }}
      role="dialog"
      aria-label={basename ? `Diff preview for ${basename}` : "Diff preview"}
      dir="ltr"
      onPointerDown={onPress}
    >
      {/* The head renders even without a path so the ✕ is always reachable. */}
      <div className="diff-preview-head">
        <span className="diff-preview-path" dir="auto" title={path}>
          {basename}
        </span>
        <button
          type="button"
          className="diff-preview-close"
          title="Close preview"
          aria-label="Close diff preview"
          onClick={onClose}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
      {/* select → Copy / Reply exactly like the Review panel. Both the toolbar
          and the comment editor are portaled to document.body, i.e. OUTSIDE
          this card: the hook that owns it keeps presses on them from closing
          it (see `useDiffPreview`). */}
      <div className="diff-preview-body" ref={previewBodyRef}>
        <DiffView diff={diff} path={path} layout="unified" />
      </div>
    </div>
  );
});

/** Click-opened diff preview state, shared by the three edit surfaces (edit
 *  card, trace row, grouped edit rows).
 *
 *  No hover behaviour by design: the card would be portaled on top of the
 *  cursor, so the row underneath reports `pointerleave` the moment it appears
 *  and a hover-opened card closes itself immediately (that was the very bug
 *  this replaced). It opens from the `Review ↗` pill, anchored to the row that
 *  owns it, and closes on ✕, Escape, or a press outside it.
 */
export function useDiffPreview() {
  // The OPEN SNAPSHOT, not a live view. While the agent streams, every diff
  // event replaces `activity` with a fresh object and briefly blanks
  // `activity.diff`; a portal gated on the live value therefore unmounted and
  // remounted the card mid-read, which reset both scroll offsets and destroyed
  // any text selection inside it (a DOM selection cannot survive its node being
  // removed). Freezing diff/path at open time is what makes reading + selecting
  // stable while the turn is still running.
  const [snap, setSnap] = useState<
    { diff: string; path?: string; pos: DiffPopPos } | null
  >(null);
  // When it was opened. The press that opened it is still propagating up to
  // document while the listeners below get attached, so a press immediately
  // after an open is ignored instead of closing what it just opened.
  const openedAt = useRef(0);
  const open = useCallback((el: Element | null | undefined, diff: string | undefined, path?: string) => {
    if (!el || !diff || typeof window === "undefined") return;
    openedAt.current = Date.now();
    setSnap({
      diff,
      path,
      pos: diffPopupPos(
        el.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
      ),
    });
  }, []);
  const close = useCallback(() => setSnap(null), []);
  /** A press landed inside the card: same grace as opening, so interacting with
   *  the diff (scrolling by dragging, selecting) never closes it. */
  const keep = useCallback(() => {
    openedAt.current = Date.now();
  }, []);
  useEffect(() => {
    if (!snap) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSnap(null);
    };
    const onDown = (e: globalThis.PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || typeof t.closest !== "function") return;
      // The Copy/Reply toolbar and the comment editor are portaled to
      // document.body — outside the card — so pressing them must keep it open.
      if (t.closest(".diff-preview-card, .fv-sel-bar, .fv-comment-float")) return;
      if (Date.now() - openedAt.current < 250) return;
      setSnap(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [snap]);
  return { snap, open, close, keep };
}

export function DiffView({
  diff,
  path,
  query,
  activeHit = -1,
  layout = "auto",
  threshold = DIFF_SIDE_BY_SIDE_THRESHOLD,
  commentable = true,
}: {
  diff: string;
  path?: string;
  query?: string;
  activeHit?: number;
  layout?: DiffLayoutMode;
  threshold?: number;
  commentable?: boolean;
}) {
  const rows = parseDiffRows(diff);
  const sideItems = parseSideBySide(diff);
  const drag = useDragScroll<HTMLDivElement>();
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const update = (w: number) => setMeasuredWidth(w);
    update(el.clientWidth || 0);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      update(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [diff]);
  // Forced side-by-side still respects a measured narrow container (SSR
  // falls back to true until the first measure) so the view stays
  // responsive instead of locking two columns in a narrow panel.
  const showSide = layout === "unified"
    ? false
    : layout === "side-by-side"
      ? measuredWidth > 0
        ? shouldShowSideBySide(measuredWidth, threshold)
        : true
      : shouldShowSideBySide(measuredWidth, threshold);
  // The drawn bars follow the layout that is actually on screen, so switching
  // unified/side-by-side re-measures instead of keeping the old insets.
  useDiffScrollbars(measureRef, showSide ? `${diff}|side` : diff);
  // Syntax highlighting for the diff: each file side is highlighted as ONE
  // text (not line by line), so a token that spans lines — doc comment,
  // template literal, docstring — keeps its colour on all of its lines. The
  // result is keyed by gutter line number and shared by both layouts.
  const lang = languageOfPath(path);
  const { beforeHtml, afterHtml, beforeSpans, afterSpans } = useMemo(() => {
    const before: { lineNo: number; text: string }[] = [];
    const after: { lineNo: number; text: string }[] = [];
    for (const row of rows) {
      if ("text" in row) continue;
      if (row.type === "add") {
        after.push({ lineNo: row.aLine, text: row.after });
      } else if (row.type === "del") {
        before.push({ lineNo: row.bLine, text: row.before });
      } else {
        before.push({ lineNo: row.bLine, text: row.before });
        after.push({ lineNo: row.aLine, text: row.after });
      }
    }
    const syntax = commentSyntax(path);
    return {
      beforeHtml: highlightSideLines(before, lang),
      afterHtml: highlightSideLines(after, lang),
      beforeSpans: buildCommentSpans(before, syntax),
      afterSpans: buildCommentSpans(after, syntax),
    };
  }, [rows, path, lang]);

  const activeRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeHit, query, diff]);
  const chatId = useStore((s) => s.activeChatId);
  const [box, setBox] = useState<{ base: string; x: number; y: number } | null>(null);
  // Copy/Reply toolbar armed by a highlight — same two-step flow as the file
  // viewer: a selection never yanks focus into the textarea, the editor opens
  // only after Reply.
  const [selBar, setSelBar] = useState<{ base: string; x: number; y: number } | null>(null);
  const [note, setNote] = useState("");
  const commentInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Focus without scrolling so the diff highlight stays put (same as FileViewerPanel).
  useEffect(() => {
    if (!box) return;
    const id = requestAnimationFrame(() => {
      try {
        commentInputRef.current?.focus?.({ preventScroll: true } as FocusOptions);
      } catch {
        commentInputRef.current?.focus?.();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [box]);
  // Outside press dismisses like Esc (no send); presses inside the diff only move the box.
  useEffect(() => {
    if (!box && !selBar) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest(".fv-comment-float, .fv-sel-bar")) return;
      const container = measureRef.current;
      if (container && t instanceof Element && container.contains(t)) return;
      setBox(null);
      setSelBar(null);
      setNote("");
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [box, selBar]);
  if (rows.length === 0) return null;
  const closeBox = () => {
    setBox(null);
    setNote("");
  };
  const closeSelBar = () => {
    setSelBar(null);
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
  };
  /** Reply: open the comment editor at the armed toolbar position. */
  const openBox = () => {
    if (!selBar) return;
    setBox({ base: selBar.base, x: selBar.x, y: selBar.y });
    setSelBar(null);
    setNote("");
  };
  /** Copy: put the highlighted text on the clipboard and dismiss the toolbar.
   *  The LIVE selection wins over the frozen diff quote — the quote carries a
   *  "[path line N]" header for the agent, which must never reach the
   *  clipboard when the user only asked to copy the highlighted text. */
  const copySelection = () => {
    if (!selBar) return;
    let live = "";
    try {
      live = window.getSelection()?.toString().trim() ?? "";
    } catch {
      live = "";
    }
    void copyToClipboard(live || selBar.base);
    closeSelBar();
  };
  const sendBox = (queued?: boolean) => {
    if (!box || !chatId) {
      closeBox();
      return;
    }
    const filePath = path ?? "diff";
    const trimmed = note.trim();
    const quote = trimmed ? `${box.base}\n\nNote: ${trimmed}` : box.base;
    // Extract line range from the frozen diff quote ([path line N] /
    // [path lines A-B]) so the agent message carries File/Lines directly.
    const lineMatch = box.base.match(/\[.* lines? (\d+(?:-\d+)?)\]/);
    const target = lineMatch ? `${filePath}:${lineMatch[1]}` : filePath;
    commentFileSelection(chatId, target, quote, { queue: queued });
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* keep highlight on failure */
    }
    closeBox();
  };
  const refreshHighlight = () => {
    if (!commentable) return;
    // Freeze while the editor is open: focusing its textarea must not rewrite
    // the frozen quote (a new highlight requires closing first).
    if (box) return;
    const container = measureRef.current;
    if (!container) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || !container.contains(sel.anchorNode)) return;
    if (sel.isCollapsed) {
      if (selBar) setSelBar(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      if (selBar) setSelBar(null);
      return;
    }
    const filePath = path ?? "diff";
    const base = diffQuoteForSelection(container, sel, filePath, text.slice(0, 500));
    try {
      const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      if (rect && typeof window !== "undefined") {
        setSelBar({
          base,
          ...selectionBarPos(rect, window.innerWidth, window.innerHeight),
        });
        return;
      }
    } catch {
      /* fall through to default position */
    }
    setSelBar({ base, x: 16, y: 96 });
  };
  // شمارنده‌ی ترتیبی رخدادها در ترتیب رندر خط‌ها.
  let hitCursor = 0;
  const renderRow = (
    key: number | string,
    cls: "diff-u-add" | "diff-u-del" | "diff-u-ctx",
    gutter: string,
    lineNo: number,
    text: string,
    side: "before" | "after" | "both",
  ) => {
    const q = (query ?? "").trim();
    const base = hitCursor;
    if (q) hitCursor += countOccurrences(text, q);
    return (
      <div key={key} className={`diff-u-row ${cls}`}>
        <span className="diff-u-gutter">{gutter}</span>
        <span className="diff-u-num">{lineNo >= 0 ? lineNo : ""}</span>
        <span className="diff-u-text">
          <DiffLineText
            text={text}
            path={path}
            html={
              side === "before"
                ? beforeHtml.get(lineNo)
                : side === "after"
                  ? afterHtml.get(lineNo)
                  : (afterHtml.get(lineNo) ?? beforeHtml.get(lineNo))
            }
            commentSpans={
              side === "before"
                ? beforeSpans.get(lineNo)
                : side === "after"
                  ? afterSpans.get(lineNo)
                  : (afterSpans.get(lineNo) ?? beforeSpans.get(lineNo))
            }
            query={query}
            hitBase={base}
            activeHit={activeHit}
            activeRef={activeRef}
          />
        </span>
      </div>
    );
  };

  // سلول یک سمت نمای دوستونی با هایلایت جست‌وجو و شماره‌ی خط.
  const renderSideCell = (
    key: number | string,
    cls: string,
    lineNo: number,
    text: string,
    empty: boolean,
    side: "before" | "after",
  ) => {
    const q = (query ?? "").trim();
    const base = hitCursor;
    if (q && !empty) hitCursor += countOccurrences(text, q);
    // Side-by-side cells carry the same −/+ marker + coloured left bar as the
    // unified rows. The `.diff-line-del/-add .diff-u-gutter` rules depend on
    // this span existing — without it the column had no add/remove cue at all
    // (the row background is transparent by design).
    const marker =
      cls === "diff-line-del" ? "-" : cls === "diff-line-add" ? "+" : " ";
    return (
      <span key={key} className={`diff-line ${cls}`}>
        <span className="diff-u-gutter">{empty ? "" : marker}</span>
        <span className="diff-u-num">{!empty && lineNo >= 0 ? lineNo : ""}</span>
        <span className="diff-u-text">
          {!empty ? (
            <DiffLineText
              text={text}
              path={path}
              html={
                side === "before"
                  ? beforeHtml.get(lineNo)
                  : afterHtml.get(lineNo)
              }
              commentSpans={
                side === "before"
                  ? beforeSpans.get(lineNo)
                  : afterSpans.get(lineNo)
              }
              query={query}
              hitBase={base}
              activeHit={activeHit}
              activeRef={activeRef}
            />
          ) : (
            "\u00a0"
          )}
        </span>
      </span>
    );
  };

  // Before/After of one hunk scroll horizontally as ONE unit: a scroll in one
  // column mirrors onto its sibling (scroll events do not bubble, so the pair
  // listens in the capture phase). The equality guard stops the echo loop.
  const syncPairScroll = (e: ReactUIEvent<HTMLElement>) => {
    const src = e.target as HTMLElement | null;
    if (!src || !src.classList?.contains("diff-col-code")) return;
    const pair = e.currentTarget;
    pair.querySelectorAll<HTMLElement>(".diff-col-code").forEach((el) => {
      if (el !== src && el.scrollLeft !== src.scrollLeft) el.scrollLeft = src.scrollLeft;
    });
  };

  const renderSide = () => (
    <div className="diff-columns" dir="ltr" {...drag}>
      <div className="diff-columns-head">
        <div className="diff-col-header diff-col-before">Before</div>
        <div className="diff-col-header diff-col-after">After</div>
      </div>
      {sideItems.map((item) => {
        if (item.kind === "gap") {
          return (
            <div key={item.key} className="diff-gap">
              {item.count} unmodified lines
            </div>
          );
        }
        const metas = item.rows.filter((r) => "text" in r);
        const contents = item.rows.filter((r) => !("text" in r));
        return (
          <div key={item.key} className="diff-hunk-pair" onScrollCapture={syncPairScroll}>
            {metas.map((m, mi) => (
              <div key={`${item.key}-m${mi}`} className={`diff-u-meta ${m.type}`}>
                {"text" in m ? m.text : ""}
              </div>
            ))}
            <div className="diff-col diff-col-before">
              <pre className="diff-col-code">
                {contents.map((r, ri) => {
                  if ("text" in r) return null;
                  if (r.type === "same")
                    return renderSideCell(`${ri}-b`, "", r.bLine, r.before, false, "before");
                  if (r.type === "del" || r.type === "mod")
                    return renderSideCell(
                      `${ri}-b`,
                      "diff-line-del",
                      r.bLine,
                      r.before,
                      false,
                      "before",
                    );
                  return renderSideCell(`${ri}-b`, "diff-line-empty", -1, "", true, "before");
                })}
              </pre>
            </div>
            <div className="diff-col diff-col-after">
              <pre className="diff-col-code">
                {contents.map((r, ri) => {
                  if ("text" in r) return null;
                  if (r.type === "same")
                    return renderSideCell(`${ri}-a`, "", r.aLine, r.after, false, "after");
                  if (r.type === "add" || r.type === "mod")
                    return renderSideCell(
                      `${ri}-a`,
                      "diff-line-add",
                      r.aLine,
                      r.after,
                      false,
                      "after",
                    );
                  return renderSideCell(`${ri}-a`, "diff-line-empty", -1, "", true, "after");
                })}
              </pre>
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderUnified = () => (
    <div className="diff-unified" dir="ltr" {...drag}>
      {rows.flatMap((row, i) => {
        if ("text" in row) {
          return (
            <div key={i} className={`diff-u-meta ${row.type}`}>
              {row.text}
            </div>
          );
        }
        if (row.type === "same")
          return renderRow(i, "diff-u-ctx", " ", row.aLine, row.after, "both");
        if (row.type === "del")
          return renderRow(i, "diff-u-del", "-", row.bLine, row.before, "before");
        if (row.type === "add")
          return renderRow(i, "diff-u-add", "+", row.aLine, row.after, "after");
        // mod: خط قدیمی قرمز + خط جدید سبز، هر دو با شماره‌ی خودشان.
        return [
          renderRow(`${i}-d`, "diff-u-del", "-", row.bLine, row.before, "before"),
          renderRow(`${i}-a`, "diff-u-add", "+", row.aLine, row.after, "after"),
        ];
      })}
    </div>
  );

  return (
    <div
      ref={measureRef}
      className="diff-responsive sp-scroll"
      data-layout={showSide ? "side-by-side" : "unified"}
      onMouseUp={refreshHighlight}
      onKeyUp={refreshHighlight}
    >
      {showSide ? renderSide() : renderUnified()}
      {commentable && selBar && !box && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fv-sel-bar"
              style={{ position: "fixed", top: selBar.y, left: selBar.x, zIndex: 9999 }}
              onMouseUp={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="fv-sel-btn"
                title="Copy"
                aria-label="Copy selection"
                onClick={copySelection}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              </button>
              <button
                type="button"
                className="fv-sel-btn"
                title="Reply"
                aria-label="Reply to selection"
                onClick={openBox}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>
              </button>
            </div>,
            document.body,
          )
        : null}
      {commentable && box && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fv-comment-float"
              style={{
                position: "fixed",
                left: box.x,
                top: box.y,
                zIndex: 9999,
              }}
              onMouseUp={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            >
              <textarea
                ref={commentInputRef}
                className="fv-comment-input"
                dir="auto"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onMouseUp={(e) => e.stopPropagation()}
                onKeyUp={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    try {
                      window.getSelection()?.removeAllRanges();
                    } catch {
                      /* ignore */
                    }
                    closeBox();
                  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    sendBox(true);
                  } else if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendBox(false);
                  }
                }}
                rows={2}
                placeholder="Write a comment… Enter to send, Esc to cancel"
                aria-label="Comment on diff highlight"
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export type DiffItem = { kind: "ctx" | "del" | "add" | "marker"; text: string };
export type Hunk = { newStart: number; items: DiffItem[] };

/** Parse a unified diff into hunks (with the new-file start line of each). */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let cur: Hunk | null = null;
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const m = hunkRe.exec(line);
    if (m) {
      cur = { newStart: parseInt(m[2], 10), items: [] };
      hunks.push(cur);
    } else if (cur) {
      if (line.startsWith("\\")) cur.items.push({ kind: "marker", text: "" });
      else if (line.startsWith("+"))
        cur.items.push({ kind: "add", text: line.slice(1) });
      else if (line.startsWith("-"))
        cur.items.push({ kind: "del", text: line.slice(1) });
      else cur.items.push({ kind: "ctx", text: line.slice(1) });
    }
  }
  return hunks;
}

/**
 * Reverse-apply a unified diff onto the current file content to recover the
 * pre-write contents. Unchanged gap lines (not shown in the diff) are taken
 * from the current file using each hunk's new-file start line.
 */
export function applyReverseDiff(diff: string, current: string): string {
  const cur = current.split("\n");
  if (current.endsWith("\n")) cur.pop();
  const hunks = parseHunks(diff);
  const out: string[] = [];
  let ci = 0;
  let oldEofNoNewline = false;
  for (const hunk of hunks) {
    const target = hunk.newStart - 1;
    while (ci < target && ci < cur.length) {
      out.push(cur[ci]);
      ci++;
    }
    let prev: DiffItem["kind"] | null = null;
    for (const item of hunk.items) {
      if (item.kind === "marker") {
        if (prev === "del" || prev === "ctx") oldEofNoNewline = true;
        prev = null;
        continue;
      }
      if (item.kind === "ctx") {
        prev = "ctx";
        out.push(ci < cur.length ? cur[ci] : item.text);
        ci++;
      } else if (item.kind === "add") {
        prev = "add";
        ci++;
      } else {
        prev = "del";
        out.push(item.text);
      }
    }
  }
  for (; ci < cur.length; ci++) out.push(cur[ci]);
  let content = out.join("\n");
  if (!oldEofNoNewline) content += "\n";
  return content;
}

/** Claude-app style trace group: a single collapsible summary line ("9
 *  commands, 3 searches, 2 notes") for a run of consecutive non-write tool
 *  activities. Collapsed by default — no preview stack. Expanding reveals a
 *  flat vertical timeline (icon + label + status per call), not a stack of
 *  full cards, matching Claude.ai's own tool-trace UI. */
