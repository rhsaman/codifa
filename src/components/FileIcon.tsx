import type { MouseEvent as ReactMouseEvent } from "react";
import { useStore } from "../lib/store";
import { useViewerTabs } from "../lib/viewerTabs";
import {
  AUDIO_EXTS,
  FILE_BADGES,
  IMAGE_EXTS,
  VIDEO_EXTS,
  fileBasename,
} from "../lib/fileTypes";

/** Shared squircle tile behind every file badge: solid extension color with
 *  a hairline dark edge plus a faint inner light edge, so the whole set
 *  reads as one family on dark themes. Flat fills only (no gradient defs),
 *  so repeated icons never collide on SVG ids and SSR output stays stable. */
function Tile({
  size,
  fill,
  children,
}: {
  size: number;
  fill: string;
  children: React.ReactNode;
}) {
  return (
    <svg
      className="file-icon-svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect
        x="2"
        y="2"
        width="20"
        height="20"
        rx="6"
        fill={fill}
        stroke="rgba(0,0,0,0.32)"
        strokeWidth="1"
      />
      <rect
        x="3"
        y="3"
        width="18"
        height="9"
        rx="4"
        fill="#ffffff"
        opacity="0.10"
      />
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="5.5"
        fill="none"
        stroke="rgba(255,255,255,0.14)"
        strokeWidth="1"
      />
      {children}
    </svg>
  );
}

/** Centered extension monogram drawn as SVG text (never a DOM text node, so
 *  text-extracting parents still read only the file name). */
function Monogram({ label, color }: { label: string; color: string }) {
  const fontSize =
    label.length === 1 ? 11 : label.length <= 2 ? 8.5 : label.length === 3 ? 7 : 5.8;
  return (
    <text
      x="12"
      y="12.6"
      textAnchor="middle"
      dominantBaseline="central"
      fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
      fontSize={fontSize}
      fontWeight="700"
      letterSpacing="0.02em"
      fill={color}
    >
      {label}
    </text>
  );
}

function PictureIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#a074c4">
      <circle cx="9.3" cy="9.6" r="1.7" fill="#ffffff" opacity="0.95" />
      <path
        d="M5.5 16.8l4.6-5 3.1 3.2 2.5-2.4 3.8 4.2z"
        fill="#ffffff"
        opacity="0.92"
      />
    </Tile>
  );
}

function AudioIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#2aa895">
      <path
        d="M10 16.8V8.2l7.5-1.6v8.2"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.95"
      />
      <circle cx="7.8" cy="16.8" r="2.1" fill="#ffffff" />
      <circle cx="15.3" cy="14.8" r="2.1" fill="#ffffff" />
    </Tile>
  );
}

function VideoIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#9b4ab8">
      <rect
        x="5.2"
        y="7.5"
        width="9.3"
        height="9"
        rx="2.2"
        fill="rgba(255,255,255,0.28)"
      />
      <path d="M8.4 10.3l3.8 2.2-3.8 2.2z" fill="#ffffff" />
      <path d="M14.8 10.5l4.2-2.5v8l-4.2-2.5z" fill="#ffffff" opacity="0.95" />
    </Tile>
  );
}

/** HTML keeps the orange tile language but joins the tile family instead of
 *  using a one-off shield shape. */
function Html5Icon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#e34f26">
      <Monogram label="5" color="#ffffff" />
    </Tile>
  );
}

/** Neutral outline document for extensions without a badge or glyph. */
function GenericIcon({ size }: { size: number }) {
  return (
    <svg
      className="file-icon-svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M6.5 3h6.8L18 7.7V20a1.6 1.6 0 0 1-1.6 1.6H6.5A1.6 1.6 0 0 1 4.9 20V4.6A1.6 1.6 0 0 1 6.5 3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ opacity: 0.65 }}
      />
      <path
        d="M13.3 3v4.7H18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        style={{ opacity: 0.65 }}
      />
      <path
        d="M8 12.5h8M8 15.5h5.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        style={{ opacity: 0.4 }}
      />
    </svg>
  );
}

/** Tinted squircle tile with the extension monogram (fits the label into
 *  the tile, shrinking for longer codes). */
function BadgeIcon({
  label,
  bg,
  fg,
  size,
}: {
  label: string;
  bg: string;
  fg: string;
  size: number;
}) {
  return (
    <Tile size={size} fill={bg}>
      <Monogram label={label} color={fg} />
    </Tile>
  );
}

/** High-quality file-type icon: a tinted tile with the extension monogram,
 *  or a glyph tile for media / HTML. No DOM text node is emitted, so
 *  text-extracting parents (CodeBlock over markdown children) still read
 *  only the file name. */
export function FileIcon({
  path,
  size = 16,
}: {
  path: string;
  size?: number;
}) {
  const base = fileBasename(path);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 || base.startsWith(".") ? base.slice(dot + 1).toLowerCase() : "";
  const badge = FILE_BADGES[ext];
  if (ext === "html" || ext === "htm") return <Html5Icon size={size} />;
  if (IMAGE_EXTS.has(ext)) return <PictureIcon size={size} />;
  if (AUDIO_EXTS.has(ext)) return <AudioIcon size={size} />;
  if (VIDEO_EXTS.has(ext)) return <VideoIcon size={size} />;
  if (badge) {
    return <BadgeIcon label={badge.label} bg={badge.bg} fg={badge.fg} size={size} />;
  }
  return <GenericIcon size={size} />;
}

/** Open a workspace file in a dedicated viewer tab (one tab per path). Also
 *  dispatches the historical `coder:open-file` CustomEvent so future
 *  listeners (e.g. an external editor hook) keep working. */
export function openWorkspaceFile(path: string, line?: number): void {
  const clean = path.trim();
  if (!clean) return;
  try {
    window.dispatchEvent(
      new CustomEvent("coder:open-file", { detail: { path: clean, line } }),
    );
  } catch {
    /* non-DOM environment (tests) */
  }
  const st = useStore.getState();
  const root = st.chats.find((c) => c.id === st.activeChatId)?.root ?? st.root;
  useViewerTabs.getState().openFile(clean, line, root);
}

/** The clickable form of a file reference: type icon + name, in the style of
 *  editor file chips. The icon is ALWAYS on the left of the path, in both RTL
 *  and LTR contexts (the button forces dir=ltr). Clicking opens the file (at
 *  `line` when given) in the viewer group. Used by chat inline code,
 *  code-block headers and grep/glob result rows. */
export function FileChip({
  path,
  line,
  display,
  className,
  onClick,
}: {
  path: string;
  line?: number;
  /** Label to show (defaults to the path as written). */
  display?: string;
  className?: string;
  /** Extra click behavior; the file open always runs and event bubbling is
   *  stopped so dense rows (tool cards, accordions) don't also toggle. */
  onClick?: () => void;
}) {
  const handle = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onClick?.();
    openWorkspaceFile(path, line);
  };
  const label = display ?? path;
  return (
    <button
      type="button"
      className={`file-chip${className ? ` ${className}` : ""}`}
      dir="ltr"
      title={`${path}${line ? `:${line}` : ""} — click to open`}
      onClick={handle}
    >
      <FileIcon path={path} size={18} />
      <span className="file-chip-name" dir="ltr">
        {label}
      </span>
    </button>
  );
}
