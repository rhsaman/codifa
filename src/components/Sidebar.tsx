import { useEffect, useRef, useState } from 'react'
import { useStore, workspaceKey } from '../lib/store'
import type { Chat, ChatMessage, ProviderConfig, Workspace } from '../types'
import { api } from '../lib/fs'
import { prepareContent } from '../lib/bidi'
import { formatTokens, formatCost } from '../lib/context'

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
  pinnedChats: string[],
): Group[] {
  const chatsByRoot = new Map<string, Chat[]>()
  for (const c of chats) {
    const key = workspaceKey(c.root ?? '')
    if (!chatsByRoot.has(key)) chatsByRoot.set(key, [])
    chatsByRoot.get(key)!.push(c)
  }

  // Pinned chats float to the top of their group (most-recently-pinned first),
  // then the rest sort by recency.
  const pinRankChat = (id: string) => {
    const i = pinnedChats.indexOf(id)
    return i === -1 ? Infinity : i
  }
  const sortChats = (list: Chat[]) => {
    list.sort((a, b) => {
      const ar = pinRankChat(a.id)
      const br = pinRankChat(b.id)
      if (ar !== br) return ar - br
      return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
    })
  }

  const groups: Group[] = []
  for (const ws of workspaces) {
    const list = chatsByRoot.get(ws.key) ?? []
    sortChats(list)
    // Don't show a "No project" bucket when it has nothing in it — the
    // sidebar stays empty instead of rendering a point-less heading.
    if (!ws.root && list.length === 0) {
      chatsByRoot.delete(ws.key)
      continue
    }
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
    sortChats(list)
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
  const pinnedChats = useStore((s) => s.pinnedChats)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [colorOpen, setColorOpen] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  const open = useStore((s) => s.sidebarOpen)
  const dir = useStore((s) => s.dir)
  const provider = useStore(
    (s) =>
      s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ??
      s.settings.providers[0],
  )

  // ---- Footer panel state (todos + model usage), VSCode-style: each panel is
  // collapsible and its content height is user-resizable via a drag handle. ----
  const [todoCollapsed, setTodoCollapsed] = useState(false)
  const [usageCollapsed, setUsageCollapsed] = useState(false)
  const [todoHeight, setTodoHeight] = useState(320)
  const [usageHeight, setUsageHeight] = useState(320)
  // Tracks CLOSED groups (not open ones) so every provider starts expanded
  // by default — the user has to collapse a group explicitly to hide it.
  const [usageGroupsClosed, setUsageGroupsClosed] = useState<Set<string>>(new Set())
  const todoDrag = useRef<{ startY: number; startH: number } | null>(null)
  const usageDrag = useRef<{ startY: number; startH: number } | null>(null)

  // Sidebar width — drag-resizable on the right edge (VSCode-style), persisted
  // locally so the layout survives restarts.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('coder:sidebarWidth')
    const n = saved ? parseInt(saved, 10) : 264
    return Number.isFinite(n) ? Math.max(180, Math.min(480, n)) : 264
  })
  const sidebarDrag = useRef<{ startX: number; startW: number } | null>(null)
  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault()
    sidebarDrag.current = { startX: e.clientX, startW: sidebarWidth }
    const onMove = (ev: MouseEvent) => {
      if (!sidebarDrag.current) return
      const w = Math.max(180, Math.min(480, sidebarDrag.current.startW + (ev.clientX - sidebarDrag.current.startX)))
      setSidebarWidth(w)
      localStorage.setItem('coder:sidebarWidth', String(w))
    }
    const onUp = () => {
      sidebarDrag.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const allProviders = useStore((s) => s.settings.providers)
  const recentModels = useStore((s) => s.recentModels)

  const groups = buildGroups(chats, workspaces, pinnedWorkspaces, pinnedChats)

  // Live plan checklist of the ACTIVE chat surfaced in the sidebar footer. Uses
  // the latest message that carries a non-empty plan; hidden only when no plan
  // exists. Completed items stay visible with ticks so the finished checklist
  // remains in view.
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

  // Per-model token usage + cost for the active chat (session totals), grouped
  // by provider and sorted by most-recently-used first. Each used model is
  // attributed to a provider by matching its id/current model; ids that match
  // no provider (e.g. an old model after the user switched provider) land in a
  // dedicated "Unknown" group instead of being silently merged into the ACTIVE
  // provider — so a previous main model/provider always stays visible.
  // Gemini's API reports model ids with a literal "models/" prefix
  // ("models/gemini-3.7-flash"), which the backend strips before recording
  // usage (so usage keys are bare "gemini-3.7-flash"). Normalize the prefix
  // away on BOTH sides so a provider always matches the usage it actually ran
  // with the strong exact match instead of tying with openrouter's bare-name
  // match (its list carries "google/gemini-...") and losing on array order.
  const norm = (m: string): string => (m || '').replace(/^models\//, '')
  const bareId = (m: string): string => norm(m).split('/').pop() || m
  const providerForModel = (model: string): ProviderConfig | undefined => {
    if (!model || model === 'main') return undefined
    const key = norm(model)
    const bare = bareId(model)
    const lower = key.toLowerCase()
    // The ALL-in-one `find` (bare-id first) misattributes a model to whichever
    // provider happens to be first in the array when two providers share a model
    // with the same last path segment (e.g. openrouter/free vs myprovider/free).
    // Resolve by decreasing specificity instead so the RIGHT provider wins.
    //
    // Many models are ALSO advertised by the opencode gateway's /models list
    // (it mirrors nearly every model), so a bare list match is too weak to
    // distinguish "ran via Google" from "listed by the opencode gateway". A
    // provider whose CURRENT configured model is the used one, or that the app
    // recently recorded actually running this model (recentModels), is a much
    // stronger signal and must outrank a plain list hit.
    const scoredBy = new Map<string, number>()
    const scoreOf = (p: ProviderConfig): number => {
      const cached = scoredBy.get(p.id)
      if (cached !== undefined) return cached
      const pModel = norm(p.model || '')
      const pModels = (p.models ?? []).map(norm)
      const pId = (p.id || '').toLowerCase()
      const pName = (p.name || '').toLowerCase()
      let s = 0
      // Recorded use: the app recently ran this exact model on this provider.
      if (recentModels.some((r) => r.providerId === p.id && norm(r.model) === key)) s = Math.max(s, 5)
      // Current configured model matches the used model.
      if (pModel === key) s = Math.max(s, 4)
      // Exact full model id in this provider's model list.
      if (pModels.includes(key)) s = Math.max(s, 3)
      // Provider id/name is a prefix of the model id.
      if ((pId && lower.startsWith(pId + '/')) || (pName && lower.startsWith(pName + '/'))) s = Math.max(s, 2)
      // Weakest: bare-name match (last path segment) — only as a last resort.
      if (pModel === bare || bareId(pModel) === bare ||
          pModels.some((m) => m === bare || bareId(m) === bare)) s = Math.max(s, 1)
      scoredBy.set(p.id, s)
      return s
    }
    let best: ProviderConfig | undefined
    let bestScore = 0
    for (const p of allProviders) {
      const s = scoreOf(p)
      if (s < bestScore) continue
      // Among equal scores prefer the ACTIVE provider (the one the user has
      // selected) over plain array order, so genuinely ambiguous ties land on
      // what the user currently sees rather than the first configured row.
      if (s > bestScore || (best && p.id === provider?.id)) {
        bestScore = s
        best = p
      }
    }
    return best
  }
  const usageGroups = new Map<string, Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null; lastUsed: number }>>()
  if (activeChat?.usage) {
    for (const [model, u] of Object.entries(activeChat.usage)) {
      if (u.input + u.output <= 0) continue
      const p = providerForModel(model)
      // Unmatched models (e.g. an old provider after the user switched) are
      // grouped under a name derived from the model id itself — never silently
      // merged into the ACTIVE provider and never hidden as a single "Unknown".
      const derived = (model.split('/')[0] || 'unknown').trim() || 'unknown'
      const key = p?.id ?? derived
      const price = p?.pricingMap?.[model]
      // Cost bills cache-read/cache-write tokens at their own (cheaper) rate
      // when the provider advertises one — input_tokens already includes the
      // cache portion, so it must be split out before charging full input.
      const cacheRead = u.cacheRead ?? 0
      const cacheWrite = u.cacheWrite ?? 0
      const cost = price
        ? ((u.input - cacheRead - cacheWrite) / 1_000_000) * price.input +
          (cacheRead / 1_000_000) * (price.cacheRead ?? price.input) +
          (cacheWrite / 1_000_000) * (price.cacheWrite ?? price.input) +
          (u.output / 1_000_000) * price.output
        : null
      if (!usageGroups.has(key)) usageGroups.set(key, [])
      usageGroups.get(key)!.push({ model, input: u.input, output: u.output, cacheRead, cacheWrite, cost, lastUsed: u.lastUsed ?? 0 })
    }
  }
  // Sort each provider group by total usage (heaviest first); ties by most
  // recently used so the freshest model wins when token counts are equal.
  for (const entries of usageGroups.values()) {
    entries.sort((a, b) => {
      const d = b.input + b.output - (a.input + a.output)
      if (d !== 0) return d
      return (b.lastUsed ?? 0) - (a.lastUsed ?? 0)
    })
  }
  // Provider groups ordered by total usage (the biggest consumer on top);
  // ties by the group's most recently used model.
  const usageGroupOrder = [...usageGroups.entries()].sort((a, b) => {
    const aTotal = a[1].reduce((s, e) => s + e.input + e.output, 0)
    const bTotal = b[1].reduce((s, e) => s + e.input + e.output, 0)
    if (aTotal !== bTotal) return bTotal - aTotal
    const aLast = Math.max(...a[1].map((e) => e.lastUsed ?? 0), 0)
    const bLast = Math.max(...b[1].map((e) => e.lastUsed ?? 0), 0)
    return bLast - aLast
  })
  // Grand total across every provider group, shown right in the panel header
  // so the full session usage/cost is visible without expanding each group.
  let usageGrandTokens = 0
  let usageGrandCost: number | null = null
  for (const [, entries] of usageGroupOrder) {
    for (const e of entries) {
      usageGrandTokens += e.input + e.output
      if (e.cost !== null) usageGrandCost = (usageGrandCost ?? 0) + e.cost
    }
  }

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

  if (!open) return null

  return (
    <aside
      className="sidebar"
      style={
        {
          flexBasis: sidebarWidth,
          width: sidebarWidth,
          '--sidebar-w': `${sidebarWidth}px`,
        } as React.CSSProperties
      }
    >
      <div
        className="sidebar-resize-handle"
        title="Drag to resize sidebar"
        onMouseDown={startSidebarResize}
      />
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
                  {g.chats.map((c) => {
                    const isPinnedChat = pinnedChats.includes(c.id)
                    return (
                      <div
                        key={c.id}
                        className={`chat-item ${c.id === activeChatId ? 'active' : ''}${isPinnedChat ? ' pinned' : ''}`}
                        onClick={() => useStore.getState().setActiveChat(c.id)}
                        title={prepareContent(titleOf(c), dir)}
                      >
                      <div className="chat-item-actions">
                        <button
                          className={`chat-item-pin${isPinnedChat ? ' active' : ''}`}
                          title={isPinnedChat ? 'Unpin conversation' : 'Pin to top'}
                          onClick={(e) => {
                            e.stopPropagation()
                            useStore.getState().togglePinChat(c.id)
                          }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill={isPinnedChat ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 17v5M5 7h14M7 7l1-4h8l1 4M8 7v4l-2 3h12l-2-3V7" />
                          </svg>
                        </button>
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
                      {renamingId === c.id ? (
                        <input
                          className="chat-rename-input"
                          dir={dir}
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
                        <span className="chat-item-title-row" dir={dir}>
                          <span
                            className="chat-item-title"
                            onDoubleClick={(e) => {
                              e.stopPropagation()
                              startRename(c)
                            }}
                          >
                            {prepareContent(titleOf(c), dir)}
                          </span>
                          {c.messages.some((m) => m.streaming) && (
                            <span className="chat-item-streaming" title="Agent is working in this chat" />
                          )}
                        </span>
                      )}
                    </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sidebar-footer">
        {todos.length > 0 && (
          <div className={`sidebar-panel ${todoCollapsed ? 'collapsed' : ''}`} dir={dir}>
            <div
              className="sidebar-panel-head"
              onClick={() => setTodoCollapsed((v) => !v)}
              title={todoCollapsed ? 'Expand Todos' : 'Collapse Todos'}
            >
              <span className="sidebar-panel-chevron">{todoCollapsed ? '▸' : '▾'}</span>
              <span className="sidebar-panel-title">Todos</span>
              <span className="sidebar-panel-count">
                {todos.filter((t) => t.status === 'completed').length}/{todos.length}
              </span>
            </div>
            {!todoCollapsed && (
              <>
                <div
                  className="sidebar-panel-resize"
                  title="Drag up to grow, down to shrink"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    todoDrag.current = { startY: e.clientY, startH: todoHeight }
                    const onMove = (ev: MouseEvent) => {
                      if (!todoDrag.current) return
                      setTodoHeight(
                        Math.max(60, Math.min(760, todoDrag.current.startH - (ev.clientY - todoDrag.current.startY))),
                      )
                    }
                    const onUp = () => {
                      todoDrag.current = null
                      window.removeEventListener('mousemove', onMove)
                      window.removeEventListener('mouseup', onUp)
                    }
                    window.addEventListener('mousemove', onMove)
                    window.addEventListener('mouseup', onUp)
                  }}
                />
                <ul className="sidebar-todos-list" style={{ maxHeight: todoHeight }}>
                  {todos.map((t, i) => (
                    <li
                      key={i}
                      className={`sidebar-todo-item ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'running' : ''}`}
                    >
                      <span className="sidebar-todo-mark">
                        {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}
                      </span>
                      <span className="sidebar-todo-content">
                        {prepareContent(t.content, dir)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {usageGroups.size > 0 && (
          <div className={`sidebar-panel ${usageCollapsed ? 'collapsed' : ''}`} dir="ltr">
            <div
              className="sidebar-panel-head"
              onClick={() => setUsageCollapsed((v) => !v)}
              title={usageCollapsed ? 'Expand Model usage' : 'Collapse Model usage'}
            >
              <span className="sidebar-panel-chevron">{usageCollapsed ? '▸' : '▾'}</span>
              <span className="sidebar-panel-title">Model usage</span>
              <span className="sidebar-usage-grand-total" title="Total tokens · cost this session">
                {formatTokens(usageGrandTokens)}
                {usageGrandCost !== null && <span className="sidebar-usage-grand-cost"> · {formatCost(usageGrandCost)}</span>}
              </span>
              <button
                className="sidebar-usage-reset"
                title="Reset all model usage to zero"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm('Reset token usage and cost for all models in this chat?')) {
                    useStore.getState().resetChatUsage(activeChatId)
                  }
                }}
              >
                ↺
              </button>
            </div>
            {!usageCollapsed && (
              <>
                <div
                  className="sidebar-panel-resize"
                  title="Drag up to grow, down to shrink"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    usageDrag.current = { startY: e.clientY, startH: usageHeight }
                    const onMove = (ev: MouseEvent) => {
                      if (!usageDrag.current) return
                      setUsageHeight(
                        Math.max(60, Math.min(760, usageDrag.current.startH - (ev.clientY - usageDrag.current.startY))),
                      )
                    }
                    const onUp = () => {
                      usageDrag.current = null
                      window.removeEventListener('mousemove', onMove)
                      window.removeEventListener('mouseup', onUp)
                    }
                    window.addEventListener('mousemove', onMove)
                    window.addEventListener('mouseup', onUp)
                  }}
                />
                <div className="sidebar-usage-groups" style={{ maxHeight: usageHeight }}>
                  {usageGroupOrder.map(([pid, entries]) => {
                    const pcfg = allProviders.find((p) => p.id === pid) ?? null
                    // Inverted: a group is open unless the user explicitly closed it,
                    // so every provider starts expanded by default.
                    const open = !usageGroupsClosed.has(pid)
                    const groupTokens = entries.reduce((s, e) => s + e.input + e.output, 0)
                    const groupCost = entries.reduce<number | null>((s, e) => {
                      if (e.cost === null) return s
                      return (s ?? 0) + e.cost
                    }, null)
                    return (
                      <div key={pid} className={`sidebar-usage-group${open ? ' open' : ''}`}>
                        <div
                          className="sidebar-usage-group-head"
                          onClick={() =>
                            setUsageGroupsClosed((prev) => {
                              const next = new Set(prev)
                              if (next.has(pid)) next.delete(pid)
                              else next.add(pid)
                              return next
                            })
                          }
                        >
                          <span className="sidebar-panel-chevron small">{open ? '▾' : '▸'}</span>
                          <span className="sidebar-usage-group-dot" aria-hidden />
                          <span className="sidebar-usage-group-name">{pcfg?.name ?? pid}</span>
                          <span className="sidebar-usage-group-total">
                            {formatTokens(groupTokens)}
                            {groupCost !== null && <span className="sidebar-usage-cost"> · {formatCost(groupCost)}</span>}
                          </span>
                        </div>
                        {open && (
                          <ul className="sidebar-usage-list">
                            <li className="sidebar-usage-head" aria-hidden>
                              <span>Model</span>
                              <span>Tokens</span>
                              <span>Cost</span>
                            </li>
                            {entries.map(({ model, input, output, cost }) => (
                              <li key={model} className="sidebar-usage-item">
                                <span className="sidebar-usage-model" title={model}>
                                  {model ? model.split('/').pop() : 'main'}
                                </span>
                                <span className="sidebar-usage-tokens">
                                  {formatTokens(input + output)}
                                </span>
                                <span className={`sidebar-usage-cost${cost === null ? ' no-price' : ''}`}>
                                  {cost !== null ? formatCost(cost) : '—'}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
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