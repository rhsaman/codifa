// Pure helpers for multi-window chat headers and per-chat event isolation.
// No React/store imports so unit tests stay fast (plain node, no electron).
export function workspaceBaseName(root: string | null | undefined): string {
  if (!root) return 'No project'
  const trimmed = root.replace(/[\\/]+$/, '')
  if (!trimmed) return 'No project'
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

export function workspaceKeyFor(root: string | null | undefined): string {
  return (root ?? '') || '__none__'
}

// Only the focused (active) chat handles a global shortcut/event. Every
// mounted ChatPanel listens on window/document, so without this guard a
// single dispatch (voice toggle, attach-file, slash command, Space to stop
// dictation) fans out to ALL visible chats.
export function shouldHandleForChat(
  activeChatId: string | null | undefined,
  ownChatId: string | null | undefined,
): boolean {
  if (!ownChatId) return false
  return activeChatId === ownChatId
}

// Resolve which provider/model label a composer should show for one chat.
// Pure so multi-window header tests stay fast (plain node, no store).
// A chat with its own override keeps it; otherwise it follows the global
// active provider. Falls back to the first provider when the override
// points at a deleted provider.
export function resolveChatModel(
  chat: { providerId?: string; model?: string } | null | undefined,
  providers: Array<{ id: string; model: string }>,
  globalActiveId: string,
): { providerId: string; model: string | undefined } {
  // Explicit per-chat override to a provider that still exists: keep it.
  if (chat?.providerId) {
    const override = providers.find((p) => p.id === chat.providerId)
    if (override) return { providerId: override.id, model: chat.model ?? override.model }
    // Override points at a deleted provider: fall back to the global
    // active provider AND its model, never the stale override model.
    const global = providers.find((p) => p.id === globalActiveId) ?? providers[0]
    if (!global) return { providerId: globalActiveId, model: undefined }
    return { providerId: global.id, model: global.model }
  }
  const active = providers.find((p) => p.id === globalActiveId) ?? providers[0]
  if (!active) return { providerId: globalActiveId, model: undefined }
  return { providerId: active.id, model: chat?.model ?? active.model }
}

export interface WorkspaceLike {
  key: string
  root: string | null
  label: string
}

export function workspaceDisplayFor(
  chatRoot: string | null | undefined,
  workspaces: WorkspaceLike[],
  workspaceColors: Record<string, string>,
): { key: string; label: string; color: string; root: string | null } {
  const key = workspaceKeyFor(chatRoot ?? '')
  const ws = workspaces.find((w) => w.key === key)
  const label = ws?.label || workspaceBaseName(chatRoot ?? '')
  const root = ws?.root ?? (chatRoot ?? null)
  const color = workspaceColors[key] || 'var(--accent)'
  return { key, label, color, root }
}
