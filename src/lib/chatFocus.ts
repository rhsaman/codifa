/** Focus the composer textarea of a chat window (pure DOM helper).
 *  Returns true when an input was found and focused. */
export function focusChatInput(chatId: string): boolean {
  if (!chatId || typeof document === 'undefined') return false
  try {
    const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(chatId)
      : chatId.replace(/["\\]/g, '')
    const el = document.querySelector<HTMLTextAreaElement>(
      `[data-chat-window="${esc}"] textarea.composer-input, [data-chat-id="${esc}"] textarea.composer-input`,
    )
    if (el) {
      el.focus({ preventScroll: true })
      return true
    }
    const fallback = document.querySelector<HTMLTextAreaElement>(
      '.chat-window.focused textarea.composer-input',
    )
    if (fallback) {
      fallback.focus({ preventScroll: true })
      return true
    }
  } catch {
    /* DOM unavailable */
  }
  return false
}
