// Persian/Arabic script ranges (incl. Persian digits ۰-۹, punctuation ، ؛ ؟,
// presentation forms). Used by context.ts for token-count weighting.
export const PERSIAN_RANGE =
  "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF"

// Bidi ISOLATE / EMBEDDING control characters that models commonly inject into
// their own output (FSI⁦/PDI⁩, LRI/RLI, LRE/RLE/PDF/LRO/RLO). Left in place they
// fight the browser's native bidi resolution: inside an RTL paragraph FSI/PDI
// resolve to RTL and mirror parens/arrows ("sometimes reversed"), and a mark
// landing before `#` or `**` also breaks markdown parsing. We strip them so the
// ONLY bidi controls in rendered text are the browser's own (via dir="auto" /
// unicode-bidi: plaintext on the message containers).
//
// NOT stripped here: ZWNJ/ZWJ (U+200C/U+200D — Persian word-joining depends on
// them), and the invisible WORD SEPARATORS ZWSP/LRM/RLM/ALM (U+200B/U+200E/
// U+200F/U+061C) — models emit those BETWEEN words instead of a regular space,
// so deleting them glues mixed-script text together ("سلام world" → "سلامworld").
// They are handled by fixZwsp below, which converts them to a space when they
// actually sit between two words.
const BIDI_MARKS = /[\u202A-\u202E\u2066-\u2069]/g

export function stripBidiMarks(text: string): string {
  return text.replace(BIDI_MARKS, "")
}

// Invisible word separators that models emit between words as a tokenizer/bidi
// safety measure instead of a regular space:
//   ZWSP (U+200B), LRM (U+200E), RLM (U+200F), ALM (U+061C).
// Simply deleting them glues Persian and English words together ("سلام world" →
// "سلامworld"). A run of these flanked by two word characters (letters/digits —
// Persian or Latin), by a word character and a markdown INLINE opener
// (* _ ` [ — so "سلام\u200B**world**" keeps its space too), or by a word
// character and a bracket that belongs to the neighbouring word (")" ends a
// word like "(world)", "(" starts one — so "سلام\u200B(world)" and
// "(world)\u200Bسلام" keep their spaces), is a real word boundary → replace the
// WHOLE run with a single regular space. Matching the run (not one char)
// matters: models sometimes emit several separators in a row, and a per-char
// check would drop them all (each neighbor is another separator, not a word
// char) → words glued. Any other separator (at an edge, beside punctuation,
// inside code) is dropped.
const INVISIBLE_SEP = /[\u200B\u200E\u200F\u061C]/g
const INVISIBLE_SEP_BETWEEN_WORDS =
  /(?<=[\p{L}\p{N}\)\]])[\u200B\u200E\u200F\u061C]+(?=[\p{L}\p{N}(*_`\[])/gu

export function fixZwsp(text: string): string {
  return text.replace(INVISIBLE_SEP_BETWEEN_WORDS, " ").replace(INVISIBLE_SEP, "")
}

// Prepare message content for rendering. Direction is handled natively by the
// browser (dir="auto" / unicode-bidi: plaintext on the message containers), so
// we no longer inject LRI/PDI/RLI isolates by hand — that manual injection was
// the source of the reversed-paren / flipped-arrow / glued-word bugs. All that
// remains is stripping model-injected bidi control chars and normalizing the
// invisible word separators, both of which are safe and direction-agnostic.
export function prepareContent(text: string, _dir?: 'rtl' | 'ltr'): string {
  if (!text) return text
  const cleaned = stripBidiMarks(text)
  const parts = cleaned.split(/```/g)
  const fixed = parts.map((p, i) => {
    if (i % 2 === 1) return p // inside code block, don't modify
    return fixZwsp(p)
  })
  return fixed.join('```')
}
