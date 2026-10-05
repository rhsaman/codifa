/** VSCode-like split tree for chat windows.
 *  A leaf shows one chat; a split arranges its children in a row
 *  (side-by-side) or a column (stacked). Any leaf can be split in any
 *  direction by dropping a tab/sidebar row or another window header onto
 *  one of its four edges, so the user can arrange the page arbitrarily.
 *  Center drop focuses (external drag replaces the target window).
 *  All helpers are pure and immutable (return new trees) for tests. */

export type ChatSplitDir = 'row' | 'col'
export type ChatDropPos = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface ChatTreeLeaf {
  kind: 'leaf'
  id: string
  chatId: string
  size: number
}

export interface ChatTreeSplit {
  kind: 'split'
  id: string
  dir: ChatSplitDir
  size: number
  children: ChatTreeNode[]
}

export type ChatTreeNode = ChatTreeLeaf | ChatTreeSplit

const TREE_KEY = 'coder:chatTree'

function nid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function clampSize(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.max(0.25, Math.min(4, n))
}

/** Minimum pane size in px: below this the chat text and composer break.
 *  Mirrored in CSS (.chat-windows.tree .chat-window and split children). */
export const CHAT_WINDOW_MIN_W = 400
export const CHAT_WINDOW_MIN_H = 320
/** Maximum open chat windows: beyond this every pane would drop below the
 *  minimum size, so new drops only focus instead of splitting. */
export const CHAT_WINDOW_MAX = 4

export function makeLeaf(chatId: string, size = 1, id?: string): ChatTreeLeaf {
  return { kind: 'leaf', id: id ?? nid('leaf'), chatId, size: clampSize(size) }
}

export function makeSplit(
  dir: ChatSplitDir,
  children: ChatTreeNode[],
  size = 1,
  id?: string,
): ChatTreeSplit {
  return { kind: 'split', id: id ?? nid('split'), dir, size: clampSize(size), children }
}

export function dirForPos(pos: ChatDropPos): ChatSplitDir | null {
  if (pos === 'left' || pos === 'right') return 'row'
  if (pos === 'top' || pos === 'bottom') return 'col'
  return null
}

export function beforePos(pos: ChatDropPos): boolean {
  return pos === 'left' || pos === 'top'
}

/** All chat ids in tree order (depth-first, left-to-right / top-to-bottom). */
export function collectChatIds(node: ChatTreeNode | null): string[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node.chatId]
  const out: string[] = []
  for (const c of node.children) out.push(...collectChatIds(c))
  return out
}

export function leafCount(node: ChatTreeNode | null): number {
  if (!node) return 0
  if (node.kind === 'leaf') return 1
  return node.children.reduce((n, c) => n + leafCount(c), 0)
}

export function containsChat(node: ChatTreeNode | null, chatId: string): boolean {
  if (!node) return false
  if (node.kind === 'leaf') return node.chatId === chatId
  return node.children.some((c) => containsChat(c, chatId))
}

export function findLeafByChat(
  node: ChatTreeNode | null,
  chatId: string,
): ChatTreeLeaf | null {
  if (!node) return null
  if (node.kind === 'leaf') return node.chatId === chatId ? node : null
  for (const c of node.children) {
    const hit = findLeafByChat(c, chatId)
    if (hit) return hit
  }
  return null
}

export function findNodeById(
  node: ChatTreeNode | null,
  id: string,
): ChatTreeNode | null {
  if (!node) return null
  if (node.id === id) return node
  if (node.kind === 'split') {
    for (const c of node.children) {
      const hit = findNodeById(c, id)
      if (hit) return hit
    }
  }
  return null
}

/** Parent split of the node with the given node id (null for root / missing). */
export function findParent(
  node: ChatTreeNode | null,
  childId: string,
): ChatTreeSplit | null {
  if (!node || node.kind !== 'split') return null
  for (const c of node.children) {
    if (c.id === childId) return node
    if (c.kind === 'split') {
      const hit = findParent(c, childId)
      if (hit) return hit
    }
  }
  return null
}

export function findParentOfChat(
  node: ChatTreeNode | null,
  chatId: string,
): ChatTreeSplit | null {
  const leaf = findLeafByChat(node, chatId)
  if (!leaf) return null
  return findParent(node, leaf.id)
}

function collapse(node: ChatTreeNode): ChatTreeNode | null {
  if (node.kind === 'leaf') return node
  if (node.children.length === 0) return null
  if (node.children.length === 1) {
    const only = node.children[0]
    // Preserve the outer size so sibling proportions survive the collapse.
    return { ...only, size: clampSize(node.size) } as ChatTreeNode
  }
  return node
}

/** Remove a chat leaf; collapses single-child splits. Null when empty. */
export function removeChat(
  node: ChatTreeNode | null,
  chatId: string,
): ChatTreeNode | null {
  if (!node) return null
  if (node.kind === 'leaf') return node.chatId === chatId ? null : node
  const children: ChatTreeNode[] = []
  for (const c of node.children) {
    const next = removeChat(c, chatId)
    if (next) children.push(next)
  }
  if (children.length === node.children.length) return node
  return collapse({ ...node, children })
}

/** Swap the chat ids of two visible leaves (center drop of a window). */
export function swapChats(
  node: ChatTreeNode | null,
  a: string,
  b: string,
): ChatTreeNode | null {
  if (!node) return null
  if (node.kind === 'leaf') {
    if (node.chatId === a) return { ...node, chatId: b }
    if (node.chatId === b) return { ...node, chatId: a }
    return node
  }
  let changed = false
  const children = node.children.map((c) => {
    const next = swapChats(c, a, b) ?? c
    if (next !== c) changed = true
    return next
  })
  return changed ? { ...node, children } : node
}

function replaceChat(
  node: ChatTreeNode,
  targetChatId: string,
  nextChatId: string,
): ChatTreeNode {
  if (node.kind === 'leaf') {
    return node.chatId === targetChatId ? { ...node, chatId: nextChatId } : node
  }
  let changed = false
  const children = node.children.map((c) => {
    const next = replaceChat(c, targetChatId, nextChatId)
    if (next !== c) changed = true
    return next
  })
  return changed ? { ...node, children } : node
}

/** Drop normalization: keeps order, drops unknown/dupe ids. Pure for tests. */
export function normalizeTree(
  node: ChatTreeNode | null,
  validIds: Set<string>,
): ChatTreeNode | null {
  if (!node) return null
  if (node.kind === 'leaf') {
    return validIds.has(node.chatId) ? { ...node, size: clampSize(node.size) } : null
  }
  const seen = new Set<string>()
  const children: ChatTreeNode[] = []
  for (const c of node.children) {
    if (c.kind === 'leaf') {
      if (!validIds.has(c.chatId) || seen.has(c.chatId)) continue
      seen.add(c.chatId)
      children.push({ ...c, size: clampSize(c.size) })
    } else {
      const next = normalizeTree(c, validIds)
      if (!next) continue
      for (const id of collectChatIds(next)) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      // A nested split that duplicates an already-kept chat is dropped.
      const ids = collectChatIds(next)
      if (ids.length === 0 || ids.some((id) => {
        // Count occurrences across kept children so far.
        const all = children.flatMap(collectChatIds)
        return all.includes(id)
      })) {
        // Re-check: keep the split only when it adds a new chat.
        const fresh = ids.filter((id) => !children.flatMap(collectChatIds).includes(id))
        if (fresh.length === 0) continue
      }
      children.push(next)
    }
  }
  if (children.length === 0) return null
  return collapse({ ...node, children })
}

/** Build a flat split from an ordered id list (migration / fallback). */
export function buildFromList(
  ids: string[],
  dir: ChatSplitDir,
  sizes?: Record<string, number>,
): ChatTreeNode | null {
  const clean = [...new Set(ids.filter(Boolean))]
  if (clean.length === 0) return null
  if (clean.length === 1) return makeLeaf(clean[0], sizes?.[clean[0]] ?? 1)
  return makeSplit(
    dir,
    clean.map((chatId) => makeLeaf(chatId, sizes?.[chatId] ?? 1)),
  )
}

/** Append a chat to the root level (no position). */
export function appendChat(
  node: ChatTreeNode | null,
  chatId: string,
  dir: ChatSplitDir,
): ChatTreeNode {
  if (!node) return makeLeaf(chatId)
  if (containsChat(node, chatId)) return node
  // Full: refuse a new window so panes never shrink below the minimum size.
  if (leafCount(node) >= CHAT_WINDOW_MAX) return node
  if (node.kind === 'leaf') {
    return makeSplit(dir, [node, makeLeaf(chatId)])
  }
  return { ...node, children: [...node.children, makeLeaf(chatId)] }
}

/** Core VSCode-like drop: drag chat onto target leaf edge or center. */
export function dropOnto(
  root: ChatTreeNode | null,
  dragChatId: string,
  targetChatId: string,
  pos: ChatDropPos,
): ChatTreeNode | null {
  if (!dragChatId || !targetChatId) return root
  if (dragChatId === targetChatId) return root
  // Full: a new chat cannot split in, only moves of visible chats are allowed.
  if (root && !containsChat(root, dragChatId) && leafCount(root) >= CHAT_WINDOW_MAX) return root
  if (pos === 'center') {
    if (!root) return makeLeaf(dragChatId)
    if (containsChat(root, dragChatId)) return swapChats(root, dragChatId, targetChatId)
    if (!containsChat(root, targetChatId)) return appendChat(root, dragChatId, 'col')
    return replaceChat(root, targetChatId, dragChatId)
  }
  const dirNeeded = dirForPos(pos)
  if (!dirNeeded) return root
  const before = beforePos(pos)
  if (!root) return makeLeaf(dragChatId)

  // Same-parent reorder along the same axis: just move, never nest.
  const dragLeaf = findLeafByChat(root, dragChatId)
  const targetLeaf = findLeafByChat(root, targetChatId)
  if (dragLeaf && targetLeaf) {
    const pDrag = findParent(root, dragLeaf.id)
    const pTarget = findParent(root, targetLeaf.id)
    if (pDrag && pTarget && pDrag.id === pTarget.id && pDrag.dir === dirNeeded) {
      const rest = pTarget.children.filter((c) => c.id !== dragLeaf.id)
      let dest = rest.findIndex((c) => c.id === targetLeaf.id) + (before ? 0 : 1)
      dest = Math.max(0, Math.min(rest.length, dest))
      const reordered = rest.slice()
      reordered.splice(dest, 0, dragLeaf)
      return replaceNode(root, pTarget.id, { ...pTarget, children: reordered })
    }
  }

  const dragSize = dragLeaf?.size ?? 1
  const base = containsChat(root, dragChatId) ? removeChat(root, dragChatId) : root
  if (!base) return makeLeaf(dragChatId, dragSize)
  const target = findLeafByChat(base, targetChatId)
  if (!target) return appendChat(base, dragChatId, dirNeeded)
  const fresh = makeLeaf(dragChatId, dragSize)
  const parent = findParent(base, target.id)
  if (parent && parent.dir === dirNeeded) {
    const idx = parent.children.findIndex((c) => c.id === target.id)
    const children = parent.children.slice()
    children.splice(before ? idx : idx + 1, 0, fresh)
    return replaceNode(base, parent.id, { ...parent, children })
  }
  const split = makeSplit(
    dirNeeded,
    before ? [fresh, { ...target }] : [{ ...target }, fresh],
    target.size,
  )
  ;(split.children[0] as ChatTreeLeaf).size = 1
  ;(split.children[1] as ChatTreeLeaf).size = 1
  return replaceNode(base, target.id, split)
}

function replaceNode(
  node: ChatTreeNode,
  id: string,
  next: ChatTreeNode,
): ChatTreeNode {
  if (node.id === id) return next
  if (node.kind === 'leaf') return node
  let changed = false
  const children = node.children.map((c) => {
    const r = replaceNode(c, id, next)
    if (r !== c) changed = true
    return r
  })
  return changed ? { ...node, children } : node
}

/** Set a node size by node id (resize handle). */
export function setNodeSize(
  node: ChatTreeNode | null,
  id: string,
  size: number,
): ChatTreeNode | null {
  if (!node) return null
  if (node.id === id) return { ...node, size: clampSize(size) } as ChatTreeNode
  if (node.kind === 'leaf') return node
  let changed = false
  const children = node.children.map((c) => {
    const next = setNodeSize(c, id, size)
    if (next && next !== c) changed = true
    return next ?? c
  })
  return changed ? { ...node, children } : node
}

/** Set a leaf size by chat id. */
export function setChatSize(
  node: ChatTreeNode | null,
  chatId: string,
  size: number,
): ChatTreeNode | null {
  const leaf = findLeafByChat(node, chatId)
  if (!leaf) return node
  return setNodeSize(node, leaf.id, size)
}

/** Resize two sibling children atomically (one store update per frame). */
export function resizePair(
  node: ChatTreeNode | null,
  parentId: string,
  firstId: string,
  secondId: string,
  firstSize: number,
  secondSize: number,
): ChatTreeNode | null {
  const step = setNodeSize(node, firstId, firstSize)
  return setNodeSize(step, secondId, secondSize)
}

export function rootDir(node: ChatTreeNode | null): ChatSplitDir | null {
  if (!node || node.kind !== 'split') return null
  return node.dir
}

export function setRootDir(
  node: ChatTreeNode | null,
  dir: ChatSplitDir,
): ChatTreeNode | null {
  if (!node || node.kind !== 'split') return node
  if (node.dir === dir) return node
  return { ...node, dir }
}

/** Sizes keyed by chat id for legacy compat (chatWindowSizes mirror). */
export function sizesByChat(node: ChatTreeNode | null): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (n: ChatTreeNode | null) => {
    if (!n) return
    if (n.kind === 'leaf') out[n.chatId] = clampSize(n.size)
    else n.children.forEach(walk)
  }
  walk(node)
  return out
}

export function loadChatTree(): ChatTreeNode | null {
  try {
    const raw = localStorage.getItem(TREE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ChatTreeNode | null
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.kind !== 'leaf' && parsed.kind !== 'split') return null
    return parsed
  } catch {
    return null
  }
}

export function persistChatTree(tree: ChatTreeNode | null): void {
  try {
    if (!tree) localStorage.removeItem(TREE_KEY)
    else localStorage.setItem(TREE_KEY, JSON.stringify(tree))
  } catch {
    /* storage unavailable */
  }
}

export type WindowNavDir = 'left' | 'right' | 'up' | 'down'

/** Pick the neighboring window in a vim-style direction from center points.
 *  Pure for tests. Keeps candidates strictly inside the direction cone
 *  (|secondary| <= primary * 1.2, primary > 4px), then picks the smallest
 *  primary distance, breaking ties by secondary. */
export function pickNeighborWindow(
  centers: Record<string, { x: number; y: number }>,
  currentId: string,
  dir: WindowNavDir,
): string | null {
  const cur = centers[currentId]
  if (!cur) return null
  let best: string | null = null
  let bestPrimary = Infinity
  let bestSecondary = Infinity
  for (const [id, p] of Object.entries(centers)) {
    if (id === currentId) continue
    const dx = p.x - cur.x
    const dy = p.y - cur.y
    let primary: number
    let secondary: number
    if (dir === 'left') { primary = -dx; secondary = Math.abs(dy) }
    else if (dir === 'right') { primary = dx; secondary = Math.abs(dy) }
    else if (dir === 'up') { primary = -dy; secondary = Math.abs(dx) }
    else { primary = dy; secondary = Math.abs(dx) }
    if (primary <= 4) continue
    if (secondary > primary * 1.2) continue
    if (primary < bestPrimary || (primary === bestPrimary && secondary < bestSecondary)) {
      best = id
      bestPrimary = primary
      bestSecondary = secondary
    }
  }
  return best
}
