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
  if (typeof text !== "string") return ""
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
// Detect a "خط N: path" / "خط N-M: path" caption the model sometimes writes
// right before a fenced code block (e.g. "کد در Plan.go خط ۲۰-۱۹ هست:" then
// ```go ...). We fold the line range into the fence's info string as
// `lang:start-end` so the renderer can show the REAL file line numbers (and the
// file name) inside the code block, instead of a bare 1-based counter. The
// caption line itself is removed so it isn't duplicated as prose.
// Accept both Persian and Latin digits (the model may write "خط ۲" or "خط 2").
// The path may appear before OR after the "خط N" token.
// We ALSO accept the Western convention the model often uses: `path:line`
// (e.g. "changePhoneConfirm.go:32") or `path:line-line` — a file reference with
// a single line or a range, written with a colon. This is folded into the
// following fence exactly like the "خط N" caption so the header shows the real
// file name and line numbers.
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const DIGITS_RE = `[0-9${FA_DIGITS}]`;
const LINE_RANGE_RE = new RegExp(
  `خط\\s*(${DIGITS_RE}+)(?:\\s*[-–—~]\\s*(${DIGITS_RE}+))?`,
);
// Persian connectors: "خط ۱۹ تا ۲۰" or "خط ۱۹ الی ۲۰"
const LINE_RANGE_CONN_RE = new RegExp(
  `خط\\s*(${DIGITS_RE}+)\\s+(?:تا|الی)\\s+(${DIGITS_RE}+)`,
);
// A file path is `dir/.../name.ext` or `name.ext` (exactly one dot). A dotted
// reference like `user.CreatedAt.After` has no `/` and multiple dots, so it is
// NOT a path. The optional `:line` / `:line-line` suffix is captured separately
// so we can both remember the path and fold the range into the fence.
// A file path is `dir/.../name.ext` or `name.ext` (exactly one dot at the end).
// An optional `:line` / `:line-line` suffix (e.g. changePhoneConfirm.go:32) is
// captured in groups 2/3 so we can fold the range into the following fence. The
// path itself must end right before `:`+digits or end-of-string (lookahead), so
// a dotted reference like `user.CreatedAt.After` is NOT mistaken for a path and
// `name.go:32` keeps `:32` OUT of the path group.
const PATH_RE = new RegExp(
  `((?:[\\w\\/\\\\-]+\\.)*[\\w\\/\\\\-]+\\.\\w+)(?=:?(?:${DIGITS_RE}+|$))(?::(${DIGITS_RE}+)(?:-(${DIGITS_RE}+))?)?`,
);

// Normalize Persian digits to Latin so downstream code can parse the range.
function faToLat(n: string): string {
  return n.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));
}

// A bare fence that already carries a line range but NO path, e.g.
// ```go:19-20 — we may still attach the most recent file path to it.
const BARE_RANGE_FENCE_RE = new RegExp(
  '^```\\s*([\\w-]+):(' + DIGITS_RE + '+)-(' + DIGITS_RE + '+)\\s*$'
);

function foldLineCaptions(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  // The most recent file path seen in prose/captions, so we can attach it to
  // later fences that only carry a line range (the model often writes the
  // path once, then several ```lang:start-end fences without repeating it).
  let lastPath = ''
  while (i < lines.length) {
    let rangeM = LINE_RANGE_RE.exec(lines[i])
    if (rangeM && !rangeM[2]) rangeM = LINE_RANGE_CONN_RE.exec(lines[i]) ?? rangeM
    let pathM = PATH_RE.exec(lines[i])
    // PATH_RE requires the path to be followed by :digits or end-of-string.
    // In captions like "کد در Plan.go خط ۲۰-۱۹ هست:", the path is followed by a
    // space + more text, so PATH_RE misses it.  Use a fallback that accepts a
    // simple name.ext pattern followed by whitespace / end-of-string.
    if (!pathM && rangeM) {
      const looseM = /([\w\/\\-]+\.\w{1,5})(?:\s|$|[:\(])/.exec(lines[i])
      if (looseM) {
        // Wrap in a match-like array with the same group layout as PATH_RE:
        // [full, path, startLine, endLine]
        pathM = [looseM[0], looseM[1], "", ""] as unknown as RegExpExecArray
      }
    }
    if (rangeM && pathM) {
      const startN = parseInt(faToLat(rangeM[1]), 10)
      const endN = rangeM[2] ? parseInt(faToLat(rangeM[2]), 10) : startN
      // Normalize a reversed range the model sometimes writes (e.g. "خط ۲۰-۱۹")
      // so the gutter shows ascending line numbers.
      const lo = Math.min(startN, endN)
      const hi = Math.max(startN, endN)
      lastPath = pathM[1]
      // Look ahead (skipping blank lines and a short connector word like "توی")
      // for the next fenced code block.
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      // Allow one short prose word between the caption and the fence.
      if (
        j < lines.length &&
        lines[j].trim().length > 0 &&
        lines[j].trim().length <= 12 &&
        !lines[j].trim().startsWith('```')
      ) {
        j++
        while (j < lines.length && lines[j].trim() === '') j++
      }
      const fence = j < lines.length ? /^```\s*([\w-]+)/.exec(lines[j]) : null
      if (fence) {
        const lang = fence[1]
        // Carry the file path into the info string as `lang:start-end:path`
        // so the renderer can show it next to the language name in the header.
        lines[j] = '```' + lang + ':' + lo + '-' + hi + ':' + pathM[1]
        // Caption line is dropped — its info is now in the fence info string.
        // Advance past the fence so we don't re-process it.
        i = j
        continue
      }
    } else if (pathM && !rangeM) {
      // A line that is a file path, possibly with a `:line` / `:line-line`
      // suffix (e.g. "changePhoneConfirm.go:32"). Remember the path for the
      // following fences that omit it, and if a line range is present fold it
      // into the NEXT fence exactly like the "خط N" caption above.
      lastPath = pathM[1]
      if (pathM[2]) {
        const startN = parseInt(faToLat(pathM[2]), 10)
        const endN = pathM[3] ? parseInt(faToLat(pathM[3]), 10) : startN
        const lo = Math.min(startN, endN)
        const hi = Math.max(startN, endN)
        let j = i + 1
        while (j < lines.length && lines[j].trim() === '') j++
        if (
          j < lines.length &&
          lines[j].trim().length > 0 &&
          lines[j].trim().length <= 12 &&
          !lines[j].trim().startsWith('```')
        ) {
          j++
          while (j < lines.length && lines[j].trim() === '') j++
        }
        const fence = j < lines.length ? /^```\s*([\w-]+)/.exec(lines[j]) : null
        if (fence) {
          const bare = BARE_RANGE_FENCE_RE.exec(lines[j])
          if (bare) {
            // Fence already carries its own line range — keep it, just attach
            // the path from the caption (don't overwrite the model's range).
            lines[j] = '```' + bare[1] + ':' + faToLat(bare[2]) + '-' + faToLat(bare[3]) + ':' + pathM[1]
          } else {
            lines[j] = '```' + fence[1] + ':' + lo + '-' + hi + ':' + pathM[1]
          }
          // Keep the prose line — it may contain descriptive text beyond the
          // path:line reference (e.g. "توی file.go:32 تغییر شماره...").
          // Only the fence is rewritten; advance past it.
          out.push(lines[i])
          i = j
          continue
        }
      }
    } else {
      // A bare ```lang:start-end fence with no path: attach the last seen path
      // so the header always shows the file name next to the language.
      const bare = BARE_RANGE_FENCE_RE.exec(lines[i])
      if (bare && lastPath) {
        lines[i] =
          '```' + bare[1] + ':' + faToLat(bare[2]) + '-' + faToLat(bare[3]) + ':' + lastPath
      }
    }
    out.push(lines[i])
    i++
  }
  // ── Pass 2: detect "# path:start-end" comments INSIDE code fences ──
  // Models sometimes put the file path as the first comment line inside the
  // fenced code block.  Strip it from the code content and inject the info
  // into the fence info string so the gutter shows correct line numbers.
  const result: string[] = []
  let k = 0
  while (k < out.length) {
    const fenceOpen = /^```(\s*)([\w-]*)/.exec(out[k])
    if (fenceOpen) {
      const indent = fenceOpen[1]
      const existingLang = faToLat(fenceOpen[2])
      // Check if the very next non-blank line is a "# path:start-end" comment.
      let contentIdx = k + 1
      while (contentIdx < out.length && out[contentIdx].trim() === '') contentIdx++
      if (contentIdx < out.length) {
        // Match paths with multiple dots like backend/agents/tools/instagram_tools.py:82-84
        const commentM = /^#\s*((?:[\w\/\\-]+\/)*[\w\/\\-]*[\w.-]+\.\w+):(\d+)(?:-(\d+))?/.exec(out[contentIdx].trim())
        if (commentM) {
          const startN = parseInt(commentM[2], 10)
          const endN = commentM[3] ? parseInt(commentM[3], 10) : startN
          const lo = Math.min(startN, endN)
          const hi = Math.max(startN, endN)
          lastPath = commentM[1]
          // Rewrite the fence open line with lang:start-end:path
          const lang = existingLang || 'text'
          result.push('```' + lang + ':' + lo + '-' + hi + ':' + commentM[1])
          // Skip the comment line — don't emit it into the code content.
          k = contentIdx + 1
          // Emit remaining code lines until the closing fence.
          while (k < out.length && !/^```\s*$/.test(out[k])) {
            result.push(out[k])
            k++
          }
          // Emit the closing fence if present.
          if (k < out.length && /^```\s*$/.test(out[k])) {
            result.push(out[k])
            k++
          }
          continue
        }
      }
    }
    result.push(out[k])
    k++
  }
  return result.join('\n')
}

export function prepareContent(text: string, _dir?: 'rtl' | 'ltr'): string {
  // اگر ورودی رشته نباشد (مثلاً object/array از tool output)، coerce کن
  // تا کل ChatPanel کرش نکنه.
  if (text == null) return ""
  if (typeof text !== "string") {
    try { text = String(text) } catch { return "" }
  }
  if (!text) return text
  // Models sometimes emit literal <br/>, <br>, </br>, <br /> between paragraphs.
  // Replace with \n outside fenced code blocks; inside ```…``` leave untouched
  // (highlight.js / escapeHtml will show them as literal text).
  const brCleaned = text
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/<\/?br\s*\/?>/gi, '\n')))
    .join('')
  const cleaned = stripBidiMarks(brCleaned)
  // Fold "خط N: path" captions into the following fence BEFORE splitting on
  // ```, otherwise the caption lands in a non-code segment and the fence info
  // string can't be rewritten.
  const folded = foldLineCaptions(cleaned)
  const parts = folded.split(/```/g)
  const fixed = parts.map((p, i) => {
    if (i % 2 === 1) return p // inside code block, don't modify
    return fixZwsp(p)
  })
  return fixed.join('```')
}

