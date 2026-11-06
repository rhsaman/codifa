// LTR islands inside bidirectional (Persian) prose.
//
// Problem: the Unicode bidi algorithm resolves several characters that sit
// BETWEEN numbers — the dash of a range ("1.10–1.16"), a percent sign
// ("۴٫۰٪"), "≈" ("TE: Q4 ≈ 1.12") — as NEUTRAL, and neutrals between two
// numbers act RTL inside an RTL paragraph. Each number keeps its internal
// order but the pieces are laid out right-to-left, so ranges render reversed
// ("1.16–1.10"), the percent jumps to the wrong side and mixed phrases like
// "TE: Q4 ≈ 1.12" scramble. A run that spans SEPARATE inline elements (a code
// chip followed by a URL link) is ordered RTL the same way.
//
// Fix: wrap every run made of Latin letters, digits (ASCII/Persian/Arabic)
// and neutral separators in U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP
// DIRECTIONAL ISOLATE. The run then renders as ONE left-to-right island in
// BOTH directions — visually a no-op in LTR text, exactly what the user asked
// for ("consecutive English words / numbers read left-to-right in ltr AND
// rtl").
//
// Runs are wrapped on the hast tree (a rehype plugin), NOT on the markdown
// source: by that point markup like ordered-list "1." markers, table pipes
// and emphasis asterisks is already parsed away, so an isolate can never break
// markdown syntax, and the message content stored in the chat stays clean.
//
// Two design constraints worth remembering when touching the glue set:
//  * It must stay a SUPERSET of the neutrals the bidi algorithm itself keeps
//    together between two Latin words (i.e. all of them). Splitting a run the
//    browser would have kept whole re-introduces the very reordering this
//    fixes — the split islands get laid out RTL.
//  * Arrows must stay OUT (→ ⇒ …): rehypeArrows owns them — it isolates the
//    operands itself and mirrors the arrow glyph for RTL flow. Ordering this
//    plugin AFTER rehypeArrows keeps the two from fighting.

const LRI = "\u2066"
const PDI = "\u2069"

// Strong LTR characters: Latin letters plus the three digit scripts a Persian
// chat mixes (ASCII, Persian ۰-۹, Arabic ٠-٩).
const STRONG = "A-Za-z0-9\u06F0-\u06F9\u0660-\u0669"

// Neutral glue allowed between strong characters of one run (and at run
// edges, where it is trimmed). Includes: spaces + the invisible separators
// (ZWSP/LRM/ZWNJ/ZWJ), all ASCII punctuation, typographic quotes and dashes,
// Arabic ، ؛ ؟ ٪ ٫ ، the math symbols ≈ ≠ ≤ ≥ − and common currency signs.
// NEWLINE IS DELIBERATELY ABSENT — a run never spans lines — and so are RLM/
// ALM (U+200F/U+061C): they are strong RTL marks and must end a run.
const GLUE =
  " \\t\\u00A0\\u200B\\u200C\\u200D\\u200E" +
  "\\u00AB\\u00BB\\u2018\\u2019\\u201C\\u201D" +
  "!\"#$%&'()*+,\\-./:;<=>?@[\\\\\\]^_`{|}~" +
  "\\u2010-\\u2015\\u2022\\u2027\\u2030" +
  "\\u060C\\u061B\\u061F\\u066A\\u066B\\u066C" +
  "\\u2212\\u2248\\u2260\\u2264\\u2265" +
  "\\u20AC\\u00A3\\u00A5"

const STRONG_CHAR_RE = new RegExp(`[${STRONG}]`)
const GLUE_CHAR_RE = new RegExp(`[${GLUE}]`)
const RUN_RE = new RegExp(
  `[${GLUE}]*[${STRONG}][${STRONG}]*([${GLUE}]+[${STRONG}][${STRONG}]*)*[${GLUE}]*`,
  "g",
)

// Edge glue worth KEEPING inside the island (attached to a strong char, no
// space in between):
//   leading [+ − ~ $ / .] — sign/approx/path prefixes: "/plugin", "~۱۵۰",
//     "+۰٫۰۴٪", ".gitignore", "$۱۰۰";
//   trailing [% ٪] — a percent glued to its number: "۴٫۰٪", "4.4%".
// Everything else at the edges (spaces, sentence punctuation, brackets,
// quotes) belongs to the surrounding RTL text and is left outside, where the
// bidi algorithm (incl. bracket pairing) places it correctly.
const LEAD_KEEP_RE = /[+\u2212~$/.]+$/
const TRAIL_KEEP_RE = /^[%\u066A]+/

// A bracket pair must never straddle the island boundary: its twin would
// render mirrored OUTSIDE while the other half sits unmirrored INSIDE the LTR
// island — "Trading Economics (۵ نوامبر)" would show two "(" glyphs and no
// ")". Any bracket left unbalanced inside the matched run moves OUT of the
// island, where the bidi bracket-pairing algorithm pairs it with the
// surrounding text (exactly what it does today, pre-islands).
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" }

function trimUnbalanced(core: string): { core: string; tail: string } {
  let tail = ""
  for (;;) {
    const stack: { ch: string; idx: number }[] = []
    let cut = -1
    for (let i = 0; i < core.length; i++) {
      const ch = core[i]
      if (OPENERS[ch]) stack.push({ ch, idx: i })
      else if (CLOSERS[ch] && stack.pop()?.ch !== CLOSERS[ch]) {
        cut = i
        break
      }
    }
    if (cut >= 0) {
      // Unmatched closer: everything from it on belongs to the outer text.
      tail = core.slice(cut) + tail
      core = core.slice(0, cut)
      continue
    }
    if (stack.length > 0) {
      // Unmatched opener(s): from the EARLIEST one on, move outside.
      tail = core.slice(stack[0].idx) + tail
      core = core.slice(0, stack[0].idx)
      continue
    }
    break
  }
  const m = /[ \t\u00A0]+$/.exec(core)
  if (m) {
    tail = m[0] + tail
    core = core.slice(0, core.length - m[0].length)
  }
  return { core, tail }
}

function isolateRun(m: string): string {
  let first = 0
  while (first < m.length && !STRONG_CHAR_RE.test(m[first])) first++
  let last = m.length - 1
  while (last > first && !STRONG_CHAR_RE.test(m[last])) last--
  const lead = m.slice(0, first)
  const bal = trimUnbalanced(m.slice(first, last + 1))
  const core = bal.core
  const trail = bal.tail + m.slice(last + 1)
  const leadKeep = LEAD_KEEP_RE.exec(lead)?.[0] ?? ""
  const trailKeep = TRAIL_KEEP_RE.exec(trail)?.[0] ?? ""
  // Skip islands that cannot change anything: a core with NO glue inside and
  // no kept edge glue is a single token ("CPI", "۱۲", "Q4", "1607MB") — the
  // bidi algorithm can never reorder one token, and skipping keeps the
  // invisible-control noise in copied text minimal.
  if (!core || (!GLUE_CHAR_RE.test(core) && !leadKeep && !trailKeep)) return m
  return (
    lead.slice(0, lead.length - leadKeep.length) +
    LRI +
    leadKeep +
    core +
    trailKeep +
    PDI +
    trail.slice(trailKeep.length)
  )
}

/** Wrap LTR runs (Latin words, numbers, ranges, mixed phrases) in LRI…PDI so
 *  they render left-to-right as one unit in RTL *and* LTR paragraphs. */
export function isolateLtrRuns(text: string): string {
  if (typeof text !== "string" || !text) return text
  return text.replace(RUN_RE, isolateRun)
}

// Direction by TOKEN majority (not characters!): Persian technical prose is
// SATURATED with Latin identifiers ("۱. crash پروتژه را تحویل می‌داد. در مسیر
// resolve بعد از sidecar:dead، URL از IPC…") — counting CHARACTERS tips such
// paragraphs LTR and scrambles real Persian. Counting WORDS works: a token is
// a whitespace-delimited run, classified by its LETTERS (persian-range letter
// → rtl token, latin letter → ltr token, digits/punct alone → ignored). The
// paragraph is rtl only when rtl tokens outnumber ltr tokens.
const RTL_TOKEN_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/
const HAS_LETTER_RE = /[\p{L}\p{N}]/u

export function dirByText(text: string): "rtl" | "ltr" {
  if (typeof text !== "string" || !text) return "ltr"
  let rtl = 0
  let ltr = 0
  let run = 0 // طول دنبالهٔ فعلی از توکن‌های لاتین
  let first: "rtl" | "ltr" | null = null
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    if (!token || !HAS_LETTER_RE.test(token)) continue
    if (RTL_TOKEN_RE.test(token)) {
      rtl++
      run = 0
      first ??= "rtl"
    } else {
      // یک عبارت انگلیسی پشت‌سرهم (نام شرکت، شناسه…) حداکثر ۲ رأی می‌دهد؛
      // وگرنه یک خط فارسی با یک اسم چندکلمه‌ای انگلیسی ltr تشخیص داده می‌شد.
      if (run < 2) ltr++
      run++
      first ??= "ltr"
    }
  }
  if (rtl === ltr) return first ?? "ltr"
  return rtl > ltr ? "rtl" : "ltr"
}

/** Minimal hast shape (react-markdown's rehype tree) — avoids a type dep. */
export interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

// Same skip list as rehypeArrows, plus style/script: code text is literal
// (chips and fences isolate themselves via CSS unicode-bidi) and link text is
// read back as a plain string by the video-card / file-chip renderers.
const SKIP_TAGS = new Set(["code", "pre", "a", "style", "script"])

// Prose blocks get an EXPLICIT dir attribute from their language majority.
// The CSS-only `unicode-bidi: plaintext` uses first-strong, which flips a
// mostly-English paragraph that merely OPENS with a Persian word — the
// explicit attribute pins direction AND alignment in every engine.
const DIR_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "blockquote"])

function walkIslands(node: HastNode): void {
  if (node.type === "text") {
    if (node.value) node.value = isolateLtrRuns(node.value)
    return
  }
  if (node.type === "element" && node.tagName && SKIP_TAGS.has(node.tagName)) {
    return
  }
  if (node.type === "element" && node.tagName && DIR_BLOCKS.has(node.tagName)) {
    let text = ""
    // Same skip rules as the island walk below: text inside pre/code is
    // LITERAL content (a fenced block nested in a bullet is a block of its
    // own, not part of the bullet's prose), so it must not vote on the
    // block's direction. Without this, a bullet like "**Caption:**" followed
    // by a Persian caption fence counted as mostly-Persian → dir=rtl → the
    // list marker jumped to the right and the label's trailing colon flipped
    // to the front, while its sibling bullets stayed ltr.
    const collect = (n: HastNode) => {
      if (n.type === "text") {
        text += n.value ?? ""
        return
      }
      if (n.type === "element" && n.tagName && SKIP_TAGS.has(n.tagName)) return
      n.children?.forEach(collect)
    };
    (node.children ?? []).forEach(collect)
    if (!node.properties) node.properties = {}
    node.properties.dir = dirByText(text)
  }
  const kids = node.children
  if (kids) for (const kid of kids) walkIslands(kid)
}

/** rehype plugin: isolate LTR runs in every text node of the tree. */
export function rehypeLtrIslands() {
  return (tree: unknown) => {
    walkIslands(tree as HastNode)
  }
}
