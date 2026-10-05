// Unit tests for the pure file-type helpers behind FileIcon/FileChip
// (extension detection, `path:line` splitting, path-likeness whitelist).
// Run: node tests/fileTypes.test.ts
import {
  FILE_BADGES,
  IMAGE_EXTS,
  extOf,
  fileBasename,
  fileIconSpec,
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

if (failed > 0) {
  console.error(`fileTypes: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("fileTypes: all checks passed");
