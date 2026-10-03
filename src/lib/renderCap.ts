// Bounds for pathological message sizes.
//
// A single accidental paste (log dumps, trace output) can reach megabytes.
// That text is re-sent to the model EVERY turn (context/token burn), written
// to disk on every persist, and parsed by the markdown/bidi pipeline on every
// chat switch. Two caps contain it:
// - PASTE_MAX: pasted blocks are truncated at send time with a visible marker
//   (prevents new monsters + context burn). File attach (@) stays unlimited.
// - RENDER_CAP: one message never renders more than this without an explicit
//   "show all" click (fast implicit paints; explicit reads stay complete).
// Model history, copy-to-clipboard and disk always keep the FULL text.
export const PASTE_MAX = 100_000
export const RENDER_CAP = 100_000

export function capText(text: string, cap: number = RENDER_CAP): { text: string; cut: number } {
  if (text.length <= cap) return { text, cut: 0 }
  return { text: text.slice(0, cap), cut: text.length - cap }
}

export function fmtSize(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`
  if (n >= 1_000) return `${Math.round(n / 1_000)}KB`
  return `${n} chars`
}
