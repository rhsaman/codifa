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
 *  text-extracting parents still read only the file name). Heavy sans-serif
 *  so letter tiles read like the official TS/JS/Go marks, not code. */
function Monogram({ label, color }: { label: string; color: string }) {
  const fontSize =
    label.length === 1 ? 11.5 : label.length <= 2 ? 9.2 : label.length === 3 ? 7.2 : 5.8;
  return (
    <text
      x="12"
      y="12.6"
      textAnchor="middle"
      dominantBaseline="central"
      fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
      fontSize={fontSize}
      fontWeight="800"
      letterSpacing="0.01em"
      fill={color}
    >
      {label}
    </text>
  );
}

/** React logo (tsx/jsx): the three-orbit atom on a transparent background,
 *  in the official cyan — reads as the real brand mark, not a letter tile. */
function ReactIcon({ size }: { size: number }) {
  return (
    <svg className="file-icon-svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="#61dafb" strokeWidth="1.5">
        <ellipse cx="12" cy="12" rx="9.4" ry="3.7" />
        <ellipse cx="12" cy="12" rx="9.4" ry="3.7" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9.4" ry="3.7" transform="rotate(-60 12 12)" />
      </g>
      <circle cx="12" cy="12" r="1.9" fill="#61dafb" />
    </svg>
  );
}

/** Python logo (py/pyi): the two interlocked snakes of the official mark
 *  (paths from the MIT-licensed devicon set, drawn in their own 128 grid). */
const PYTHON_BLUE =
  "M63.391 1.988c-4.222.02-8.252.379-11.8 1.007-10.45 1.846-12.346 5.71-12.346 12.837v9.411h24.693v3.137H29.977c-7.176 0-13.46 4.313-15.426 12.521-2.268 9.405-2.368 15.275 0 25.096 1.755 7.311 5.947 12.519 13.124 12.519h8.491V67.234c0-8.151 7.051-15.34 15.426-15.34h24.665c6.866 0 12.346-5.654 12.346-12.548V15.833c0-6.693-5.646-11.72-12.346-12.837-4.244-.706-8.645-1.027-12.84-1.008zM50.037 9.557c2.55 0 4.634 2.117 4.634 4.721 0 2.593-2.083 4.69-4.634 4.69-2.56 0-4.633-2.097-4.633-4.69-.001-2.604 2.073-4.721 4.633-4.721z";
const PYTHON_YELLOW =
  "M91.682 28.38v10.966c0 8.5-7.208 15.655-15.426 15.655H51.591c-6.756 0-12.346 5.783-12.346 12.549v23.515c0 6.691 5.818 10.628 12.346 12.547 7.816 2.297 15.312 2.713 24.665 0 6.216-1.801 12.346-5.423 12.346-12.547v-9.412H63.938v-3.138h37.012c7.176 0 9.852-5.005 12.348-12.519 2.578-7.735 2.467-15.174 0-25.096-1.774-7.145-5.161-12.521-12.348-12.521h-9.268zM77.809 87.927c2.561 0 4.634 2.097 4.634 4.692 0 2.602-2.074 4.719-4.634 4.719-2.55 0-4.633-2.117-4.633-4.719 0-2.595 2.083-4.692 4.633-4.692z";

function PythonIcon({ size }: { size: number }) {
  return (
    <svg className="file-icon-svg" width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <path d={PYTHON_BLUE} fill="#3776ab" />
      <path d={PYTHON_YELLOW} fill="#ffd43b" />
    </svg>
  );
}

/** Markdown (md/mdx/markdown): the official "M↓" mark on the blue tile. */
function MarkdownIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#083fa1">
      <g stroke="#ffffff" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5.4 15.8V8.2l3 3.5 3-3.5v7.6" />
        <path d="M17 8.2v7.4M14.5 13.4l2.5 2.6 2.5-2.6" />
      </g>
    </Tile>
  );
}

/** Shared white shield with a tile-colored numeral behind it — the CSS3/HTML5
 *  badge language, kept inside the squircle tile family. */
function ShieldMonogram({ size, fill, numeral, textColor }: { size: number; fill: string; numeral: string; textColor: string }) {
  return (
    <Tile size={size} fill={fill}>
      <path d="M6.4 5.4h11.2l-1 11.6L12 18.8l-4.6-1.8z" fill="#ffffff" opacity="0.96" />
      <text
        x="12"
        y="13"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        fontSize="9"
        fontWeight="700"
        fill={textColor}
      >
        {numeral}
      </text>
    </Tile>
  );
}

/** Shell scripts (sh/bash/zsh/fish): a prompt glyph on the green tile. */
function ShellIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#89e051">
      <g stroke="#1e3b0d" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7.2 8.4l3.6 3.6-3.6 3.6" />
        <path d="M12.6 15.6h4.2" />
      </g>
    </Tile>
  );
}

/** JSON: mirrored curly braces, dark on the straw tile. */
function JsonIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#cbcb41">
      <g stroke="#3b3106" strokeWidth="1.6" fill="none" strokeLinecap="round">
        <path d="M11.2 6.8c-1.6 0-2.4.8-2.4 2.2v1.2c0 1-.6 1.6-1.7 1.8 1.1.2 1.7.8 1.7 1.8v1.2c0 1.4.8 2.2 2.4 2.2" />
        <path d="M12.8 6.8c1.6 0 2.4.8 2.4 2.2v1.2c0 1 .6 1.6 1.7 1.8-1.1.2-1.7.8-1.7 1.8v1.2c0 1.4-.8 2.2-2.4 2.2" />
      </g>
    </Tile>
  );
}

/** SQL: a database cylinder on the amber tile. */
function SqlIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#e38c00">
      <g stroke="#ffffff" strokeWidth="1.6" fill="none" strokeLinecap="round">
        <ellipse cx="12" cy="7.6" rx="6" ry="2.4" />
        <path d="M6 7.6v8.8c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V7.6" />
        <path d="M6 12c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4" opacity="0.65" />
      </g>
    </Tile>
  );
}

/** Ruby: a faceted gem on the red tile. */
function RubyIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#9b1111">
      <path d="M7.2 8h9.6l3 4-7.8 7.4L4.2 12z" fill="#ffffff" opacity="0.95" />
      <g stroke="#9b1111" strokeWidth="1.1" fill="none" strokeLinejoin="round">
        <path d="M4.2 12h15.6" />
        <path d="M7.2 8l2.3 4 2.5-4 2.5 4 2.3-4" />
        <path d="M9.5 12L12 19.4l2.5-7.4" />
      </g>
    </Tile>
  );
}

/** PHP: the official purple oval with the italic wordmark. */
function PhpIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#4f5d95">
      <ellipse cx="12" cy="12" rx="8.4" ry="4.7" fill="#ffffff" opacity="0.95" />
      <text
        x="12"
        y="12.6"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
        fontSize="5.4"
        fontWeight="800"
        fontStyle="italic"
        fill="#4f5d95"
      >
        php
      </text>
    </Tile>
  );
}

/** Java: the coffee cup on the official blue. */
function JavaIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#5382a1">
      <path
        d="M6.8 10.2h8.4v3.4a3.5 3.5 0 0 1-3.5 3.5h-1.4a3.5 3.5 0 0 1-3.5-3.5z"
        fill="#ffffff"
        opacity="0.95"
      />
      <path
        d="M15.4 11h1.2a2 2 0 0 1 0 4h-1.6"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <g fill="none" stroke="#ffffff" strokeWidth="1.4" strokeLinecap="round">
        <path d="M9.4 5.2c0 1.1.9 1.3.9 2.4" />
        <path d="M12.6 5.2c0 1.1.9 1.3.9 2.4" />
      </g>
    </Tile>
  );
}

/** Kotlin: the diagonal split mark, drawn transparent like the real logo. */
function KotlinIcon({ size }: { size: number }) {
  return (
    <svg className="file-icon-svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.4 3.4h17.2v17.2H3.4z" fill="#a855f7" />
      <path d="M20.6 3.4L3.4 20.6h17.2z" fill="#f97316" />
    </svg>
  );
}

/** Lua: the crescent moon and its orbit dot on the navy tile. */
function LuaIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#000080">
      <circle cx="12" cy="12.2" r="6.6" fill="#ffffff" opacity="0.95" />
      <circle cx="14.1" cy="10.1" r="6.6" fill="#000080" />
      <circle cx="17.4" cy="6.6" r="1.5" fill="#ffffff" />
    </Tile>
  );
}

/** Shared gear glyph: ring + eight teeth, optional center letter. Used for
 *  Rust (with the R) and binary formats (no letter). */
function GearGlyph({ size, fill, letter, letterColor }: { size: number; fill: string; letter?: string; letterColor?: string }) {
  const teeth = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <Tile size={size} fill={fill}>
      <circle cx="12" cy="12" r="6.4" fill="none" stroke="#ffffff" strokeWidth="1.7" opacity="0.95" />
      {teeth.map((deg) => (
        <rect
          key={deg}
          x="11.15"
          y="2.6"
          width="1.7"
          height="3"
          rx="0.7"
          fill="#ffffff"
          opacity="0.95"
          transform={`rotate(${deg} 12 12)`}
        />
      ))}
      {letter ? <Monogram label={letter} color={letterColor ?? "#57330f"} /> : null}
    </Tile>
  );
}

/** Vue: the nested green/dark chevrons, transparent like the real mark. */
function VueIcon({ size }: { size: number }) {
  return (
    <svg className="file-icon-svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.4 4.4h4.9L12 12.2l4.7-7.8h4.9L12 21.2z" fill="#41b883" />
      <path d="M7.3 4.4h2.6L12 8l2.1-3.6h2.6L12 13.1z" fill="#35495e" />
    </svg>
  );
}

/** GraphQL: the pink hexagon with node dots, transparent like the real mark. */
function GraphqlIcon({ size }: { size: number }) {
  return (
    <svg className="file-icon-svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 5.2l5.9 3.4v6.8L12 18.8l-5.9-3.4V8.6z"
        fill="none"
        stroke="#e10098"
        strokeWidth="1.4"
      />
      <g fill="#e10098">
        <circle cx="12" cy="5.2" r="1.5" />
        <circle cx="17.9" cy="8.6" r="1.5" />
        <circle cx="17.9" cy="15.4" r="1.5" />
        <circle cx="12" cy="18.8" r="1.5" />
        <circle cx="6.1" cy="15.4" r="1.5" />
        <circle cx="6.1" cy="8.6" r="1.5" />
      </g>
    </svg>
  );
}

/** Elixir: the drop on the purple tile. */
function ElixirIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#6e4a7e">
      <path
        d="M12 3.8c2.5 3.2 5 6.1 5 9.3a5 5 0 0 1-10 0c0-3.2 2.5-6.1 5-9.3z"
        fill="#c79fe0"
      />
    </Tile>
  );
}

/** CSV/TSV: a data table grid on the green tile. */
function CsvIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#0f9d58">
      <g stroke="#ffffff" strokeWidth="1.5" fill="none" strokeLinecap="round">
        <rect x="5" y="6" width="14" height="12" rx="1.6" />
        <path d="M5 10.1h14M10.3 6v12" opacity="0.9" />
      </g>
    </Tile>
  );
}

/** Archives: a box with the zipper line on the straw tile. */
function ZipIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#b98a3f">
      <rect x="6.6" y="4.2" width="10.8" height="15.6" rx="1.8" fill="none" stroke="#ffffff" strokeWidth="1.5" opacity="0.95" />
      <path d="M12 5.6v12.8" stroke="#ffffff" strokeWidth="1.6" strokeDasharray="2.1 1.9" strokeLinecap="round" />
    </Tile>
  );
}

/** Android packages: the robot head on the green tile. */
function AndroidIcon({ size }: { size: number }) {
  return (
    <Tile size={size} fill="#3ddc84">
      <path d="M5.9 14.6a6.1 6.1 0 0 1 12.2 0z" fill="#ffffff" opacity="0.95" />
      <g stroke="#ffffff" strokeWidth="1.4" strokeLinecap="round">
        <path d="M8.3 6.4L7 4.4" />
        <path d="M15.7 6.4L17 4.4" />
      </g>
      <circle cx="9.6" cy="12" r="0.85" fill="#3ddc84" />
      <circle cx="14.4" cy="12" r="0.85" fill="#3ddc84" />
    </Tile>
  );
}

function PictureIcon({ size }: { size: number }) {  return (
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
  return <ShieldMonogram size={size} fill="#e34f26" numeral="5" textColor="#e34f26" />;
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
  // Extension-less well-known build files ("Dockerfile", "Makefile") map by
  // their whole basename.
  const lowerBase = base.toLowerCase();
  const badge =
    FILE_BADGES[ext] ??
    (lowerBase in FILE_BADGES ? FILE_BADGES[lowerBase] : undefined);
  if (ext === "tsx" || ext === "jsx") return <ReactIcon size={size} />;
  if (ext === "py" || ext === "pyi") return <PythonIcon size={size} />;
  if (ext === "md" || ext === "markdown" || ext === "mdx") return <MarkdownIcon size={size} />;
  if (ext === "css") return <ShieldMonogram size={size} fill="#264de4" numeral="3" textColor="#264de4" />;
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "fish") return <ShellIcon size={size} />;
  if (ext === "json" || ext === "jsonc") return <JsonIcon size={size} />;
  if (ext === "sql") return <SqlIcon size={size} />;
  if (ext === "rb") return <RubyIcon size={size} />;
  if (ext === "php") return <PhpIcon size={size} />;
  if (ext === "java" || ext === "jar" || ext === "war") return <JavaIcon size={size} />;
  if (ext === "kt") return <KotlinIcon size={size} />;
  if (ext === "lua") return <LuaIcon size={size} />;
  if (ext === "rs") return <GearGlyph size={size} fill="#dea584" letter="R" />;
  if (ext === "vue") return <VueIcon size={size} />;
  if (ext === "graphql" || ext === "gql") return <GraphqlIcon size={size} />;
  if (ext === "ex" || ext === "exs") return <ElixirIcon size={size} />;
  if (ext === "csv" || ext === "tsv") return <CsvIcon size={size} />;
  if (ext === "zip" || ext === "tar" || ext === "gz" || ext === "bz2" || ext === "xz" || ext === "7z" || ext === "rar") return <ZipIcon size={size} />;
  if (ext === "apk" || ext === "aab") return <AndroidIcon size={size} />;
  if (ext === "dylib" || ext === "so" || ext === "dll" || ext === "exe" || ext === "bin") return <GearGlyph size={size} fill="#6b7280" />;
  if (ext === "wasm") return <GearGlyph size={size} fill="#654ff0" letter="W" letterColor="#ffffff" />;
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
  let clean = path.trim();
  if (!clean) return;
  // Message-text chips often carry the line inside the path ("store.ts:42")
  // — split it off so the viewer resolves the real file instead of missing
  // it with "No file exists at this path".
  if (line === undefined) {
    const m = clean.match(/^(.+\.[A-Za-z0-9]+):(\d+)$/);
    if (m) {
      clean = m[1];
      line = Number(m[2]);
    }
  }
  try {
    window.dispatchEvent(
      new CustomEvent("coder:open-file", { detail: { path: clean, line } }),
    );
  } catch {
    /* non-DOM environment (tests) */
  }
  const st = useStore.getState();
  const root = st.chats.find((c) => c.id === st.activeChatId)?.root ?? st.root;
  // Absolute paths must reach the viewer AS-IS: FileViewerPanel reads them
  // as (dir, basename) with their own containment — joining them with the
  // workspace root here produced "root/Users/..." which never exists.
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
      <FileIcon path={path} size={20} />
      <span className="file-chip-name" dir="ltr">
        {label}
      </span>
    </button>
  );
}
