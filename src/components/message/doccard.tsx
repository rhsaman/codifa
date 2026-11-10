import { ensureSidecar, peekSidecarUrl } from '../../lib/api'
import { detectDir, isMostlyRtlText, prepareContent } from '../../lib/bidi'
import { copyToClipboard } from '../../lib/clipboard'
import { getHighlightedLines } from '../../lib/highlight'
import { resolveLocalMedia } from '../../lib/mediaUrl'
import { useStore } from '../../lib/store'
import { useViewerTabs } from '../../lib/viewerTabs'
import { ChartBlock } from '../ChartBlock'
import { FileChip, FileIcon, openWorkspaceFile } from '../FileIcon'
import { Mermaid } from '../Mermaid'
import { ReactNode, lazy, memo, useMemo, useRef, useState } from 'react'

export function PlanDocCard({
  planDoc,
  messageId,
}: {
  planDoc: { title: string; body: string };
  /** Owning message: the card's plan belongs to ITS chat, which is not always
   *  the focused chat (several chat windows can be open at once). */
  messageId?: string;
}) {
  const [copied, setCopied] = useState(false);
  // Direction follows the plan body's own language (see detectDir).
  const appDir = detectDir(planDoc.body);
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
    return prepareContent(clipped);
  }, [planDoc.body]);
  const openFullPlan = () => {
    const st = useStore.getState();
    // The plan belongs to the message's OWN chat. The window's focus handler
    // runs AFTER this click, so without resolving the owner first a card in a
    // background chat window opened the already-focused chat's plan.
    const owner = messageId
      ? st.chats.find((c) => c.messages.some((m) => m.id === messageId))
      : undefined;
    if (owner && st.activeChatId !== owner.id) st.focusWindow(owner.id);
    useViewerTabs.getState().openPlan(owner?.id);
  };
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
        onClick={openFullPlan}
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

export function textFromChildren(node: ReactNode): string {
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
export function openExternalPreferred(url: string): void {
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

export function codeLang(children: ReactNode): string {
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
export function codeStartLine(children: ReactNode): number {
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

export function codeFilePath(children: ReactNode): string {
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


export const CodeBlock = memo(function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
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
  // Runs for EVERY branch: the early returns below sit after this hook, so a
  // fence that flips branch mid-stream (lang arriving late, Persian filling in)
  // keeps the hook order stable across renders.
  const highlightedLines = useMemo(
    () => getHighlightedLines(codeLines.join("\n"), lang),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, lang],
  );

  // A fence the model left UNNAMED (or ```text) whose content is mostly
  // Persian is not code — it is prose or column-aligned data (price levels,
  // small tables) the model fenced to preserve spacing. Rendering that as an
  // LTR highlighted code block scrambles the bidi order, gets hljs keywords
  // "highlighted" mid-sentence, and stretches the script in monospace, so
  // render it as plain, per-line direction-aware text instead. A NAMED fence
  // (```python …) always stays code, even with Persian comments inside.
  if ((!lang || lang === "text") && isMostlyRtlText(code)) {
    return <pre dir="auto" className="plain-fence">{code}</pre>;
  }

  // A ```mermaid fenced block is rendered as a live diagram, not as code.
  if (lang === "mermaid") {
    return <Mermaid chart={code} />;
  }

  // A ```chart fenced block (JSON spec) renders as a real chart — bars, line,
  // pie — like ChatGPT's inline charts. Streaming-safe: an incomplete/unparsable
  // body falls back to the raw source until it parses (ChartBlock).
  if (lang === "chart") {
    return <ChartBlock spec={code} />;
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
        {filePath && (
          <span
            className="code-block-path code-block-path-open"
            title={`Open ${filePath}`}
            // pointerdown, not click: a chat refocus re-render can replace the
            // node before `click` fires, swallowing the open (see FileChip).
            onPointerDown={() => openWorkspaceFile(filePath)}
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

export function _ytId(u: URL): string | null {
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

export function _vimeoId(u: URL): string | null {
  if (u.hostname !== "vimeo.com" && u.hostname !== "player.vimeo.com") return null;
  return /\/video\/(\d+)/.exec(u.pathname)?.[1]
    ?? /^\/(\d+)/.exec(u.pathname)?.[1]
    ?? null;
}

export function extractVideoEmbed(href: string): VideoEmbed | null {
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
// `codifa-media://` sources (and bare `media/...` paths the model writes by
// hand) resolve to the local /media/file route; a VIDEO extension renders an
// inline player instead of a broken <img>. Local media is CENTERED and carries
// an edit affordance: clicking the media (or the pencil) opens the Media
// editor in the right-hand viewer.

/** Pencil-in-square glyph for the edit affordance — a stroke icon matching the
 *  app's other chrome icons, deliberately NOT an emoji. */
export const EDIT_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);

export function MarkdownImage({
  src,
  alt,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [errored, setErrored] = useState(false);
  // The sidecar URL resolves ASYNCHRONOUSLY (and is unknown right after an app
  // restart, when persisted history renders before any request ran). A media
  // source that failed for that reason must RETRY once the backend is known —
  // a memo over a non-reactive peek would otherwise stick on the broken
  // fallback forever.
  const [retryTick, setRetryTick] = useState(0);
  const retriesLeft = useRef(3);
  const resolved = useMemo(
    () => resolveLocalMedia(src, peekSidecarUrl()),
    // retryTick forces the re-resolve after ensureSidecar() succeeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the tick IS the signal
    [src, retryTick],
  );
  const retryOrError = () => {
    const isLocalMedia = Boolean(resolveLocalMedia(src, "http://retry-probe.invalid"));
    if (isLocalMedia && retriesLeft.current > 0) {
      retriesLeft.current -= 1;
      void ensureSidecar().then((url) => {
        if (url) setRetryTick((t) => t + 1);
        else setErrored(true);
      });
      return;
    }
    setErrored(true);
  };

  if (resolved?.video) {
    if (errored) {
      return (
        <span className="md-image-wrap md-image-errored">
          <span className="md-image-fallback">🎬 {alt || "Video unavailable"}</span>
        </span>
      );
    }
    return (
      <span className="md-image-wrap md-media-wrap">
        <video
          className="md-video-inline"
          src={resolved.url}
          controls
          preload="metadata"
          onError={retryOrError}
        />
        <button
          type="button"
          className="md-media-edit"
          title="Open in the Media editor"
          onClick={() => useViewerTabs.getState().openMedia(resolved.path)}
        >
          {EDIT_ICON}
        </button>
      </span>
    );
  }

  const effectiveSrc = resolved?.url ?? src;
  if (!effectiveSrc || errored) {
    return (
      <span className="md-image-wrap md-image-errored">
        <span className="md-image-fallback">
          🖼️ {alt || "Image unavailable"}
        </span>
      </span>
    );
  }

  return (
    <span className={`md-image-wrap${resolved ? " md-media-wrap" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- markdown inline image */}
      <img
        src={effectiveSrc}
        alt={alt ?? ""}
        loading="lazy"
        onClick={
          resolved
            ? () => useViewerTabs.getState().openMedia(resolved.path)
            : undefined
        }
        style={resolved ? { cursor: "pointer" } : undefined}
        onError={retryOrError}
        {...props}
      />
      {resolved && (
        <button
          type="button"
          className="md-media-edit"
          title="Open in the Media editor"
          onClick={(e) => {
            e.stopPropagation();
            useViewerTabs.getState().openMedia(resolved.path);
          }}
        >
          {EDIT_ICON}
        </button>
      )}
      {alt ? <span className="md-image-caption">{alt}</span> : null}
    </span>
  );
}

// ── Video thumbnail card ──────────────────────────────────────────────────
// Shows a clickable YouTube/Vimeo thumbnail with a play overlay.
// Clicking opens the video in the system browser — more reliable than
// iframe embeds, which YouTube blocks from Electron origins.

export function VideoThumbnailCard({
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
