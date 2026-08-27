// Persian/Arabic script ranges (incl. Persian digits ۰-۹, punctuation ، ؛ ؟,
// presentation forms). Used by context.ts for token-count weighting.
export const PERSIAN_RANGE =
  "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF"

// Any Persian/Arabic character. Exported so callers (e.g. Mermaid) can decide
// whether a string needs RTL isolation without re-declaring the range.
export const RTL_CHAR_RE = new RegExp(`[${PERSIAN_RANGE}]`)

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

// NOTE: We deliberately do NOT try to restore missing half-spaces (ZWNJ) in
// the model's Persian output here. Glued words like کتابخانههای are a MODEL
// OUTPUT problem, and no regex can reliably reconstruct the ZWNJ position
// without a dictionary (persian-tools' halfSpace only converts EXISTING
// spaces and doesn't know های at all). The fix lives at the source: the
// system prompt (backend/agents.py, _UNIVERSAL_RULES) instructs the model to
// emit ZWNJ correctly. Do not re-add per-pattern regexes here.

// Mark runs that contain Persian/Arabic characters as `dir="auto"`.
//
// Mermaid lays out node/edge labels with absolute x/y coordinates, so the
// browser's bidi algorithm can't reorder a mixed run correctly on its own —
// `unicode-bidi: plaintext` is not enough because the glyph positions are
// fixed. Setting dir="auto" on the text element itself tells the renderer to
// resolve direction from the FIRST strong character while leaving the node's
// x/y placement untouched.
//
// We use `auto` (NOT `rtl`) on purpose: a mixed label like
// `shutdown ... .پایان کار شما` starts with Latin, so `auto` keeps the whole
// run LTR and only the trailing Persian part renders RTL — the Latin text is
// NOT mirrored/reversed. Forcing `rtl` on such a label would reorder the
// entire string as RTL and mirror the Latin portion ("sometimes reversed").
// A purely-Persian label still resolves to RTL via `auto`, so nothing regresses.
// We only touch runs that actually contain Persian, so purely-English labels
// stay LTR.
//
// Mermaid renders labels two ways depending on `htmlLabels`:
//   * htmlLabels:false → SVG <text>/<tspan> (processed innermost-first so a
//     nested mark isn't overridden by an outer container).
//   * htmlLabels:true (the default) → HTML inside <foreignObject> (a <div> or
//     <p>/<span>). We flip those too, otherwise the container's dir="ltr"
//     makes Persian labels render LTR ("سنوی" ends up at the end).
// We never add a second dir= attribute.
export function applyRtlToSvgText(svg: string): string {
  const markSvg = (s: string, tag: 'tspan' | 'text') => {
    const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'g')
    return s.replace(re, (m, attrs: string, content: string) => {
      if (RTL_CHAR_RE.test(content) && !/\bdir\s*=/.test(attrs)) {
        return `<${tag} dir="auto"${attrs}>${content}</${tag}>`
      }
      return m
    })
  }
  let out = markSvg(markSvg(svg, 'tspan'), 'text')

  // HTML labels inside <foreignObject> (mermaid's default htmlLabels:true).
  // Mark only elements that wrap Persian text, so English labels stay LTR.
  out = out.replace(/<foreignObject\b[^>]*>([\s\S]*?)<\/foreignObject>/g, (fo) => {
    return fo.replace(
      /<(div|p|span|label|td|li)\b([^>]*)>([\s\S]*?)<\/\1>/g,
      (m, tag: string, attrs: string, content: string) => {
        if (/\bdir\s*=/.test(attrs)) return m
        if (!RTL_CHAR_RE.test(content)) return m
        return `<${tag} dir="auto"${attrs}>${content}</${tag}>`
      }
    )
  })
  return out
}

// Direction for UI containers that must line up with the app's RTL/LTR toggle
// (ask cards, steer/queue bubbles, composer). dir="auto" alone resolves from
// the FIRST strong character, so a mostly-Persian message that opens with a
// Latin word or digit ("API key رو بده", "3 فایل باز کن") renders LTR and
// flips sides between the composer (which forces the app-wide dir) and the
// bubble. Any Persian/Arabic character in the text means the user expects RTL
// layout — decide from the whole text, not the first char.
export function detectDir(text: string): 'rtl' | 'ltr' {
  return RTL_CHAR_RE.test(text) ? 'rtl' : 'ltr'
}

// Prepare message content for rendering. Direction is handled natively by the
// browser (dir="auto" / unicode-bidi: plaintext on the message containers), so
// we no longer inject LRI/PDI/RLI isolates by hand — that manual injection was
// the source of the reversed-paren / flipped-arrow / glued-word bugs. All that
// remains is stripping model-injected bidi control chars and normalizing the
// invisible word separators — both safe and direction-agnostic. (Missing
// half-spaces in Persian are a model-output issue fixed via the system prompt,
// not here — see the note above.)
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

