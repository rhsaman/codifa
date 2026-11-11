// Helpers for reply-to-selection quoting in the chat transcript.
// Pure functions so they can be unit-tested without a DOM.

export const CHAT_QUOTE_MAX_CHARS = 1000;

/** True when the selected text is worth offering a reply action for. */
export function isQuotableSelection(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0;
}

/** Format raw selected text as a markdown quote block. */
export function formatChatQuote(text: string): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return "";
  const truncated =
    clean.length > CHAT_QUOTE_MAX_CHARS
      ? `${clean.slice(0, CHAT_QUOTE_MAX_CHARS).trimEnd()}…`
      : clean;
  return truncated
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line.trimEnd()}`))
    .join("\n");
}

/** Prepend a quote block to the composer input, keeping typed text after it. */
export function insertQuoteIntoInput(current: string, selection: string): string {
  const formatted = formatChatQuote(selection);
  if (!formatted) return current;
  const block = `${formatted}\n\n`;
  if (!current) return block;
  if (!current.trim()) return block;
  return `${block}${current.replace(/^\n+/, "")}`;
}

/** Combine a pinned reply quote block with typed/pasted text for sending. */
export function combineQuoteAndInput(quoteBlock: string, current: string): string {
  const quote = quoteBlock.trim();
  if (!quote) return current;
  if (!current.trim()) return `${quote}\n\n`;
  return `${quote}\n\n${current.replace(/^\n+/, "")}`;
}

/** One-line preview of a quote block for the composer reply bar: strip the
 *  "> " prefixes and collapse the lines, so the bar never grows with a
 *  multi-line quote (CSS ellipsizes the rest). */
export function quotePreviewText(quoteBlock: string): string {
  const inner = quoteBlock
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}>\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
  return inner;
}

/** Split a SENT message into its leading reply-quote block and the typed
 *  body. `combineQuoteAndInput` bakes the quote into `content` as markdown
 *  "> " lines followed by a blank line, so the bubble renderer can recover
 *  it without a new field on the message (retroactive for old sends). */
export function splitQuoteFromContent(content: string): { quote: string | null; body: string } {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const quoteLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^\s{0,3}>\s?(.*)$/);
    if (!m) break;
    quoteLines.push(m[1]);
    i++;
  }
  if (quoteLines.length === 0) return { quote: null, body: content };
  // Skip the single blank line the composer put between quote and body.
  if (i < lines.length && lines[i].trim() === "") i++;
  const quote = quoteLines.join("\n").trim();
  return { quote: quote || null, body: lines.slice(i).join("\n") };
}

// Reply-quote requests from surfaces OUTSIDE the chat (reading mode, schedule
// inbox, schedule panel): they pin the selection into the chat composer, which
// owns `activeQuote`. A tiny module-level pub/sub keeps that one-way bridge
// free of store plumbing.
type ReplyQuoteListener = (block: string) => void;
const replyQuoteListeners = new Set<ReplyQuoteListener>();

/** Subscribe to reply-quote requests; returns the unsubscribe function. */
export function onReplyQuoteRequest(listener: ReplyQuoteListener): () => void {
  replyQuoteListeners.add(listener);
  return () => replyQuoteListeners.delete(listener);
}

/** Format a raw selection and broadcast it to the chat composer. No-op when
 *  the selection has no quotable text. */
export function requestReplyQuote(rawText: string): void {
  const block = formatChatQuote(rawText);
  if (!block) return;
  for (const listener of replyQuoteListeners) listener(block);
}
