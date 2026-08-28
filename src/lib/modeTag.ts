// Strip a stray mode tag the model may echo at the very start of its reply.
//
// Some models learned (from older history that carried mode markers) to prefix
// their answer with a mode tag such as ``[Mode: Coder]`` or ``<!-- mode:ask -->``
// even though the authoritative mode is already declared by the system prompt
// (``=== CURRENT MODE: … ===``). We strip BOTH formats for ALL modes
// (ask/plan/coder/reader) so the button and the chat text never disagree.
//
// Only strip on the FIRST chunk (prev === "") so we never touch real content
// that arrives mid-stream.

const MODE_TAG_RE = /^\s*(?:\[Mode:\s*[^\]\n]*\]|<!--\s*mode:[^>]*-->)\s*/i;

/**
 * Strip a leading mode tag from the first text chunk of a model reply.
 *
 * @param chunk  The incoming text chunk.
 * @param prev   The assistant message content accumulated so far (before this
 *               chunk). Pass "" for the very first chunk.
 * @returns      The chunk with any leading mode tag removed (only when prev is
 *               empty).
 */
export function stripLeadingModeTag(chunk: string, prev: string): string {
  if (prev !== "") return chunk;
  return chunk.replace(MODE_TAG_RE, "");
}
