import { useState } from 'react'
import { useStore, workspaceKey } from '../lib/store'
import type { Chat, ChatMessage, Workspace } from '../types'
import { api } from '../lib/fs'
import { fixMixedText } from '../lib/bidi'

const WORKSPACE_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
]

function titleOf(chat: Chat): string {
  if (chat.title && chat.title !== 'New chat') return chat.title
  const firstUser = chat.messages.find((m) => m.role === 'user')
  return firstUser ? firstUser.content.slice(0, 48) : 'New chat'
}

/** Last path segment of a root folder, for a compact group label. */
function rootName(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  const last = parts[parts.length - 1]
  return last || root
}

interface Group {
  key: string
  label: string
  root: string | null
  chats: Chat[]
}

/**
 * Build sidebar groups from the PERSISTED workspace list (workspaces are
 * first-class and outlive their chats), then attach chats by workspace key.
 * Workspace order is user-controlled — only the chats INSIDE each workspace
 * sort by recency. Pinned workspaces float to the very top (in pin order).
 */
function buildGroups(
  chats: Chat[],
  workspaces: Workspace[],
  pinnedWorkspaces: string[],
): Group[] {
  const chatsByRoot = new Map<string, Chat[]>()
  for (const c of chats) {
    const key = workspaceKey(c.root ?? '')
    if (!chatsByRoot.has(key)) chatsByRoot.set(key, [])
    chatsByRoot.get(key)!.push(c)
  }

  const groups: Group[] = []
  for (const ws of workspaces) {
    const list = chatsByRoot.get(ws.key) ?? []
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    groups.push({
      key: ws.key,
      label: ws.label || (ws.root ? rootName(ws.root) : 'No project'),
      root: ws.root,
      chats: list,
    })
    chatsByRoot.delete(ws.key)
  }

  // Workspaces not yet in the persisted list (e.g. chats created before the
  // first-class workspace feature, or new roots) — appended after the ordered
  // ones so they never jump around the user's layout.
  const pinRank = (key: string) => {
    const i = pinnedWorkspaces.indexOf(key)
    return i === -1 ? Infinity : i
  }
  const leftovers = [...chatsByRoot.entries()].map(([key, list]) => {
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    const root = list.find((c) => c.root)?.root ?? ''
    return {
      key,
      label: root ? rootName(root) : 'No project',
      root: root || null,
      chats: list,
    }
  })
  leftovers.sort((a, b) => {
    const ar = pinRank(a.key)
    const br = pinRank(b.key)
    if (ar !== br) return ar - br
    const aLatest = Math.max(...a.chats.map((c) => c.updatedAt), 0)
    const bLatest = Math.max(...b.chats.map((c) => c.updatedAt), 0)
    return bLatest - aLatest
  })

  const ordered = [...groups, ...leftovers]
  // Pinned float to top, in pin order; the rest keep the persisted order.
  ordered.sort((a, b) => {
    const ar = pinRank(a.key)
    const br = pinRank(b.key)
    if (ar !== br) return ar - br
    return 0
  })
  return ordered
}

export function Sidebar() {
  const chats = useStore((s) => s.chats)
  const workspaces = useStore((s) => s.workspaces)
  const activeChatId = useStore((s) => s.activeChatId)
  const theme = useStore((s) => s.theme)
  const workspaceColors = useStore((s) => s.workspaceColors)
  const pinnedWorkspaces = useStore((s) => s.pinnedWorkspaces)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [colorOpen, setColorOpen] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  const open = useStore((s) => s.sidebarOpen)
  const dir = useStore((s) => s.dir)
  if (!open) return null

  const groups = buildGroups(chats, workspaces, pinnedWorkspaces)

  // Live plan checklist of the ACTIVE chat surfaced in the sidebar footer. Uses
  // the latest message that carries a non-empty plan; hidden once every item is
  // completed or no plan exists.
  const activeChat = chats.find((c) => c.id === activeChatId)
  const todos: ChatMessage['plan'] = []
  if (activeChat) {
    for (let i = activeChat.messages.length - 1; i >= 0; i--) {
      const plan = activeChat.messages[i].plan
      if (plan && plan.length > 0) {
        todos.push(...plan)
        break
      }
    }
  }
  const todosDone = todos.length > 0 && todos.every((t) => t.status === 'completed')

  const newWorkspace = async () => {
    const dir = await api.selectFolder()
    if (dir) useStore.getState().createWorkspace(dir)
  }

  const onDragStart = (e: React.DragEvent, key: string) => {
    setDragKey(key)
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData('text/plain', key)
    } catch {
      /* ignore dataTransfer restrictions (rare) */
    }
  }

  const onDragOver = (e: React.DragEvent, key: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverKey(key)
  }

  const onDrop = (e: React.DragEvent, targetKey: string) => {
    e.preventDefault()
    const from = dragKey || (e.dataTransfer.getData('text/plain') as string) || ''
    setDragKey(null)
    setDragOverKey(null)
    if (!from || from === targetKey) return
    const keys = groups.map((g) => g.key)
    const i = keys.indexOf(from)
    const j = keys.indexOf(targetKey)
    if (i === -1) return
    keys.splice(i, 1)
    keys.splice(j, 0, from)
    useStore.getState().setWorkspaceOrder(keys)
  }

  const onDragEnd = () => {
    setDragKey(null)
    setDragOverKey(null)
  }

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const startRename = (chat: Chat) => {
    setRenamingId(chat.id)
    setRenameValue(titleOf(chat) === 'New chat' ? '' : titleOf(chat))
  }

  const commitRename = () => {
    if (renamingId) useStore.getState().renameChat(renamingId, renameValue.trim() || 'New chat')
    setRenamingId(null)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-new">
        <button className="sidebar-new-btn" onClick={newWorkspace} title="Create a new workspace">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New workspace
        </button>
      </div>

      <div className="sidebar-list">
        {colorOpen !== null && <div className="color-backdrop" onClick={() => setColorOpen(null)} />}
        {chats.length === 0 && <div className="sidebar-empty">No conversations yet</div>}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key)
          const color = workspaceColors[g.key]
          const isPinned = pinnedWorkspaces.includes(g.key)
          return (
            <div
              key={g.key}
              className={`sidebar-group${isPinned ? ' pinned' : ''}${dragKey === g.key ? ' dragging' : ''}${dragOverKey === g.key && dragKey && dragKey !== g.key ? ' drop-target' : ''}`}
              style={color ? { '--ws': color } as React.CSSProperties : undefined}
              draggable
              onDragStart={(e) => onDragStart(e, g.key)}
              onDragOver={(e) => onDragOver(e, g.key)}
              onDrop={(e) => onDrop(e, g.key)}
              onDragEnd={onDragEnd}
            >
              <div className="sidebar-group-head">
                <button className="sidebar-group-toggle" onClick={() => toggleGroup(g.key)} title={g.root || g.label}>
                  <svg className="sidebar-group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={isCollapsed ? 'M6 9l6 6 6-6' : 'M18 15l-6-6-6 6'} />
                  </svg>
                  {color && <span className="sidebar-ws-dot" style={{ background: color }} title="Workspace color" />}
                  <svg className="sidebar-group-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span className="sidebar-group-label">{g.label}</span>
                  <span className="sidebar-group-count">{g.chats.length}</span>
                </button>
                <div className="sidebar-group-actions">
                  <button
                    className={`sidebar-group-btn${isPinned ? ' active' : ''}`}
                    title={isPinned ? 'Unpin workspace' : 'Pin to top'}
                    onClick={() => useStore.getState().togglePinWorkspace(g.key)}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 17v5M5 7h14M7 7l1-4h8l1 4M8 7v4l-2 3h12l-2-3V7" />
                    </svg>
                  </button>
                  <button
                    className="sidebar-group-btn color"
                    title="Workspace color"
                    onClick={() => setColorOpen(colorOpen === g.key ? null : g.key)}
                  >
                    <span className="sidebar-ws-dot" style={{ background: color || 'transparent', borderColor: color || 'currentColor' }} />
                  </button>
                  <button
                    className="sidebar-group-btn"
                    title="New chat in this workspace"
                    onClick={() => useStore.getState().newChatInRoot(g.root ?? '')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <button
                    className="sidebar-group-btn danger"
                    title="Delete workspace"
                    onClick={() => {
                      if (window.confirm(`Delete the "${g.label}" workspace and all ${g.chats.length} conversations?`))
                        useStore.getState().deleteWorkspace(g.key)
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </div>
                {colorOpen === g.key && (
                  <div className="color-popover" onClick={(e) => e.stopPropagation()}>
                    {WORKSPACE_COLORS.map((c2) => (
                      <button
                        key={c2}
                        className="color-swatch"
                        style={{ background: c2 }}
                        onClick={() => {
                          useStore.getState().setWorkspaceColor(g.key, c2)
                          setColorOpen(null)
                        }}
                      />
                    ))}
                    <button
                      className="color-none"
                      title="Remove color"
                      onClick={() => {
                        useStore.getState().setWorkspaceColor(g.key, '')
                        setColorOpen(null)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
              {!isCollapsed && (
                <div className="sidebar-group-chats" style={color ? { '--ws': color } as React.CSSProperties : undefined}>
                  {g.chats.map((c) => (
                    <div
                      key={c.id}
                      className={`chat-item ${c.id === activeChatId ? 'active' : ''}`}
                      onClick={() => useStore.getState().setActiveChat(c.id)}
                      title={titleOf(c)}
                    >
                      {renamingId === c.id ? (
                        <input
                          className="chat-rename-input"
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename()
                            else if (e.key === 'Escape') setRenamingId(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className="chat-item-title"
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            startRename(c)
                          }}
                        >
                          {titleOf(c)}
                        </span>
                      )}
                      <button
                        className="chat-item-edit"
                        title="Rename conversation"
                        onClick={(e) => {
                          e.stopPropagation()
                          startRename(c)
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                        </svg>
                      </button>
                      <button
                        className="chat-item-remove"
                        title="Delete conversation"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (window.confirm('Delete this conversation?')) useStore.getState().deleteChat(c.id)
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sidebar-footer">
        {todos.length > 0 && !todosDone && (
          <div className="sidebar-todos" dir={dir}>
            <div className="sidebar-todos-head">
              <span className="sidebar-todos-title">Todos</span>
              <span className="sidebar-todos-count">
                {todos.filter((t) => t.status === 'completed').length}/{todos.length}
              </span>
            </div>
            <ul className="sidebar-todos-list">
              {todos.map((t, i) => (
                <li
                  key={i}
                  className={`sidebar-todo-item ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'running' : ''}`}
                >
                  <span className="sidebar-todo-mark">
                    {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}
                  </span>
                  <span className="sidebar-todo-content">
                    {dir === 'rtl' ? fixMixedText(t.content) : t.content}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button
          className="sidebar-foot-btn"
          title="Toggle theme"
          onClick={() => useStore.getState().toggleTheme()}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
          <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
        <button
          className="sidebar-foot-btn"
          title="Settings (⌘,)"
          onClick={() => useStore.getState().setSettingsOpen(true)}
        >
          ⚙️
          <span>Settings</span>
        </button>
      </div>
    </aside>
  )
}