import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";
import type { ChatMessage, ToolActivity } from "../types";
import {
  detectDir,
  fixZwsp,
  prepareContent,
  stripBidiMarks,
} from "../lib/bidi";
import { copyToClipboard } from "../lib/clipboard";
import { cancelSteer } from "../lib/api";
import { useStore } from "../lib/store";
import { getMode } from "../lib/modes";
import { splitSections } from "../lib/sections";
import { handleLinkClick } from "../lib/link";
import { sanitizeHtml } from "../lib/sanitizeHtml";
import {
  ToolCallView,
  ToolGroupView,
  ToolSingleRow,
  TraceNarration,
  isExploreCard,
} from "./ToolCallView";
import { ReadingMode } from "./ReadingMode";
import { Mermaid } from "./Mermaid";
import "highlight.js/styles/github-dark.min.css";

// Cache prepareContent per message id so re-renders with UNCHANGED content
// (dir toggles, parent re-renders that don't recreate the message, memo
// defeats) don't re-run the bidi-mark strip + ZWSP-fix passes over every
// message on every paint. The cached text is validated on each hit, so a
// STREAMING message (same id, growing content) always recomputes instead of
// showing stale text. FIFO-bounded so long sessions can't leak memory.
const preparedCache = new Map<string, { text: string; out: string }>();
const PREPARED_CACHE_MAX = 400;
function computePrepared(
  id: string,
  text: string,
  dir?: "rtl" | "ltr",
): string {
  const hit = preparedCache.get(id);
  if (hit && hit.text === text) return hit.out;
  const out = prepareContent(text, dir);
  if (preparedCache.size >= PREPARED_CACHE_MAX) {
    const oldest = preparedCache.keys().next().value;
    if (oldest !== undefined) preparedCache.delete(oldest);
  }
  preparedCache.set(id, { text, out });
  return out;
}
function cachedPrepare(id: string, text: string, dir?: "rtl" | "ltr"): string {
  if (!text) return text;
  return computePrepared(id, text, dir);
}
/** For content with no stable id (the thinking block only receives `text`):
 *  key by the text itself — prepareContent is deterministic, so equal text
 *  always yields equal output. */
function cachedPrepareText(text: string, dir?: "rtl" | "ltr"): string {
  if (!text) return text;
  return computePrepared(`t:${text}`, text, dir);
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

// Minimal HTML escaper used as a fallback when highlight.js can't process a
// snippet — keeps the raw text safe to inject via dangerouslySetInnerHTML.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Splits highlight.js output HTML into per-line HTML fragments while keeping
// any <span> that's still open at a line boundary open across the split — so
// a token that spans multiple lines (block comment, template literal,
// docstring, ...) keeps its color on every line it covers, not just the
// first. highlight.js only ever emits <span ...> / </span> tags into its
// output (text is HTML-escaped), so a simple tag-aware scan is sufficient.
function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = [];
  const openTags: string[] = [];
  let current = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "\n") {
      current += "</span>".repeat(openTags.length);
      lines.push(current);
      current = openTags.join("");
      i++;
      continue;
    }
    if (html.startsWith("<span", i)) {
      const end = html.indexOf(">", i) + 1;
      const tag = html.slice(i, end);
      openTags.push(tag);
      current += tag;
      i = end;
      continue;
    }
    if (html.startsWith("</span>", i)) {
      openTags.pop();
      current += "</span>";
      i += 7;
      continue;
    }
    current += ch;
    i++;
  }
  lines.push(current);
  return lines;
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

function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const code = textFromChildren(props.children).replace(/^\n+|\n+$/g, "");
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
  // syntax state across lines and get correct colors. The resulting HTML is then
  // split back into per-line fragments by splitHighlightedHtml, which re-opens any
  // <span> still open at a line boundary on the next line, so a token spanning
  // multiple lines keeps its color on every line, not just the first. The line
  // numbers are rendered as a VISUAL-ONLY gutter (the real file line number when
  // the fence carries `lang:start-end`, otherwise 1-based) with `user-select:
  // none`, so selecting/copying the block copies just the code, never the numbers.
  let highlightedLines: string[];
  try {
    const whole = codeLines.join("\n");
    const html =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(whole, { language: lang }).value
        : hljs.highlightAuto(whole).value;
    // highlight.js round-trips whatever the model wrote into the code block
    // (e.g. unterminated tags, stray attributes) into the highlighted HTML.
    // Sanitize the result so a malicious payload can't smuggle an event
    // handler or a javascript: URL into the chat via a code block.
    const safeHtml = sanitizeHtml(html);
    highlightedLines = splitHighlightedHtml(safeHtml);
  } catch {
    highlightedLines = codeLines.map(escapeHtml);
  }

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
        {filePath && <span className="code-block-path">{filePath}</span>}
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
}

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
    return (
      <a
        {...props}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          // Forward http(s) links to the OS browser; internal anchors keep
          // their default behaviour inside the app.
          handleLinkClick(
            e,
            props.href,
            (url) => void window.coder.openExternal(url),
          );
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
  if (!startedAt || delay <= 0) return delay;
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return Math.max(0, delay - elapsed);
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
  fallback,
  stalled,
  startedAt,
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
  fallback?: boolean;
  stalled?: boolean;
  startedAt?: number;
  onCancel?: () => void;
  onRetry?: () => void;
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
  const who = model
    ? ` — ${model}${agent ? ` (${agent})` : ""}`
    : agent
      ? ` — ${agent}`
      : "";
  // A sub-agent model hard-failed and the tool fell back to the MAIN model.
  // Distinct banner: no spinner, no retry button — the fallback already ran.
  if (fallback) {
    return (
      <div
        className="retry-banner retry-banner-fallback"
        title={reason || undefined}
      >
        <span className="retry-fallback-icon" aria-hidden>
          ⚠
        </span>
        <span>
          Sub-agent failed — using main model
          {who ? <span className="retry-who">{who}</span> : null}
          {reason ? <span className="retry-reason"> — {reason}</span> : null}
        </span>
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
  const label = gaveUp
    ? watchdog
      ? "Connection lost"
      : attempt > 1
        ? "Retry limit reached"
        : "Provider rejected the request"
    : isRateLimit
      ? "Provider rate limit"
      : unlimited
        ? "Provider rate limit"
        : "Provider hiccup";
  const suffix = gaveUp
    ? watchdog
      ? ""
      : ` (${attempt}/${maxAttempts})`
    : unlimited
      ? ` (attempt ${attempt})${countdown}`
      : ` (${attempt}/${maxAttempts})${countdown}`;
  return (
    <div className="retry-banner" title={reason || undefined}>
      {!gaveUp && <span className="spinner" />}
      <span className="retry-text">
        {label}
        {suffix}
        {who ? <span className="retry-who">{who}</span> : null}
        {reason ? <span className="retry-reason"> — {reason}</span> : null}
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
          onClick={onRetry}
          title="Retry — resumes where it stopped without redoing completed work"
        >
          Retry
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

// Only tools that write to the workspace filesystem always render as their
// own full, visible card (diff + revert) — every other tool (including
// memory/skill/connector saves) sweeps into the collapsed Claude-app-style
// trace group. Explore sub-agents are also always-visible (isExploreCard
// below) so the explorer never hides inside the collapsed group.
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
function UserMessageBubble({
  message,
  onRetry,
  className,
}: {
  message: ChatMessage;
  onRetry?: (id: string) => void;
  className?: string;
}) {
  const dir = useStore((s) => s.dir);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(message.content)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };

  return (
    <>
      <div className={`msg-bubble${className ? ` ${className}` : ""}`}>
        <div className="chat-message user-text" dir={dir}>
          {cachedPrepare(message.id, message.content, dir) || "(empty)"}
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments" dir="ltr">
            {message.attachments.map((a) => (
              <span className="attachment-chip" key={a}>
                @ {a}
              </span>
            ))}
          </div>
        )}
      </div>
      {message.content && (
        <div className="msg-actions">
          {onRetry && (
            <button
              className="msg-copy msg-retry"
              onClick={() => onRetry(message.id)}
              title="Retry"
            >
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
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          )}
          <button
            className={`msg-copy ${copied ? "copied" : ""}`}
            onClick={copy}
            title="Copy message"
          >
            {copied ? (
              <svg
                width="13"
                height="13"
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
                width="13"
                height="13"
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
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </>
  );
}

function SegSteerBubble({
  message,
  onRetry,
}: {
  message: ChatMessage;
  onRetry?: (id: string) => void;
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
      <UserMessageBubble message={message} onRetry={onRetry} />
    </div>
  );
}

/** Renders a folded context-summary message: collapsed by default (long dump
 *  of earlier turns), header toggles it open. Shared by the standalone
 *  system-message bubble (a compact between turns) and the inline `compact`
 *  segment (a compact mid-turn, spliced into the still-streaming assistant
 *  message at the point it happened — see renderSegments). */
function SummaryBlock({ message }: { message: ChatMessage }) {
  const dir = useStore((s) => s.dir);
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div className={`summary-block${collapsed ? " collapsed" : ""}`}>
      <div
        className="summary-head"
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        tabIndex={0}
      >
        <span className={`summary-chevron${collapsed ? "" : " open"}`}>
          ▶
        </span>
        <span className="summary-icon">📎</span>
        <span className="summary-label">Context summary</span>
        {collapsed && message.content && (
          <span className="summary-preview" dir="auto">
            {cachedPrepare(message.id, message.content, dir)}
          </span>
        )}
        <span className="summary-hint">
          earlier turns folded into this summary — the agent still
          receives it
        </span>
      </div>
      {!collapsed && (
        <div className="summary-body chat-message markdown-body" dir="auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {cachedPrepare(
              `${message.id}:summary`,
              message.content || "(empty summary)",
              dir,
            )}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

/** A text segment counts as a "caption" (narration the model wrote right
 *  before a tool call, e.g. "بذار ببینم X رو...") rather than real answer
 *  prose. Any text immediately preceding a groupable tool call is narration —
 *  length, line count and headings do NOT disqualify it (the old 260-char /
 *  2-line cap split one logical run into several floating groups whenever a
 *  narration ran long — the "چند تا tool group پشت هم" bug). The ONE
 *  exception: fenced code blocks — those are real content the model is
 *  showing off, never a "let me check X" line, and rendering them as a raw
 *  narration row would lose all formatting. */
function isCaptionCandidate(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("```")) return false;
  return true;
}

/** برای تست واحد export شده (الگوی filterCodeMap در CodeMapPanel): بازرسی
 *  مستقیم کلیدهای عناصر — پایداری هویت کارت trace حین استریم — بدون
 *  نیاز به render. */
export function renderSegments(
  message: ChatMessage,
  onRetry?: (id: string) => void,
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
    if (pending.length === 1) {
      // یک فراخوانی تکی: narration مدل — اگر بود — به‌صورت ردیف جدا بالای
      // همین ردیف رندر می‌شود (TraceNarration) — مثل Claude.ai که کپشنِ
      // کارِ تکی در کادر جدا بالای ردیف ابزار دیده می‌شود.
      if (captions[0]) {
        trace.push(
          <TraceNarration key={`nar-${key}`} text={captions[0]} />,
        );
      }
      const { activity } = pending[0];
      trace.push(<ToolSingleRow key={key} activity={activity} />);
    } else {
      // 2+ consecutive read-only calls collapse into ONE trace group even
      // when narrations interleave (caption, tool, caption, tool…): each
      // caption rides INSIDE the group attached to its own call — the last
      // one also becomes the head's summary title (Claude.ai style) — so
      // the run never splits into several floating groups. Pass a COPY:
      // `captions` is reused (cleared) for the next run, and React reads the
      // prop at render time — by-reference passing would hand it an empty
      // array by then.
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
      <div key={key} className="chat-message markdown-body" dir="auto">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={mdComponents}
        >
          {cachedPrepare(
            `${message.id}:seg:${key}`,
            text,
            useStore.getState().dir,
          )}
        </ReactMarkdown>
      </div>,
    );
  };

  const segs = message.segments ?? [];
  segs.forEach((seg, i) => {
    if (seg.kind === "user") {
      flush();
      wrapTrace();
      const steerMsg = useStore
        .getState()
        .chats.flatMap((c) => c.messages)
        .find((m) => m.id === seg.id);
      if (steerMsg) {
        nodes.push(
          <SegSteerBubble key={i} message={steerMsg} onRetry={onRetry} />,
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
      const summaryMsg = useStore
        .getState()
        .chats.flatMap((c) => c.messages)
        .find((m) => m.id === seg.id);
      if (summaryMsg) {
        nodes.push(<SummaryBlock key={i} message={summaryMsg} />);
      }
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
        !isExploreCard(nextActivity);

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
      renderProse(String(i), seg.text);
      return;
    }
    const activity = message.toolActivity?.[seg.index];
    if (!activity) return;
    if (ALWAYS_VISIBLE_TOOLS.has(activity.tool) || isExploreCard(activity)) {
      flush();
      wrapTrace();
      nodes.push(
        <ToolCallView
          key={i}
          activity={activity}
          onReverted={() =>
            useStore.getState().markToolReverted(message.id, seg.index)
          }
        />,
      );
    } else {
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
  return nodes;
}

export const ChatMessageView = memo(function ChatMessageView({
  message,
  onRetry,
}: {
  message: ChatMessage;
  onRetry?: (id: string) => void;
}) {
  const isUser = message.role === "user";
  const dir = useStore((s) => s.dir);
  const settings = useStore((s) => s.settings);
  const [copied, setCopied] = useState(false);

  const modeLabel = (id: string) => getMode(settings, id).label;

  const copyMessage = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(message.content)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };

  // No live token estimate while streaming: the char-based estimate overshot
  // and then "fell back down" to the real provider numbers once the usage event
  // landed, which made the badge flicker up/down during long replies. The badge
  // now appears only once real usage exists (same as the titlebar meter), so it
  // stays stable.

  const isSummary = message.role === "system" && !message.modeSwitch;
  const isModeSwitch = message.modeSwitch === true;

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

  // A steer confirmed by the backend (steer_applied) is rendered inline inside
  // the assistant message it interrupted — hide its own otherwise-bottom bubble.
  if (isUser && message.steerInterleaved) return null;

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
                key={i}
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

      {message.attachments && message.attachments.length > 0 && (
        <div className="msg-attachments" dir="ltr">
          {message.attachments.map((a) => (
            <span className="attachment-chip" key={a}>
              @ {a}
            </span>
          ))}
        </div>
      )}

      {message.images && message.images.length > 0 && (
        <div className="msg-images" dir="ltr">
          {message.images.map((img) => (
            <div className="msg-image" key={img.path} title={img.name}>
              {img.dataUrl ? (
                <img src={img.dataUrl} alt={img.name} />
              ) : (
                <span className="msg-image-ph">{img.name}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {(isSummary ||
        message.content ||
        (message.segments && message.segments.length > 0)) &&
        (isModeSwitch ? (
          <div className="mode-switch-note" dir="ltr">
            {cachedPrepare(message.id, message.content, "ltr")}
          </div>
        ) : isSummary ? (
          <SummaryBlock message={message} />
        ) : message.segments && message.segments.length > 0 ? (
          /* Claude-style interleaved rendering: text slices and tool cards follow
             each other in the exact order the agent produced them, with runs of
             2+ read-only tool calls collapsed into one summary (see renderSegments). */
          <div className="msg-bubble segmented">
            {renderSegments(message, onRetry)}
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
            <div
              className="queued-bubble-text"
              dir={detectDir(message.content)}
            >
              {cachedPrepare(message.id, message.content, dir)}
            </div>
          </div>
        ) : isUser ? (
          /* Same fixed dir as the composer (dir={dir}): dir="auto" resolved
             from the first strong char only, so a user message starting with
             a Latin word/digit (e.g. "API key رو بده") flipped to LTR and the
             72ch box hugged the LEFT side even in RTL mode. A fixed dir keeps
             the rendered bubble identical to what the user typed. */
          <UserMessageBubble message={message} onRetry={onRetry} />
        ) : (
          <div className="msg-bubble">
            <div className="chat-message markdown-body" dir="auto">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={mdComponents}
              >
                {cachedPrepare(message.id, message.content, dir)}
              </ReactMarkdown>
            </div>
          </div>
        ))}

      {!isUser && message.interrupted && (
        <div className="msg-interrupted" dir="auto">
          ⚠️ Interrupted — this reply was cut off (e.g. power loss). Send
          “continue” to resume.
        </div>
      )}

      {!isUser && (message.content || message.usage || message.streaming) && (
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
                title="Copy message"
              >
                {copied ? (
                  <svg
                    width="13"
                    height="13"
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
                    width="13"
                    height="13"
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
                {copied ? "Copied" : "Copy"}
              </button>
              {!isUser &&
                !isSummary &&
                !message.streaming &&
                sections.length >= 2 && (
                  <button
                    className="msg-copy msg-read"
                    onClick={() => setReading(true)}
                    title="Reading mode — study each section separately and ask about it"
                  >
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
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                    </svg>
                    Read
                  </button>
                )}
            </>
          )}
          {message.streaming &&
            (message.thinkingActive ? (
              <ThinkingIndicator startedAt={message.thinkingStartedAt} />
            ) : (
              <ThinkingIndicator label="Working" startedAt={message.workingStartedAt} />
            ))}
        </div>
      )}

      {reading && (
        <ReadingMode message={message} onClose={() => setReading(false)} />
      )}
    </div>
  );
});
