#!/usr/bin/env node
/**
 * Split one huge stylesheet into ordered part files WITHOUT changing the cascade.
 *
 *   node scripts/split-css.mjs --dry-run             # report only, write nothing
 *   node scripts/split-css.mjs                       # src/styles/global.css -> src/styles/global/NN-*.css
 *   node scripts/split-css.mjs --target 2500         # approx lines per part (default 2500)
 *   node scripts/split-css.mjs --in a.css --out dir  # custom paths
 *   node scripts/split-css.mjs --force               # overwrite an existing output dir
 *
 * How it stays safe:
 *  - Cuts happen ONLY between complete top-level rules/at-rules (brace depth 0),
 *    never inside @media / @keyframes / strings / comments / url(...).
 *  - Parts are re-imported by the new entry file in the ORIGINAL order, so the
 *    cascade is identical (Vite inlines plain-CSS @import).
 *  - Before writing it proves: concatenating the parts reproduces the original
 *    byte-for-byte, and every part has balanced braces. Otherwise it aborts.
 *  - Cut points prefer section banner comments (a comment made of dashes/equals
 *    around a title) near the target size so each part is a coherent area; part
 *    names come from that banner (or from the first selector when there is none).
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(name);

const IN = path.resolve(opt("--in", "src/styles/global.css"));
const OUT = path.resolve(opt("--out", path.join(path.dirname(IN), path.basename(IN, ".css"))));
const TARGET = Math.max(300, parseInt(opt("--target", "2500"), 10) || 2500);
const SLACK = Math.round(TARGET * 0.3);
const DRY = flag("--dry-run");
const FORCE = flag("--force");

const src = fs.readFileSync(IN, "utf8").replace(/\r\n/g, "\n");

/** Tokenize top level: returns statement end offsets (exclusive) at depth 0. */
function topLevelEnds(text) {
  const ends = [];
  let i = 0;
  let depth = 0;
  let paren = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j < 0) throw new Error("unterminated comment at offset " + i);
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === "\\") j++;
        if (text[j] === "\n") break; // invalid string; stop at EOL like CSS does
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (paren === 0) {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth < 0) throw new Error("unbalanced } at offset " + i);
        if (depth === 0) ends.push(i + 1);
      } else if (c === ";" && depth === 0) ends.push(i + 1);
    }
    i++;
  }
  if (depth !== 0) throw new Error("unbalanced { (depth " + depth + ") at EOF");
  return ends;
}

const lineOf = (offset, lineStarts) => {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo; // 0-based line index containing offset
};

const lineStarts = [0];
for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
const totalLines = lineStarts.length;

const ends = topLevelEnds(src);
// Statement k spans [ends[k-1], ends[k]); trivia (comments/blank) leading it is part of it.
const stmts = ends.map((e, k) => ({ start: k === 0 ? 0 : ends[k - 1], end: e }));

// Leading header: pure @import/@charset statements before any real rule must stay in the entry.
let headerEnd = 0;
let firstReal = 0;
for (; firstReal < stmts.length; firstReal++) {
  const body = src.slice(stmts[firstReal].start, stmts[firstReal].end).replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (/^@(import|charset)\b[^{}]*;$/i.test(body)) headerEnd = stmts[firstReal].end;
  else break;
}

const BANNER = /\/\*\s*(?:[-=─━#*~]{2,}\s*)([^*\n]*?)(?:\s*[-=─━#*~]{2,})?\s*(?:\*\/|$)/m;
const bannerOf = (s) => {
  const m = BANNER.exec(s.replace(/^[\s\S]*?(?=\/\*)/, (x) => (x.trim() ? x : "")));
  return m && m[1] && m[1].trim() ? m[1].trim() : "";
};

// Candidate cut points = statement starts (offset). Banner cuts are preferred.
const startLine = (k) => lineOf(stmts[k].start, lineStarts);
const hasBannerBefore = (k) => {
  const lead = src.slice(stmts[k].start, stmts[k].end);
  const head = lead.slice(0, lead.search(/[{;]/) < 0 ? lead.length : lead.search(/[{;]/));
  return bannerOf(head) !== "";
};

const parts = []; // {from: stmtIndex, to: stmtIndex(exclusive)}
let from = firstReal;
while (from < stmts.length) {
  const fromLine = startLine(from);
  let cut = -1;
  let bestBanner = -1;
  let bestDist = Infinity;
  let firstPastTarget = -1;
  for (let k = from + 1; k < stmts.length; k++) {
    const len = startLine(k) - fromLine;
    if (len >= TARGET && firstPastTarget < 0) firstPastTarget = k;
    if (len >= TARGET - SLACK && len <= TARGET + SLACK && hasBannerBefore(k)) {
      const dist = Math.abs(len - TARGET);
      if (dist < bestDist) {
        bestDist = dist;
        bestBanner = k;
      }
    }
    if (len > TARGET + SLACK) break;
  }
  cut = bestBanner >= 0 ? bestBanner : firstPastTarget >= 0 ? firstPastTarget : stmts.length;
  parts.push({ from, to: cut });
  from = cut;
}

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const names = new Set();
const files = parts.map((p, idx) => {
  const startOff = idx === 0 ? headerEnd : stmts[p.from].start;
  const endOff = idx === parts.length - 1 ? src.length : stmts[p.to - 1].end;
  const text = src.slice(startOff, endOff);
  let title = "";
  for (let k = p.from; k < p.to && !title; k++) {
    const lead = src.slice(stmts[k].start, stmts[k].end);
    const cut = lead.search(/[{;]/);
    title = bannerOf(cut < 0 ? lead : lead.slice(0, cut));
  }
  const firstSelector = () => {
    const m = /(^|\n)\s*([.#@:\[a-zA-Z][^{\n;]{0,60})\s*\{/.exec(text.replace(/\/\*[\s\S]*?\*\//g, ""));
    return m ? m[2] : "styles";
  };
  // Persian/non-Latin banners cannot become a file name: use the first selector instead.
  if (!title) title = firstSelector();
  let slug = slugify(title) || slugify(firstSelector()) || "styles";
  let base = String(idx + 1).padStart(2, "0") + "-" + slug;
  while (names.has(base)) base += "x";
  names.add(base);
  return { name: base + ".css", text, lines: text.split("\n").length, title };
});

// ---- verification (abort on any mismatch) ---------------------------------
const header = src.slice(0, headerEnd);
const rebuilt = header + files.map((f) => f.text).join("");
if (rebuilt !== src) throw new Error("VERIFY FAILED: concatenated parts differ from the original");
for (const f of files) {
  const ends2 = topLevelEnds(f.text); // throws on unbalanced braces / comments
  const last = ends2.length ? ends2[ends2.length - 1] : 0;
  if (f.text.slice(last).replace(/\/\*[\s\S]*?\*\//g, "").trim() && f !== files[files.length - 1])
    throw new Error("VERIFY FAILED: stray content after the last rule in " + f.name);
}

const rel = (p) => path.relative(process.cwd(), p) || ".";
console.log(`input : ${rel(IN)} (${totalLines} lines)`);
console.log(`output: ${rel(OUT)}/ (${files.length} parts, target ~${TARGET} lines)`);
for (const f of files) console.log(`  ${f.name.padEnd(48)} ${String(f.lines).padStart(6)} lines  ${f.title.slice(0, 50)}`);
console.log("verify: concatenation == original, braces balanced in every part  OK");
if (DRY) {
  console.log("dry-run: nothing written");
  process.exit(0);
}

if (fs.existsSync(OUT) && !FORCE) {
  console.error(`refusing: ${rel(OUT)} already exists (use --force)`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
for (const f of files) fs.writeFileSync(path.join(OUT, f.name), f.text);
const dirName = path.basename(OUT);
const entry =
  header +
  `/* Entry stylesheet: the former monolith is split into ordered parts under ./${dirName}/.\n` +
  `   ORDER MATTERS (cascade) — keep the imports in this order; add new rules to the\n` +
  `   part for that area, or a new numbered part at the end. */\n` +
  files.map((f) => `@import "./${dirName}/${f.name}";`).join("\n") +
  "\n";
fs.writeFileSync(IN, entry);
console.log(`wrote ${files.length} parts; ${rel(IN)} is now the import index`);
