/** The composer textarea that belongs to ONE chat (exact match, no fallback).
 *  `null` while that chat's panel is still committing. */
function composerFor(chatId: string): HTMLTextAreaElement | null {
  if (!chatId || typeof document === 'undefined') return null
  try {
    const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(chatId)
      : chatId.replace(/["\\]/g, '')
    return document.querySelector<HTMLTextAreaElement>(
      `[data-chat-window="${esc}"] textarea.composer-input, [data-chat-id="${esc}"] textarea.composer-input`,
    )
  } catch {
    return null
  }
}

/** Focus the composer textarea of a chat window (pure DOM helper).
 *  Returns true when an input was found and focused. */
export function focusChatInput(chatId: string): boolean {
  if (!chatId || typeof document === 'undefined') return false
  const el = composerFor(chatId)
  if (el) {
    el.focus({ preventScroll: true })
    return true
  }
  try {
    // Only the LAST resort (a window whose id attribute is not in the DOM):
    // the visibly focused window. Never used by focusChatInputSoon, because a
    // brand-new chat would otherwise settle for the OLD window's composer.
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

/** Focus a chat's composer once its panel actually mounts. A store action
 *  (newChat) returns before React commits the new window — and a workspace
 *  switch can push that commit a frame or two further — so probing is the
 *  difference between "the caret is in the new chat" and "focus() found
 *  nothing". Strictly chat-scoped: an early frame can never land in the
 *  previously focused window. */
export function focusChatInputSoon(chatId: string, frames = 12): void {
  if (!chatId || typeof document === 'undefined') return
  if (typeof requestAnimationFrame !== 'function') return
  requestAnimationFrame(() => {
    const el = composerFor(chatId)
    if (el) {
      el.focus({ preventScroll: true })
      return
    }
    if (frames > 0) focusChatInputSoon(chatId, frames - 1)
  })
}
