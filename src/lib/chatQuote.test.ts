// Unit tests for the reply-to-selection quote helpers.
// Run: npx esbuild src/lib/chatQuote.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/chatQuote.test.mjs && node /tmp/chatQuote.test.mjs
import {
  CHAT_QUOTE_MAX_CHARS,
  combineQuoteAndInput,
  formatChatQuote,
  insertQuoteIntoInput,
  isQuotableSelection,
} from "./chatQuote";

export {};

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}

console.log("1) isQuotableSelection — blank text offers no reply:");
{
  check("empty -> false", isQuotableSelection("") === false);
  check("whitespace -> false", isQuotableSelection("   \n\t  ") === false);
  check("text -> true", isQuotableSelection("hello") === true);
}

console.log("2) formatChatQuote + insertQuoteIntoInput — quote block into composer:");
{
  check(
    "single line becomes quote",
    formatChatQuote("hello") === "> hello",
  );
  check(
    "multiline quotes every line",
    formatChatQuote("a\n\nb") === "> a\n>\n> b",
    JSON.stringify(formatChatQuote("a\n\nb")),
  );
  check("blank selection formats empty", formatChatQuote("  ") === "");
  const long = "x".repeat(CHAT_QUOTE_MAX_CHARS + 10);
  const formatted = formatChatQuote(long);
  check(
    "long selection truncates",
    formatted.endsWith("…") && formatted.length < long.length + 4,
  );
  check(
    "empty input gets quote block",
    insertQuoteIntoInput("", "hello") === "> hello\n\n",
  );
  check(
    "typed text kept after quote",
    insertQuoteIntoInput("my question", "hello") === "> hello\n\nmy question",
  );
  check(
    "blank selection leaves input alone",
    insertQuoteIntoInput("typed", "   ") === "typed",
  );
}

console.log("3) combineQuoteAndInput — pinned reply plus typed question:");
{
  check(
    "quote plus question",
    combineQuoteAndInput("> hello", "what is this?") === "> hello\n\nwhat is this?",
  );
  check(
    "empty question keeps quote block",
    combineQuoteAndInput("> hello", "   ") === "> hello\n\n",
  );
  check(
    "empty quote returns input",
    combineQuoteAndInput("   ", "my question") === "my question",
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat quote helper checks passed");
