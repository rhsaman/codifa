// Arrows (→) inside bidirectional (Persian) prose.
//
// Problem: in an RTL paragraph "۱۶۰۷MB → ~۴۰۰MB" is two Latin/digit runs with a
// neutral arrow between them, so the browser merges the whole thing into ONE
// left-to-right island: 1607MB on the left, 400MB on the right, "→" pointing at
// 400MB. A reader who reads RTL meets ~۴۰۰MB first, then an arrow pointing back
// at it — the flow looks reversed. (Unicode never mirrors arrow glyphs.)
//
// Fix, in two steps:
//  1. rehypeArrows isolates each OPERAND next to a "→" as its own dir="ltr"
//     span (keeps "۱۶۰۷MB" / "~۴۰۰MB" readable inside) and wraps the arrow in
//     `.md-arrow`. The operands are now separate isolates, so the paragraph's
//     own direction orders them: in RTL the first operand sits on the right.
//  2. fixArrowDirections runs after layout and mirrors every `.md-arrow` whose
//     reading flow (previous char -> next char) runs leftwards, so the arrow
//     points from the first operand to the second in whatever direction the
//     text actually flows. LTR paragraphs are left exactly as they were.
// Only right-pointing arrows are handled: a "←" in Persian text is usually
// written on purpose to point left, so it is never touched.

const ARROW_CHARS = "→⟶⇒⟹➔➜➞↦"
const ARROW_RE_SRC = `[${ARROW_CHARS}][\\uFE0E\\uFE0F]?`
const ARROW_GLOBAL = new RegExp(ARROW_RE_SRC, "g")
const HAS_ARROW = new RegExp(`[${ARROW_CHARS}]`)
const SPACE = /\s/
// Brackets/quotes/punctuation hugging an operand stay OUTSIDE its isolate, so
// "(۱۶۰۷MB → ~۴۰۰MB):" keeps its parentheses around the whole expression.
const OPEN_PUNCT = /[(\[{«"'“‘<]/
const CLOSE_PUNCT = /[)\]}»"'”’>.,:;!?،؛؟…]/

/** Minimal hast shape (react-markdown's rehype tree) — avoids a type dependency. */
interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

// Code is literal; link text is read back as a plain string by the video-card
// and file-chip renderers, so neither is rewritten.
const SKIP_TAGS = new Set(["code", "pre", "a"])

const isArrowChar = (c: string | undefined): boolean =>
  c !== undefined && (ARROW_CHARS.includes(c) || c === "︎" || c === "️")

/** The operand [start, end) before (-1) or after (+1) the arrow spanning
 *  [from, to): the nearest whitespace-delimited run that is not itself an
 *  arrow, minus hugging brackets/punctuation. null when there is none. */
function operandRange(text: string, from: number, to: number, dir: -1 | 1): [number, number] | null {
  let start: number
  let end: number
  if (dir < 0) {
    end = from
    while (end > 0 && SPACE.test(text[end - 1])) end--
    start = end
    while (start > 0 && !SPACE.test(text[start - 1]) && !isArrowChar(text[start - 1])) start--
  } else {
    start = to
    while (start < text.length && SPACE.test(text[start])) start++
    end = start
    while (end < text.length && !SPACE.test(text[end]) && !isArrowChar(text[end])) end++
  }
  while (start < end && OPEN_PUNCT.test(text[start])) start++
  while (end > start && CLOSE_PUNCT.test(text[end - 1])) end--
  return end > start ? [start, end] : null
}

/** Split one text node into text / operand-isolate / arrow pieces. */
function splitText(text: string): HastNode[] {
  const pieces: { start: number; end: number; kind: "arrow" | "operand" }[] = []
  const seen = new Set<string>()
  const push = (start: number, end: number, kind: "arrow" | "operand") => {
    const key = `${kind}:${start}:${end}`
    if (seen.has(key)) return // "A → B → C": B is both operands, isolate it once
    seen.add(key)
    pieces.push({ start, end, kind })
  }
  for (const m of text.matchAll(ARROW_GLOBAL)) {
    const from = m.index ?? 0
    const to = from + m[0].length
    const left = operandRange(text, from, to, -1)
    const right = operandRange(text, from, to, 1)
    if (left) push(left[0], left[1], "operand")
    push(from, to, "arrow")
    if (right) push(right[0], right[1], "operand")
  }
  pieces.sort((x, y) => x.start - y.start)
  const out: HastNode[] = []
  let last = 0
  for (const piece of pieces) {
    if (piece.start < last) continue // overlapping range: keep the earlier one
    if (piece.start > last) out.push({ type: "text", value: text.slice(last, piece.start) })
    const value = text.slice(piece.start, piece.end)
    out.push({
      type: "element",
      tagName: "span",
      properties:
        piece.kind === "arrow" ? { className: ["md-arrow"] } : { className: ["md-op"], dir: "ltr" },
      children: [{ type: "text", value }],
    })
    last = piece.end
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) })
  return out
}

function wrapArrows(node: HastNode): void {
  if (!node.children) return
  if (node.type === "element" && node.tagName && SKIP_TAGS.has(node.tagName)) return
  const out: HastNode[] = []
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string" && HAS_ARROW.test(child.value)) {
      out.push(...splitText(child.value))
    } else {
      wrapArrows(child)
      out.push(child)
    }
  }
  node.children = out
}

/** rehype plugin: isolate the operands of every "→" outside code/links and wrap
 *  the arrow in <span class="md-arrow"> for fixArrowDirections. */
export function rehypeArrows() {
  // `unknown` on purpose: react-markdown hands us its own hast Root type, and
  // any tree is assignable to unknown, so no type dependency is needed here.
  return (tree: unknown) => wrapArrows(tree as HastNode)
}

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** true = the reading flow (previous char -> next char) runs leftwards, so the
 *  arrow must be mirrored; false = rightwards; null = cannot tell (the
 *  neighbours sit on different lines, or at the same x). */
export function flowRunsLeft(prev: Box, next: Box): boolean | null {
  const h = Math.min(prev.bottom - prev.top, next.bottom - next.top)
  const dy = Math.abs((prev.top + prev.bottom) / 2 - (next.top + next.bottom) / 2)
  if (!(h > 0) || dy > h * 0.6) return null
  const dx = (next.left + next.right) / 2 - (prev.left + prev.right) / 2
  if (Math.abs(dx) < 1) return null
  return dx < 0
}

const BLOCK_SELECTOR = "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, div"

/** On-screen box of the nearest non-space character before (-1) / after (1)
 *  the arrow inside its own block, or null when there is none. */
function neighbourBox(arrow: HTMLElement, dir: -1 | 1): Box | null {
  const block = arrow.closest<HTMLElement>(BLOCK_SELECTOR) ?? arrow.parentElement
  const own = arrow.firstChild
  if (!block || !own) return null
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  walker.currentNode = own
  for (let node = dir < 0 ? walker.previousNode() : walker.nextNode(); node; node = dir < 0 ? walker.previousNode() : walker.nextNode()) {
    const text = node.nodeValue ?? ""
    let i = dir < 0 ? text.length - 1 : 0
    while (i >= 0 && i < text.length && SPACE.test(text[i])) i += dir
    if (i < 0 || i >= text.length) continue
    let start = i
    let end = i + 1
    const code = text.charCodeAt(i)
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) start = i - 1 // low surrogate
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) end = i + 2 // high surrogate
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.height > 0)
    if (rect) return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    return null
  }
  return null
}

function setMirrored(el: HTMLElement, on: boolean): void {
  // Inline style on purpose: React never manages it for these spans, so a
  // re-render (streaming) cannot undo or collide with it.
  if (on) {
    el.style.display = "inline-block"
    el.style.transform = "scaleX(-1)"
  } else {
    el.style.removeProperty("display")
    el.style.removeProperty("transform")
  }
}

/** Mirror every `.md-arrow` under `root` whose reading flow runs leftwards.
 *  Call after layout (useLayoutEffect) — it reads real glyph positions. */
export function fixArrowDirections(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".md-arrow").forEach((el) => {
    let left: boolean | null = null
    try {
      const prev = neighbourBox(el, -1)
      const next = neighbourBox(el, 1)
      if (prev && next) left = flowRunsLeft(prev, next)
    } catch {
      left = null // measuring must never break rendering
    }
    setMirrored(el, left === true)
  })
}
