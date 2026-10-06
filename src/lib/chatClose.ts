// Pure helper for Ctrl/Cmd+W chat close behavior.
// Multi-window: close the focused WINDOW (chat stays in the sidebar).
// Single window: close the TAB (legacy behavior).
export type ChatCloseAction =
  | { kind: "window"; id: string }
  | { kind: "tab"; id: string };

export function resolveChatClose(
  winId: string | null | undefined,
  visibleChatIds: string[],
  activeChatId: string,
): ChatCloseAction | null {
  const focused = winId || activeChatId;
  if (!focused) return null;
  if (visibleChatIds.length > 1) return { kind: "window", id: focused };
  const tabId = activeChatId || focused;
  if (!tabId) return null;
  return { kind: "tab", id: tabId };
}
