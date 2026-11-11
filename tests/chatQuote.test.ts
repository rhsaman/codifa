// Unit tests for the reply-to-selection quote helpers.
// Run: npx esbuild tests/chatQuote.test.ts --bundle --platform=node \
//        --format=esm --outfile=/tmp/chatQuote.test.mjs && node /tmp/chatQuote.test.mjs
import {
  CHAT_QUOTE_MAX_CHARS,
  combineQuoteAndInput,
  formatChatQuote,
  insertQuoteIntoInput,
  isQuotableSelection,
  onReplyQuoteRequest,
  quotePreviewText,
  requestReplyQuote,
  splitQuoteFromContent,
} from "../src/lib/chatQuote";

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

console.log("4) quotePreviewText — one-line preview for the composer reply bar:");
{
  check("single line strips the prefix", quotePreviewText("> hello") === "hello");
  check(
    "multiline joins into one line",
    quotePreviewText("> a\n>\n> b") === "a b",
    JSON.stringify(quotePreviewText("> a\n>\n> b")),
  );
  check("plain text passes through", quotePreviewText("no quote") === "no quote");
  check("blank block is empty", quotePreviewText(">  \n>") === "");
}

console.log("5) splitQuoteFromContent — sent bubble recovers quote + body:");
{
  const noQuote = splitQuoteFromContent("just a question");
  check("no quote -> null + verbatim body", noQuote.quote === null && noQuote.body === "just a question");
  const sent = splitQuoteFromContent("> hello\n\nwhat is this?");
  check("quote + body split", sent.quote === "hello" && sent.body === "what is this?");
  const multi = splitQuoteFromContent("> a\n> b\n\nbody line");
  check("multiline quote", multi.quote === "a\nb" && multi.body === "body line");
  const quoteOnly = splitQuoteFromContent("> only the quote\n\n");
  check("quote-only send has empty body", quoteOnly.quote === "only the quote" && quoteOnly.body === "");
  const crlf = splitQuoteFromContent("> hi\r\n\r\nbody");
  check("CRLF normalised", crlf.quote === "hi" && crlf.body === "body");
  const deepBlock = splitQuoteFromContent("body first\n> not a quote");
  check("quote after body is not split", deepBlock.quote === null && deepBlock.body === "body first\n> not a quote");
  const missingSep = splitQuoteFromContent("> q\nbody");
  check("missing blank separator still splits", missingSep.quote === "q" && missingSep.body === "body");
}

console.log("6) requestReplyQuote bridge — non-chat surfaces pin into the composer:");
{
  let received: string | null = null;
  const off = onReplyQuoteRequest((b) => { received = b; });
  requestReplyQuote("hello");
  check("listener got the formatted block", received === "> hello");
  received = null;
  off();
  requestReplyQuote("again");
  check("unsubscribed listener stays silent", received === null);
  requestReplyQuote("   ");
  check("blank selection is a no-op", received === null);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat quote helper checks passed");
