/**
 * Turn raw provider/tool errors into one short, readable line.
 *
 * The backend composes retry reasons by pasting the provider's raw HTTP body
 * into a sentence, so a single hiccup arrives as:
 *
 *   explore failed: key rejected (429): {"error":{"message":"[429]: {\"error\":
 *   {\"type\":\"server_error\",\"message\":\"Upstream request failed: Endpoint
 *   is unavailable.\"}}","type":"rate_limit_error"}} — trying the next model
 *
 * — a wall of escaped JSON where the human sentence is the smallest part. This
 * module keeps the sentence and drops the envelope:
 *  - un-escapes the JSON (each nesting layer was escaped once by its writer),
 *  - lifts the innermost `message`/`detail` out of any embedded JSON object,
 *  - collapses whitespace + strips bidi marks that flip the line in RTL,
 *  - truncates at a word boundary.
 *
 * Pure + dependency-free: loaded directly by plain `node` in tests.
 */

/** Bidi controls + zero-width marks: they make an error line render reversed
 *  for RTL users, and never carry meaning in a provider message. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g

/** One un-escape pass: `\"`, `\n`, `\\`, `\/`, … → their literal characters. */
function unescapeJson(s: string): string {
  return s.replace(/\\(["\\/bfnrt])/g, (_m, c: string) => {
    switch (c) {
      case 'n':
      case 'b':
      case 'f':
      case 'r':
      case 't':
        return ' '
      default:
        return c === '/' ? '/' : c
    }
  })
}

/**
 * The innermost quoted `message` in a (already un-escaped) provider body.
 *
 * The LAST match wins: a body nests `{"error":{"message":"…"}}`, and the inner
 * text is the specific one — the outer is a wrapper restating the status code.
 */
function deepestMessage(s: string): string | null {
  const re = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  const all = [...s.matchAll(re)]
  if (!all.length) return null
  return unescapeJson(all[all.length - 1][1]).trim() || null
}

/**
 * Human-readable form of a raw error string, capped at `max` characters.
 * Returns the input (cleaned) when it carries no embedded JSON, so plain
 * messages such as "upstream connection lost" pass through untouched.
 */
export function humanizeError(raw: string, max = 140): string {
  if (!raw) return ''
  let s = raw.replace(INVISIBLE, '')
  // Provider bodies arrive escaped (`\"`), which also hides their structure
  // from the regex below — un-escape first, then lift the message out.
  const decoded = unescapeJson(s)
  const inner = deepestMessage(decoded)
  if (inner) {
    // Replace the whole JSON blob (first `{` … last `}`) with its message. The
    // match must actually look like the provider payload, so a reason that
    // merely contains braces in prose keeps its text.
    const blob = /\{[\s\S]*\}/
    s = blob.test(s) && blob.test(s) && /"message"/.test(decoded)
      ? s.replace(/\{[\s\S]*\}/, inner)
      : decoded
  }
  s = s
    // Leftovers from the envelope once the message is lifted out.
    .replace(/\{\s*\}/g, '')
    .replace(/\[\s*\]/g, '')
    // A separator with nothing after it (dangling "reason:" / "reason,").
    .replace(/\s*[:;,]\s*(?=[—–-]|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * The kernel of a sub-agent fallback reason — for the banner that already says
 * the sub-agent's model died and the tool moved to the main model.
 *
 * Drops the two halves the banner restates out loud ("<tool> failed:",
 * "— trying the next model") and keeps what the user cannot infer: WHICH
 * failure forced the switch.
 */
export function fallbackReason(raw: string, max = 120): string {
  const s = raw
    .replace(INVISIBLE, '')
    .replace(/^\s*[^:]{1,40}?\bfailed\s*:\s*/i, '')
    .replace(/\s*[—–-]\s*trying the next model\s*$/i, '')
  return humanizeError(s, max)
}
