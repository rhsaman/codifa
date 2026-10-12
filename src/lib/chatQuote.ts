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
