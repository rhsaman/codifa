// Unit tests for the pure file-type helpers behind FileIcon/FileChip
// (extension detection, `path:line` splitting, path-likeness whitelist).
// Run: node tests/fileTypes.test.ts
import {
  FILE_BADGES,
  IMAGE_EXTS,
  dedupDocPaths,
  defaultAppForExt,
  extOf,
  extractInlinePathParts,
  fileBasename,
  fileIconSpec,
  filePathFromHref,
  looksLikeFilePath,
  splitPathLine,
} from "../src/lib/fileTypes.ts";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`, extra ?? "");
  }
}

console.log("1) extOf — extension of a path's basename:");
{
  check("tsx", extOf("src/App.tsx") === "tsx");
  check("no extension", extOf("Makefile") === "");
  check("dotfile counts as ext", extOf(".gitignore") === "gitignore");
  check("bidi marks stripped", extOf("\u202asrc/App.tsx\u202c") === "tsx");
  check("trailing punctuation ignored", extOf("`src/App.tsx`") === "tsx");
  check("directory with dots is not an ext", extOf("a.b/c") === "");
}

console.log("2) splitPathLine — `path:line` suffix extraction:");
{
  const plain = splitPathLine("src/App.tsx");
  check(
    "plain path untouched",
    plain.path === "src/App.tsx" && plain.line === undefined,
  );
  const withLine = splitPathLine("src/App.tsx:12");
  check(
    "path:line",
    withLine.path === "src/App.tsx" && withLine.line === 12,
  );
  check("range keeps start", splitPathLine("src/App.tsx:12-20").line === 12);
  check(
    "version-like untouched",
    splitPathLine("pkg-1.2.3").path === "pkg-1.2.3" &&
      splitPathLine("pkg-1.2.3").line === undefined,
  );
  check(
    "windows drive is not a line",
    splitPathLine("C:/x/y.ts").line === undefined,
  );
}

console.log("3) looksLikeFilePath — inline-code chip whitelist:");
{
  const yes = [
    "src/App.tsx",
    "backend/agents.py",
    "electron/main.cjs",
    "pyproject.toml",
    "src/App.tsx:12",
    ".gitignore",
    "package-lock.json",
  ];
  const no = [
    "npm run build",
    "https://example.com/a.ts",
    "mailto:a@b.com",
    "v1.2",
    "#ffcc00",
    "two words.ts",
    "justtext",
    "",
    "e.g",
    "src/<App>.tsx",
  ];
  for (const t of yes) check(`yes: ${t}`, looksLikeFilePath(t));
  for (const t of no) check(`no: ${JSON.stringify(t)}`, !looksLikeFilePath(t));
}

console.log("4) badge map + basename:");
{
  check(
    "cjs renders as JS (reference screenshot)",
    FILE_BADGES.cjs?.label === "JS",
  );
  check("ts badge is TS", FILE_BADGES.ts?.label === "TS");
  check("png is an image glyph", IMAGE_EXTS.has("png"));
  check("basename", fileBasename("a/b/c.py") === "c.py");
  check(
    "basename windows separators",
    fileBasename("a\\b\\c.py") === "c.py",
  );
}

console.log("5) fileIconSpec — tile mapping:");
{
  check("ts keeps TS monogram", fileIconSpec("src/App.ts").label === "TS");
  check("tsx accent is blue", fileIconSpec("src/App.tsx").accent === "#3178c6");
  check("html collapses to a badge tile", fileIconSpec("index.html").kind === "badge");
  check("png is an image glyph", fileIconSpec("a.png").kind === "image");
  check("mp3 is an audio glyph", fileIconSpec("a.mp3").kind === "audio");
  check("unknown ext is neutral generic", fileIconSpec("notes.xyz123").kind === "generic");
  check("uppercase path still maps", fileIconSpec("SRC/APP.TSX").label === "TSX");
}

console.log("6) extractInlinePathParts — paths inside composite spans:");
{
  type Chip = { path: string; line?: number; display: string };
  const chipParts = (parts: readonly unknown[]) =>
    parts.filter((p): p is Chip => typeof p === "object" && p !== null);

  const row = extractInlinePathParts("Edit fs.ts src/lib/ +49");
  check(
    "tool-row pair keeps surrounding words as text",
    row.length === 3 && row[0] === "Edit " && row[2] === " +49",
  );
  const rowChip = chipParts(row)[0];
  check(
    "tool-row pair combines name + dir into the real path",
    rowChip?.path === "src/lib/fs.ts" && rowChip?.display === "src/lib/fs.ts",
  );

  const read = extractInlinePathParts("Read ToolCallView.tsx src/components/");
  check(
    "read row pair resolves under its dir",
    chipParts(read)[0]?.path === "src/components/ToolCallView.tsx",
  );

  const qualified = extractInlinePathParts("see src/lib/store.ts:12 here");
  const qChip = chipParts(qualified)[0];
  check(
    "qualified path with line inside words",
    qChip?.path === "src/lib/store.ts" && qChip?.line === 12,
  );

  const wrapped = extractInlinePathParts("(src/lib/store.ts)");
  check(
    "wrapped path keeps brackets as text",
    wrapped[0] === "(" &&
      chipParts(wrapped)[0]?.path === "src/lib/store.ts" &&
      wrapped[2] === ")",
  );

  const noDir = extractInlinePathParts("edit fs.ts please");
  check("bare filename without dir stays text", chipParts(noDir).length === 0);

  const two = extractInlinePathParts("fs.ts src/lib/ and store.ts src/lib/");
  check("multiple pairs in one span", chipParts(two).length === 2);

  const untouched = [
    "Changes +2823 −633",
    "Working for 1m 17s",
    "Thought · a few seconds",
    "https://example.com/a.ts",
    "plain words only",
  ];
  check(
    "non-path spans stay untouched",
    untouched.every((t) => {
      const parts = extractInlinePathParts(t);
      return chipParts(parts).length === 0 && parts.join("") === t;
    }),
  );
}

// Markdown-link hrefs: which ones are workspace files (must become chips, not
// navigable anchors) and which ones stay real links.
{
  const rel = filePathFromHref("src/components/ChatMessage.tsx");
  check("relative href is a file", rel?.path === "src/components/ChatMessage.tsx" && rel.line === undefined);
  const withLine = filePathFromHref("src/lib/store.ts:12");
  check("href with line keeps the line", withLine?.path === "src/lib/store.ts" && withLine.line === 12);
  const abs = filePathFromHref("/Users/saman/x/foo.ts");
  check("absolute href is a file", abs?.path === "/Users/saman/x/foo.ts");
  const fileUrl = filePathFromHref("file:///Users/saman/x/foo.ts");
  check("file:// href keeps the absolute path", fileUrl?.path === "/Users/saman/x/foo.ts");
  const doc = filePathFromHref("report.pdf");
  check("document href is a file", doc?.path === "report.pdf");
  check("https href is NOT a file", filePathFromHref("https://example.com/x") === null);
  check("http href is NOT a file", filePathFromHref("http://example.com") === null);
  check("mailto href is NOT a file", filePathFromHref("mailto:a@b.c") === null);
  check("anchor href is NOT a file", filePathFromHref("#section") === null);
  check("bare word href is NOT a file", filePathFromHref("docs") === null);
  check("empty href is NOT a file", filePathFromHref(undefined) === null && filePathFromHref("  ") === null);
}

if (failed > 0) {
  console.error(`fileTypes: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("fileTypes: all checks passed");

console.log("7) dedupDocPaths — attachments hide duplicate doc chips:");
{
  check(
    "same basename filtered",
    dedupDocPaths(["a/contract.docx"], ["/data/contract.docx"]).length === 0,
  );
  check(
    "case-insensitive",
    dedupDocPaths(["a/Report.PDF"], ["b/report.pdf"]).length === 0,
  );
  check(
    "unattached docs kept",
    dedupDocPaths(["a/one.docx", "b/two.xlsx"], ["c/one.docx"]).join() === "b/two.xlsx",
  );
  check(
    "same file twice with different forms kept once",
    dedupDocPaths(["contract.docx", "/Users/saman/Downloads/workspace/contract.docx"], []).join() ===
      "contract.docx",
  );
  check(
    "persian basename duplicate kept once",
    dedupDocPaths(["قرارداد_تهاتر.docx", "/Users/saman/Downloads/workspace/قرارداد_تهاتر.docx"], []).length === 1,
  );
}

console.log("8) defaultAppForExt — office docs open in system app:");
{
  check("docx maps to Word", defaultAppForExt("docx")?.label === "Word");
  check("xlsx maps to Excel", defaultAppForExt("xlsx")?.label === "Excel");
  check("csv maps to Excel", defaultAppForExt("csv")?.label === "Excel");
  check("pdf maps to viewer", defaultAppForExt("pdf")?.label === "Default PDF app");
  check("code files keep editors", defaultAppForExt("ts") === null);
}
