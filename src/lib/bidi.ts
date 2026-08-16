// Persian/Arabic script ranges (incl. Persian digits ۰-۹, punctuation ، ؛ ؟,
// presentation forms) - anything OUTSIDE these ranges (Latin, digits, arrows,
// punctuation, markdown syntax, whitespace...) is treated as a "foreign" run.
export const PERSIAN_RANGE =
  "\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF"
// \u200C/\u200D (ZWNJ/ZWJ) are excluded from the match so they stay glued to
// the Persian word they join (e.g. "می‌کنم") instead of getting isolated on
// their own.
const NON_PERSIAN_RUN = new RegExp(`[^${PERSIAN_RANGE}\\u200C\\u200D\\n]+`, "g")

// Bidi format / isolate / embedding control characters that models commonly
// inject into their own output (FSI⁦/PDI⁩, LRM, RLM, ALM, LRI/RLI, LRE/RLE...).
// Left in place they fight the LRI/PDI isolation below: inside an RTL
// paragraph FSI/PDI resolve to RTL and mirror parens/arrows ("sometimes
// reversed"), and a mark landing before `#` or `**` also breaks markdown
// parsing. We strip them so the ONLY bidi controls in rendered RTL text are the
// app's own deterministic LRI/PDI pairs. ZWNJ/ZWJ (U+200C/U+200D) are NOT
// stripped — Persian word-joining depends on them. ZWSP (U+200B) is NOT in this
// list either: models use it as an invisible WORD SEPARATOR between words, so
// stripping it glues Persian text together ("نکتههای مهم" → "نکتههایمهم"). It is
// handled separately by fixZwsp (see below).
const BIDI_MARKS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

export function stripBidiMarks(text: string): string {
  return text.replace(BIDI_MARKS, "")
}

// Zero-Width Space (U+200B): models emit it between words as an invisible word
// separator (tokenizer/bidi safety), so simply deleting it glues Persian words
// together. ZWSP flanked by two word characters (letters/digits — Persian or
// Latin) is a real word boundary → replace it with a regular space. Any other
// ZWSP (at an edge, beside punctuation, inside code) is dropped.
const ZWSP = /\u200B/g
const ZWSP_BETWEEN_WORDS = /(?<=[\p{L}\p{N}])\u200B(?=[\p{L}\p{N}])/gu

export function fixZwsp(text: string): string {
  return text.replace(ZWSP_BETWEEN_WORDS, " ").replace(ZWSP, "")
}

// Markdown BLOCK syntax that must sit at the true start of a line to parse
// (headings, lists, blockquotes, tables, code fences, thematic breaks). If an
// FSI char (U+2068) is inserted before these, CommonMark treats the line as a
// plain paragraph and the markdown renders as literal text in RTL messages.
const MARKDOWN_BLOCK_START =
  /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|\||`{3,}|~{3,}|[-*_]{3,}|=+)/

// Wraps every contiguous non-Persian run (English words, numbers, arrows,
// paths, markdown table pipes, etc.) in a single LRI/PDI isolate pair.
//
// This MUST wrap each run as one unit, not token-by-token: isolating "1",
// "->", "2" separately leaves three adjacent neutral runs with nothing to
// pin their relative order, so the RTL paragraph reorders them and "1->2"
// renders as "2->1". Wrapping the whole "1->2" run once keeps its internal
// order fixed while still letting it sit correctly inside RTL text (and RTL
// table cells).
//
// LRI (U+2066), not FSI (U+2068): FSI auto-detects the isolate's direction
// from its first STRONG character, and digits/parens/arrows/pipes are all
// bidi-"weak" or "neutral" — they carry no strong direction. A run like
// "(2024)" or a lone "->"/"→" has no strong char at all, so FSI falls back
// to the surrounding paragraph direction (RTL here). Inside an RTL-resolved
// isolate, bidi-mirrored glyphs (parentheses, arrow characters) get flipped
// to their mirror image for correct RTL presentation — which is exactly why
// "(" rendered as ")" and "→" rendered as "←". LRI forces the isolate itself
// to always resolve LTR regardless of content, which is what every one of
// these runs (English words, numbers, arrows, paths, markdown syntax) is.
//
// EXCEPTION 1: markdown block syntax at the start of a line is NOT isolated
// (see MARKDOWN_BLOCK_START above) so headings/lists/blockquotes/tables/code
// fences still parse in RTL messages.
// EXCEPTION 2: runs with NO strong character — pure punctuation / markdown
// delimiters such as "**", ":**", "`", "]", "—" or "؟". Wrapping these in LRI
// silently breaks CommonMark *inline* parsing: an LRI before "**" prevents
// emphasis from opening, and a ":" landing inside the same isolated run as the
// closing "**" prevents it from closing ("**text:**" is a real common pattern).
// Runs that carry at least one letter/digit (English words, "(Performance)",
// "1->2", paths, "→ 2024") are still wrapped exactly as before — that keeps
// parens/arrows pinned LTR while never touching markdown delimiters.
const HAS_STRONG = /[\p{L}\p{N}]/u

// Mirrored bracket characters ( ) [ ] { } need isolation purely because of
// their MIRRORING behavior, independent of whether the run also has a
// "strong" letter/digit. A lone ")" (e.g. closing the paren opened by a
// PREVIOUS isolated run like "grep_tool (") has no strong char, so it used to
// hit EXCEPTION 2 and stay unwrapped — leaving it in raw RTL context while its
// matching "(" sits inside a forced-LTR isolate. That mismatch is exactly what
// renders as a reversed/mirrored paren. Square/curly brackets are included for
// the same mirroring reason; "]" alone as markdown link syntax is rare enough,
// and still-unwrapped "**"/"`"/"—"/"؟" etc. (no bracket char) are unaffected.
const HAS_MIRRORED_BRACKET = /[()[\]{}]/

export function fixMixedText(text: string): string {
  return text.replace(NON_PERSIAN_RUN, (m, offset) => {
    if (!/\S/.test(m)) return m // pure whitespace - nothing to isolate
    // True start of a line? (only whitespace between the last \n and the run)
    let i = offset - 1
    while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--
    const atLineStart = i < 0 || text[i] === '\n'
    if (atLineStart && MARKDOWN_BLOCK_START.test(m)) return m
    if (!HAS_STRONG.test(m) && !HAS_MIRRORED_BRACKET.test(m)) return m
    return "\u2066" + m + "\u2069"
  })
}

export function prepareContent(text: string, dir: 'rtl' | 'ltr'): string {
  if (!text) return text
  const cleaned = stripBidiMarks(text)
  const parts = cleaned.split(/```/g)
  const fixed = parts.map((p, i) => {
    if (i % 2 === 1) return p // inside code block, don't modify
    const p2 = fixZwsp(p)
    if (dir !== 'rtl') return p2
    return p2
      .split('\n')
      // Table rows (GFM) contain pipes mid-line; isolating those lines inserts
      // FSI/PDI control chars that break remark-gfm's pipe parsing, so tables
      // render as plain text. Skip any line containing '|' entirely.
      .map((line) => (line.includes('|') ? line : fixMixedText(line)))
      .join('\n')
  })
  return fixed.join('```')
}
