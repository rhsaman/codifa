import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ToolActivity } from "../types";
import {
  detectDir,
  fixZwsp,
  prepareContent,
  stripBidiMarks,
} from "../lib/bidi";
import { fixArrowDirections, rehypeArrows } from "../lib/arrowDir";
import { copyToClipboard } from "../lib/clipboard";
import { dedupDocPaths, extractInlinePathParts, filePathFromHref, isDocPath, looksLikeFilePath, splitPathLine } from "../lib/fileTypes";
import { FileChip, FileIcon, openWorkspaceFile } from "./FileIcon";
import { RENDER_CAP, fmtSize } from "../lib/renderCap";
import { fmtClock, fmtClockFull } from "../lib/time";
import { cancelSteer } from "../lib/api";
import { fallbackReason, humanizeError } from "../lib/errorText";
import { friendlyTtsError, speakableMessageText, useTtsPlayback } from "../lib/tts";
import type { SpeakProviderOpts } from "../lib/api";
import { lspStatusLabel, useStore } from "../lib/store";
import { getMode } from "../lib/modes";
import { splitSections } from "../lib/sections";
import { handleLinkClick, splitTextByUrls } from "../lib/link";
import { ArtifactCard } from "./ArtifactCard";
import { getHighlightedLines } from "../lib/highlight";
import {
  ToolCallView,
  ToolEditGroupView,
  ToolGroupView,
  ToolSingleRow,
  TraceNarration,
  isEditActivity,
  isSubagentCard,
} from "./ToolCallView";
import { ExploreCard } from "./ExploreCard";
import { MessageImages } from "./MessageImages";
import "highlight.js/styles/github-dark.min.css";
import { useViewerTabs } from "../lib/viewerTabs";
import { planDisplay } from "../lib/planDoc";

// ── Heavy, rarely-mounted children are code-split ────────────────────────────
// Reading mode is a two-pane document viewer that only mounts after the user
// clicks "مطالعه"; Mermaid drags in the whole diagram engine (~500 KB). Both
// used to sit in the startup chunk, so every session paid for them even when
// neither was ever shown.
const ReadingMode = lazy(() =>
  import("./ReadingMode").then((m) => ({ default: m.ReadingMode })),
);
// Mermaid: the module itself is light (it only imports the ENGINE dynamically,
// so the engine lands in its own chunk) and the block paints a static
// placeholder until the user scrolls it into view.
import { Mermaid } from "./Mermaid";

/** Basename for attachment chips: message bubbles must show "report.pdf",
 *  never the full absolute path (imported uploads live in the app data root
 *  and rendering it verbatim is noise). The full path stays in the tooltip. */
function attachmentBasename(a: string): string {
  const idx = Math.max(a.lastIndexOf("/"), a.lastIndexOf("\\"));
  return idx >= 0 ? a.slice(idx + 1) : a;
}

/** Collect distinct non-code document paths (pdf/word/excel/csv) from tool
 *  activities for created or edited files. Covers write_document
 *  (create/edit/style) plus edit_file/write_file when they touch a doc
 *  extension. Only path strings are collected, no file bodies, so rendering
 *  stays cheap. */
function docPathsFromActivities(list?: ToolActivity[]): string[] {
  if (!list || list.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    const tool = a.tool ?? "";
    const isDocTool =
      tool === "write_document" || tool === "edit_file" || tool === "write_file";
    if (isDocTool) {
      const raw = (a.args?.path ?? a.args?.filePath) as unknown;
      const candidates = [
        typeof raw === "string" ? raw : "",
        typeof a.summary === "string" ? a.summary : "",
      ];
      for (const c of candidates) {
        if (!c) continue;
        const token =
          c.trim().split(/\s+/).find((t) => isDocPath(t)) ?? "";
        const target = token || (isDocPath(c) ? c.trim() : "");
        if (!target) continue;
        const { path } = splitPathLine(target);
        const clean = path.trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
      }
    }
    if (a.children && a.children.length > 0) {
      for (const p of docPathsFromActivities(a.children)) {
        if (!seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    }
  }
  return out;
}

/** Clickable row of non-code document files produced in this turn. Each chip
 *  opens the file in the viewer panel via openWorkspaceFile (path/line/root
 *  only, no body preload). */
function DocFileChips({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="msg-attachments" dir="ltr">
      {paths.map((p) => (
        <FileChip key={p} path={p} display={attachmentBasename(p)} />
      ))}
    </div>
  );
}

// Cache prepareContent per message id so re-renders with UNCHANGED content
// (dir toggles, parent re-renders that don't recreate the message, memo
// defeats) don't re-run the bidi-mark strip + ZWSP-fix passes over every
// message on every paint. The cached text is validated on each hit, so a
// STREAMING message (same id, growing content) always recomputes instead of
// showing stale text. FIFO-bounded so long sessions can't leak memory.
const preparedCache = new Map<string, { text: string; out: string }>();
const PREPARED_CACHE_MAX = 400;
/** Byte ceiling for the cache, on top of the entry count.
 *
 *  A COUNT cap alone is not a memory bound when entries are huge: a thinking
 *  block streams token by token and `cachedPrepareText` keys by the TEXT, so
 *  every delta inserted a brand-new entry holding two copies (input + output) of
 *  a growing multi-hundred-KB string. 400 such entries is tens of MB of pure
 *  garbage that the FIFO only evicts long after it was allocated — and it never
 *  even helped, because the NEXT token has a different key. */
const PREPARED_CACHE_MAX_CHARS = 2_000_000;
/** Content above this is not worth caching at all: it is (a) unlikely to be
 *  re-rendered with identical text and (b) most of the cache's weight. */
const PREPARED_CACHE_SKIP_CHARS = 40_000;
let preparedCacheChars = 0;

function dropPrepared(id: string): void {
  const hit = preparedCache.get(id);
  if (hit) {
    preparedCacheChars -= hit.text.length + hit.out.length;
    preparedCache.delete(id);
  }
}

function computePrepared(
  id: string,
  text: string,
  dir?: "rtl" | "ltr",
): string {
  const hit = preparedCache.get(id);
  if (hit && hit.text === text) return hit.out;
  const out = prepareContent(text, dir);
  if (text.length > PREPARED_CACHE_SKIP_CHARS) return out;
  // Replace (not just insert) so a streaming message's previous, smaller entry
  // is released as it grows instead of leaving a trail of stale copies.
  dropPrepared(id);
  while (
    preparedCache.size > 0 &&
    (preparedCache.size >= PREPARED_CACHE_MAX ||
      preparedCacheChars + text.length + out.length > PREPARED_CACHE_MAX_CHARS)
  ) {
    const oldest = preparedCache.keys().next().value;
    if (oldest === undefined) break;
    dropPrepared(oldest);
  }
  preparedCache.set(id, { text, out });
  preparedCacheChars += text.length + out.length;
  return out;
}
function cachedPrepare(id: string, text: string, dir?: "rtl" | "ltr"): string {
  if (!text) return text;
  return computePrepared(id, text, dir);
}
/** For content with no stable id (the thinking block only receives `text`):
 *  key by the text itself — prepareContent is deterministic, so equal text
 *  always yields equal output.
 *
 *  Short-circuits before building the key for long content: the key is a full
 *  COPY of the text (`t:${text}`), and while a reasoning block streams that is a
 *  fresh multi-hundred-KB allocation per token that can never hit (the next token
 *  has different text). Streaming was paying for a duplicate of the whole block
 *  on every delta. */
function cachedPrepareText(text: string, dir?: "rtl" | "ltr"): string {
  if (!text) return text;
  if (text.length > PREPARED_CACHE_SKIP_CHARS) return prepareContent(text, dir);
  return computePrepared(`t:${text}`, text, dir);
}

// Never render more than RENDER_CAP chars of ONE message without an explicit
// click: pasted log/trace dumps reach megabytes, and parsing + laying out
// that text on EVERY chat switch (plus re-sending it to the model every turn)
// is the main cost on giant histories. History on disk, copy-to-clipboard
// and the model context always keep the FULL text — only the paint is capped.
// Live (streaming) messages are never capped: truncating a reply mid-stream
// would flicker and hide the newest tokens.
function useCapped(id: string, text: string, live: boolean) {
  const over = !live && text.length > RENDER_CAP;
  const [showAll, setShowAll] = useState(false);
  // Reset the expansion when the hook is reused for a different message
  // (virtualized bubbles recycle the component). Without this, switching chats
  // while one bubble was expanded left the NEXT message fully expanded too.
  useEffect(() => {
    setShowAll(false);
  }, [id]);
  const shown = over && !showAll ? text.slice(0, RENDER_CAP) : text;
  return { shown, over, cut: text.length - shown.length, showAll, setShowAll };
}

/** Collapsed implementation-plan card on a Plan-mode reply (kind:"plan_card").
 *  Shows the plan's title, a faded plain-text preview and a "View full plan"
 *  pill that opens the docked Plan viewer tab with the whole document. */
function PlanDocCard({
  planDoc,
}: {
  planDoc: { title: string; body: string };
}) {
  const [copied, setCopied] = useState(false);
  // Follow the app's direction + bidi handling, like the chat bubble does.
  const appDir = useStore((s) => s.dir);
  const preview = useMemo(() => {
    const text = planDoc.body
      // Code blocks dominate the preview height — collapse them to a marker.
      .replace(/```[\s\S]*?```/g, "\n[…]\n")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*`>]/g, "")
      // A bare "Plan" first line repeats the card's own label.
      .replace(/^plan\s*:?[ \t]*\n/i, "")
      .trim();
    const clipped = text.length > 600 ? `${text.slice(0, 600).trimEnd()}…` : text;
    return prepareContent(clipped, appDir);
  }, [planDoc.body, appDir]);
  return (
    <div className="plan-doc-card" dir={appDir}>
      <div className="plan-doc-head">
        <span className="plan-doc-icon" aria-hidden="true">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="8" y="2" width="8" height="4" rx="1" />
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          </svg>
        </span>
        <span className="plan-doc-label">Plan</span>
        {planDoc.title ? (
          <span className="plan-doc-title">{planDoc.title}</span>
        ) : null}
        <span className="plan-doc-spacer" />
        <button
          type="button"
          className={`plan-doc-copy${copied ? " copied" : ""}`}
          title="Copy plan"
          aria-label="Copy plan"
          onClick={() => {
            void copyToClipboard(planDoc.body);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? (
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
      <div className="plan-doc-preview">{preview}</div>
      <button
        type="button"
        className="plan-doc-open"
        onClick={() => useViewerTabs.getState().openPlan()}
      >
        View full plan
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}

function textFromChildren(node: ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromChildren).join("");
  if (typeof node === "object" && "props" in node) {
    return textFromChildren(
      (node as { props: { children?: ReactNode } }).props.children,
    );
  }
  return "";
}

/** Open an external URL in the OS browser, preferring Chrome when the
 * bridge exposes it and falling back to the default external opener. */
function openExternalPreferred(url: string): void {
  const coder = window.coder as unknown as {
    openExternal?: (u: string) => unknown;
    openExternalChrome?: (u: string) => unknown;
  };
  if (coder && typeof coder.openExternalChrome === "function") {
    void coder.openExternalChrome(url);
    return;
  }
  void coder?.openExternal?.(url);
}

function codeLang(children: ReactNode): string {
  const kids = Array.isArray(children) ? children : [children];
  for (const k of kids) {
    const props = (k as { props?: { className?: string } } | null)?.props;
    const m = props?.className
      ? /language-([\w-]+)/.exec(String(props.className))
      : null;
    if (m) return m[1];
  }
  return "";
}

// Extract the starting line number of a fenced code block, when the info string
// carries a `lang:start-end` range (e.g. ```go:19-20). Returns 0 when absent so
// callers can fall back to 1-based numbering. The number is rendered as a
// VISUAL-ONLY gutter (user-select: none) so copying the block never includes it.
function codeStartLine(children: ReactNode): number {
  const kids = Array.isArray(children) ? children : [children];
  for (const k of kids) {
    const props = (k as { props?: { className?: string; "data-meta"?: string; children?: ReactNode } } | null)?.props;
    // Prefer the full meta string that the `code` component stashes. It may be
    // either the canonical `lang:start-end:path` (foldLineCaptions output) or the
    // legacy `start-end:path` form, so match the `start-end` range wherever it
    // appears after a colon, not just at the start of the string.
    const meta = (props?.["data-meta"] ?? "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
    const m =
      // form 1: "19-20:path" — start before "-"
      /(\d+)(?=-\d+:)/.exec(meta) ??
      // form 2: ":19-20:path" — start after ":" and before "-"
      /:(\d+)(?=-)/.exec(meta) ??
      // form 3: "32:path" (single line) — digits right after ":" before next ":" or end
      /:(\d+)(?=[:\b]|$)/.exec(meta) ??
      (props?.className
        ? /language-[\w-]+:(\d+)(?:-\d+)?/.exec(String(props.className))
        : null);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) return n;
    }
    // Fallback: extract from comments inside code, e.g.
    // "// front/app/layout.tsx (خط 34)" or "# file (line 50)"
    const raw = typeof props?.children === "string" ? props.children : "";
    if (raw) {
      const fallback =
        /\(\s*(?:خط|Line|line)\s*([\d۰-۹]+)\s*\)/.exec(raw);
      if (fallback) {
        // parseInt doesn't handle Persian digits (۰-۹) — normalise first
        const n = parseInt(fallback[1].replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))), 10);
        if (!Number.isNaN(n)) return n;
      }
    }
  }
  return 0;
}

function codeFilePath(children: ReactNode): string {
  const kids = Array.isArray(children) ? children : [children];
  for (const k of kids) {
    const props = (k as { props?: { className?: string; "data-meta"?: string } } | null)?.props;
    const meta = props?.["data-meta"] ?? "";
    // meta is like "19-20:backend/agents/tools/instagram_tools.py" — extract path after the range.
    // Path can have multiple dots and slashes.
    const m = /\d+(?:-\d+)?:((?:[\w\/\\-]+\/)*[\w\/\\-]*[\w.-]+\.\w+)$/.exec(meta);
    if (m) return m[1];
  }
  return "";
}


const CodeBlock = memo(function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  // The `code` override may hand back a FileChip for a single-token fence
  // (bare or with a language) whose whole content is one path-like token:
  // textFromChildren can't see the chip's internal JSX, so recover the text
  // from the chip's props instead of rendering an empty block. The chip is
  // never mounted here — the <pre> below replaces the children entirely.
  const chipProps = (() => {
    const kid = Array.isArray(props.children) ? props.children[0] : props.children;
    const p =
      kid && typeof kid === "object" && "props" in kid
        ? (kid as { props: { path?: unknown; display?: unknown } }).props
        : undefined;
    return p && typeof p.path === "string" ? p : undefined;
  })();
  const code = (
    textFromChildren(props.children) ||
    (chipProps ? String(chipProps.display ?? chipProps.path) : "")
  ).replace(/^\n+|\n+$/g, "");
  const lang = codeLang(props.children);
  const startLine = codeStartLine(props.children);
  const filePath = codeFilePath(props.children);

  // A ```mermaid fenced block is rendered as a live diagram, not as code.
  if (lang === "mermaid") {
    return <Mermaid chart={code} />;
  }

  const codeLines = code.split("\n");

  const copy = async () => {
    try {
      await copyToClipboard(codeLines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };

  // Highlight the WHOLE block in ONE hljs pass (not line-by-line), so multi-line
  // constructs (block comments, template literals, docstrings, ...) keep their
  // syntax state across lines and get correct colors. getHighlightedLines
  // (src/lib/highlight.ts) splits the result back into per-line fragments and
  // re-opens any <span> still open at a line boundary, so a token spanning
  // multiple lines keeps its color on every line, not just the first. The line
  // numbers are rendered as a VISUAL-ONLY gutter (the real file line number when
  // the fence carries `lang:start-end`, otherwise 1-based) with `user-select:
  // none`, so selecting/copying the block copies just the code, never the numbers.
  // Memoized on (code + lang): re-renders caused by streaming tokens elsewhere
  // in the message reuse the module's cached highlight instead of re-running hljs.
  const highlightedLines = useMemo(
    () => getHighlightedLines(codeLines.join("\n"), lang),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, lang],
  );

  const lines = codeLines.map((_line, i) => {
    const num = startLine > 0 ? startLine + i : i + 1;
    const html = highlightedLines[i] ?? "";
    return (
      <span className="code-line" key={i}>
        <span className="code-gutter" aria-hidden="true">
          {num}
        </span>
        <span
          className="code-text"
          dangerouslySetInnerHTML={{ __html: html === "" ? "\n" : html }}
        />
        {"\n"}
      </span>
    );
  });

  return (
    <div className="code-block">
      <div className="code-block-head">
        {filePath && (
          <span
            className="code-block-path code-block-path-open"
            title={`Open ${filePath}`}
            onClick={() => openWorkspaceFile(filePath)}
          >
            <FileIcon path={filePath} size={20} />
            {filePath}
          </span>
        )}
        <span className="code-block-lang">
          {lang || "code"}
        </span>
        <button className="copy-btn" onClick={copy}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre {...props} dir="ltr" className="code-lines hljs">
        {lines}
      </pre>
    </div>
  );
});

// ── Video-embed detection ────────────────────────────────────────────────
// Detects YouTube / Vimeo links and returns metadata for a clickable
//  thumbnail card (thumbnail + play overlay).  Iframes are unreliable in
//  Electron because YouTube blocks embedding from non-standard origins,
//  so we show a static thumbnail that opens the video in the system browser.

interface VideoEmbed {
  platform: "youtube" | "vimeo";
  videoUrl: string;
  thumbnailUrl: string;
  title: string;
}

function _ytId(u: URL): string | null {
  // youtu.be/ID
  if (u.hostname === "youtu.be") {
    const id = u.pathname.slice(1);
    return id || null;
  }
  if (!u.hostname.includes("youtube.com")) return null;
  // youtube.com/watch?v=ID
  const v = u.searchParams.get("v");
  if (v) return v;
  // youtube.com/shorts/ID
  const shorts = /\/shorts\/([\w-]+)/.exec(u.pathname);
  if (shorts) return shorts[1];
  // youtube.com/embed/ID
  const embed = /\/embed\/([\w-]+)/.exec(u.pathname);
  return embed ? embed[1] : null;
}

function _vimeoId(u: URL): string | null {
  if (u.hostname !== "vimeo.com" && u.hostname !== "player.vimeo.com") return null;
  return /\/video\/(\d+)/.exec(u.pathname)?.[1]
    ?? /^\/(\d+)/.exec(u.pathname)?.[1]
    ?? null;
}

function extractVideoEmbed(href: string): VideoEmbed | null {
  try {
    const u = new URL(href);
    const ytId = _ytId(u);
    if (ytId) {
      return {
        platform: "youtube",
        videoUrl: `https://www.youtube.com/watch?v=${ytId}`,
        // maxresdefault falls back to hqdefault automatically
        thumbnailUrl: `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`,
        title: "YouTube video",
      };
    }
    const vmId = _vimeoId(u);
    if (vmId) {
      return {
        platform: "vimeo",
        videoUrl: `https://vimeo.com/${vmId}`,
        // Vimeo thumbnail via oEmbed isn't available client-side, use placeholder
        thumbnailUrl: `https://vumbnail.com/${vmId}.jpg`,
        title: "Vimeo video",
      };
    }
  } catch {
    // invalid URL — ignore
  }
  return null;
}

// ── Markdown image with error handling ──────────────────────────────────────
// Shows a fallback placeholder when the image URL is broken or unreachable.

function MarkdownImage({
  src,
  alt,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [errored, setErrored] = useState(false);

  if (!src || errored) {
    return (
      <span className="md-image-wrap md-image-errored">
        <span className="md-image-fallback">
          🖼️ {alt || "Image unavailable"}
        </span>
      </span>
    );
  }

  return (
    <span className="md-image-wrap">
      {/* eslint-disable-next-line @next/next/no-img-element -- markdown inline image */}
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        onError={() => setErrored(true)}
        {...props}
      />
      {alt ? <span className="md-image-caption">{alt}</span> : null}
    </span>
  );
}

// ── Video thumbnail card ──────────────────────────────────────────────────
// Shows a clickable YouTube/Vimeo thumbnail with a play overlay.
// Clicking opens the video in the system browser — more reliable than
// iframe embeds, which YouTube blocks from Electron origins.

function VideoThumbnailCard({
  video,
  href,
  children,
}: {
  video: VideoEmbed;
  href: string;
  children?: ReactNode;
}) {
  const [thumbErr, setThumbErr] = useState(false);
  const label = children?.toString().trim() || video.title;
  const openVideo = () => void window.coder.openExternal(video.videoUrl);

  return (
    <span className="md-video-card" onClick={openVideo} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openVideo(); }}>
      {!thumbErr ? (
        <img
          className="md-video-thumb"
          src={video.thumbnailUrl}
          alt={label}
          loading="lazy"
          onError={() => setThumbErr(true)}
        />
      ) : (
        <span className="md-video-thumb md-video-thumb-fallback">
          🎬
        </span>
      )}
      <span className="md-video-play">▶</span>
      <span className="md-video-label">{label}</span>
    </span>
  );
}

// Shared overrides for every markdown renderer in this component.
// `table` is wrapped in a scroll container: `display: block` on the <table>
// itself makes its anonymous inner table shrink-wrap to content width, so the
// cells never stretch to the border. A bordered full-width wrapper fixes the
// "table doesn't fill the width" gap and carries the horizontal scroll.
//
// Exported so ReadingMode.tsx can reuse the exact same overrides (including the
// ```mermaid -> diagram rendering) without duplicating them.
export const mdComponents = {
  // react-markdown only puts the language in `className` and DROPS the rest of
  // the info string (e.g. `go:19-20:Plan.go` -> className `language-go`). We
  // stash the full meta (`19-20:Plan.go`) on `data-meta` so CodeBlock can read
  // the real line range and file name that foldLineCaptions injected.
  code: (props: any) => {
    const node = props.node;
    let meta = node?.data?.meta ?? "";
    // Fallback: react-markdown v9 may put the entire info string in className
    // (e.g. "language-go:19-20:Plan.go"). Extract meta after the language prefix.
    if (!meta) {
      const cn = String(node?.properties?.className ?? props.className ?? "");
      const m = /^language-[\w-]+:(.+)/.exec(cn);
      if (m) meta = m[1];
    }
    // Inline code that is a bare file path (`src/App.tsx`, `backend/x.py:12`)
    // renders as a clickable file chip instead of a code span. Fences with a
    // language/meta never chip (meta is set); a single-token bare fence that
    // slips into this branch is still safe — CodeBlock recovers the text from
    // the chip's props, so the block renders with the path verbatim.
    if (!meta) {
      const text = textFromChildren(props.children);
      // Inline code that contains an http(s) URL linkifies the URL part and
      // opens it in the OS browser (Chrome when available). URLs never become
      // FileChips: looksLikeFilePath already rejects schemes, and this branch
      // runs first so a URL is never misclassified as a path.
      if (!text.includes("\n")) {
        const urlParts = splitTextByUrls(text);
        if (urlParts.some((p) => typeof p !== "string")) {
          if (
            urlParts.length === 1 &&
            typeof urlParts[0] !== "string"
          ) {
            const url = (urlParts[0] as { url: string }).url;
            return (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  handleLinkClick(e, url, openExternalPreferred);
                }}
              >
                {url}
              </a>
            );
          }
          return (
            <>
              {urlParts.map((p, i) =>
                typeof p === "string" ? (
                  <code key={i} data-meta={meta}>
                    {p}
                  </code>
                ) : (
                  <a
                    key={i}
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      handleLinkClick(e, p.url, openExternalPreferred);
                    }}
                  >
                    {p.url}
                  </a>
                ),
              )}
            </>
          );
        }
      }
      if (looksLikeFilePath(text)) {
        const { path, line } = splitPathLine(text);
        return <FileChip path={path} line={line} display={text} />;
      }
      // Composite spans ("Edit fs.ts src/lib/ +49") keep their single pill:
      // the path inside becomes a clickable FileChip while the surrounding
      // words stay plain code text.
      const parts = extractInlinePathParts(text);
      if (parts.some((p) => typeof p !== "string")) {
        return (
          <code {...props} data-meta={meta}>
            {parts.map((p, i) =>
              typeof p === "string" ? (
                p
              ) : (
                <FileChip key={i} path={p.path} line={p.line} display={p.display} />
              ),
            )}
          </code>
        );
      }
    }
    return (
      <code {...props} data-meta={meta}>
        {props.children}
      </code>
    );
  },
  img: (props: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) => (
    <MarkdownImage {...props} />
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const href = props.href ?? "";
    const video = extractVideoEmbed(href);
    if (video) {
      return (
        <VideoThumbnailCard
          video={video}
          href={href}
          children={props.children}
        />
      );
    }
    // EVERY link that points at a workspace file — a code path, a path with a
    // line, an absolute path, a `file://` URL or a document (pdf/word/excel/
    // csv) — renders as a clickable chip that opens the viewer, exactly like
    // inline-code paths. As a plain `<a target="_blank">` the webview followed
    // the href and left the app (the OS browser opened) instead of opening the
    // file; only real web URLs and in-page anchors stay links.
    const fileRef = filePathFromHref(href);
    if (fileRef) {
      const label =
        typeof props.children === "string" && props.children
          ? props.children
          : href;
      return (
        <FileChip
          path={fileRef.path}
          line={fileRef.line}
          display={String(label)}
        />
      );
    }
    // react-markdown's sanitizer blanks the href of anything it refuses
    // (javascript:, data:, …): show the label as plain text — an anchor with an
    // empty href would reload the whole webview when clicked.
    if (!href) {
      return <>{props.children}</>;
    }
    return (
      <a
        {...props}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          // Forward http(s) links to the OS browser (Chrome when available);
          // internal anchors keep their default behaviour inside the app.
          handleLinkClick(e, props.href, openExternalPreferred);
        }}
      />
    );
  },
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <CodeBlock {...props} />
  ),
  table: ({
    node: _node,
    ...props
  }: React.HTMLAttributes<HTMLTableElement> & { node?: unknown }) => (
    <div className="markdown-table-scroll">
      <table {...props} />
    </div>
  ),
};

const PROSE_REMARK_PLUGINS = [remarkGfm];
const PROSE_REHYPE_PLUGINS = [rehypeArrows];

/** react-markdown blanks the href of every scheme it does not know, which
 *  killed `file://` citations before the `a` override could turn them into
 *  file chips. Keep `file:` intact; every other scheme stays sanitized. */
function keepFileUrls(url: string): string {
  return /^file:/i.test(url) ? url : defaultUrlTransform(url);
}

/** One markdown prose block. Besides rendering, it fixes the direction of
 *  arrows in RTL text (see lib/arrowDir.ts).
 *
 *  The layout effect is keyed on `text` (the direction is already baked into it
 *  by `cachedPrepare`): with NO dependency array it re-ran after every commit,
 *  so a streaming reply walked the whole prose block —
 *  `querySelectorAll(".md-arrow")` plus a `createTreeWalker` per arrow — once per
 *  TOKEN, for every mounted message, defeating the point of the text cache. The
 *  arrow direction is a pure function of the text, so re-measuring it is only
 *  needed when the text actually changes.
 *
 *  `memo` keeps a parent re-render (dir toggle, sibling stream) from re-parsing
 *  markdown that did not change. */
const MarkdownProse = memo(function MarkdownProse({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) fixArrowDirections(ref.current);
  }, [text]);
  return (
    <div ref={ref} className="chat-message markdown-body" dir="auto">
      <ReactMarkdown
        remarkPlugins={PROSE_REMARK_PLUGINS}
        rehypePlugins={PROSE_REHYPE_PLUGINS}
        urlTransform={keepFileUrls}
        components={mdComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
})

const fmtTokens = (n?: number): string => {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
};

const THINKING_MIN_H = 56;
const THINKING_MAX_H = 320;
const THINKING_DEFAULT_H = 84;

export function ThinkingBlock({ text }: { text: string }) {
  const dir = useStore((s) => s.dir);
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(THINKING_DEFAULT_H);
  const textRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  /** Removers for an in-flight height drag; run on unmount (the agent may
   *  re-render/replace this block mid-drag) so the window listeners never leak. */
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const empty = text.trim().length === 0;
  // While collapsed, show the latest streamed line (truncated to one line)
  // instead of a word count, so the user sees live reasoning progress.
  const lastLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  const label = empty
    ? "Thinking…"
    : open
      ? "Hide thinking"
      : lastLine
        ? `Thinking — ${lastLine}`
        : "Thinking…";
  useEffect(() => {
    const el = textRef.current;
    if (!el || !open || empty || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, open, empty]);
  // Detach an interrupted height-drag's window listeners when this block
  // unmounts (the agent can replace it mid-drag while streaming).
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag.current = { startY: e.clientY, startH: height };
    const onMove = (ev: PointerEvent) => {
      if (!drag.current) return;
      const next = drag.current.startH + (ev.clientY - drag.current.startY);
      setHeight(Math.max(THINKING_MIN_H, Math.min(THINKING_MAX_H, next)));
    };
    const onUp = () => {
      drag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    // Stash the removers so an unmount mid-drag can detach them.
    resizeCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  };

  return (
    <div
      className={`thinking-block ${open ? "open" : ""}${empty ? " busy" : ""}`}
    >
      <button className="thinking-head" onClick={() => setOpen((o) => !o)}>
        <span className={`thinking-dot${empty ? " busy" : ""}`}>
          {empty ? <span className="spinner" /> : "✦"}
        </span>
        <span className="thinking-label">{label}</span>
        {!empty && <span className={`chev ${open ? "open" : ""}`}>▾</span>}
      </button>
      {open && !empty && (
        <>
          <div
            className="thinking-text"
            ref={textRef}
            style={{ height }}
            dir="auto"
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToBottom.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {cachedPrepareText(text, dir)}
          </div>
          <div
            className="thinking-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize thinking panel"
            onPointerDown={startResize}
          >
            <span className="thinking-resizer-grip" />
          </div>
        </>
      )}
    </div>
  );
}

// Used by the RetryBanner countdown. Pure function so it can be called from
// `useState` initializer AND from the effect that resets `left` when
// `startedAt` changes mid-mount.
function computeLeft(delay: number, startedAt: number | undefined): number {
  // Backend backoff carries jitter as a float (e.g. 16.8277s) — ceil once
  // here so the banner never renders a fractional "retry in 16.82…s".
  if (!startedAt || delay <= 0) return Math.ceil(delay);
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return Math.max(0, Math.ceil(delay) - elapsed);
}

export function RetryBanner({
  attempt,
  maxAttempts,
  delay,
  reason,
  gaveUp,
  watchdog,
  model,
  agent,
  tool,
  fallback,
  transient,
  stalled,
  startedAt,
  onRetire,
  onCancel,
  onRetry,
}: {
  attempt: number;
  maxAttempts: number;
  delay: number;
  reason: string;
  gaveUp?: boolean;
  watchdog?: boolean;
  model?: string;
  agent?: string;
  /** The tool that owns this retry (e.g. "explore"), when it is a sub-agent
   *  retry — lets the banner name the tool, not just the agent. */
  tool?: string;
  fallback?: boolean;
  stalled?: boolean;
  startedAt?: number;
  /** Informational banners (sub-agent fallback, exhausted retries) are silent,
   *  here-to-tell-you notes — the turn keeps streaming and nothing needs a
   *  click. Instead of pinning them at the end of the transcript, they read
   *  (first ~4s) and then dissolve with `retry-fade-out`: visibility bounded,
   *  attention cost bounded. When the fade ends the banner is retired by the
   *  parent; a NEW failure replaces this one outright, so no action is lost. */
  /** Fires once the fade-out is done. */
  onRetire?: () => void;
  transient?: boolean;
  onCancel?: () => void;
  /** May be async: the banner keeps the button in its loading state until the
   *  click has actually been handled (see `pending` below). */
  onRetry?: () => void | Promise<void>;
}) {
  // Recompute `left` from props on every render. The banner may receive a new
  // `startedAt` (and a bumped `attempt`) on each retry cycle WITHOUT remounting
  // — the previous version initialized `left` once via `useState` and only
  // decremented it, so once a cycle ended at `left = 0` the next cycle
  // inherited that 0 and the countdown never reset (the user reported
  // "ریترای استپ زیاد میشه اما تایمر جدید نشون نمیده" — counter goes up but
  // the new timer never shows).
  const [left, setLeft] = useState(() => computeLeft(delay, startedAt));
  // Keep the interval in sync with whichever prop changed: `delay` (backoff
  // changed), `startedAt` (a new retry cycle started), or `attempt` (parent
  // bumped it for any reason). When `startedAt` changes, force `left` back to
  // its freshly-computed value before re-arming the interval.
  const lastStartedAt = useRef<number | undefined>(startedAt);
  // A click is an ASYNC round trip (POST /chat/retry_now, or a whole re-sent
  // turn), and a button that looks identical before and after being pressed
  // reads as broken — the user clicks again and again. While the request is in
  // flight the button shows a spinner and refuses a second click.
  const [pending, setPending] = useState(false);
  // Number of clicks whose promise has not settled yet. `pending` alone is not
  // enough: acknowledging a click immediately bumps `attempt`/`startedAt` on the
  // banner, so the reset below would clear the spinner WHILE the click was still
  // being handled. The button then flickered back to "Retry" mid-request, which
  // is exactly how it kept reading as a dead button.
  const inFlight = useRef(0);
  // A NEW retry cycle (or a replaced banner) ends the previous click's loading
  // state — but only once nothing is still in flight.
  useEffect(() => {
    if (inFlight.current === 0) setPending(false);
  }, [attempt, startedAt]);
  useEffect(() => {
    if (!pending) return;
    // Safety net: if nothing comes back (backend gone, banner about to retire),
    // never leave the button spinning forever.
    const t = setTimeout(() => {
      inFlight.current = 0;
      setPending(false);
    }, 15_000);
    return () => clearTimeout(t);
  }, [pending]);
  useEffect(() => {
    if (delay <= 0) return;
    if (lastStartedAt.current !== startedAt) {
      lastStartedAt.current = startedAt;
      setLeft(computeLeft(delay, startedAt));
    }
    const t = setInterval(() => {
      setLeft((l) => {
        if (l <= 1) {
          clearInterval(t);
          return 0;
        }
        return l - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [delay, startedAt, attempt]);
  /** How long a transient banner is readable before it starts dissolving. */
  const READ_MS = 4000;
  /** How long the dissolve itself takes. MUST match the `.retry-banner--fading`
   *  animation duration in styles/global.css — retiring earlier unmounts the
   *  banner while it is still ~20% opaque, which reads as a flicker. */
  const FADE_MS = 2000;
  const unlimited = maxAttempts <= 0;
  const isRateLimit =
    reason?.toLowerCase().includes("rate limit") ||
    reason?.toLowerCase().includes("quota");
  const countdown =
    delay > 0
      ? left > 0
        ? ` — retry in ${left}s`
        : " — retrying…"
      : " — retrying…";
  // The tool that owns the retry (e.g. "explore") + the agent label, joined so
  // the user can tell a main-agent retry from a specific tool's at a glance.
  // Skipped when the agent label already names the tool ("explore subagent" vs
  // "explore"): repeating it as "tool: explore, explore subagent" is noise.
  const tags = agent
    ? tool && !agent.toLowerCase().includes(tool.toLowerCase())
      ? [`tool: ${tool}`, agent]
      : [agent]
    : tool
      ? [`tool: ${tool}`]
      : [];
  const who = model
    ? ` — ${model}${tags.length ? ` (${tags.join(", ")})` : ""}`
    : tags.length
      ? ` — ${tags.join(", ")}`
      : "";
  // A sub-agent (explore/task/…) retry: it runs INSIDE the parent turn, so
  // calling it a "provider" hiccup would be misleading — the wording names it.
  const subAgent = !!agent && !fallback;
  // Exhausted-retire: when the banner says the attempt count is at its cap.
  // `unlimited` (maxAttempts <= 0) is the OPPOSITE of a cap: folding it in made
  // every unlimited retry render the "still trying" line instead of its
  // countdown, i.e. the banner hid the retry it was supposed to offer.
  const atLimit = maxAttempts > 0 && attempt >= maxAttempts;
  // Transient banners dissolve: a press-down period (READ_MS, fully readable),
  // then the full fade-out (FADE_MS, timed to the CSS animation). Hooks above
  // must stay unconditional — this is a prop, not a render-mode branch.
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!transient) {
      // A banner that STOPS being transient (the retry resolved, the turn
      // resumed) must not stay stuck half-faded.
      setLeaving(false);
      return;
    }
    // A NEW notice — a second failure, a fresh cycle — starts fully readable
    // again instead of inheriting the previous one's half-faded state.
    setLeaving(false);
    const a = setTimeout(() => setLeaving(true), READ_MS);
    return () => clearTimeout(a);
  }, [transient, reason, startedAt]);
  useEffect(() => {
    if (!transient || !leaving || !onRetire) return;
    const t = setTimeout(onRetire, FADE_MS);
    return () => clearTimeout(t);
  }, [transient, leaving, onRetire]);
  // Provider bodies arrive pasted in raw (escaped JSON and all) and can run to
  // several screen lines. The banner shows the sentence inside them; the full
  // text stays reachable through the tooltip (`title`).
  const detail = fallback
    ? fallbackReason(reason ?? "")
    : humanizeError(reason ?? "");
  // Label and suffix are computed BEFORE the early-return branches below: the
  // capped branch renders the attempt suffix, and declaring it after that
  // return put the variable in its temporal dead zone — every gave-up render
  // threw `Cannot access 'suffix' before initialization` instead of showing a
  // banner.
  const label = subAgent
    ? "Sub-agent retrying"
    : isRateLimit
      ? "Provider rate limit"
      : "Provider hiccup";
  const suffix = unlimited
    ? ` (attempt ${attempt})${countdown}`
    : ` (${attempt}/${maxAttempts})${countdown}`;
  // A sub-agent model hard-failed and the tool fell back to the MAIN model.
  // Distinct banner: no spinner, no retry button — the fallback already ran.
  if (fallback) {
    return (
      <div
        className={[
          "retry-banner",
          "retry-banner-fallback",
          ...(transient && leaving ? ["retry-banner--fading"] : []),
        ].join(" ")}
        title={reason || undefined}
      >
        <span className="retry-fallback-icon" aria-hidden>
          ⚠
        </span>
        <span className="retry-text">
          Sub-agent hit a wall — switched to the main model
          {who ? <span className="retry-who">{who}</span> : null}
          {detail ? <span className="retry-reason"> — {detail}</span> : null}
        </span>
      </div>
    );
  }
  // Attempt capped: nothing left to ride but pressure. One message, one line,
  // no countdown — and transient: the turn has either already moved on or is
  // about to surface its real error; lingering would stay unreadable noise.
  if (gaveUp || atLimit) {
    const ranOut = gaveUp === true;
    return (
      <div
        className={[
          "retry-banner",
          ...(transient && leaving ? ["retry-banner--fading"] : []),
        ].join(" ")}
        title={reason || undefined}
      >
        {!ranOut && <span className="spinner" />}
        <span className="retry-text">
          {agent ? `${agent} — ` : ""}
          {ranOut
            ? "kept failing after retries"
            : `still trying (${attempt}/${maxAttempts})`}
          {who ? <span className="retry-who">{who}</span> : null}
          {detail ? <span className="retry-reason"> — {detail}</span> : null}
        </span>
        {onRetry && (
          <button className="retry-btn" onClick={() => void onRetry()}>
            Retry
          </button>
        )}
        {onCancel && (
          <button
            className="retry-cancel"
            onClick={onCancel}
            title="Dismiss"
          >
            ✕
          </button>
        )}
      </div>
    );
  }
  // gave-up/watchdog wording is handled by the early return above.
  return (
    <div className="retry-banner" title={reason || undefined}>
      {!gaveUp && <span className="spinner" />}
      <span className="retry-text">
        {label}
        {suffix}
        {who ? <span className="retry-who">{who}</span> : null}
        {detail ? <span className="retry-reason"> — {detail}</span> : null}
        {stalled && !gaveUp ? (
          <span className="retry-stalled">
            {" "}
            — still waiting for the provider
          </span>
        ) : null}
      </span>
      {onRetry && (
        <button
          className="retry-btn"
          disabled={pending}
          onClick={() => {
            if (pending) return;
            const out = onRetry();
            // Async handler: hold the loading state until it settles. A sync
            // one (resume the turn) restarts a stream, so the banner is about
            // to be replaced anyway.
            if (out && typeof (out as Promise<void>).then === "function") {
              inFlight.current += 1;
              setPending(true);
              void (out as Promise<void>).finally(() => {
                inFlight.current = Math.max(0, inFlight.current - 1);
                if (inFlight.current === 0) setPending(false);
              });
            }
          }}
          title={
            pending
              ? "Retrying…"
              : "Retry — resumes where it stopped without redoing completed work"
          }
        >
          {pending ? <span className="spinner retry-btn-spinner" /> : null}
          {pending ? "Retrying…" : "Retry"}
        </button>
      )}
      {onCancel && (
        <button
          className="retry-cancel"
          onClick={onCancel}
          title="Cancel retry"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function localWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  // بیش از ۶۰ ثانیه: دقیقه + ثانیه (هم‌راستا با fmtTime در ToolCallView)
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${totalSec.toFixed(1)}s`;
}

function UsageBadge({
  input,
  output,
  total,
  live,
}: {
  input: number;
  output: number;
  total: number;
  live?: boolean;
}) {
  const body = `↑ ${fmtTokens(input)} in · ↓ ${live ? "…" : fmtTokens(output)} out`;
  return (
    <span
      className={`msg-usage${live ? " live" : ""}`}
      title={`${total.toLocaleString()} tokens total (${input.toLocaleString()} in, ${output.toLocaleString()} out)`}
      dir="ltr"
    >
      {body}
    </span>
  );
}

/**
 * نشانگر «در حال فکر کردن / در حال کار» که در ردیف فوتر پیام (سمت مخالف
 * کپی/usage) نمایش داده می‌شود. ۳ نقطهٔ لودینگ از سمت راست شروع به پر شدن
 * می‌کنند (نقطهٔ اول = سمت راست زودتر روشن می‌شود) تا هر ۳ تا پر شوند، سپس
 * چرخه از اول تکرار می‌شود. `label` برچسب حالت را تعیین می‌کند: «Thinking»
 * وقتی مدل reasoning تولید می‌کند و «Working» وقتی ایجنت مشغول کار است ولی
 * think نمی‌کند (اجرای ابزار، انتظار برای نتیجه و…).
 */
export function ThinkingIndicator({
  startedAt,
  label = "Thinking",
}: {
  startedAt?: number;
  label?: string;
}) {
  const [elapsed, setElapsed] = useState(() => {
    const base = startedAt ?? Date.now();
    return Date.now() - base;
  });
  useEffect(() => {
    const base = startedAt ?? Date.now();
    setElapsed(Date.now() - base);
    const id = setInterval(() => setElapsed(Date.now() - base), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <span className="msg-thinking" aria-label={label}>
      <span className="msg-thinking-inner" dir="ltr">
        <span className="msg-thinking-text">{label}</span>
        <span className="msg-thinking-dots" aria-hidden="true">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </span>
        <span className="msg-thinking-elapsed">{fmtElapsed(elapsed)}</span>
      </span>
    </span>
  );
}

// Only tools that write to the workspace filesystem render as their own
// visible edit UI (diff + revert) — every other tool (including
// memory/skill/connector saves) sweeps into the collapsed Claude-app-style
// trace group. Background sub-agents are also always-visible (isSubagentCard
// below) so the sub-agent never hides inside the collapsed group.
// ویرایش‌های پشت‌سرهم (edit_file/write_file) در یک گروه ویرایش جدا
// (ToolEditGroupView) جمع می‌شوند — نه کارت تکی جدا، نه قاطی با گروه
// ابزارهای فقط‌خواندنی.
const ALWAYS_VISIBLE_TOOLS = new Set(["edit_file", "write_file"]);

/** Interleave text slices with tool cards (Claude-style), but collapse runs of
 *  2+ consecutive read-only/non-mutating tool calls (grep/glob/read/
 *  web_search/run_terminal/search_memory) into one ToolGroupView so a
 *  search-heavy turn doesn't stack a full-height row per call. Anything in
 *  ALWAYS_VISIBLE_TOOLS always breaks the run and renders as its own full card
 *  (diff/confirmation visible), same as before. */
/** Shared rendering for a user message bubble + its action buttons (retry/copy).
 *  Used both for standalone user messages and for interleaved steer segments so
 *  the icons always match the main user message. `className` is applied to the
 *  bubble wrapper (e.g. "seg-steer" for the interleaved steer look). */
// Claude-style folding threshold for long user text (attachments/images
// always stay visible, only the text clamps).
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 10;

/** True when text overflows a folded bubble: too many characters or too many
 *  lines. Shared by user bubbles, queued/steer bubbles and the composer's
 *  pasted-text cards so every surface folds at the same size. */
export function isCollapsibleText(text: string): boolean {
  return (
    text.length > USER_COLLAPSE_CHARS ||
    text.split("\n").length > USER_COLLAPSE_LINES
  );
}

// Above this size a message is too big to paint inline at all: it keeps a
// short preview in the chat and the full text opens in the side panel.
const USER_PANEL_CHARS = 4000;
const USER_PANEL_LINES = 100;

/** True for a message that must open in the side panel instead of unfolding
 *  in the chat. Only a VERY long text (a pasted log/dump) qualifies — a
 *  merely long one expands in place, because clicking "Show more" should not
 *  move a message the user can already read out of the conversation. */
export function opensInPanel(text: string): boolean {
  return (
    text.length > USER_PANEL_CHARS ||
    text.split("\n").length > USER_PANEL_LINES
  );
}

/** Tab title for a full-text side panel: the first non-empty line, capped. */
function textTabTitle(text: string, fallback: string): string {
  const firstLine = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!firstLine) return fallback;
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

/** Refined pen-nib edit icon (pen-line style): slimmer nib plus a baseline
 *  reads as "edit text" and stays crisp at 16px next to retry/copy icons. */
function EditIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
    </svg>
  );
}

function UserMessageBubble({
  message,
  onRetry,
  onEdit,
  editingDisabled,
  className,
}: {
  message: ChatMessage;
  onRetry?: (id: string) => void;
  onEdit?: (messageId: string, newText: string) => void;
  editingDisabled?: boolean;
  className?: string;
}) {
  const dir = useStore((s) => s.dir);
  const [copied, setCopied] = useState(false);
  // Inline edit mode: the bubble text swaps for a textarea with Save/Cancel.
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Auto-grow the textarea to fit the draft (up to max-height) so long
  // messages keep the full bubble size instead of a small scroll box.
  useEffect(() => {
    if (!isEditing) return;
    const el = editInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [isEditing, draft]);
  const content = message.content || "";
  // Two separate limits: `folded` clamps the bubble to a preview, while
  // `inPanel` marks a HUGE text (pasted log/dump) whose full body is only
  // readable in the side panel. A merely long message unfolds IN PLACE, so
  // "Show more" never moves something the user can already read out of the
  // conversation (user request).
  const folded = isCollapsibleText(content);
  const inPanel = folded && opensInPanel(content);
  const [expanded, setExpanded] = useState(false);
  // Virtualized bubbles recycle: a fold state must not leak to the next message.
  useEffect(() => setExpanded(false), [message.id]);
  const showFull = folded && !inPanel && expanded;
  const body =
    folded && !showFull ? content.slice(0, USER_COLLAPSE_CHARS) : content;
  const clamped = folded && !showFull;

  const copy = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(message.content)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };

  // Enter edit mode with a fresh draft; Enter sends via onEdit only when the
  // trimmed text is non-empty and actually changed.
  const startEdit = () => {
    if (editingDisabled) return;
    setDraft(content);
    setIsEditing(true);
  };
  const cancelEdit = () => setIsEditing(false);
  const saveEdit = () => {
    const next = draft.trim();
    if (!next || next === content) {
      setIsEditing(false);
      return;
    }
    onEdit?.(message.id, next);
    setIsEditing(false);
  };

  return (
    <>
      <div className={`msg-bubble${className ? ` ${className}` : ""}${isEditing ? " editing" : ""}`}>
        {isEditing ? (
          <div className="msg-edit-wrap">
            <textarea
              ref={editInputRef}
              className="msg-edit-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") cancelEdit();
                else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
              }}
              dir="auto"
              rows={4}
              autoFocus
            />
            <div className="msg-edit-actions">
              <span
                className="msg-edit-hint"
                title="Escape cancels, Enter sends"
                aria-hidden="true"
              >
                i
              </span>
              <button className="msg-edit-cancel" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
        <div
          className={`chat-message user-text${clamped ? " clamped" : ""}`}
          dir={dir}
        >
          {cachedPrepare(message.id, body, dir) || "(empty)"}
        </div>
        )}
        {!isEditing && folded && (
          <button
            className="msg-expand"
            onClick={() => {
              if (!inPanel) {
                setExpanded((v) => !v);
                return;
              }
              useViewerTabs
                .getState()
                .openText(textTabTitle(content, "Message"), content);
            }}
            title={
              inPanel
                ? "Open the full text in the side panel"
                : undefined
            }
          >
            {inPanel ? "Show more" : expanded ? "Show less" : "Show more"}
          </button>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments" dir="ltr">
            {message.attachments.map((a) => (
              <span
                className="attachment-chip attachment-chip-open"
                key={a}
                role="button"
                tabIndex={0}
                title={`${a} — open in the side panel`}
                onClick={() => openWorkspaceFile(a)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openWorkspaceFile(a);
                  }
                }}
              >
                <FileIcon path={a} size={20} />{attachmentBasename(a)}
              </span>
            ))}
          </div>
        )}
        {message.images && message.images.length > 0 && (
          <MessageImages images={message.images} />
        )}
      </div>
      {message.content && !isEditing && (
        <div className="msg-actions">
          {onRetry && (
            <button
              className="msg-copy msg-retry"
              onClick={() => onRetry(message.id)}
              title="Retry"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          )}
          {onEdit && !isEditing && (
            <button
              className="msg-copy msg-edit"
              onClick={startEdit}
              disabled={editingDisabled}
              title="Edit message"
              aria-label="Edit message"
            >
              <EditIcon />
            </button>
          )}
          <button
            className={`msg-copy ${copied ? "copied" : ""}`}
            onClick={copy}
            title="Copy message"
            aria-label="Copy message"
          >
            {copied ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          <button
            className="msg-copy msg-fork"
            onClick={() => useStore.getState().forkChatFromMessage(message.id)}
            title="Fork chat from here"
            aria-label="Fork chat from here"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <circle cx="18" cy="6" r="3" />
              <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
              <path d="M12 12v3" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}

/** Order-preserving in-place text swap for a not-yet-sent queue item.
 *  Returns the updated list, or null when the edit is rejected (empty text
 *  or unknown id). Pure helper so the queue edit path is unit-testable
 *  without rendering. */
export function editQueuedText<T extends { id: string; text: string }>(
  items: T[],
  id: string,
  newText: string,
): T[] | null {
  const text = newText.trim();
  if (!text) return null;
  let found = false;
  const next = items.map((q) => {
    if (q.id !== id) return q;
    found = true;
    return { ...q, text };
  });
  return found ? next : null;
}

/** Foldable body text for queued / steer bubbles: long text clamps like a
 *  folded user message; the button opens the full text in the side panel.
 *  When onEdit is set, a pencil button swaps the text for the same inline
 *  textarea + Save/Cancel used by user bubbles (same CSS classes). Queue
 *  items edit in place (no resubmit); steer bubbles resubmit through the
 *  shared onEdit path in Chat.tsx. */
export function QueuedCollapsibleText({
  id,
  text,
  onEdit,
  editingDisabled,
}: {
  id: string;
  text: string;
  onEdit?: (messageId: string, newText: string) => void;
  editingDisabled?: boolean;
}) {
  const dir = useStore((s) => s.dir);
  const folded = isCollapsibleText(text);
  // Same rule as the user bubble: a huge text keeps a preview and opens in the
  // panel, anything merely long unfolds in place.
  const inPanel = folded && opensInPanel(text);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [id]);
  // Inline edit mode: same UX as UserMessageBubble — the text swaps for a
  // textarea with Save/Cancel.
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Auto-grow the textarea to fit the draft (up to max-height).
  useEffect(() => {
    if (!isEditing) return;
    const el = editInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [isEditing, draft]);

  // Enter edit mode with a fresh draft; Enter sends via onEdit only when the
  // trimmed text is non-empty and actually changed.
  const startEdit = () => {
    if (editingDisabled) return;
    setDraft(text);
    setIsEditing(true);
  };
  const cancelEdit = () => setIsEditing(false);
  const saveEdit = () => {
    const next = draft.trim();
    if (!next || next === text) {
      setIsEditing(false);
      return;
    }
    onEdit?.(id, next);
    setIsEditing(false);
  };

  return (
    <>
      {isEditing ? (
        <div className="msg-edit-wrap">
          <textarea
            ref={editInputRef}
            className="msg-edit-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                if (e.key === "Escape") cancelEdit();
                else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
              }}
              dir="auto"
              rows={4}
              autoFocus
            />
            <div className="msg-edit-actions">
              <span
                className="msg-edit-hint"
                title="Escape cancels, Enter sends"
                aria-hidden="true"
              >
                i
              </span>
              <button className="msg-edit-cancel" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
        </div>
      ) : (
        <>
          <div
            className={`queued-bubble-text${folded && !expanded ? " clamped" : ""}`}
            dir={detectDir(text)}
          >
            {cachedPrepare(id, text, dir) || "(empty)"}
          </div>
          {folded && (
            <button
              className="msg-expand queued-expand"
              onClick={() => {
                if (!inPanel) {
                  setExpanded((v) => !v);
                  return;
                }
                useViewerTabs
                  .getState()
                  .openText(textTabTitle(text, "Queued text"), text);
              }}
              title={
                inPanel
                  ? "Open the full text in the side panel"
                  : undefined
              }
            >
              {inPanel ? "Show more" : expanded ? "Show less" : "Show more"}
            </button>
          )}
        </>
      )}
      {onEdit && !isEditing && (
        <div className="msg-actions">
          <button
            className="msg-copy msg-edit"
            onClick={startEdit}
            disabled={editingDisabled}
            title="Edit message"
            aria-label="Edit message"
          >
            <EditIcon />
          </button>
        </div>
      )}
    </>
  );
}

function SegSteerBubble({
  message,
  onRetry,
  onEdit,
  editingDisabled,
}: {
  message: ChatMessage;
  onRetry?: (id: string) => void;
  onEdit?: (messageId: string, newText: string) => void;
  editingDisabled?: boolean;
}) {
  // Render the EXACT same structure as a standalone user message (role header
  // + bubble + actions) so an interleaved steer is pixel-identical to the
  // user's own messages — the .msg.user wrapper reuses the same CSS.
  return (
    <div className="msg user seg-steer">
      <div className="msg-role">
        <span className="msg-role-avatar" aria-hidden="true">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
          </svg>
        </span>
        You
      </div>
      <UserMessageBubble message={message} onRetry={onRetry} onEdit={onEdit} editingDisabled={editingDisabled} />
    </div>
  );
}

/** Renders a folded context-summary message: the preview stays folded in the
 *  chat and the header opens the full summary in the side panel (like
 *  diff/plan), never inline. Shared by the standalone system-message bubble
 *  and the inline `compact` segment. */
const SummaryBlock = memo(function SummaryBlock({ message }: { message: ChatMessage }) {
  const dir = useStore((s) => s.dir);
  const content = message.content || "";
  const open = () =>
    useViewerTabs.getState().openText("Context summary", content);
  return (
    <div className="summary-block collapsed">
      <div
        className="summary-head"
        onClick={open}
        role="button"
        tabIndex={0}
        title="Open the full summary in the side panel"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
      >
        <span className="summary-chevron">▶</span>
        <span className="summary-icon">📎</span>
        <span className="summary-label">Context summary</span>
        {content && (
          <span className="summary-preview" dir="auto">
            {cachedPrepare(message.id, content, dir)}
          </span>
        )}
        <span className="summary-hint">
          earlier turns folded into this summary — click to open it
        </span>
      </div>
    </div>
  );
});

/** A text segment counts as a "caption" (narration the model wrote right
 *  before a tool call, e.g. "بذار ببینم X رو...") rather than real answer
 *  prose. Only SHORT narration qualifies: a long or multi-line text is real
 *  answer prose (e.g. the plan body or a summary) and must render as a
 *  paragraph OUTSIDE the tool group — otherwise the reply stays trapped
 *  inside the group card. Fenced code blocks are also real content, never a
 *  "let me check X" line, and rendering them as a raw narration row would
 *  lose all formatting. */
const CAPTION_MAX_CHARS = 260;
const CAPTION_MAX_LINES = 2;

function isCaptionCandidate(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("```")) return false;
  if (t.length > CAPTION_MAX_CHARS) return false;
  if (t.split("\n").length > CAPTION_MAX_LINES) return false;
  return true;
}

/** Unit-tested helper (trace card identity pattern): direct key inspection —
 *  keeps trace card identity stable during streaming — without
 *  needing a render. */
export function renderSegments(
  message: ChatMessage,
  onRetry?: (id: string) => void,
  onEdit?: (messageId: string, newText: string) => void,
  editingDisabled?: boolean,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let pending: { activity: ToolActivity; index: number }[] = [];
  // A run of consecutive tool rows / groups (no real prose between them)
  // accumulates here instead of going straight into `nodes`, so the whole run
  // wraps in ONE card (see wrapTrace) instead of each item floating as its own
  // bordered box with a gap around it.
  let trace: ReactNode[] = [];
  // The narration line held back to attach to the NEXT tool call (see
  // isCaptionCandidate). Stored per-call so a narration BETWEEN two calls
  // (caption, tool, caption, tool) attaches to its own call without breaking
  // the run into separate groups — the whole run stays ONE group.
  let pendingCaption: string | null = null;
  // Per-call captions collected while the run accumulates: caption[i] is the
  // narration that preceded pending[i]. The LAST one also becomes the group
  // head's summary title (Claude.ai style).
  const captions: (string | null)[] = [];
  // Monotonic counter for orphan-caption prose fallbacks (a held-back caption
  // with no groupable call after it) — guarantees unique React keys even when
  // several such captions appear in one message.
  let orphanCap = 0;
  // هویت پایدار کارت trace (والد گروه‌ها): ایندکس اولین فعالیتِ رانِ جاری —
  // نه نقطه‌ای که ران بسته می‌شود. کلید پوزیشنال («trace-{i}» / «trace-end»)
  // همان باگ کلید گروه را برای والدِ آن هم زنده نگه می‌داشت: حین استریم،
  // narration نیمه‌تایپ‌شده هنوز فراخوانیِ بعدی را ندارد و موقتاً prose
  // حساب می‌شود؛ ران زیر یک کلید flush می‌شود. لحظه‌ای بعد فراخوانی می‌رسد،
  // همان متن caption می‌شود و ران زیر کلید دیگری دوباره flush می‌شود —
  // تغییر کلید والد یعنی unmount کل زیردرخت و از دست رفتن state باز/بسته
  // بودن گروهی که کاربر باز کرده بود. لنگر به اولین فعالیتِ ران (مثل
  // grp-… فقط یک‌بار ثبت می‌شود) کلید را در همهٔ رندرها ثابت نگه می‌دارد؛
  // گروهِ باز فقط با کلیک خود کاربر بسته می‌شود.
  let traceAnchor: number | null = null;
  // ران ویرایشی جدا: edit_file/write_fileهای پشت‌سرهم این‌جا انباشته می‌شوند
  // تا در یک گروه ویرایش واحد (ToolEditGroupView) فلاش شوند — هرگز با ران
  // فقط‌خواندنی (pending) قاطی نمی‌شوند.
  let pendingEdit: { activity: ToolActivity; index: number }[] = [];
  const flushEdits = () => {
    if (pendingEdit.length === 0) return;
    if (pendingEdit.length === 1) {
      const entry = pendingEdit[0];
      const { activity } = entry;
      const entryIndex = entry.index;
      nodes.push(
        <ToolCallView
          key={`edit-${entryIndex}`}
          activity={activity}
          messageId={message.id}
          onReverted={() =>
            useStore.getState().markToolReverted(message.id, entryIndex)
          }
        />,
      );
    } else {
      const key = `edit-grp-${pendingEdit[0].index}`;
      nodes.push(
        <ToolEditGroupView
          key={key}
          activities={pendingEdit}
          messageId={message.id}
          onReverted={(idx) =>
            useStore.getState().markToolReverted(message.id, idx)
          }
        />,
      );
    }
    pendingEdit = [];
  };
  const wrapTrace = () => {
    if (trace.length === 0) return;
    nodes.push(
      <div key={`trace-${traceAnchor}`} className="tool-trace">
        {trace}
      </div>,
    );
    trace = [];
    traceAnchor = null;
  };

  const flush = () => {
    if (pending.length === 0) {
      // A held-back caption with no groupable call after it (e.g. the run
      // ended on a narration) renders as plain prose instead of vanishing.
      if (pendingCaption) {
        wrapTrace();
        renderProse(`cap-${orphanCap}`, pendingCaption);
        orphanCap++;
        pendingCaption = null;
      }
      return;
    }
    // Keyed by the FIRST activity's own stable index into
    // message.toolActivity — assigned once and never reused — NOT by the
    // segment-scan position. A position-based key breaks under streaming:
    // while a short narration line is still being typed, its FOLLOWING tool
    // segment hasn't arrived yet, so `nextIsGroupable` below can't tell it
    // apart from real prose and this run gets flushed early under one
    // positional key. A moment later the tool call lands, the same line is
    // correctly reclassified as a caption, and the run keeps accumulating
    // before flushing again under a DIFFERENT positional key (e.g.
    // "grp-end"). React sees a different key for what is, to the user, the
    // same group — unmounts the old ToolGroupView and mounts a fresh one
    // with open=false, which is the mid-stream "collapses by itself" bug.
    // The first activity's index survives that reclassification: the group
    // keeps one identity across renders no matter which scan point ends up
    // triggering the flush.
    const key = `grp-${pending[0].index}`;
    if (pending.length === 1 && !isSubagentCard(pending[0].activity)) {
      // یک فراخوانی تکی: narration مدل — اگر بود — به‌صورت ردیف جدا بالای
      // همین ردیف رندر می‌شود (TraceNarration) — مثل Claude.ai که کپشنِ
      // کارِ تکی در کادر جدا بالای ردیف ابزار دیده می‌شود.
      if (captions[0]) {
        trace.push(
          <TraceNarration key={`nar-${key}`} text={captions[0]} />,
        );
      }
      const { activity } = pending[0];
      trace.push(
        <ToolSingleRow key={key} activity={activity} messageId={message.id} />,
      );
    } else {
      // 2+ consecutive read-only calls collapse into ONE trace group even
      // when narrations interleave (caption, tool, caption, tool…): each
      // caption rides INSIDE the group attached to its own call — the last
      // one also becomes the head's summary title (Claude.ai style) — so
      // the run never splits into several floating groups. Pass a COPY:
      // `captions` is reused (cleared) for the next run, and React reads the
      // prop at render time — by-reference passing would hand it an empty
      // array by then.
      // A LONE sub-agent call (explore) also takes this path: ToolGroupView
      // renders it as a pill carrying the short description of what that
      // explore is looking for, which ToolSingleRow cannot show — so a single
      // explore is no longer an anonymous row.
      trace.push(
        <ToolGroupView
          key={key}
          activities={pending}
          captions={captions.slice()}
        />,
      );
    }
    pending = [];
    captions.length = 0;
    pendingCaption = null;
  };

  const renderProse = (key: string, text: string) => {
    nodes.push(
      <MarkdownProse
        key={key}
        text={cachedPrepare(
          `${message.id}:seg:${key}`,
          text,
          useStore.getState().dir,
        )}
      />,
    );
  };

  const segs = message.segments ?? [];
  segs.forEach((seg, i) => {
    if (seg.kind === "user") {
      flush();
      wrapTrace();
      flushEdits();
      const steerMsg = useStore
        .getState()
        .chats.flatMap((c) => c.messages)
        .find((m) => m.id === seg.id);
      if (steerMsg) {
        nodes.push(
          <SegSteerBubble key={i} message={steerMsg} onRetry={onRetry} onEdit={onEdit} editingDisabled={editingDisabled} />,
        );
      }
      return;
    }
    if (seg.kind === "compact") {
      // A mid-turn auto-compact: fold the checkpoint in AT THE POINT it fired,
      // same treatment as an interleaved steer message above — the summary
      // message itself lives in the store (compactChat pushes it there too),
      // this segment just anchors where it renders.
      flush();
      wrapTrace();
      flushEdits();
      const summaryMsg = useStore
        .getState()
        .chats.flatMap((c) => c.messages)
        .find((m) => m.id === seg.id);
      if (summaryMsg) {
        nodes.push(<SummaryBlock key={i} message={summaryMsg} />);
      }
      return;
    }
    if (seg.kind === "artifact") {
      // An artifact card sits where the agent built it, between the prose that
      // introduced it and whatever comes next — not appended at the end.
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(<ArtifactCard key={i} segment={seg} />);
      return;
    }
    if (seg.kind === "text") {
      // Whitespace-only text (the model often emits a bare "\n\n" between two
      // tool calls, with no narration around it): pure formatting noise.
      // Falling through to the prose branch would flush the accumulating run
      // and close the trace card — the invisible break that split one logical
      // run into several back-to-back group cards with nothing rendered
      // between them. Skip it: the run keeps accumulating as if it never
      // existed.
      if (!seg.text.trim()) return;

      // Does this text immediately precede a groupable (non-always-visible)
      // tool call? If so, it's the model's narration for that call: render it
      // as its own row INSIDE the trace card, right above the call(s) — not a
      // separate prose paragraph outside the card.
      const next = segs[i + 1];
      const nextActivity =
        next && next.kind === "tool"
          ? message.toolActivity?.[next.index]
          : undefined;
      const nextIsGroupable =
        nextActivity &&
        !ALWAYS_VISIBLE_TOOLS.has(nextActivity.tool) &&
        !isSubagentCard(nextActivity);

      if (nextIsGroupable && isCaptionCandidate(seg.text)) {
        // A narration BEFORE a groupable tool: it belongs to the NEXT call.
        // Do NOT flush here — a narration BETWEEN two calls (caption, tool,
        // caption, tool) must attach to its own call while the run keeps
        // accumulating; flushing would split one logical run into several
        // floating groups (the "groups came out separate" bug).
        pendingCaption = seg.text;
        return;
      }

      // Genuine prose — flush whatever tool run was accumulating.
      flush();
      wrapTrace();
      flushEdits();
      renderProse(String(i), seg.text);
      return;
    }
    const activity = message.toolActivity?.[seg.index];
    if (!activity) return;
    // ران ویرایشی جدا: edit_file/write_file پشت‌سرهم در pendingEdit انباشته
    // می‌شوند و هرگز با ران فقط‌خواندنی (pending) یا گروه ابزارهای دیگر قاطی
    // نمی‌شوند. تک‌ویرایش مثل قبل کارت تکی (ToolCallView) می‌ماند تا Undo و
    // Review تکی هر فایل حفظ شود؛ ۲+ ویرایش در یک ToolEditGroupView جمع می‌شوند.
    if (isEditActivity(activity) && !isSubagentCard(activity)) {
      flush();
      wrapTrace();
      pendingEdit.push({ activity, index: seg.index });
      return;
    }
    // Explore/sub-agent runs never expand inside the chat: each one renders as
    // the compact ExploreCard (run title + one chip per tool with its call
    // count); clicking it opens that run's tool group in the right-hand panel
    // (user request — parallel runs each get their own independent card).
    if (isSubagentCard(activity)) {
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(
        <ExploreCard
          key={`exp-${seg.index}`}
          activity={activity}
          messageId={message.id}
          index={seg.index}
        />,
      );
      return;
    }
    if (ALWAYS_VISIBLE_TOOLS.has(activity.tool)) {
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(
        <ToolCallView
          key={i}
          activity={activity}
          messageId={message.id}
          onReverted={() =>
            useStore.getState().markToolReverted(message.id, seg.index)
          }
        />,
      );
    } else {
      // شروع ران فقط‌خواندنی: گروه ویرایش قبلی (اگر بود) اول بسته می‌شود تا
      // دو ران هرگز در یک کارت قاطی نشوند.
      flushEdits();
      // Attach the held-back narration to THIS call (per-call captions), then
      // keep accumulating — the run stays one group even with interleaved
      // narrations.
      captions.push(pendingCaption);
      pendingCaption = null;
      pending.push({ activity, index: seg.index });
      // لنگر wrapper = اولین فعالیتِ ران؛ فقط یک‌بار ثبت می‌شود (توضیح
      // traceAnchor بالا) تا کلید کارت trace در همهٔ رندرها ثابت بماند.
      if (traceAnchor === null) traceAnchor = seg.index;
    }
  });
  flush();
  wrapTrace();
  flushEdits();
  return nodes;
}

export const ChatMessageView = memo(
  function ChatMessageView({
    message,
    onRetry,
    onEdit,
    editingDisabled,
  }: {
    message: ChatMessage;
    onRetry?: (id: string) => void;
    onEdit?: (messageId: string, newText: string) => void;
    editingDisabled?: boolean;
  }) {
  const isUser = message.role === "user";
  const dir = useStore((s) => s.dir);
  // Narrow subscriptions: reading the whole settings object re-rendered EVERY
  // message on ANY settings change. Only the mode label is needed for render;
  // TTS config is read lazily from getState() inside toggleSpeak.
  const modeLabelStr = useStore((s) =>
    message.mode ? getMode(s.settings, message.mode).label : "",
  );
  const [copied, setCopied] = useState(false);
  const { status: ttsStatus, toggle: ttsToggle, stop: ttsStop } = useTtsPlayback();

  const modeLabel = (_id: string) => modeLabelStr;

  const copyMessage = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(message.content)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };

  // تصمیم پلی/پاز داخل toggle همگام و اتمیک است (نه با ttsStatus ناهمگام) —
  // کلیک تند هرگز دو پخش همزمان نمی‌سازد. حین پخش → pause درجا، حین pause →
  // resume از همان‌جا (نه از اول)، حین لودینگ → لغو. لغو دستی خطا نیست.
  const toggleSpeak = async () => {
    // Clear any previous banner error for this chat before a new attempt.
    try {
      const prevChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message.id))?.id;
      if (prevChatId) useStore.getState().setChatTtsError(prevChatId, null);
    } catch {
      // Banner clear is best-effort.
    }
    const st = useStore.getState();
    // A live voice session owns the audio output: never start separate message playback over it.
    const liveVoice = (st as unknown as { liveVoiceState?: string }).liveVoiceState;
    if (liveVoice === "live" || liveVoice === "speaking" || liveVoice === "connecting") return;
    const providers = st.settings.providers ?? [];
    // Build the provider chain: primary first, then ordered fallbacks.
    const toSpeakOpts = (
      provider: (typeof providers)[number],
      model: string | undefined,
      voice: string | undefined,
    ): SpeakProviderOpts => ({
      kind: provider.kind,
      baseUrl: provider.baseUrl ?? "",
      apiKeys: [...(provider.apiKeys ?? (provider.apiKey ? [provider.apiKey] : []))],
      model,
      voice,
    });
    const chain: SpeakProviderOpts[] = [];
    const primary = providers.find((p) => p.id === st.ttsProviderId);
    if (primary) chain.push(toSpeakOpts(primary, st.ttsModel, st.ttsVoice));
    for (const fb of st.ttsFallbacks ?? []) {
      const p = providers.find((x) => x.id === fb.providerId);
      if (!p) continue;
      chain.push(toSpeakOpts(p, fb.model, fb.voice));
    }
    if (chain.length === 0) {
      const msg = "برای پخش صدا ابتدا یک پروایدر TTS در تنظیمات ← مدل‌ها انتخاب کنید";
      const bannerChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message.id))?.id;
      if (bannerChatId) useStore.getState().setChatTtsError(bannerChatId, msg);
      return;
    }
    // Only the final answer is spoken — the working trace (tool narrations,
    // status lines) shown mid-run is never read aloud.
    const speakable = stripBidiMarks(fixZwsp(speakableMessageText(message)));
    if (!speakable.trim()) {
      const msg = "متن قابل خواندنی برای پخش نیست";
      const bannerChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message.id))?.id;
      if (bannerChatId) useStore.getState().setChatTtsError(bannerChatId, msg);
      return;
    }
    try {
      await ttsToggle(speakable, chain);
    } catch (err) {
      const friendly = friendlyTtsError(err);
      if (!friendly) return;
      console.warn("speak failed", err);
      const bannerChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message.id))?.id;
      if (bannerChatId) useStore.getState().setChatTtsError(bannerChatId, friendly);
    }
  };

  // قطع صدا هنگام شروع پیام جدید یا unmount تا پخش قدیمی روی پیام تازه نماند.
  useEffect(() => {
    if (message.streaming) ttsStop();
  }, [message.streaming, ttsStop]);
  useEffect(() => () => ttsStop(), [ttsStop]);

  // No live token estimate while streaming: the char-based estimate overshot
  // and then "fell back down" to the real provider numbers once the usage event
  // landed, which made the badge flicker up/down during long replies. The badge
  // now appears only once real usage exists (same as the titlebar meter), so it
  // stays stable.

  // Every system message is a context summary (compactChat is the only
  // producer of role=system) — render ALL of them as the collapsed
  // SummaryBlock, including older summaries marked compacted:true, which
  // previously fell through to the prose branch and dumped the FULL
  // summary text into the chat (the auto-compact "full text" bug).
  const isSummary = message.role === "system" && !message.modeSwitch;
  const isModeSwitch = message.modeSwitch === true;

  // Plan card display filtering: when a planDoc landed on this message the
  // plan portion of the streamed reply collapses into the Plan card BELOW the
  // bubble (see planDisplay). Raw content/segments stay untouched — model
  // history and "Copy message" keep the full text.
  const planDoc = !isUser && !isSummary ? message.planDoc : undefined;
  const display = planDisplay(message);
  const displayContent = display.content;
  const displaySegments = display.segments;
  // Non-code documents created or edited this turn (write_document plus doc
  // edits via edit_file/write_file). Rendered as clickable chips below.
  const docPaths = useMemo(() => {
    const docs = docPathsFromActivities(message.toolActivity);
    return dedupDocPaths(docs, message.attachments ?? []);
  }, [message.toolActivity, message.attachments]);
  // Render cap for the plain (non-segmented) assistant reply. Segmented
  // replies render caption slices around tool cards (small by construction);
  // the full text stays in history/copy regardless.
  const cap = useCapped(message.id, displayContent ?? "", !!message.streaming);
  // A reply only leaves the chat when it is VERY long (a dumped log): it then
  // keeps a short preview here and the full body opens in the side panel.
  // Anything shorter renders in full, exactly as before — the chat must not
  // grow a "Show more" for every ordinary answer. Streaming replies are never
  // folded (that would flicker).
  const replyText = displayContent ?? message.content ?? "";
  const replyInPanel = !message.streaming && opensInPanel(replyText);
  const replyBody = replyInPanel
    ? replyText.slice(0, USER_COLLAPSE_CHARS)
    : cap.shown;

  // Reading mode: only assistant replies with ≥2 headed sections get the
  // "مطالعه" button — short answers don't need a two-pane viewer.
  const [reading, setReading] = useState(false);
  const sections = useMemo(
    () => (!isUser && !isSummary ? splitSections(message.content) : []),
    [message.content, isUser, isSummary],
  );

  // Mode-switch notices exist so the model knows which mode the next message
  // runs in — the user doesn't want them rendered in the chat. Keep the message
  // in the data (the agent still receives it) but render nothing.
  if (isModeSwitch) return null;
  // Folded messages (auto/manual compact) stay in the store for history but
  // must NOT render their full text in the chat — the collapsed SummaryBlock
  // represents them. Without this guard every folded turn kept dumping its
  // whole content into the scrollback after a compact.
  if (message.compacted) return null;

  // A steer confirmed by the backend (steer_applied) is rendered inline inside
  // the assistant message it interrupted — hide its own otherwise-bottom bubble.
  // Fallback: if no assistant message actually references this steer as a
  // segment (retry wiped segments, parent truncated/compacted), do NOT hide —
  // otherwise the message suddenly vanishes with no inline copy.
  if (isUser && message.steerInterleaved) {
    const referenced = useStore
      .getState()
      .chats.some((c) =>
        c.messages.some((m) =>
          (m.segments ?? []).some(
            (s) => s.kind === "user" && (s as { id: string }).id === message.id,
          ),
        ),
      );
    if (referenced) return null;
  }

  // While the provider is retrying, the assistant message has no content yet —
  // hide the empty placeholder so the retry banner (rendered once, at the END
  // of the chat in Chat.tsx) is the only thing between the user's message and
  // the incoming reply, instead of a dangling empty bubble.
  if (
    message.retry &&
    !message.content &&
    !(message.segments && message.segments.length > 0)
  ) {
    return null;
  }
  const roleLabel = isUser
    ? "You"
    : isSummary
      ? "Context summary"
      : message.role === "tool"
        ? "Tools"
        : message.mode
          ? modeLabel(message.mode)
          : "Assistant";

  return (
    <div
      className={`msg ${isUser ? "user" : ""} ${message.error ? "error" : ""}`}
      data-msg-id={message.id}
      data-is-summary={isSummary ? "true" : undefined}
    >
      <div className="msg-role">
        {isUser && (
          <span className="msg-role-avatar" aria-hidden="true">
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
            </svg>
          </span>
        )}
        {roleLabel}
      </div>

      {!isUser && message.plan && message.plan.length > 0 && (
        <div className="plan-block" dir={dir}>
          <div className="plan-head">
            <span className="plan-dot">◎</span>
            <span className="plan-label">Plan</span>
          </div>
          <ul className="plan-list">
            {message.plan.map((item, i) => (
              <li
                // Content is the only stable field (the backend stores no item
                // id), so an index key repainted the wrong row as done/running
                // whenever the agent reordered or appended plan items.
                key={item.id ?? item.content}
                className={`plan-item ${item.status === "completed" ? "done" : item.status === "in_progress" ? "running" : ""}`}
              >
                <span className="plan-item-mark">
                  {item.status === "completed"
                    ? "✓"
                    : item.status === "in_progress"
                      ? "●"
                      : "○"}
                </span>
                <span className="plan-item-content" dir="auto">
                  {cachedPrepare(`${message.id}:plan:${i}`, item.content, dir)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!isUser && message.attachments && message.attachments.length > 0 && (
        <div className="msg-attachments" dir="ltr">
          {message.attachments.map((a) => (
            <span
              className="attachment-chip attachment-chip-open"
              key={a}
              role="button"
              tabIndex={0}
              title={`${a} — open in the side panel`}
              onClick={() => openWorkspaceFile(a)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openWorkspaceFile(a);
                }
              }}
            >
              <FileIcon path={a} size={20} />{attachmentBasename(a)}
            </span>
          ))}
        </div>
      )}

      {(isSummary ||
        displayContent ||
        (displaySegments && displaySegments.length > 0)) &&
        (isModeSwitch ? (
          <div className="mode-switch-note" dir="ltr">
            {cachedPrepare(message.id, message.content, "ltr")}
          </div>
        ) : isSummary ? (
          <SummaryBlock message={message} />
        ) : displaySegments && displaySegments.length > 0 ? (
          /* Claude-style interleaved rendering: text slices and tool cards follow
             each other in the exact order the agent produced them, with runs of
             2+ read-only tool calls collapsed into one summary (see renderSegments). */
          <div className="msg-bubble segmented">
            {renderSegments(
              { ...message, segments: displaySegments },
              onRetry,
              onEdit,
              editingDisabled,
            )}
          </div>
        ) : isUser && message.steerPending ? (
          <div className="queued-bubble steer" dir={dir}>
            <div className="queued-bubble-head">
              <span className="queued-bubble-icon">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 14L4 9l5-5" />
                  <path d="M4 9h10a5 5 0 015 5v6" />
                </svg>
              </span>
              <span className="queued-bubble-label">
                Steering the running agent…
              </span>
              <span className="queued-bubble-pulse" />
              <button
                className="chip-x queued-bubble-x"
                onClick={() => {
                  const s = useStore.getState();
                  const chat = s.chats.find((c) =>
                    c.messages.some((m) => m.id === message.id),
                  );
                  if (!chat) return;
                  s.removeMessage(chat.id, message.id);
                  void cancelSteer(chat.id, message.id);
                }}
                title="Cancel steer — remove this message"
              >
                ×
              </button>
            </div>
            <QueuedCollapsibleText
              id={message.id}
              text={message.content}
              onEdit={onEdit}
              editingDisabled={editingDisabled}
            />
            {message.attachments && message.attachments.length > 0 && (
              <div className="msg-attachments" dir="ltr">
                {message.attachments.map((a) => (
                  <span
                    className="attachment-chip attachment-chip-open"
                    key={a}
                    role="button"
                    tabIndex={0}
                    title={`${a} — open in the side panel`}
                    onClick={() => openWorkspaceFile(a)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openWorkspaceFile(a);
                      }
                    }}
                  >
                    <FileIcon path={a} size={20} />{attachmentBasename(a)}
                  </span>
                ))}
              </div>
            )}
            {message.images && message.images.length > 0 && (
              <MessageImages images={message.images} />
            )}
          </div>
        ) : isUser ? (
          /* Same fixed dir as the composer (dir={dir}): dir="auto" resolved
             from the first strong char only, so a user message starting with
             a Latin word/digit (e.g. "API key رو بده") flipped to LTR and the
             72ch box hugged the LEFT side even in RTL mode. A fixed dir keeps
             the rendered bubble identical to what the user typed. */
          <UserMessageBubble message={message} onRetry={onRetry} onEdit={onEdit} editingDisabled={editingDisabled} />
        ) : (
          <>
            <div className="msg-bubble">
              <MarkdownProse text={cachedPrepare(message.id, replyBody, dir)} />
            </div>
            {replyInPanel && (
              <button
                className="msg-expand"
                onClick={() =>
                  useViewerTabs
                    .getState()
                    .openText(textTabTitle(replyText, "Reply"), replyText)
                }
                title={`Full reply is ${fmtSize(replyText.length)} — opens in the side panel`}
              >
                {`Show all (${fmtSize(replyText.length)})`}
              </button>
            )}
          </>
        ))}

      {!isUser && docPaths.length > 0 && <DocFileChips paths={docPaths} />}

      {!isUser && planDoc && <PlanDocCard planDoc={planDoc} />}


      {!isUser && message.interrupted && (
        <div className="msg-interrupted" dir="auto">
          ⚠️ Interrupted — this reply was cut off (e.g. power loss). Send
          “continue” to resume.
        </div>
      )}

      {!isUser && (message.content || message.usage || message.streaming || message.turnElapsedMs != null) && (
        <div className="msg-actions">
          {message.usage && (
            <UsageBadge
              input={message.usage.inputTokens}
              output={message.usage.outputTokens}
              total={message.usage.totalTokens}
            />
          )}
          {message.content && (
            <>
              <button
                className={`msg-copy ${copied ? "copied" : ""}`}
                onClick={copyMessage}
                title={copied ? "Copied" : "Copy message"}
                aria-label={copied ? "Copied" : "Copy message"}
              >
                {copied ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
              <button
                className="msg-copy msg-fork"
                onClick={() => useStore.getState().forkChatFromMessage(message.id)}
                title="Fork chat from here"
                aria-label="Fork chat from here"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="18" r="3" />
                  <circle cx="6" cy="6" r="3" />
                  <circle cx="18" cy="6" r="3" />
                  <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                  <path d="M12 12v3" />
                </svg>
              </button>
              {!isUser && !message.streaming && (
                <button
                  className={`msg-copy msg-speak ${ttsStatus === "speaking" ? "speaking" : ""} ${ttsStatus === "loading" ? "loading" : ""} ${ttsStatus === "paused" ? "paused" : ""}`}
                  onClick={toggleSpeak}
                  title={
                    (ttsStatus === "speaking"
                      ? "توقف موقت"
                      : ttsStatus === "paused"
                        ? "ادامه پخش"
                        : ttsStatus === "loading"
                          ? "لغو"
                          : "خواندن با صدا")
                  }
                  aria-label={
                    ttsStatus === "speaking"
                      ? "Pause"
                      : ttsStatus === "paused"
                        ? "Resume"
                        : ttsStatus === "loading"
                          ? "Cancel"
                          : "Speak"
                  }
                >
                  {ttsStatus === "loading" ? (
                    <svg
                      className="tts-spinner"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                    </svg>
                  ) : ttsStatus === "speaking" ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9 5v14M15 5v14" />
                    </svg>
                  ) : ttsStatus === "paused" ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  ) : (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                  )}
                </button>
              )}
              {!isUser &&
                !isSummary &&
                !message.streaming &&
                sections.length >= 2 && (
                  <button
                    className="msg-copy"
                    onClick={() => setReading(true)}
                    title="Reading mode — study each section separately and ask about it"
                    aria-label="Read"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                    </svg>
                  </button>
                )}
            </>
          )}
          {message.streaming &&
            (message.thinkingActive ? (
              <ThinkingIndicator startedAt={message.thinkingStartedAt} />
            ) : (
              <ThinkingIndicator
                label={(() => {
                  const lsp = lspStatusLabel(message.lspStatus);
                  if (lsp) return lsp;
                  return message.statusText ? `Working · ${message.statusText}` : "Working";
                })()}
                startedAt={message.workingStartedAt}
              />
            ))}
          {/* Turn duration + send clock share the far end of the footer,
              opposite the usage/buttons cluster (same spot the live Working
              indicator occupied while streaming). One auto margin on the
              first item only — two autos would split the free space.
              NOTE: no dir on the outer spans — margin-inline-start must
              resolve against the row direction (a dir="ltr" here would flip
              the margin side in RTL and glue the pair to the buttons). The
              inner spans keep the digits LTR. */}
          {!message.streaming && message.turnElapsedMs != null && (
            <span
              className="msg-elapsed msg-elapsed-far"
              title={`Working time for this turn: ${fmtElapsed(message.turnElapsedMs)}`}
            >
              <span dir="ltr">{fmtElapsed(message.turnElapsedMs)}</span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="10" x2="14" y1="2" y2="2" />
                <line x1="12" x2="15" y1="14" y2="11" />
                <circle cx="12" cy="14" r="8" />
              </svg>
            </span>
          )}
          {!message.streaming && (
            <span
              className={`msg-time${message.turnElapsedMs == null ? " msg-time-far" : ""}`}
              title={fmtClockFull(message.createdAt)}
            >
              <span dir="ltr">{fmtClock(message.createdAt)}</span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </span>
          )}
        </div>
      )}

      {reading && (
        <Suspense fallback={null}>
          <ReadingMode message={message} onClose={() => setReading(false)} />
        </Suspense>
      )}
    </div>
  );
  },
  // Custom comparator: every streamed token rebuilds the active chat object,
  // so the parent re-renders with a fresh `chat.messages` array. Unchanged
  // messages keep their object identity (see updateMessage) and skip via the
  // fast path; the field-wise fallback also skips when the store recreates an
  // identical record. Only a real content/state change re-parses markdown.
  (prev, next) => {
    if (prev.onRetry !== next.onRetry) return false;
    if (prev.onEdit !== next.onEdit) return false;
    if (prev.editingDisabled !== next.editingDisabled) return false;
    const a = prev.message;
    const b = next.message;
    if (a === b) return true;
    return (
      a.id === b.id &&
      a.role === b.role &&
      a.content === b.content &&
      a.streaming === b.streaming &&
      a.thinking === b.thinking &&
      a.thinkingActive === b.thinkingActive &&
      a.thinkingStartedAt === b.thinkingStartedAt &&
      a.workingStartedAt === b.workingStartedAt &&
      a.turnElapsedMs === b.turnElapsedMs &&
      a.error === b.error &&
      a.retry === b.retry &&
      a.toolActivity === b.toolActivity &&
      a.segments === b.segments &&
      a.plan === b.plan &&
      a.planDoc === b.planDoc &&
      a.attachments === b.attachments &&
      a.images === b.images &&
      a.usage === b.usage &&
      a.compacted === b.compacted &&
      a.mode === b.mode &&
      a.modeSwitch === b.modeSwitch &&
      a.steerPending === b.steerPending &&
      a.steerInterleaved === b.steerInterleaved &&
      (a as { statusText?: string }).statusText === (b as { statusText?: string }).statusText &&
      (a as { lspStatus?: unknown }).lspStatus === (b as { lspStatus?: unknown }).lspStatus &&
      a.interrupted === b.interrupted
    );
  },
);
