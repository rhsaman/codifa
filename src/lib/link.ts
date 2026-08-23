// Helpers for deciding how a markdown link should open.
//
// External http(s) links are forwarded to the OS browser via the Electron
// bridge (window.coder.openExternal); internal anchors (#, mailto:, etc.)
// keep their default in-app behaviour.

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
  return false
}
