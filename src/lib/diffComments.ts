/** Comment detection for diff lines.
 *
 *  Two shapes matter when dimming a diff:
 *   - a trailing line comment (`//`, `#`, `--`) that ends at the newline, and
 *   - a block comment that may open on one line and close several lines later.
 *
 *  The block case needs state, because diff lines are rendered one at a time:
 *  the scanner reports whether a block is still open at the end of a line, and
 *  the next line starts inside it. `buildCommentSpans` runs that scan over the
 *  lines of ONE file side and returns the spans keyed by gutter line number.
 *
 *  Everything here is pure so it can be unit-tested without a DOM.
 */

/** Half-open `[start, end)` range of a line that is comment text. */
export type CommentSpan = { start: number; end: number };

/** A comment piece of a line, ready to render. */
export type CommentSegment = { text: string; comment: boolean };

/** Comment syntax for one language. `line` markers end the line; `block` may span lines. */
export type CommentSyntax = {
  line: string[];
  block?: { open: string; close: string };
};

const SLASH_BLOCK = { open: "/*", close: "*/" } as const;
const HTML_BLOCK = { open: "<!--", close: "-->" } as const;

/** Syntax nobody dims (unknown extension). */
export const NO_COMMENT_SYNTAX: CommentSyntax = { line: [] };

const SLASH_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "java", "c", "h", "cc",
  "cpp", "hpp", "cs", "kt", "swift", "scss", "less", "mm", "dart", "zig",
  "jsonc", "proto", "groovy", "php",
]);

const HASH_EXT = new Set([
  // `toml` is deliberately absent: TomlLine renders those diffs with its own
  // key/value highlighting, and two dimming paths must not fight over a line.
  "py", "rb", "sh", "bash", "zsh", "fish", "yml", "yaml", "ini", "cfg", "conf",
  "pl", "jl", "nim", "tf", "hcl", "dockerfile", "makefile", "mk",
]);

const DASH_EXT = new Set(["sql", "lua", "hs", "elm"]);

const SLASH_BLOCK_EXT = new Set(["css"]);

const HTML_BLOCK_EXT = new Set(["html", "htm", "xml", "svg", "vue", "svelte"]);

/** Comment syntax for a file path, or an empty syntax when unknown.
 *  Query strings are ignored (`x.ts?3` is still TypeScript). */
export function commentSyntax(path?: string): CommentSyntax {
  if (!path) return NO_COMMENT_SYNTAX;
  const clean = path.split("?")[0].toLowerCase();
  const base = clean.split(/[\\/]/).pop() ?? "";
  const ext = base.split(".").pop() ?? "";
  // Extension-less files are matched by NAME (Makefile, Dockerfile), which is
  // how the hash-comment languages are actually shipped in a repo.
  if (!base.includes(".") && HASH_EXT.has(base)) return { line: ["#"] };
  if (SLASH_EXT.has(ext)) return { line: ["//"], block: SLASH_BLOCK };
  if (HASH_EXT.has(ext)) return { line: ["#"] };
  if (DASH_EXT.has(ext)) return { line: ["--"] };
  if (SLASH_BLOCK_EXT.has(ext)) return { line: [], block: SLASH_BLOCK };
  if (HTML_BLOCK_EXT.has(ext)) return { line: [], block: HTML_BLOCK };
  return NO_COMMENT_SYNTAX;
}

/** Scan one line for comments, starting either inside or outside a block.
 *
 *  Quotes are respected, so a marker inside a string literal stays code.
 *  Returns the comment spans of this line plus the block state to carry into
 *  the next line.
 */
export function scanCommentLine(
  text: string,
  syntax: CommentSyntax,
  startInBlock = false,
): { spans: CommentSpan[]; open: boolean } {
  const spans: CommentSpan[] = [];
  const block = syntax.block;
  let i = 0;

  // Continuation of a block opened on an earlier line: everything up to the
  // closing marker is comment text.
  if (startInBlock) {
    if (!block) return { spans, open: false };
    const close = text.indexOf(block.close);
    if (close < 0) return { spans: [{ start: 0, end: text.length }], open: true };
    const end = close + block.close.length;
    spans.push({ start: 0, end });
    i = end;
  }

  let quote: string | null = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (block && text.startsWith(block.open, i)) {
      const close = text.indexOf(block.close, i + block.open.length);
      if (close < 0) {
        spans.push({ start: i, end: text.length });
        return { spans, open: true };
      }
      const end = close + block.close.length;
      spans.push({ start: i, end });
      i = end - 1;
      continue;
    }
    let lineHit = false;
    for (const m of syntax.line) {
      if (text.startsWith(m, i)) {
        spans.push({ start: i, end: text.length });
        lineHit = true;
        break;
      }
    }
    if (lineHit) return { spans, open: false };
  }
  return { spans, open: false };
}

/** Spans for the lines of one file side, in file order.
 *
 *  `lines` must be that side's lines in ascending file order: a unified diff
 *  interleaves before/after, so build one array per side and call this twice.
 *  The returned map is keyed by gutter line number; lines without a comment are
 *  absent (and unknown/negative line numbers are skipped).
 */
export function buildCommentSpans(
  lines: { lineNo: number; text: string }[],
  syntax: CommentSyntax,
): Map<number, CommentSpan[]> {
  const map = new Map<number, CommentSpan[]>();
  if (syntax.line.length === 0 && !syntax.block) return map;
  let open = false;
  for (const line of lines) {
    const result = scanCommentLine(line.text, syntax, open);
    open = result.open;
    if (result.spans.length > 0 && line.lineNo >= 0) {
      map.set(line.lineNo, result.spans);
    }
  }
  return map;
}

/** Split a line into plain and comment pieces for rendering.
 *  `comment: true` pieces get the dimmed style. */
export function splitCommentSegments(
  text: string,
  spans: CommentSpan[] | undefined,
): CommentSegment[] {
  if (!spans || spans.length === 0) return [{ text, comment: false }];
  const out: CommentSegment[] = [];
  let at = 0;
  for (const span of spans) {
    const start = Math.max(at, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > at) out.push({ text: text.slice(at, start), comment: false });
    if (end > start) out.push({ text: text.slice(start, end), comment: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), comment: false });
  return out;
}
