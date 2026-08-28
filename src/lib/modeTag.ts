// Strip a stray mode tag the model may echo at the very start of its reply
// (e.g. "[Mode: Coder]"). The backend already forbids this in the system
// prompt, but some models learned the habit from older history. Only strip on
// the first chunk (when prev is empty) so we never touch real content mid-stream.
export function stripLeadingModeTag(chunk: string, prev: string): string {
  if (prev !== "") return chunk;
  return chunk
    .replace(/^\s*\[\s*Mode:\s*[^\]\n]*\s*\]\s*/i, "")
    .replace(/^\s*\[\s*\/\s*Mode\s*\]\s*/i, "");
}
