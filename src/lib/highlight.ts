/** Syntax highlighting shared by chat code fences, the file viewer and diff views.
 *
 *  highlight.js CORE + only the languages this app actually shows: the default
 *  `highlight.js` entry registers ~190 grammars and would parse them all at
 *  launch, which is a real cost in the renderer heap. `lib/core` ships none, so
 *  every grammar is registered explicitly on first use.
 *
 *  Highlighting is done on a WHOLE text and then split back into per-line HTML
 *  (keeping spans that stay open across a newline open on every line they
 *  cover), so a multi-line token — block comment, template literal, docstring —
 *  keeps its colour on each of its lines.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { sanitizeHtml } from "./sanitizeHtml";
import { extOf } from "./fileTypes";

/** Languages the app highlights — the fence languages that actually appear in
 *  agent output plus the file extensions the viewer opens. */
const HLJS_LANGUAGES: Array<[string, unknown]> = [
  ["bash", bash],
  ["c", c],
  ["cpp", cpp],
  ["csharp", csharp],
  ["css", css],
  ["diff", diff],
  ["dockerfile", dockerfile],
  ["go", go],
  ["graphql", graphql],
  ["ini", ini],
  ["java", java],
  ["javascript", javascript],
  ["json", json],
  ["kotlin", kotlin],
  ["less", less],
  ["lua", lua],
  ["makefile", makefile],
  ["markdown", markdown],
  ["nginx", nginx],
  ["objectivec", objectivec],
  ["perl", perl],
  ["php", php],
  ["plaintext", plaintext],
  ["python", python],
  ["ruby", ruby],
  ["rust", rust],
  ["scss", scss],
  ["shell", shell],
  ["sql", sql],
  ["swift", swift],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml],
];

/** Aliases the model (and file extensions) actually emit, mapped onto the
 *  grammars registered above. Without these, `bash`/`sh`/`zsh` etc. would fall
 *  through to auto-detection and lose their highlighting. */
const HLJS_ALIASES: Record<string, string> = {
  sh: "bash",
  zsh: "bash",
  ksh: "bash",
  console: "bash",
  shellscript: "shell",
  py: "python",
  python3: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "typescript",
  rs: "rust",
  golang: "go",
  yml: "yaml",
  jsonc: "json",
  json5: "json",
  html: "xml",
  htm: "xml",
  svg: "xml",
  vue: "xml",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  h: "c",
  cs: "csharp",
  "c#": "csharp",
  rb: "ruby",
  objc: "objectivec",
  "objective-c": "objectivec",
  md: "markdown",
  patch: "diff",
  docker: "dockerfile",
  make: "makefile",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  text: "plaintext",
  txt: "plaintext",
  log: "plaintext",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  properties: "ini",
  sass: "scss",
};

let hljsReady = false;
/** Grammar for each base language name — needed for aliases, because
 *  `hljs.getLanguage()` returns a registered Language OBJECT, not the grammar
 *  function `registerLanguage` expects. */
const HLJS_BY_NAME: Record<string, unknown> = Object.fromEntries(HLJS_LANGUAGES);
/** Register every grammar once per webview, on the first highlight. */
function ensureHljsLanguages(): void {
  if (hljsReady) return;
  for (const [name, grammar] of HLJS_LANGUAGES) {
    hljs.registerLanguage(name, grammar as never);
  }
  for (const [alias, target] of Object.entries(HLJS_ALIASES)) {
    const grammar = HLJS_BY_NAME[target];
    if (grammar) hljs.registerLanguage(alias, grammar as never);
  }
  // Only after BOTH loops succeeded: a throw mid-way must not leave the module
  // believing it is registered (every later highlight would then silently
  // fall back to unhighlighted code).
  hljsReady = true;
}

/** True when `lang` (a fence language or a file extension) has a grammar here.
 *  Callers use it to decide between highlighted output and their own fallback. */
export function hasHighlightLanguage(lang: string): boolean {
  if (!lang) return false;
  ensureHljsLanguages();
  return Boolean(hljs.getLanguage(lang));
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

// Highlight cache: blocks re-render whenever their parent re-renders (e.g.
// every streamed token of a long reply re-renders the whole transcript
// window). hljs.highlight over a big block on every token is the main CPU cost
// of streaming. Cache by (lang + source) so unchanged blocks pay zero.
// FIFO-bounded so long sessions can't leak memory.
const highlightCache = new Map<string, string[]>();
const HIGHLIGHT_CACHE_MAX = 150;

/** Highlight `whole` as `lang` and return one HTML fragment per source line.
 *  Never throws: unknown languages fall back to auto-detection, and a failure
 *  falls back to escaped plain text. */
export function getHighlightedLines(whole: string, lang: string): string[] {
  const key = `${lang}\n${whole}`;
  const hit = highlightCache.get(key);
  if (hit) return hit;
  // Grammars are registered lazily on the first highlight: `lib/core` ships
  // none, so without this the block would fall through to `highlightAuto`
  // (which also has nothing to detect) and render unhighlighted.
  ensureHljsLanguages();
  let lines: string[];
  try {
    const html =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(whole, { language: lang }).value
        : hljs.highlightAuto(whole).value;
    // highlight.js round-trips whatever the model wrote into the code block
    // (e.g. unterminated tags, stray attributes) into the highlighted HTML.
    // Sanitize the result so a malicious payload can't smuggle an event
    // handler or a javascript: URL into the chat via a code block.
    lines = splitHighlightedHtml(sanitizeHtml(html));
  } catch {
    lines = whole.split("\n").map(escapeHtml);
  }
  if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  highlightCache.set(key, lines);
  return lines;
}

/** Highlight one file side of a diff and key the HTML by gutter line number.
 *
 *  `lines` must be that side's lines in ascending file order: a diff gives the
 *  two sides interleaved, so the caller builds one array per side and calls
 *  this twice. Highlighting the side as ONE text (instead of line by line) is
 *  what keeps multi-line tokens coloured on all of their lines.
 */
export function highlightSideLines(
  lines: { lineNo: number; text: string }[],
  lang: string,
): Map<number, string> {
  const out = new Map<number, string>();
  // No grammar means the caller's own fallback (plain text + comment spans)
  // must win: `getHighlightedLines` would auto-detect and colour the text as
  // something it is not.
  if (lines.length === 0 || !hasHighlightLanguage(lang)) return out;
  const html = getHighlightedLines(
    lines.map((line) => line.text).join("\n"),
    lang,
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fragment = html[i];
    if (fragment !== undefined && line.lineNo >= 0) out.set(line.lineNo, fragment);
  }
  return out;
}

/** Highlight.js language for a file PATH — the extension when there is one,
 *  otherwise the bare basename. Dotless files (Makefile, Dockerfile,
 *  CMakeLists.txt) are how the hash/make grammars actually ship in a repo, so
 *  falling back to the name keeps a diff of them coloured instead of flat. */
export function languageOfPath(path?: string): string {
  if (!path) return "";
  const clean = path.split("?")[0];
  const ext = extOf(clean);
  if (ext) return ext;
  const base = (clean.split(/[\\/]/).pop() ?? "").toLowerCase();
  return base;
}
