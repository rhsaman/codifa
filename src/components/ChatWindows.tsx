import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { markWindowClicked, useStore } from "../lib/store";
import type { ChatLayout } from "../lib/store";
import type { ChatDropPos, ChatTreeNode } from "../lib/chatTree";
import { buildFromList, CHAT_WINDOW_MAX, CHAT_WINDOW_MIN_H, CHAT_WINDOW_MIN_W, collectChatIds, findNodeById, leafCount, normalizeTree, pickNeighborWindow } from "../lib/chatTree";
import { focusChatInput } from "../lib/chatFocus";
import { workspaceDisplayFor } from "../lib/chatWindowMeta";
import { physicalKey } from "../lib/shortcuts";
import { syncViewerToChat } from "../lib/viewerTabs";
import { ChatPanel } from "./Chat";
import { TabPendingBadges } from "./ChatTabBar";
import { windowStatusFor } from "../lib/chatWindowStatus";
import { hasFileDrop, isFileDrag } from "../lib/fileDrag";

/** MIME type for dragging a chat id from tabs/sidebar into the chat stack. */
export const CHAT_DRAG_MIME = "application/x-coder-chat-id";
/** Synthetic drop id for outer-edge (root) drops: the dragged window's own
 *  space counts as empty, so the remaining tree decides the landing zone. */
export const CHAT_ROOT_DROP_ID = "__root__";

export function readChatDragId(e: DragEvent | { dataTransfer?: DataTransfer | null }): string {
  try {
    const dt = (e as DragEvent).dataTransfer ?? (e as { dataTransfer?: DataTransfer | null }).dataTransfer;
    if (!dt) return "";
    const viaType = dt.getData(CHAT_DRAG_MIME);
    if (viaType) return viaType;
    const plain = dt.getData("text/plain");
    // Only accept plain-text ids that look like a chat id (tabs set both).
    if (plain && /^[A-Za-z0-9_-]{6,64}$/.test(plain)) return plain;
    return "";
  } catch {
    return "";
  }
}

export function setChatDragData(e: { dataTransfer: DataTransfer }, chatId: string): void {
  try {
    e.dataTransfer.setData(CHAT_DRAG_MIME, chatId);
    e.dataTransfer.setData("text/plain", chatId);
    e.dataTransfer.effectAllowed = "move";
  } catch {
    /* drag unsupported */
  }
}

/** Memoized panel: the parent re-renders on every drag/resize frame, but a
 *  window transcript must only re-render when its own chat changes. */
const MemoChatPanel = memo(ChatPanel);

function chatTitleOf(id: string): string {
  const st = useStore.getState();
  const c = st.chats.find((x) => x.id === id);
  if (!c) return "Chat";
  if (c.title && c.title !== "New chat") return c.title;
  const first = c.messages.find((m) => m.role === "user");
  return first ? first.content.slice(0, 40) || "New chat" : "New chat";
}

/** Map a pointer position inside a leaf to a VSCode-like drop position.
 *  Edges split (left/right/top/bottom), center swaps/focuses. Works for any
 *  current orientation so a horizontal row can still accept a vertical drop
 *  and vice versa. */
function posForPoint(e: DragEvent, el: HTMLElement): ChatDropPos {
  const rect = el.getBoundingClientRect();
  const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
  const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
  const edge = 0.25;
  if (x < edge && x <= y && x <= 1 - y) return "left";
  if (x > 1 - edge && x >= y && x >= 1 - y) return "right";
  if (y < edge) return "top";
  if (y > 1 - edge) return "bottom";
  return "center";
}

/** Outer-edge threshold for root drops (whole chat area border).
 *  Thin strip so leaf edge splits stay reachable: only the outer edge
 *  counts as root edge, inner area stays leaf-level. */
const ROOT_EDGE_MIN_PX = 16;
const ROOT_EDGE_FRACTION = 0.06;

/** Outer-edge position when the pointer is near the chat area border.
 *  The dragged window's own space counts as empty: proximity is measured
 *  against the whole chat-windows container, not the leaf under the cursor,
 *  so dragging the bottom-right pane to the bottom edge highlights the full
 *  bottom strip (remaining windows stay on top side-by-side). A corner
 *  (near two borders at once) stays leaf-level so a pane can be parked in
 *  the top-right corner instead of forcing a full-width root strip. */
function rootEdgeForStackPoint(e: DragEvent, stackEl: HTMLElement | null): ChatDropPos | null {
  const rect = stackEl?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const threshold = Math.max(ROOT_EDGE_MIN_PX, Math.min(rect.width, rect.height) * ROOT_EDGE_FRACTION);
  const leftDist = e.clientX - rect.left;
  const rightDist = rect.right - e.clientX;
  const topDist = e.clientY - rect.top;
  const bottomDist = rect.bottom - e.clientY;
  const min = Math.min(leftDist, rightDist, topDist, bottomDist);
  if (min < -8 || min > threshold) return null;
  // Corner guard: inside the container but close to two borders at once
  // (e.g. top-right corner) is a leaf split, not a full-width root strip.
  if (min >= 0) {
    const sorted = [leftDist, rightDist, topDist, bottomDist].sort((a, b) => a - b);
    if (sorted[1] <= threshold) return null;
  }
  if (min === leftDist) return "left";
  if (min === rightDist) return "right";
  if (min === topDist) return "top";
  return "bottom";
}

function rootEdgeForPoint(e: DragEvent, leafEl: HTMLElement): ChatDropPos | null {
  const stackEl = leafEl.closest?.(".chat-windows") as HTMLElement | null;
  return rootEdgeForStackPoint(e, stackEl);
}

/** Header drag handle: reorders stacked windows (HTML5 DnD, no extra deps).
 *  Only the title starts a drag so the close button always clicks. */
// Memoized: the parent re-renders every drag-preview frame, but a header only
// changes with its own focus/fullscreen state (toggle calls the store itself
// so no inline-callback prop breaks the memo). Keeps reorder drags smooth.
const WindowHeader = memo(function WindowHeader({
  chatId,
  focused,
  multi,
  fullscreen,
  onDragState,
}: {
  chatId: string;
  focused: boolean;
  multi: boolean;
  fullscreen: boolean;
  onDragState: (dragId: string | null) => void;
}) {
  const title = chatTitleOf(chatId);
  const chat = useStore((s) => s.chats.find((c) => c.id === chatId));
  const activeChatId = useStore((s) => s.activeChatId);
  const unreadChats = useStore((s) => s.unreadChats);
  const workspaces = useStore((s) => s.workspaces);
  const workspaceColors = useStore((s) => s.workspaceColors);
  const status = windowStatusFor(chat, chatId, activeChatId, unreadChats);
  const ws = workspaceDisplayFor(chat?.root, workspaces, workspaceColors);
  const beginDrag = (e: DragEvent) => {
    if (!multi) return;
    e.stopPropagation();
    setChatDragData(e, chatId);
    onDragState(chatId);
  };
  const focus = () => {
    markWindowClicked(chatId);
    useStore.getState().focusWindow(chatId);
  };
  return (
    <div
      className={"chat-window-head" + (focused ? " focused" : "")}
      draggable={false}
      onClick={focus}
      title={multi ? `Drag to reorder — ${title}` : title}
      role="tab"
      aria-selected={focused}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          markWindowClicked(chatId);
          useStore.getState().focusWindow(chatId);
        }
      }}
    >
      {status.streaming && (
        <span className="editor-tab-dot busy" title="Agent is working in this chat" aria-hidden="true" />
      )}
      {(status.pendingPermission || status.pendingAsk) && (
        <TabPendingBadges pendingPermission={status.pendingPermission} pendingAsk={status.pendingAsk} />
      )}
      {!status.streaming &&
        !status.pendingPermission &&
        !status.pendingAsk &&
        status.unread && (
          <span className="editor-tab-dot unread" title="New message from the agent — click to view" aria-hidden="true" />
        )}
      <span
        className="chat-window-title"
        draggable={multi}
        onDragStart={beginDrag}
        onDragEnd={() => onDragState(null)}
      >
        {title}
      </span>
      <span
        className="chat-window-ws"
        style={{ "--ws": ws.color } as CSSProperties}
        title={ws.root ? `${ws.label} — ${ws.root}` : ws.label}
      >
        <span className="chat-window-ws-label">{ws.label}</span>
      </span>
      {multi && (
        <>
          <button
            type="button"
            className="chat-window-fullscreen"
            title={fullscreen ? "Exit window fullscreen (Ctrl+M)" : "Fullscreen window (Ctrl+M)"}
            aria-label={fullscreen ? `Exit ${title} fullscreen` : `Fullscreen ${title}`}
            aria-pressed={fullscreen}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              useStore.getState().toggleWindowFullscreen(chatId);
            }}
          >
            {fullscreen ? (
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4.5 1.5v3.5h-3M4.5 1.5 1.6 4.4M7.5 10.5V7h3M7.5 10.5l2.9-2.9" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 1.5h3.5V5M10.5 1.5 7 5M5 10.5H1.5V7M1.5 10.5 5 7" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="chat-window-minimize"
            title="Minimize window (keeps tab, agent keeps working)"
            aria-label={`Minimize ${title}`}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // Sync + light: clear preview first, close immediately.
              // Persist is debounced inside the store (no await here).
              onDragState(null);
              useStore.getState().closeWindow(chatId);
            }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M2.5 6h7" />
            </svg>
          </button>
          <button
            type="button"
            className="chat-window-close"
            title="Close window and tab (chat stays in sidebar)"
            aria-label={`Close ${title}`}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onDragState(null);
              useStore.getState().closeChatTab(chatId);
            }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
});

type DropMark = { id: string; pos: ChatDropPos } | null;

interface DragState {
  dragId: string | null;
  drop: DropMark;
  setDragId: (id: string | null) => void;
  setDrop: (d: DropMark | ((prev: DropMark) => DropMark)) => void;
}

/** Single chat leaf with 5-way edge highlight (left/right/top/bottom/center).
 *  Fullscreen keeps every panel mounted and hides the rest with CSS
 *  (display:none) so toggling fullscreen never remounts ChatPanels. */
function leafDragEqual(
  prev: { chatId: string; focused: boolean; multi: boolean; drag: DragState; fullscreenId: string | null },
  next: { chatId: string; focused: boolean; multi: boolean; drag: DragState; fullscreenId: string | null },
): boolean {
  if (prev.chatId !== next.chatId || prev.focused !== next.focused || prev.multi !== next.multi || prev.fullscreenId !== next.fullscreenId) return false;
  if (prev.drag.dragId !== next.drag.dragId) return false;
  // Root-edge preview is rendered by the parent overlay, not inside leaves:
  // a root-only change must not re-render any leaf (avoids a stale empty
  // page flashing inside an unrelated pane).
  const prevOwn = prev.drag.drop?.id === prev.chatId ? prev.drag.drop.pos : null;
  const nextOwn = next.drag.drop?.id === next.chatId ? next.drag.drop.pos : null;
  return prevOwn === nextOwn;
}

const LeafView = memo(function LeafView({
  chatId,
  focused,
  multi,
  drag,
  fullscreenId,
}: {
  chatId: string;
  focused: boolean;
  multi: boolean;
  drag: DragState;
  fullscreenId: string | null;
}) {
  // Preview whenever this leaf is the drop target, including external
  // tab/sidebar drags (dragId stays null for those — the id is only
  // readable on drop). Stale previews are cleared on dragend/drop.
  const dropPos = drag.drop?.id === chatId ? drag.drop.pos : null;
  const isDragSource = !!drag.dragId && drag.dragId === chatId;
  const isFullscreen = fullscreenId === chatId;
  const isHidden = !!fullscreenId && fullscreenId !== chatId;
  return (
    <section
      className={
        "chat-window" +
        (focused ? " focused" : " dimmed") +
        (dropPos ? ` drop-active drop-${dropPos}` : "") +
        (isDragSource ? " drag-source" : "") +
        (isFullscreen ? " window-full" : "") +
        (isHidden ? " window-hidden" : "")
      }
      data-chat-window={chatId}
      aria-label={chatTitleOf(chatId)}
      aria-hidden={isHidden}
      style={multi ? ({ flexGrow: 1, flexShrink: 0, flexBasis: 0, ...(isHidden ? { display: "none" } : null) } as CSSProperties) : isHidden ? ({ display: "none" } as CSSProperties) : undefined}
      onDragOver={(e) => {
        // File drops belong to the chat composer: never treat them as
        // window moves so the panel overlay keeps the event.
        if (isFileDrag(e.dataTransfer.types)) return;
        const internal = drag.dragId && drag.dragId !== chatId;
        let hasExternal = false;
        try {
          const types = Array.from(e.dataTransfer.types ?? []);
          hasExternal = types.includes(CHAT_DRAG_MIME) || types.includes("text/plain");
        } catch {
          hasExternal = false;
        }
        // Root edge wins over leaf zones for any chat drag (internal move
        // or external tab/sidebar drag): the dragged window's own space
        // counts as empty, so the remaining tree decides the landing zone.
        if (drag.dragId || hasExternal) {
          const rootPos = rootEdgeForPoint(e, e.currentTarget as HTMLElement);
          if (rootPos) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            drag.setDrop((prev) => (prev?.id === CHAT_ROOT_DROP_ID && prev.pos === rootPos ? prev : { id: CHAT_ROOT_DROP_ID, pos: rootPos }));
            return;
          }
        }
        // The moving window itself is never a drop target: showing a preview
        // on the source suggests a wrong landing zone, so clear it instead.
        if (drag.dragId && drag.dragId === chatId) {
          drag.setDrop((prev) => (prev?.id === chatId ? null : prev));
          return;
        }
        if (!internal && !hasExternal) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        const rawPos = posForPoint(e, e.currentTarget as HTMLElement);
        // External tab/sidebar drags never replace on center: map center to a
        // beside split so dropping creates a new window next to the target.
        // Internal moves (dragId set) keep swap/replace on center.
        const pos = (!internal && rawPos === "center") ? "right" : rawPos;
        // Full: a new chat cannot split in (external center already maps to split above).
        if (!internal) {
          const st = useStore.getState();
          const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds;
          if (ids.length >= CHAT_WINDOW_MAX && pos !== 'center') {
            drag.setDrop((prev) => (prev?.id === chatId ? null : prev));
            return;
          }
        }
        drag.setDrop((prev) => (prev?.id === chatId && prev.pos === pos ? prev : { id: chatId, pos }));
      }}
      onDragLeave={(e) => {
        // dragleave fires when moving between children inside the same pane
        // (transcript nodes): only clear when the pointer truly leaves it,
        // otherwise the preview flickers and re-renders every few pixels.
        const to = e.relatedTarget as Node | null;
        if (to && (e.currentTarget as HTMLElement).contains(to)) return;
        drag.setDrop((prev) => (prev?.id === chatId ? null : prev));
      }}
      onDrop={(e) => {
        // File drops belong to the chat composer: let the inner panel
        // handle the attach instead of swallowing the event here.
        if (hasFileDrop(e.dataTransfer.files)) return;
        e.preventDefault();
        e.stopPropagation();
        const from = readChatDragId(e) || drag.dragId;
        // Trust the shown preview so the result matches what the user saw:
        // recomputing from drop coordinates can disagree by a few pixels.
        const shown = drag.drop;
        // External tab/sidebar drags keep dragId null (id only in dataTransfer).
        const isExternal = !drag.dragId;
        drag.setDragId(null);
        drag.setDrop(null);
        if (!from) return;
        if (shown?.id === CHAT_ROOT_DROP_ID && shown.pos !== "center") {
          useStore.getState().dropChatOntoRoot(from, shown.pos);
          return;
        }
        if (shown?.id === chatId && from !== chatId) {
          // External center never replaces: split beside instead (openBeside-style).
          const edgePos = isExternal && shown.pos === "center" ? "right" : shown.pos;
          useStore.getState().dropChatOnto(from, chatId, edgePos);
          return;
        }
        const rootPos = rootEdgeForPoint(e, e.currentTarget as HTMLElement);
        if (rootPos) {
          useStore.getState().dropChatOntoRoot(from, rootPos);
          return;
        }
        if (from === chatId) return;
        const rawPos = posForPoint(e, e.currentTarget as HTMLElement);
        const pos = isExternal && rawPos === "center" ? "right" : rawPos;
        useStore.getState().dropChatOnto(from, chatId, pos);
      }}
    >
      {multi && (
        <WindowHeader chatId={chatId} focused={focused} multi={multi} fullscreen={isFullscreen} onDragState={drag.setDragId} />
      )}
      <div className="chat-window-body" onClick={() => {
        markWindowClicked(chatId);
        useStore.getState().focusWindow(chatId);
      }}>
        <MemoChatPanel chatId={chatId} dimmed={multi && !focused} />
      </div>
      {dropPos && (
        <div className={`chat-drop-preview preview-${dropPos}`} aria-hidden="true">
          <div className="chat-drop-empty-page">
            <span className="chat-drop-empty-title">{drag.dragId ? chatTitleOf(drag.dragId) : "Chat"}</span>
            <span className="chat-drop-hint">
              {dropPos === "center" && drag.dragId ? "Release to focus here" : "Release to open here"}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}, leafDragEqual);

/** Recursive split node: row = side-by-side, col = stacked. */
function SplitView({
  node,
  activeChatId,
  multi,
  drag,
  fullscreenId,
  startTreeResize,
}: {
  node: ChatTreeNode;
  activeChatId: string;
  multi: boolean;
  drag: DragState;
  fullscreenId: string | null;
  startTreeResize: (
    e: ReactMouseEvent,
    parentId: string,
    firstId: string,
    secondId: string,
    firstSize: number,
    secondSize: number,
    isRow: boolean,
  ) => void;
}) {
  if (node.kind === "leaf") {
    // The dragged window stays visible (dimmed via .drag-source): its space
    // counts as empty logically (drop helpers remove it first), so the
    // layout never shifts under the cursor and the preview stays stable.
    return (
      <LeafView chatId={node.chatId} focused={node.chatId === activeChatId} multi={multi} drag={drag} fullscreenId={fullscreenId} />
    );
  }
  const isRow = node.dir === "row";
  return (
    <div className={`chat-split ${isRow ? "row" : "col"}`} data-split-id={node.id}>
      {node.children.map((child, i) => {
        // Fullscreen keeps every panel mounted: subtrees without the
        // fullscreen chat hide with CSS instead of unmounting.
        const childHidden = !!fullscreenId && !collectChatIds(child).includes(fullscreenId);
        return (
        <div
          key={child.id}
          className={"chat-split-child" + (childHidden ? " window-hidden" : "")}
          style={{ flexGrow: child.size, flexShrink: 0, flexBasis: 0, ...(childHidden ? { display: "none" } : null) } as CSSProperties}
          aria-hidden={childHidden}
        >
          {i > 0 && (
            <div
              className={`chat-split-resize ${isRow ? "col-bar" : "row-bar"}`}
              title="Drag to resize"
              role="separator"
              aria-orientation={isRow ? "vertical" : "horizontal"}
              onMouseDown={(e) => {
                const prev = node.children[i - 1];
                startTreeResize(e, node.id, prev.id, child.id, prev.size, child.size, isRow);
              }}
            />
          )}
          <SplitView node={child} activeChatId={activeChatId} multi={multi} drag={drag} fullscreenId={fullscreenId} startTreeResize={startTreeResize} />
        </div>
        );
      })}
    </div>
  );
}

/** VSCode-like split group for chats: single window renders borderless
 *  (legacy look), multi-window renders the recursive split tree with
 *  edge highlight overlays. Drag a tab or a sidebar row onto any window
 *  edge to split — no buttons. Each window mounts its own ChatPanel so
 *  scroll/draft/composer stay local. */
export function ChatWindows() {
  const visibleChatIds = useStore((s) => s.visibleChatIds);
  const chatTree = useStore((s) => s.chatTree);
  const activeChatId = useStore((s) => s.activeChatId);
  const layout = useStore((s) => s.chatLayout);
  const windowFullscreenId = useStore((s) => s.windowFullscreenId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: ChatDropPos } | null>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ parentId: string; firstId: string; secondId: string; startX: number; startY: number; firstSize: number; secondSize: number; totalFlex: number; childCount: number; isRow: boolean } | null>(null);
  // Resize perf: mousemove fires faster than React can re-render all panes,
  // so coordinates collapse into one store update per animation frame.
  const resizeRafRef = useRef<number>(0);
  const pendingResizeRef = useRef<{ x: number; y: number } | null>(null);
  // Drag preview perf: dragover fires dozens of times per second. Coalesce
  // bursts into one state update per frame; handlers return prev on
  // unchanged positions so idle hovering never re-renders either.
  const dropRafRef = useRef<number>(0);
  const pendingDropRef = useRef<DropMark | ((prev: DropMark) => DropMark) | null>(null);

  const treeLeaves = chatTree ? leafCount(chatTree) : 0;
  const multi = treeLeaves > 1 || (!chatTree && visibleChatIds.length > 1);
  const horizontal = layout === "horizontal";
  const didInitFullscreenRef = useRef(false);
  const fullscreenId = windowFullscreenId && ((chatTree ? collectChatIds(chatTree) : visibleChatIds).includes(windowFullscreenId)) ? windowFullscreenId : null;

  // Focus follows windows: the right panel (Git/Trace/Plan/...) always shows
  // the focused chat's tab. Runs on focus change only, not on every render.
  useEffect(() => {
    if (activeChatId) syncViewerToChat(activeChatId);
  }, [activeChatId]);

  // Vim-style window navigation: Ctrl+H/J/K/L moves focus between windows
  // (h=left, j=down, k=up, l=right) and drops the caret into the new
  // window's composer input. Capture phase so it can win over the global
  // Cmd/Ctrl+J terminal toggle on non-Mac layouts — but only when a
  // neighbor actually exists in that direction; otherwise the key passes
  // through so Ctrl+J still toggles the terminal (App.tsx). Skipped while
  // the terminal has focus (the shell keeps its own Ctrl chords) and while
  // a popup already consumed the key (defaultPrevented).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.terminal-panel')) return;
      if (t?.closest?.('[role="dialog"], .settings-modal, .search-overlay')) return;
      const k = physicalKey(e as { code: string; key: string });
      // Composer popups (slash palette, @mention, history, plus menu) own
      // Ctrl+J/K for list navigation — let them keep those keys.
      if ((k === 'j' || k === 'k') && t?.closest?.('.composer-input-wrap')) {
        const win = t.closest('[data-chat-window]');
        if (win?.querySelector('.mention-popup, .plus-menu')) return;
      }
      // Window fullscreen: Ctrl+M expands the focused window to the whole
      // chat area; pressing again restores the split. Focus lands back in
      // the composer so typing can continue. Skipped in the terminal (the
      // shell owns Ctrl chords there) and in dialogs/overlays.
      if (k === 'm') {
        if (t?.closest?.('.terminal-panel') || t?.closest?.('[role="dialog"], .settings-modal, .search-overlay')) return;
        e.preventDefault();
        e.stopPropagation();
        const st2 = useStore.getState();
        const ids2 = st2.chatTree ? collectChatIds(st2.chatTree) : st2.visibleChatIds;
        if (ids2.length < 2 && !st2.windowFullscreenId) return;
        st2.toggleWindowFullscreen();
        const after = useStore.getState().activeChatId;
        if (after) requestAnimationFrame(() => focusChatInput(after));
        return;
      }
      const dir = k === 'h' ? 'left' : k === 'j' ? 'down' : k === 'k' ? 'up' : k === 'l' ? 'right' : null;
      if (!dir) return;
      const st = useStore.getState();
      const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds;
      if (ids.length < 2) return;
      const els = document.querySelectorAll<HTMLElement>('[data-chat-window]');
      const centers: Record<string, { x: number; y: number }> = {};
      els.forEach((el) => {
        const id = el.getAttribute('data-chat-window');
        if (!id) return;
        if (el.classList.contains('window-hidden') || el.getAttribute('aria-hidden') === 'true') return;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        centers[id] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const target = pickNeighborWindow(centers, st.activeChatId, dir);
      // No neighbor in this direction: let the key through (Ctrl+J toggles
      // the terminal, Ctrl+K stays free) instead of swallowing it.
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      st.focusWindow(target);
      // Focus after paint so the hop lands in the committed DOM.
      requestAnimationFrame(() => focusChatInput(target));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Window fullscreen consistency: drop a stale id, and exit fullscreen when
  // focus moves to another window so a hidden window never holds focus. On
  // first mount a valid persisted id focuses its window instead of clearing.
  useEffect(() => {
    if (!windowFullscreenId) {
      didInitFullscreenRef.current = true;
      return;
    }
    const st = useStore.getState();
    const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds;
    if (!ids.includes(windowFullscreenId)) {
      didInitFullscreenRef.current = true;
      st.setWindowFullscreen(null);
      return;
    }
    if (!didInitFullscreenRef.current) {
      didInitFullscreenRef.current = true;
      if (st.activeChatId !== windowFullscreenId) st.focusWindow(windowFullscreenId);
      return;
    }
    if (st.activeChatId && st.activeChatId !== windowFullscreenId) {
      st.setWindowFullscreen(null);
    }
  }, [windowFullscreenId, activeChatId, treeLeaves, visibleChatIds.length]);

  // Keep the visible set valid: drop deleted ids, fall back to the focused chat.
  // Normalizes the split tree too so a restart never restores stale windows.
  useEffect(() => {
    const st = useStore.getState();
    const valid = new Set(st.chats.map((c) => c.id));
    if (st.chatTree) {
      const norm = normalizeTree(st.chatTree, valid);
      const ids = norm ? collectChatIds(norm) : [];
      const nextIds = ids.length > 0 ? ids : st.activeChatId && valid.has(st.activeChatId) ? [st.activeChatId] : [];
      const nextTree = norm ?? (nextIds.length > 0 ? buildFromList(nextIds, layout === "horizontal" ? "row" : "col") : null);
      if (nextTree !== st.chatTree || JSON.stringify(nextIds) !== JSON.stringify(st.visibleChatIds)) {
        useStore.setState({ chatTree: nextTree, visibleChatIds: nextIds });
      }
      return;
    }
    const cleaned = st.visibleChatIds.filter((id) => valid.has(id));
    if (cleaned.length !== st.visibleChatIds.length || (cleaned.length === 0 && st.activeChatId)) {
      const next = cleaned.length > 0 ? cleaned : st.activeChatId ? [st.activeChatId] : [];
      if (next.length > 0) useStore.setState({ visibleChatIds: next });
    }
  }, [visibleChatIds.length, treeLeaves, layout]);

  const startTreeResize = useCallback(
    (
      e: ReactMouseEvent,
      parentId: string,
      firstId: string,
      secondId: string,
      firstSize: number,
      secondSize: number,
      isRow: boolean,
    ) => {
      e.preventDefault();
      const tree = useStore.getState().chatTree;
      const parent = findNodeById(tree, parentId);
      const totalFlex = parent && parent.kind === "split" ? parent.children.reduce((n, c) => n + c.size, 0) : firstSize + secondSize;
      const childCount = parent && parent.kind === "split" ? parent.children.length : 2;
      resizeRef.current = { parentId, firstId, secondId, startX: e.clientX, startY: e.clientY, firstSize, secondSize, totalFlex, childCount, isRow };
      const applyResize = (clientX: number, clientY: number) => {
        const r = resizeRef.current;
        if (!r) return;
        // Measure the split parent so the minimum is enforced in real pixels.
        const parentEl = document.querySelector(`[data-split-id="${r.parentId}"]`);
        const parentRect = parentEl?.getBoundingClientRect();
        const parentSpan = r.isRow ? (parentRect?.width ?? 0) : (parentRect?.height ?? 0);
        const span = parentSpan > 0 ? parentSpan : (r.isRow ? (stackRef.current?.getBoundingClientRect().width ?? 800) : (stackRef.current?.getBoundingClientRect().height ?? 600));
        const travelled = r.isRow ? clientX - r.startX : clientY - r.startY;
        const pairTotal = r.firstSize + r.secondSize;
        const delta = (travelled / Math.max(200, span)) * r.totalFlex;
        // Clamp so neither pane shrinks below the pixel minimum.
        const minPx = r.isRow ? CHAT_WINDOW_MIN_W : CHAT_WINDOW_MIN_H;
        const usable = Math.max(0, span - Math.max(0, r.childCount - 1) * 6);
        let nextFirst = r.firstSize + delta;
        let nextSecond = r.secondSize - delta;
        if (usable > minPx * 2 && r.totalFlex > 0) {
          const minFlex = (minPx / usable) * r.totalFlex;
          const lo = Math.max(minFlex, 0.25);
          const hi = pairTotal - Math.max(minFlex, 0.25);
          if (hi >= lo) {
            nextFirst = Math.min(Math.max(nextFirst, lo), hi);
            nextSecond = pairTotal - nextFirst;
          } else {
            return;
          }
        }
        useStore.getState().resizeTreePair(r.parentId, r.firstId, r.secondId, nextFirst, nextSecond);
      };
      const onMove = (ev: MouseEvent) => {
        if (!resizeRef.current) return;
        // Collapse bursts of mousemove into one store update per frame.
        pendingResizeRef.current = { x: ev.clientX, y: ev.clientY };
        if (resizeRafRef.current) return;
        resizeRafRef.current = requestAnimationFrame(() => {
          resizeRafRef.current = 0;
          const p = pendingResizeRef.current;
          pendingResizeRef.current = null;
          if (p) applyResize(p.x, p.y);
        });
      };
      const onUp = () => {
        if (resizeRafRef.current) {
          cancelAnimationFrame(resizeRafRef.current);
          resizeRafRef.current = 0;
        }
        // Flush the latest position so the pane lands exactly on release.
        const p = pendingResizeRef.current;
        pendingResizeRef.current = null;
        if (p) applyResize(p.x, p.y);
        resizeRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );

  const hasExternalChat = (e: DragEvent) => {
    try {
      const types = Array.from(e.dataTransfer.types ?? []);
      return types.includes(CHAT_DRAG_MIME) || types.includes("text/plain");
    } catch {
      return false;
    }
  };

  const onStackDragOver = (e: DragEvent) => {
    if (isFileDrag(e.dataTransfer.types)) return;
    if (!dragId && !hasExternalChat(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Gaps between panes (resize bars, split padding) also accept root-edge
    // drops so the full-width highlight works even off-leaf. Applies to both
    // internal moves and external tab/sidebar drags (which keep dragId null).
    const rootPos = rootEdgeForStackPoint(e, stackRef.current);
    if (rootPos) {
      setDrop((prev) => (prev?.id === CHAT_ROOT_DROP_ID && prev.pos === rootPos ? prev : { id: CHAT_ROOT_DROP_ID, pos: rootPos }));
    } else {
      setDrop((prev) => (prev?.id === CHAT_ROOT_DROP_ID ? null : prev));
    }
  };

  // Leaving the chat area mid-drag clears a stale root-edge highlight so no
  // empty-page ghost lingers over the panes while hovering outside them.
  const onStackDragLeave = (e: DragEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && (e.currentTarget as HTMLElement).contains(to)) return;
    setDrop((prev) => (prev?.id === CHAT_ROOT_DROP_ID ? null : prev));
  };

  // External drags (tabs/sidebar) have no source dragend here: a global
  // dragend/drop clears any stale leaf/root preview on cancel or drop
  // outside the chat area.
  useEffect(() => {
    const clear = () => {
      setDragId(null);
      setDrop(null);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  const onStackDrop = (e: DragEvent) => {
    if (hasFileDrop(e.dataTransfer.files)) return;
    const from = readChatDragId(e) || dragId;
    const curDrop = drop;
    setDragId(null);
    setDrop(null);
    if (!from) return;
    if (curDrop?.id === CHAT_ROOT_DROP_ID && curDrop.pos !== "center") {
      e.preventDefault();
      useStore.getState().dropChatOntoRoot(from, curDrop.pos);
      return;
    }
    // Gap drop (resize bars, split padding): trust the last shown leaf
    // preview so the result matches the highlight the user saw.
    // External center never replaces: split beside instead.
    if (curDrop && curDrop.id !== CHAT_ROOT_DROP_ID && from !== curDrop.id) {
      e.preventDefault();
      const edgePos = !dragId && curDrop.pos === "center" ? "right" : curDrop.pos;
      useStore.getState().dropChatOnto(from, curDrop.id, edgePos);
      return;
    }
    const rootPos = rootEdgeForStackPoint(e, stackRef.current);
    if (rootPos) {
      e.preventDefault();
      useStore.getState().dropChatOntoRoot(from, rootPos);
      return;
    }
    // Dropped on empty stack space → append as a new window (splits when single).
    // Never duplicate: focusing is enough when the chat is already visible.
    if (e.target === e.currentTarget) {
      e.preventDefault();
      const st = useStore.getState();
      const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds;
      if (ids.includes(from)) st.focusWindow(from);
      else st.openInWindow(from);
    }
  };

  // Coalesced preview setter: keeps only the latest position per frame.
  const scheduleDrop = useCallback((updater: DropMark | ((prev: DropMark) => DropMark)) => {
    pendingDropRef.current = updater;
    if (dropRafRef.current) return;
    dropRafRef.current = requestAnimationFrame(() => {
      dropRafRef.current = 0;
      const u = pendingDropRef.current;
      pendingDropRef.current = null;
      if (u !== null && u !== undefined) {
        setDrop((prev) => (typeof u === "function" ? (u as (p: DropMark) => DropMark)(prev) : u));
      }
    });
  }, []);
  // Stable drag-source setter: cancels a pending preview on drag end so no
  // stale empty page lingers after drop/cancel.
  const stableSetDragId = useCallback((id: string | null) => {
    if (!id && dropRafRef.current) {
      cancelAnimationFrame(dropRafRef.current);
      dropRafRef.current = 0;
      pendingDropRef.current = null;
    }
    setDragId(id);
    if (!id) setDrop(null);
  }, []);
  // Stable drag object: without useMemo every setDrop re-render would hand
  // every leaf a new drag reference. Leaves are memoized on the relevant
  // slice (dragId + own preview) so untouched panes skip re-renders.
  const drag: DragState = useMemo(() => ({
    dragId,
    drop,
    setDragId: stableSetDragId,
    setDrop: scheduleDrop,
  }), [dragId, drop, stableSetDragId, scheduleDrop]);
  // Drop any pending preview frame on unmount (no setState after unmount).
  useEffect(() => () => {
    if (dropRafRef.current) cancelAnimationFrame(dropRafRef.current);
  }, []);

  // Fullscreen keeps every ChatPanel mounted: non-fullscreen windows hide
  // with CSS (display:none) so toggling never remounts panels (no lag).
  // A drop target implies an active drag (cleared on dragend/drop), so the
  // root preview also covers external tab/sidebar drags (dragId stays null).
  const rootDropPos = drop?.id === CHAT_ROOT_DROP_ID ? drop.pos : null;
  const rootPreview = rootDropPos ? (
    <div className={`chat-root-preview preview-${rootDropPos}`} aria-hidden="true">
      <div className="chat-drop-empty-page">
        <span className="chat-drop-empty-title">{dragId ? chatTitleOf(dragId) : "Chat"}</span>
        <span className="chat-drop-hint">Release to open here</span>
      </div>
    </div>
  ) : null;
  // Tree path: recursive splits with edge highlights.
  if (chatTree && treeLeaves > 0) {
    const single = treeLeaves <= 1;
    if (single) {
      // Prefer the tree leaf over the legacy mirror so a stale visible list
      // never shows the wrong chat next to the tree window.
      const only = collectChatIds(chatTree)[0] ?? visibleChatIds[0] ?? activeChatId;
      if (!only) return null;
      // Single window still accepts a split drop: LeafView shows the
      // empty-page edge preview so the user sees where the pane lands.
      return (
        <div
          ref={stackRef}
          className={"chat-windows single vertical" + (fullscreenId ? " window-full" : "") + (rootDropPos ? ` root-drop-active root-drop-${rootDropPos}` : "")}
          data-testid="chat-windows"
          data-layout={layout}
          onDragOver={onStackDragOver}
          onDragLeave={onStackDragLeave}
          onDrop={onStackDrop}
        >
          <div className="chat-window-slot" style={{ flex: "1 1 auto" } as CSSProperties}>
            <LeafView chatId={only} focused multi={false} drag={drag} fullscreenId={fullscreenId} />
          </div>
          {rootPreview}
        </div>
      );
    }
    return (
      <div
        ref={stackRef}
                  className={"chat-windows multi tree" + (fullscreenId ? " window-full" : "") + (rootDropPos ? ` root-drop-active root-drop-${rootDropPos}` : "")}
          data-testid="chat-windows"
          data-layout={layout}
          onDragOver={onStackDragOver}
          onDragLeave={onStackDragLeave}
          onDrop={onStackDrop}
      >
        <SplitView node={chatTree} activeChatId={activeChatId} multi drag={drag} fullscreenId={fullscreenId} startTreeResize={startTreeResize} />
        {rootPreview}
      </div>
    );
  }

  if (visibleChatIds.length === 0) return null;

  // Legacy flat fallback (no persisted tree yet): linear stack.
  return (
    <div
      ref={stackRef}
                className={"chat-windows" + (multi ? " multi" : " single") + (horizontal ? " horizontal" : " vertical") + (fullscreenId ? " window-full" : "") + (rootDropPos ? ` root-drop-active root-drop-${rootDropPos}` : "")}
          data-testid="chat-windows"
          data-layout={layout}
          onDragOver={onStackDragOver}
          onDragLeave={onStackDragLeave}
          onDrop={onStackDrop}
    >
      {visibleChatIds.map((id) => {
        const focused = id === activeChatId;
        return (
          <div key={id} className="chat-window-slot" style={multi ? ({ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties) : undefined}>
            <LeafView chatId={id} focused={focused} multi={multi} drag={drag} fullscreenId={fullscreenId} />
          </div>
        );
      })}
      {rootPreview}
    </div>
  );
}
