async function legacyCopy(text: string): Promise<boolean> {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  const sel = document.getSelection()
  const prevRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
  try {
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    return ok
  } finally {
    document.body.removeChild(ta)
    if (sel && prevRange) {
      sel.removeAllRanges()
      sel.addRange(prevRange)
    } else if (sel) {
      sel.removeAllRanges()
    }
  }
}

/** Copy text reliably on every platform. Prefers the Electron main-process
 *  clipboard (always available, no permission prompt); falls back to the Web
 *  Clipboard API, then to the legacy execCommand path (works even in
 *  non-secure contexts). Returns false only when every path failed. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const value = String(text ?? '')
  try {
    const w = window as Window & { coder?: { copyText?: (t: string) => Promise<boolean> } }
    if (typeof w.coder?.copyText === 'function') {
      const ok = await w.coder.copyText(value)
      if (ok) return true
    }
  } catch {
    /* fall through to the web API */
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    /* fall through to legacy */
  }
  return legacyCopy(value)
}