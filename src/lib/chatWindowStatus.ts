/** Status for a multi-window header, same language as sidebar rows and chat tabs:
 *  blinking accent dot while streaming, green dot when the turn finished
 *  elsewhere, shield/? badges while waiting on the user. Pure for tests. */
export interface WindowChatStatusInput {
  messages: Array<{ streaming?: boolean; retry?: { reconnecting?: boolean } | null }>
  pendingPermission?: { action: string; path?: string } | null
  pendingAsk?: { question: string } | null
}

export interface WindowChatStatus {
  streaming: boolean
  unread: boolean
  pendingPermission: { action: string; path?: string } | null
  pendingAsk: { question: string } | null
}

export function windowStatusFor(
  chat: WindowChatStatusInput | undefined,
  chatId: string,
  activeChatId: string,
  unreadChats: string[],
): WindowChatStatus {
  const streaming = chat?.messages.some((m) => m.streaming || m.retry?.reconnecting === true) ?? false
  const pendingPermission = chat?.pendingPermission
    ? { action: chat.pendingPermission.action, path: chat.pendingPermission.path }
    : null
  const pendingAsk = chat?.pendingAsk ? { question: chat.pendingAsk.question } : null
  const unread =
    !streaming && !pendingPermission && !pendingAsk && chatId !== activeChatId && unreadChats.includes(chatId)
  return { streaming, unread, pendingPermission, pendingAsk }
}
