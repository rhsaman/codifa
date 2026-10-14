// Unit tests for the cmux/nvim open helpers (socket-denied detection, shell
// quoting, UI-scripting fallback args). Run: node tests/cmuxNvim.test.ts
import {
  appleScriptEscape,
  buildNvimCommand,
  buildNvimKeystrokeArgs,
  isSocketDeniedOutput,
  shellQuote,
} from "../src/lib/cmuxNvim.ts";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`, extra ?? "");
  }
}

console.log("1) isSocketDeniedOutput — cmux exits 0 on refusal, output is the signal:");
{
  check(
    "access denied detected",
    isSocketDeniedOutput("Error: ERROR: Access denied - only processes started inside cmux can connect"),
  );
  check("broken pipe detected", isSocketDeniedOutput("Broken pipe, errno 32"));
  check("case-insensitive", isSocketDeniedOutput("ACCESS DENIED"));
  check("clean OK output passes", !isSocketDeniedOutput("OK\n"));
  check("empty output passes", !isSocketDeniedOutput(""));
}

console.log("2) nvim command + keystroke fallback args:");
{
  check("simple command", buildNvimCommand("nvim", "/a/b.ts") === "nvim '/a/b.ts'");
  check(
    "single quote escaped",
    buildNvimCommand("/opt/homebrew/bin/nvim", "/a/b'c.ts") ===
      "/opt/homebrew/bin/nvim '/a/b'\"'\"'c.ts'",
  );
  check("shellQuote", shellQuote("a'b") === "'a'\"'\"'b'");
  const args = buildNvimKeystrokeArgs("nvim '/a/b.ts'");
  check("activates cmux", args.includes('tell application "cmux" to activate'));
  check("pastes the command", args.some((a) => a.includes("nvim '/a/b.ts'")));
  check("pastes via Cmd+V", args.includes('tell application "System Events" to keystroke "v" using command down'));
  check("restores clipboard", args.includes('set the clipboard to oldClip'));
  check("sends return", args.includes('tell application "System Events" to key code 36'));
  check("escapes for AppleScript", appleScriptEscape('a"b\\c') === 'a\\"b\\\\c');
}

if (failed > 0) {
  console.error(`cmuxNvim: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("cmuxNvim: all checks passed");
