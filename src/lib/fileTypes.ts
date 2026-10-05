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
  java: { label: "JAVA", bg: "#5382a1", fg: "#ffffff" },
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
  // Additional languages / formats so every whitelisted ext gets a tile.
  vue: { label: "VUE", bg: "#41b883", fg: "#35495e" },
  svelte: { label: "S", bg: "#ff3e00", fg: "#ffffff" },
  astro: { label: "A", bg: "#ff5d01", fg: "#ffffff" },
  dart: { label: "DA", bg: "#0175c8", fg: "#ffffff" },
  ex: { label: "EX", bg: "#6e4a7e", fg: "#ffffff" },
  exs: { label: "EX", bg: "#6e4a7e", fg: "#ffffff" },
  erl: { label: "ER", bg: "#a90533", fg: "#ffffff" },
  hs: { label: "HS", bg: "#5e5086", fg: "#ffffff" },
  clj: { label: "CL", bg: "#63b132", fg: "#ffffff" },
  cljs: { label: "CL", bg: "#63b132", fg: "#ffffff" },
  pl: { label: "PL", bg: "#39457e", fg: "#ffffff" },
  pm: { label: "PL", bg: "#39457e", fg: "#ffffff" },
  r: { label: "R", bg: "#276dc3", fg: "#ffffff" },
  jl: { label: "JL", bg: "#9558b2", fg: "#ffffff" },
  graphql: { label: "GQL", bg: "#e10098", fg: "#ffffff" },
  gql: { label: "GQL", bg: "#e10098", fg: "#ffffff" },
  proto: { label: "PR", bg: "#4285f4", fg: "#ffffff" },
  ipynb: { label: "IP", bg: "#f37726", fg: "#ffffff" },
  csv: { label: "CSV", bg: "#0f9d58", fg: "#ffffff" },
  tsv: { label: "TSV", bg: "#0f9d58", fg: "#ffffff" },
  log: { label: "LOG", bg: "#8d8d8d", fg: "#26221e" },
  diff: { label: "DIF", bg: "#4d7a3a", fg: "#ffffff" },
  patch: { label: "DIF", bg: "#4d7a3a", fg: "#ffffff" },
  dockerfile: { label: "DK", bg: "#2496ed", fg: "#ffffff" },
  makefile: { label: "MK", bg: "#6a9fb5", fg: "#26221e" },
  mk: { label: "MK", bg: "#6a9fb5", fg: "#26221e" },
  cmake: { label: "CM", bg: "#ba1e44", fg: "#ffffff" },
  gradle: { label: "GR", bg: "#02303a", fg: "#ffffff" },
  tex: { label: "TEX", bg: "#008080", fg: "#ffffff" },
  sty: { label: "TEX", bg: "#008080", fg: "#ffffff" },
  bat: { label: "BAT", bg: "#3d3d3d", fg: "#ffffff" },
  cmd: { label: "CMD", bg: "#3d3d3d", fg: "#ffffff" },
  doc: { label: "W", bg: "#2b579a", fg: "#ffffff" },
  docx: { label: "W", bg: "#2b579a", fg: "#ffffff" },
  xls: { label: "X", bg: "#217346", fg: "#ffffff" },
  xlsx: { label: "X", bg: "#217346", fg: "#ffffff" },
  ppt: { label: "P", bg: "#d24726", fg: "#ffffff" },
  pptx: { label: "P", bg: "#d24726", fg: "#ffffff" },
  zip: { label: "ZIP", bg: "#b98a3f", fg: "#26221e" },
  tar: { label: "TAR", bg: "#b98a3f", fg: "#26221e" },
  gz: { label: "GZ", bg: "#b98a3f", fg: "#26221e" },
  bz2: { label: "BZ", bg: "#b98a3f", fg: "#26221e" },
  xz: { label: "XZ", bg: "#b98a3f", fg: "#26221e" },
  "7z": { label: "7Z", bg: "#b98a3f", fg: "#26221e" },
  rar: { label: "RAR", bg: "#b98a3f", fg: "#26221e" },
  jar: { label: "JAR", bg: "#e76f00", fg: "#ffffff" },
  war: { label: "WAR", bg: "#e76f00", fg: "#ffffff" },
  apk: { label: "APK", bg: "#3ddc84", fg: "#1b4423" },
  aab: { label: "AAB", bg: "#3ddc84", fg: "#1b4423" },
  wasm: { label: "WA", bg: "#654ff0", fg: "#ffffff" },
  ttf: { label: "TTF", bg: "#5c6bc0", fg: "#ffffff" },
  otf: { label: "OTF", bg: "#5c6bc0", fg: "#ffffff" },
  woff: { label: "WOFF", bg: "#5c6bc0", fg: "#ffffff" },
  woff2: { label: "W2", bg: "#5c6bc0", fg: "#ffffff" },
  dylib: { label: "BIN", bg: "#6b7280", fg: "#ffffff" },
  so: { label: "BIN", bg: "#6b7280", fg: "#ffffff" },
  dll: { label: "BIN", bg: "#6b7280", fg: "#ffffff" },
  exe: { label: "BIN", bg: "#6b7280", fg: "#ffffff" },
  bin: { label: "BIN", bg: "#6b7280", fg: "#ffffff" },
  gitignore: { label: "GI", bg: "#f05033", fg: "#ffffff" },
  gitattributes: { label: "GA", bg: "#f05033", fg: "#ffffff" },
  editorconfig: { label: "EC", bg: "#6d8086", fg: "#ffffff" },
  npmrc: { label: "NR", bg: "#cb3837", fg: "#ffffff" },
  nvmrc: { label: "NV", bg: "#43853d", fg: "#ffffff" },
  babelrc: { label: "BA", bg: "#f5da55", fg: "#3b3106" },
  prettierrc: { label: "PT", bg: "#56b3b4", fg: "#ffffff" },
  eslintrc: { label: "ES", bg: "#4b32c3", fg: "#ffffff" },
  cfg: { label: "CFG", bg: "#8d8d8d", fg: "#26221e" },
  conf: { label: "CONF", bg: "#8d8d8d", fg: "#26221e" },
  properties: { label: "PRO", bg: "#8d8d8d", fg: "#26221e" },
  plist: { label: "PLS", bg: "#8d8d8d", fg: "#26221e" },
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

/** One segment of a parsed inline `code` span: plain text, or a detected
 *  file reference that renders as a clickable FileChip. */
export type InlinePathPart =
  | string
  | { path: string; line?: number; display: string };

const BARE_NAME_RE = /^[A-Za-z0-9_][\w.-]*$/;
const DIR_TOKEN_RE = /^(?:[A-Za-z0-9_.-]+\/)+$/;

/** Split an inline code span's text into text parts and file references.
 *  Covers the shapes a whole-span check (looksLikeFilePath) misses:
 *  - a qualified path inside words ("see src/lib/store.ts:12 here");
 *  - the tool-row pair "fs.ts src/lib/" — filename followed by its
 *    directory — combined into the real path "src/lib/fs.ts".
 *  A bare filename with no directory next to it stays plain text: without
 *  a directory it rarely resolves against the workspace root, so chipping
 *  it would create a dead chip. */
export function extractInlinePathParts(raw: string): InlinePathPart[] {
  if (!raw || !raw.includes("/")) return [raw];
  const tokens = raw.split(/(\s+)/).filter((t) => t !== "");
  const nextNonSep = (from: number) => {
    let j = from;
    while (j < tokens.length && /^\s+$/.test(tokens[j])) j++;
    return j;
  };
  const parts: InlinePathPart[] = [];
  let text = "";
  const flushText = () => {
    if (text) {
      parts.push(text);
      text = "";
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^\s+$/.test(tok)) {
      text += tok;
      continue;
    }
    // Strip wrapping punctuation so "(src/lib/a.ts)" still classifies as a
    // path; the stripped brackets stay as text around the chip.
    const lead = /^[([{'"`]+/.exec(tok)?.[0] ?? "";
    const core = tok.slice(lead.length).replace(/[.,;:)\]}'"`]+$/, "");
    if (!core) {
      text += tok;
      continue;
    }
    if (core.includes("/") && looksLikeFilePath(core)) {
      flushText();
      if (lead) parts.push(lead);
      const { path, line } = splitPathLine(core);
      parts.push({ path, line, display: core });
      const tail = tok.slice(lead.length + core.length);
      if (tail) text += tail;
      continue;
    }
    if (
      !core.includes("/") &&
      BARE_NAME_RE.test(core) &&
      looksLikeFilePath(core)
    ) {
      const j = nextNonSep(i + 1);
      if (j < tokens.length && DIR_TOKEN_RE.test(tokens[j])) {
        flushText();
        if (lead) parts.push(lead);
        const display = tokens[j] + core;
        const { path, line } = splitPathLine(display);
        parts.push({ path, line, display });
        const tail = tok.slice(lead.length + core.length);
        if (tail) text += tail;
        i = j;
        continue;
      }
    }
    text += tok;
  }
  flushText();
  return parts.length > 0 ? parts : [raw];
}

/** Basename of a path for tab/chip labels ("a/b/c.py" → "c.py"). */
export function fileBasename(path: string): string {
  return path.replace(INVISIBLE, "").trim().split(/[\\/]/).pop() || path;
}
