// src/lib/bidi.ts
var PERSIAN_RANGE = "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF";
var RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`);
var BIDI_MARKS = /[\u202A-\u202E\u2066-\u2069]/g;
function stripBidiMarks(text) {
  return text.replace(BIDI_MARKS, "");
}
var INVISIBLE_SEP = /[\u200B\u200E\u200F\u061C]+/g;
var LEFT_WORDISH = /[\p{L}\p{N}\)\]\u060C\u061B\u061F,.;!?:»«\u2013\u2014"']/u;
var RIGHT_WORDISH = /[\p{L}\p{N}(*_`\[\u2013\u2014«»"']/u;
function fixZwsp(text) {
  return text.replace(INVISIBLE_SEP, (sep, offset) => {
    const before = text[offset - 1];
    const after = text[offset + sep.length];
    if (before && /\s/u.test(before)) return "";
    if (after && /\s/u.test(after)) return "";
    const leftOk = before === void 0 ? true : LEFT_WORDISH.test(before);
    const rightOk = after === void 0 ? true : RIGHT_WORDISH.test(after);
    return leftOk && rightOk ? " " : "";
  });
}
var FA_DIGITS = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
var DIGITS_RE = `[0-9${FA_DIGITS}]`;
var LINE_RANGE_RE = new RegExp(
  `\u062E\u0637\\s*(${DIGITS_RE}+)(?:\\s*-\\s*(${DIGITS_RE}+))?`
);
var PATH_RE = /([\w./\\-]+\.\w+)/;
function faToLat(n) {
  return n.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));
}
var BARE_RANGE_FENCE_RE = /^```\s*([\w-]+):(\d+)-(\d+)\s*$/;
function foldLineCaptions(text) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  let lastPath = "";
  while (i < lines.length) {
    const rangeM = LINE_RANGE_RE.exec(lines[i]);
    const pathM = PATH_RE.exec(lines[i]);
    if (rangeM && pathM) {
      const startN = parseInt(faToLat(rangeM[1]), 10);
      const endN = rangeM[2] ? parseInt(faToLat(rangeM[2]), 10) : startN;
      const lo = Math.min(startN, endN);
      const hi = Math.max(startN, endN);
      lastPath = pathM[1];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && lines[j].trim().length > 0 && lines[j].trim().length <= 12 && !lines[j].trim().startsWith("```")) {
        j++;
        while (j < lines.length && lines[j].trim() === "") j++;
      }
      const fence = j < lines.length ? /^```\s*([\w-]+)/.exec(lines[j]) : null;
      if (fence) {
        const lang = fence[1];
        lines[j] = "```" + lang + ":" + lo + "-" + hi + ":" + pathM[1];
        i = j;
        continue;
      }
    } else if (pathM && !rangeM) {
      lastPath = pathM[1];
    } else {
      const bare = BARE_RANGE_FENCE_RE.exec(lines[i]);
      if (bare && lastPath) {
        lines[i] = "```" + bare[1] + ":" + bare[2] + "-" + bare[3] + ":" + lastPath;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}
function prepareContent(text, _dir) {
  if (!text) return text;
  const cleaned = stripBidiMarks(text);
  const folded = foldLineCaptions(cleaned);
  const parts = folded.split(/```/g);
  const fixed = parts.map((p, i) => {
    if (i % 2 === 1) return p;
    return fixZwsp(p);
  });
  return fixed.join("```");
}

// tests/lineCaption.test.ts
function assert(cond, msg) {
  if (!cond) {
    console.error("\u274C " + msg);
    process.exit(1);
  }
  console.log("\u2705 " + msg);
}
{
  const md = `\u06A9\u062F \u062F\u0631 Plan.go \u062E\u0637 \u06F2\u06F0-\u06F1\u06F9 \u0647\u0633\u062A:
\`\`\`go
fromDate := time.Date(...)
isAfterCutoff := user.CreatedAt.After(fromDate)
\`\`\``;
  const out = prepareContent(md);
  assert(out.includes("```go:19-20"), "\u0631\u0646\u062C \u0645\u0639\u06A9\u0648\u0633 \u0628\u0647 \u06F1\u06F9-\u06F2\u06F0 normalize \u0634\u062F: " + out.split("\n").find((l) => l.startsWith("```")));
  assert(!/خط ۲۰-۱۹/.test(out), "\u062E\u0637 \u06A9\u067E\u0634\u0646 \u062D\u0630\u0641 \u0634\u062F");
}
{
  const md = `\u062F\u0631 Plan.go \u062E\u0637 \u06F5\u06F9:
\`\`\`go
if !isAfterCutoff {
\`\`\``;
  const out = prepareContent(md);
  assert(out.includes("```go:59-59"), "\u0639\u062F\u062F \u0641\u0627\u0631\u0633\u06CC \u0628\u0647 \u06F5\u06F9 \u062A\u0628\u062F\u06CC\u0644 \u0634\u062F: " + out.split("\n").find((l) => l.startsWith("```")));
}
{
  const md = "```go\nx := 1\n```";
  const out = prepareContent(md);
  assert(out === md, "\u0628\u062F\u0648\u0646 \u06A9\u067E\u0634\u0646 \u0628\u0644\u0648\u06A9 \u062A\u063A\u06CC\u06CC\u0631 \u0646\u06A9\u0631\u062F");
}
console.log("\u2705 \u062A\u0633\u062A lineCaption \u067E\u0627\u0633 \u0634\u062F");
