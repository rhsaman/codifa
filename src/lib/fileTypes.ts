// Pure file-type helpers shared by every surface that shows a file name
// (chat chips, tool rows, viewer tabs, diff list, code map). No store or
// React imports here so plain-node tests can load this module directly.

/** Marks stripped before inspecting user/model text (bidi isolation marks,
 *  zero-width chars and BOM would otherwise break extension detection). */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Extensions that render as a colored letter badge. Keys double as the
 *  `looksLikeFilePath` whitelist — anything outside the list stays a plain
 *  `code` span so prose like "v1.2" or "e.g" never turns into a chip. */
export const FILE_BADGES: Record<string, { label: string; bg: string; fg: string }> = {
  js: { label: "JS", bg: "#f1e05a", fg: "#3b3106" },
  cjs: { label: "JS", bg: "#f1e05a", fg: "#3b3106" },
  mjs: { label: "JS", bg: "#f1e05a", fg: "#3b3106" },
  jsx: { label: "JSX", bg: "#f1e05a", fg: "#3b3106" },
  ts: { label: "TS", bg: "#3178c6", fg: "#ffffff" },
  mts: { label: "TS", bg: "#3178c6", fg: "#ffffff" },
  cts: { label: "TS", bg: "#3178c6", fg: "#ffffff" },
  tsx: { label: "TSX", bg: "#3178c6", fg: "#ffffff" },
  json: { label: "{}", bg: "#cbcb41", fg: "#3b3106" },
  jsonc: { label: "{}", bg: "#cbcb41", fg: "#3b3106" },
  html: { label: "5", bg: "#e34f26", fg: "#ffffff" },
  htm: { label: "5", bg: "#e34f26", fg: "#ffffff" },
  css: { label: "CSS", bg: "#264de4", fg: "#ffffff" },
  scss: { label: "SCSS", bg: "#c6538c", fg: "#ffffff" },
  sass: { label: "SASS", bg: "#c6538c", fg: "#ffffff" },
  less: { label: "LESS", bg: "#2b5e9d", fg: "#ffffff" },
  md: { label: "MD", bg: "#083fa1", fg: "#ffffff" },
  markdown: { label: "MD", bg: "#083fa1", fg: "#ffffff" },
  mdx: { label: "MDX", bg: "#083fa1", fg: "#ffffff" },
  py: { label: "PY", bg: "#3572a5", fg: "#ffffff" },
  pyi: { label: "PY", bg: "#3572a5", fg: "#ffffff" },
  rs: { label: "RS", bg: "#dea584", fg: "#57330f" },
  go: { label: "GO", bg: "#00add8", fg: "#ffffff" },
  rb: { label: "RB", bg: "#701516", fg: "#ffffff" },
  java: { label: "JAVA", bg: "#b07219", fg: "#ffffff" },
  kt: { label: "KT", bg: "#a97bff", fg: "#241536" },
  swift: { label: "SWIFT", bg: "#f05138", fg: "#ffffff" },
  c: { label: "C", bg: "#555555", fg: "#ffffff" },
  h: { label: "H", bg: "#777777", fg: "#ffffff" },
  cpp: { label: "C++", bg: "#f34b7d", fg: "#ffffff" },
  cc: { label: "C++", bg: "#f34b7d", fg: "#ffffff" },
  hpp: { label: "HPP", bg: "#f34b7d", fg: "#ffffff" },
  cs: { label: "C#", bg: "#178600", fg: "#ffffff" },
  php: { label: "PHP", bg: "#4f5d95", fg: "#ffffff" },
  lua: { label: "LUA", bg: "#000080", fg: "#ffffff" },
  sh: { label: "SH", bg: "#89e051", fg: "#1e3b0d" },
  bash: { label: "SH", bg: "#89e051", fg: "#1e3b0d" },
  zsh: { label: "SH", bg: "#89e051", fg: "#1e3b0d" },
  fish: { label: "SH", bg: "#89e051", fg: "#1e3b0d" },
  ps1: { label: "PS", bg: "#012456", fg: "#ffffff" },
  sql: { label: "SQL", bg: "#e38c00", fg: "#ffffff" },
  yml: { label: "YML", bg: "#cb171e", fg: "#ffffff" },
  yaml: { label: "YML", bg: "#cb171e", fg: "#ffffff" },
  toml: { label: "TOML", bg: "#9c4221", fg: "#ffffff" },
  ini: { label: "INI", bg: "#8d8d8d", fg: "#ffffff" },
  env: { label: "ENV", bg: "#8d8d8d", fg: "#ffffff" },
  txt: { label: "TXT", bg: "#9e9e9e", fg: "#26221e" },
  pdf: { label: "PDF", bg: "#d0021b", fg: "#ffffff" },
  svg: { label: "SVG", bg: "#ffb13b", fg: "#57330f" },
  lock: { label: "LOCK", bg: "#7c7c7c", fg: "#ffffff" },
};

/** Extensions that render as a small glyph instead of a letter badge. */
export const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "heic",
]);
export const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"]);
export const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi"]);

/** Accent hues for the media glyph tiles (previously solid fills, now used
 *  only as a tile tint + glyph source so they stay quiet on any theme). */
const IMAGE_ACCENT = "#a074c4";
const AUDIO_ACCENT = "#2aa895";
const VIDEO_ACCENT = "#9b4ab8";

/** File-icon rendering kind: `badge` shows the extension monogram on a
 *  tinted tile, media kinds show an outline glyph, `generic` is neutral. */
export type FileIconKind = "badge" | "image" | "audio" | "video" | "generic";

/** Resolved icon spec for a path: monogram label + accent hue + glyph kind.
 *  Pure (no React) so plain-node tests can cover the mapping. */
export interface FileIconSpec {
  kind: FileIconKind;
  /** Monogram shown on badge tiles ("" for glyph/neutral kinds). */
  label: string;
  /** Accent hue for the tile tint + glyph ("" = neutral, derived from text). */
  accent: string;
}

/** Map a path to its file-icon spec (extension lookup + media sets). */
export function fileIconSpec(path: string): FileIconSpec {
  const ext = extOf(path);
  if (IMAGE_EXTS.has(ext)) return { kind: "image", label: "", accent: IMAGE_ACCENT };
  if (AUDIO_EXTS.has(ext)) return { kind: "audio", label: "", accent: AUDIO_ACCENT };
  if (VIDEO_EXTS.has(ext)) return { kind: "video", label: "", accent: VIDEO_ACCENT };
  const badge = FILE_BADGES[ext];
  if (badge) return { kind: "badge", label: badge.label, accent: badge.bg };
  return { kind: "generic", label: "", accent: "" };
}

const WHITELIST_EXTRA = new Set([
  "gitignore", "gitattributes", "editorconfig", "npmrc", "nvmrc", "babelrc",
  "prettierrc", "eslintrc", "dockerfile", "makefile", "cmake", "gradle",
  "ipynb", "proto", "graphql", "gql", "vue", "svelte", "astro", "dart",
  "ex", "exs", "erl", "hs", "clj", "cljs", "fs", "fsi", "vb", "pl", "pm",
  "r", "jl", "tcl", "bat", "cmd", "mk", "patch", "diff", "log", "csv",
  "tsv", "rst", "adoc", "tex", "sty", "cfg", "conf", "properties", "plist",
  "aab", "apk", "jar", "war", "dylib", "so", "dll", "exe", "bin", "wasm",
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "doc", "docx", "xls",
  "xlsx", "ppt", "pptx", "ttf", "otf", "woff", "woff2",
]);

/** Extension of a path's basename, lowercased ("" when there is none).
 *  Dotfiles like ".gitignore" count — their whole name is the extension. */
export function extOf(path: string): string {
  const base = path
    .replace(INVISIBLE, "")
    .trim()
    .replace(/[.,;:)\]}'"`]+$/, "");
  const name = base.split(/[\\/]/).pop() ?? base;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return ext;
}

/** `src/App.tsx:12` → `{ path: "src/App.tsx", line: 12 }`. Range suffixes
 *  (`:12-20`) keep only the start line. Text without a numeric suffix stays
 *  untouched. */
export function splitPathLine(raw: string): { path: string; line?: number } {
  const s = raw.replace(INVISIBLE, "").trim().replace(/[.,;)\]}'"]+$/, "");
  const m = /^(.+?):(\d{1,7})(?:-\d{1,7})?$/.exec(s);
  if (m) {
    const line = parseInt(m[2], 10);
    if (Number.isFinite(line) && line > 0) return { path: m[1], line };
  }
  return { path: s };
}

/** True when a token (usually the content of an inline `code` span) looks
 *  like a file path worth rendering as a chip: single token, no whitespace,
 *  not a URL, and its extension is in the known list. `path:line` suffixes
 *  are allowed. */
export function looksLikeFilePath(raw: string): boolean {
  const s = raw.replace(INVISIBLE, "").trim();
  if (!s || s.length > 300 || /\s/.test(s)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false; // http:, mailto:, data:…
  if (s.startsWith("#") || s.startsWith("@") || s.startsWith("$")) return false;
  if (s.includes("**") || s.includes("<") || s.includes(">")) return false;
  const { path } = splitPathLine(s);
  const ext = extOf(path);
  if (!ext) return false;
  const name = path.split(/[\\/]/).pop() ?? path;
  // A dotfile's "extension" is its whole name (".gitignore").
  if (name.startsWith(".") && name.lastIndexOf(".") === 0) {
    return WHITELIST_EXTRA.has(ext) || ext in FILE_BADGES;
  }
  return ext in FILE_BADGES || WHITELIST_EXTRA.has(ext);
}

/** Basename of a path for tab/chip labels ("a/b/c.py" → "c.py"). */
export function fileBasename(path: string): string {
  return path.replace(INVISIBLE, "").trim().split(/[\\/]/).pop() || path;
}
