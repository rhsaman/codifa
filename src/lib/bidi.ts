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
// "سلامworld"), so a separator run is converted to a single regular space
// whenever it actually marks a word boundary. Matching the run (not one char)
// matters: models sometimes emit several separators in a row, and a per-char
// check would drop them all (each neighbor is another separator, not a word
// char) → words glued.
//
// A run is a word boundary when the character BEFORE it wants a space after it
// and the character AFTER it wants a space before it:
//   LEFT  — letters/digits, closing brackets ) ], dashes — – (Persian wraps —
//           in spaces), and pause punctuation ، ؛ ؟ ! . , : ; — the separator
//           then belongs to the FOLLOWING word ("سلام،\u200Bجهان" → "سلام، جهان").
//   RIGHT — letters/digits, opening brackets ( [, markdown inline openers
//           * _ `, dashes, and opening/ambiguous quotes.
// A run at the very START or END of a text slice also becomes a space: during
// streaming the slice boundary can split "word\u200B" from the next chunk
// "جهان", and a rule demanding BOTH neighbors would delete the separator at
// that moment → the words glue across the split. A leading/trailing space is
// invisible, so this is safe. Any other run — beside real whitespace (a space
// already exists), beside a newline, or beside attaching punctuation that
// would make "سلام ." wrong — is dropped.
const INVISIBLE_SEP = /[\u200B\u200E\u200F\u061C]+/g
const LEFT_WORDISH = /[\p{L}\p{N}\)\]\u060C\u061B\u061F,.;!?:»«\u2013\u2014"']/u
const RIGHT_WORDISH = /[\p{L}\p{N}(*_`\[\u2013\u2014«»"']/u

export function fixZwsp(text: string): string {
  return text.replace(INVISIBLE_SEP, (sep, offset) => {
    const before = text[offset - 1]
    const after = text[offset + sep.length]
    // Real whitespace on either side → a space already exists (or the
    // separator sits beside a newline): drop it.
    if (before && /\s/u.test(before)) return ""
    if (after && /\s/u.test(after)) return ""
    // Slice edge: keep a space (invisible) so a separator split across two
    // streamed chunks / segments can't glue the words on each side.
    const leftOk = before === undefined ? true : LEFT_WORDISH.test(before)
    const rightOk = after === undefined ? true : RIGHT_WORDISH.test(after)
    return leftOk && rightOk ? " " : ""
  })
}

// The model's own Persian output frequently OMITS the half-space (ZWNJ,
// U+200C) that correct Persian typography requires — producing text that
// visually reads as one glued word (کتابخانههای → کتابخانه‌های,
// منسوخشدهاند → منسوخ‌شدهاند). We tried @persian-tools/persian-tools'
// halfSpace() here, but it only converts EXISTING spaces for می/نمی/بی
// prefixes, ها/تر/ترین suffixes and ~26 word pairs — it never inserts a
// missing ZWNJ into already-glued words, and it doesn't know the های suffix
// at all. So we hand-roll the safe, high-signal patterns instead:
//   1) Ezafe "ه" + "ی" (بقیهی → بقیه‌ی) — a Persian root ending in ه
//      essentially never has a genuine (non-ezafe) "ی" glued onto it at a
//      word boundary.
//   2) The negation prefix "نمی" (نمیفرستد → نمی‌فرستد) — no common word
//      begins with نمی other than this prefix. ("می" is deliberately NOT
//      handled: میز/میدان/میلیون make it false-positive-prone.)
//   3) The plural suffix "های/هایی" (کتابخانههای → کتابخانه‌های) — after a
//      2+-letter word ending in ه, a glued های/هایی is almost always the
//      plural suffix (هایلایت etc. are excluded by the boundary check).
//   4) Compound past forms "Xشده" (منسوخشده → منسوخ‌شده) and "Xاند"
//      (شدهاند → شده‌اند) — a glued شده/اند after a 2+-letter word is a
//      verb compound, not a standalone word.
const ZWNJ = "\u200C"
const PERSIAN_LETTER = `[${PERSIAN_RANGE}]`
const BOUND_AFTER = `(?:[\\s)\\]»«"'.,:;!?\u060C\u061B\u061F]|$)`
const EZAFE_RE = new RegExp(`(${PERSIAN_LETTER}{2,}\u0647)(\u06CC)(?=${BOUND_AFTER})`, "gu")
const NEGATION_PREFIX_RE = /(?<![\u0621-\u06FF])(\u0646\u0645\u06CC)(?=[\u0621-\u06FF])/gu
const HAYES_SUFFIX_RE = new RegExp(`(${PERSIAN_LETTER}{2,}\u0647)(\u0647\u0627\u06CC\u06CC|\u0647\u0627\u06CC)(?=${BOUND_AFTER})`, "gu")
const SHODE_RE = new RegExp(`(${PERSIAN_LETTER}{2,})(\u0634\u062F\u0647)(?=\u0627\u0646\u062F|${BOUND_AFTER})`, "gu")
const AND_RE = new RegExp(`(${PERSIAN_LETTER}{2,}\u0647)(\u0627\u0646\u062F)(?=${BOUND_AFTER})`, "gu")

export function fixMissingZwnj(text: string): string {
  return text
    .replace(EZAFE_RE, `$1${ZWNJ}$2`)
    .replace(HAYES_SUFFIX_RE, `$1${ZWNJ}$2`)
    .replace(SHODE_RE, `$1${ZWNJ}$2`)
    .replace(AND_RE, `$1${ZWNJ}$2`)
    .replace(NEGATION_PREFIX_RE, `$1${ZWNJ}`)
}

// Direction for UI containers that must line up with the app's RTL/LTR toggle
// (ask cards, steer/queue bubbles, composer). dir="auto" alone resolves from
// the FIRST strong character, so a mostly-Persian message that opens with a
// Latin word or digit ("API key رو بده", "3 فایل باز کن") renders LTR and
// flips sides between the composer (which forces the app-wide dir) and the
// bubble. Any Persian/Arabic character in the text means the user expects RTL
// layout — decide from the whole text, not the first char.
const RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`)
export function detectDir(text: string): 'rtl' | 'ltr' {
  return RTL_CHAR_RE.test(text) ? 'rtl' : 'ltr'
}

// Prepare message content for rendering. Direction is handled natively by the
// browser (dir="auto" / unicode-bidi: plaintext on the message containers), so
// we no longer inject LRI/PDI/RLI isolates by hand — that manual injection was
// the source of the reversed-paren / flipped-arrow / glued-word bugs. All that
// remains is stripping model-injected bidi control chars, normalizing the
// invisible word separators, and restoring missing half-spaces (ZWNJ) — all
// safe and direction-agnostic.
export function prepareContent(text: string, _dir?: 'rtl' | 'ltr'): string {
  if (!text) return text
  const cleaned = stripBidiMarks(text)
  const parts = cleaned.split(/```/g)
  const fixed = parts.map((p, i) => {
    if (i % 2 === 1) return p // inside code block, don't modify
    return fixMissingZwnj(fixZwsp(p))
  })
  return fixed.join('```')
}
