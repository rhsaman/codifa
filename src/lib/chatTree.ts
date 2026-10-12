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
/** Soft cap for drag-created splits: beyond this every pane would drop below
 *  the minimum size, so edge drops stop splitting (center drops still
 *  replace/swap). Explicit opens (new chat, sidebar/tab select) always add
 *  a window. */
export const CHAT_WINDOW_MAX = 6

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

/** Best split direction for a new window from the container aspect ratio.
 *  Wide areas split side-by-side (row), tall areas stack (col). Pure. */
export function bestSplitDir(width: number, height: number): ChatSplitDir {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'row'
  return width >= height ? 'row' : 'col'
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

/** Remove a chat leaf. Null when empty.
 *  Single-child splits are KEPT (never collapsed): collapsing would change
 *  the React parent chain of every remaining window, unmounting and
 *  remounting their ChatPanels on every minimize (the minimize lag). Keeping
 *  the split wrapper preserves each remaining LeafView instance by key, so
 *  minimizing only unmounts the minimized panel. */
export function removeChat(
  node: ChatTreeNode | null,
  chatId: string,
): ChatTreeNode | null {
  if (!node) return null
  if (node.kind === 'leaf') return node.chatId === chatId ? null : node
  const children: ChatTreeNode[] = []
  let changed = false
  for (const c of node.children) {
    const next = removeChat(c, chatId)
    if (next) children.push(next)
    if (next !== c) changed = true
  }
  if (!changed) return node
  if (children.length === 0) return null
  return { ...node, children }
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

export function replaceChat(
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

/** Drop normalization: keeps order, drops unknown/dupe ids. Pure for tests.
 *  The seen set is threaded through nested splits so a chat kept anywhere
 *  earlier (even inside another split) is dropped on later occurrences: one
 *  chat never renders in two windows.
 *  Identity-stable: when nothing is dropped and every size is already
 *  clamped, the original node reference is returned so store subscribers can
 *  bail out without re-rendering (e.g. the post-minimize validation pass).
 *  Single-child splits are kept (never collapsed) so remaining windows keep
 *  their React instances across minimize. */
export function normalizeTree(
  node: ChatTreeNode | null,
  validIds: Set<string>,
  seen: Set<string> = new Set<string>(),
): ChatTreeNode | null {
  if (!node) return null
  if (node.kind === 'leaf') {
    if (!validIds.has(node.chatId) || seen.has(node.chatId)) return null
    seen.add(node.chatId)
    const size = clampSize(node.size)
    return size === node.size ? node : { ...node, size }
  }
  const children: ChatTreeNode[] = []
  let changed = false
  for (const c of node.children) {
    const next = normalizeTree(c, validIds, seen)
    if (next) children.push(next)
    if (next !== c) changed = true
  }
  if (children.length === 0) return null
  if (!changed) return node
  return { ...node, children }
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
  // Explicit opens always create a window (never replace); drag splits stay
  // capped by CHAT_WINDOW_MAX inside dropOnto/dropOntoRoot.
  if (node.kind === 'leaf') {
    return makeSplit(dir, [node, makeLeaf(chatId)])
  }
  return { ...node, children: [...node.children, makeLeaf(chatId)] }
}

/** Open a chat beside the focused window (explicit opens: new chat, sidebar
 *  or tab select). Never replaces: the focused leaf splits along the best
 *  axis (wide area -> side-by-side, tall area -> stacked) so the new window
 *  lands in the best place; same-axis siblings just extend. Pure. */
export function openBeside(
  node: ChatTreeNode | null,
  chatId: string,
  targetChatId: string,
  dir: ChatSplitDir,
): ChatTreeNode {
  if (!node) return makeLeaf(chatId)
  if (containsChat(node, chatId)) return node
  const fresh = makeLeaf(chatId)
  if (node.kind === 'leaf') return makeSplit(dir, [node, fresh])
  const target = findLeafByChat(node, targetChatId)
  if (!target) {
    if (node.dir === dir) return { ...node, children: [...node.children, fresh] }
    return makeSplit(dir, [node, fresh])
  }
  const parent = findParent(node, target.id)
  if (parent && parent.dir === dir) {
    const idx = parent.children.findIndex((c) => c.id === target.id)
    const children = parent.children.slice()
    children.splice(idx + 1, 0, fresh)
    return replaceNode(node, parent.id, { ...parent, children })
  }
  return replaceNode(node, target.id, makeSplit(dir, [{ ...target }, fresh]))
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
  // Full: a new chat cannot split in, but center drop replaces the target window.
  if (root && !containsChat(root, dragChatId) && leafCount(root) >= CHAT_WINDOW_MAX && pos !== 'center') return root
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

/** Root-edge drop: move a chat to the outer edge of the chat area.
 *  The dragged window is removed first, so the remaining tree decides the
 *  landing zone (e.g. dragging the bottom-right pane to the bottom edge puts
 *  the rest on top side-by-side and the dragged pane full-width below).
 *  Pure for tests. */
export function dropOntoRoot(
  root: ChatTreeNode | null,
  dragChatId: string,
  pos: ChatDropPos,
): ChatTreeNode | null {
  if (!dragChatId) return root
  const dirNeeded = dirForPos(pos)
  if (!dirNeeded) return root
  const before = beforePos(pos)
  if (!root) return makeLeaf(dragChatId)
  const dragLeaf = findLeafByChat(root, dragChatId)
  const dragSize = dragLeaf?.size ?? 1
  if (dragLeaf) {
    if (leafCount(root) <= 1) return root
    const base = removeChat(root, dragChatId)
    if (!base) return makeLeaf(dragChatId, dragSize)
    const fresh = makeLeaf(dragChatId, dragSize)
    if (base.kind === 'split' && base.dir === dirNeeded) {
      const children = before ? [fresh, ...base.children] : [...base.children, fresh]
      return { ...base, children }
    }
    return makeSplit(dirNeeded, before ? [fresh, base] : [base, fresh])
  }
  if (leafCount(root) >= CHAT_WINDOW_MAX) return root
  const fresh = makeLeaf(dragChatId)
  if (root.kind === 'split' && root.dir === dirNeeded) {
    const children = before ? [fresh, ...root.children] : [...root.children, fresh]
    return { ...root, children }
  }
  return makeSplit(dirNeeded, before ? [fresh, root] : [root, fresh])
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

/** Toggle a fullscreen window id: same target exits, another target switches.
 *  Empty target keeps the current state. Pure, for test. */
export function toggleFullscreenId(current: string | null, target: string): string | null {
  if (!target) return current
  return current === target ? null : target
}

/** Whether a split child's slot is vacated by the in-progress internal drag.
 *  Pure for tests. The dragged window's own space counts as empty while
 *  dragging, so its wrapping flex slot collapses and the remaining panes
 *  expand: the drop preview then shows the final layout (e.g. 2 panes)
 *  instead of looking like an extra window next to the dimmed source.
 *  External tab/sidebar drags keep dragId null and never vacate. */
export function isVacatedByDrag(childChatIds: string[], dragId: string | null): boolean {
  if (!dragId) return false
  return childChatIds.length === 1 && childChatIds[0] === dragId
}

/** Landing index for a sibling ghost placeholder next to the drop target.
 *  Pure for tests. Edge drops insert before (left/top) or after
 *  (right/bottom) the target so the ghost participates in flex layout with
 *  equal size instead of overlaying half a pane. */
export function ghostInsertIndex(targetIndex: number, pos: ChatDropPos): number {
  return beforePos(pos) ? targetIndex : targetIndex + 1
}

/** Whether the drop preview should render as a sibling ghost placeholder.
 *  Pure for tests. Only for edge drops onto a direct-child leaf along the
 *  parent split axis: the ghost becomes a real flex sibling with equal size,
 *  so dragging shows N equal windows (e.g. 3 stay 3 equal) instead of an
 *  overlay that reads as an extra window. Center and cross-axis drops keep
 *  the overlay highlight. */
export function shouldShowSiblingGhost(parentDir: ChatSplitDir, pos: ChatDropPos, isDirectChild: boolean): boolean {
  if (!isDirectChild) return false
  if (pos === 'center') return false
  return dirForPos(pos) === parentDir
}

/** Resolve a leaf drop position from normalized pointer fractions with hysteresis.
 *  Pure for tests. Entering an edge needs x/y past 0.25, but staying in the
 *  same edge tolerates drift to 0.34: vacating the drag source and inserting
 *  the ghost sibling expand the target leaf, which shifts fractions by a few
 *  px under a steady cursor — without the wider exit band the preview flips
 *  edge/center every frame and the empty page flickers in and out. */
export function resolveLeafPos(x: number, y: number, prev: ChatDropPos | null): ChatDropPos {
  const enter = 0.25
  const exit = 0.34
  const lx = prev === 'left' ? exit : enter
  const rx = prev === 'right' ? 1 - exit : 1 - enter
  const ty = prev === 'top' ? exit : enter
  const by = prev === 'bottom' ? 1 - exit : 1 - enter
  if (x < lx && x <= y && x <= 1 - y) return 'left'
  if (x > rx && x >= y && x >= 1 - y) return 'right'
  if (y < ty) return 'top'
  if (y > by) return 'bottom'
  return 'center'
}

/** Whether the drop preview should render as a nested ghost inside the target leaf.
 *  Pure for tests. Edge drops across the parent split axis (e.g. top/bottom
 *  onto a row child) cannot insert a flex sibling along the parent axis;
 *  instead the target slot splits along the drop axis with an equal-size
 *  ghost next to the target content, so dragging still previews N equal
 *  panes with the source vacated instead of an overlay that reads as extra.
 *  Center and along-axis drops never nest (sibling ghost or swap). */
export function shouldShowNestedGhost(parentDir: ChatSplitDir, pos: ChatDropPos, isDirectChild: boolean): boolean {
  if (!isDirectChild) return false
  if (pos === 'center') return false
  const need = dirForPos(pos)
  if (!need) return false
  return need !== parentDir
}
