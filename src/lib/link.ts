// Helpers for deciding how a markdown link should open.
//
// External http(s) links are forwarded to the OS browser via the Electron
// bridge (window.coder.openExternal); internal anchors (#, mailto:, etc.)
// keep their default in-app behaviour.

/** Any URI scheme prefix (`https:`, `mailto:`, `tel:`, `file:` …). */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** True when `href` points to an http(s) URL that should open externally. */
export function isExternalHref(href: string | undefined): boolean {
  return typeof href === 'string' && /^https?:\/\//i.test(href)
}

/**
 * Click handler for markdown links. When the link is external it prevents the
 * default in-app navigation and asks the OS browser to open it. Returns true
 * when the click was handled externally (so callers can ignore it further).
 */
export function handleLinkClick(
  e: { preventDefault: () => void },
  href: string | undefined,
  openExternal: (url: string) => void,
): boolean {
  if (isExternalHref(href)) {
    e.preventDefault()
    openExternal(href as string)
    return true
  }
  // A relative href has no page to land on inside the app: letting the default
  // navigation run replaced the whole webview with a dead URL, so the click is
  // swallowed and the label stays inert. `#anchor` and `mailto:`/`tel:` keep
  // their native behaviour.
  if (href && !href.startsWith('#') && !SCHEME_RE.test(href)) {
    e.preventDefault()
    return true
  }
  return false
}

/** One segment of text split by URLs: plain text, or a detected http(s) URL. */
export type UrlTextPart = string | { url: string }

const URL_SPLIT_RE = /https?:\/\/[^\s<>"'`]+/gi

/** Trailing punctuation that is rarely part of a URL (sentence period,
 * closing bracket/quote). Stripped from the link and kept as plain text. */
const URL_TRAIL_RE = /[.,;:!?)\]}'"`]+$/

/**
 * Split text on http(s) URLs so inline code spans can linkify only the URL
 * part. Pure (no DOM/window access) so plain-node tests can cover it.
 * Returns a single [input] entry when no URL is found.
 */
export function splitTextByUrls(raw: string): UrlTextPart[] {
  if (!raw || raw.indexOf('http') === -1) return [raw]
  const parts: UrlTextPart[] = []
  const re = new RegExp(URL_SPLIT_RE)
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    let url = m[0]
    const trail = URL_TRAIL_RE.exec(url)?.[0] ?? ''
    if (trail) url = url.slice(0, -trail.length)
    if (!url) continue
    const start = m.index
    if (start > last) parts.push(raw.slice(last, start))
    parts.push({ url })
    last = start + url.length
  }
  if (last < raw.length) parts.push(raw.slice(last))
  const nonEmpty = parts.filter((p) => typeof p !== 'string' || p.length > 0)
  return nonEmpty.length > 0 ? nonEmpty : [raw]
}

/** Collect just the URLs from text (convenience wrapper over splitTextByUrls). */
export function extractUrls(raw: string): string[] {
  return splitTextByUrls(raw).filter((p): p is { url: string } => typeof p !== 'string').map((p) => p.url)
}
