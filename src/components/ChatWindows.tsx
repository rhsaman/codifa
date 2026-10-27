import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useStore } from "../lib/store";
import { useViewerTabs } from "../lib/viewerTabs";
import type { ChatDropPos, ChatTreeNode } from "../lib/chatTree";
import { beforePos, buildFromList, CHAT_WINDOW_MAX, CHAT_WINDOW_MIN_H, CHAT_WINDOW_MIN_W, collectChatIds, dirForPos, findNodeById, flexWeights, ghostInsertIndex, isVacatedByDrag, leafCount, normalizeTree, pickNeighborWindow, resolveLeafPos, shouldShowNestedGhost, shouldShowSiblingGhost } from "../lib/chatTree";
import { focusChatInput } from "../lib/chatFocus";
import { workspaceDisplayFor } from "../lib/chatWindowMeta";
import { physicalKey } from "../lib/shortcuts";
import { syncViewerToChat } from "../lib/viewerTabs";
import { ChatPanel } from "./Chat";
import { TabPendingBadges } from "./ChatTabBar";
import { ChatRenameInput, normalizeRenameValue } from "./ChatRenameInput";
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
  // Index rows carry the first-user preview, so the window title is correct
  // even before the transcript is fetched.
  if (c.firstUser) return c.firstUser.slice(0, 40) || "New chat";
  const first = c.messages.find((m) => m.role === "user");
  return first ? first.content.slice(0, 40) || "New chat" : "New chat";
}

/** Map a pointer position inside a leaf to a VSCode-like drop position.
 *  Edges split (left/right/top/bottom), center swaps/focuses. Works for any
 *  current orientation so a horizontal row can still accept a vertical drop
 *  and vice versa. */
function posForPoint(e: DragEvent, el: HTMLElement, prev: ChatDropPos | null = null): ChatDropPos {
  const rect = el.getBoundingClientRect();
  const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
  const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
  // Hysteresis via resolveLeafPos: inserting the ghost sibling and vacating
  // the source expand the target leaf, shifting fractions a few px under a
  // steady cursor. Without the wider exit band the pos flips edge/center
  // every frame and the empty page flickers in and out.
  return resolveLeafPos(x, y, prev);
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
function rootEdgeForStackPoint(e: DragEvent, stackEl: HTMLElement | null, extraPx = 0): ChatDropPos | null {
  const rect = stackEl?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  // extraPx widens the exit band while a root preview shows: leaving the
  // edge strip must travel further before the preview flips back to a leaf
  // ghost, otherwise a steady cursor near the border flickers root/leaf.
  const threshold = Math.max(ROOT_EDGE_MIN_PX, Math.min(rect.width, rect.height) * ROOT_EDGE_FRACTION) + extraPx;
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

function rootEdgeForPoint(e: DragEvent, leafEl: HTMLElement, extraPx = 0): ChatDropPos | null {
  const stackEl = leafEl.closest?.(".chat-windows") as HTMLElement | null;
  return rootEdgeForStackPoint(e, stackEl, extraPx);
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
  const dir = useStore((s) => s.dir);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setEditing(false);
  }, [chatId]);
  const status = windowStatusFor(chat, chatId, activeChatId, unreadChats);
  const ws = workspaceDisplayFor(chat?.root, workspaces, workspaceColors);
  const beginDrag = (e: DragEvent) => {
    if (!multi) return;
    e.stopPropagation();
    setChatDragData(e, chatId);
    onDragState(chatId);
  };
  const focus = () => {
    useStore.getState().focusWindow(chatId);
  };
  // Instant minimize: pointerdown fires on press (~100ms before click which
  // waits for release). Guarded so the follow-up click never closes twice.
  const minimizeArmedRef = useRef(false);
  const doMinimize = useCallback((hideEl?: HTMLElement | null) => {
    if (minimizeArmedRef.current) return;
    minimizeArmedRef.current = true;
    // Optimistic hide: collapse the flex slot synchronously so the remaining
    // panes expand in the same frame. closest() with a selector list returns
    // the NEAREST match (the inner section), which would leave an empty flex
    // slot behind and feel like a two-step lag — so find the leaf first, then
    // hide its wrapping slot.
    try {
      const leaf = hideEl?.closest?.('[data-chat-window]') as HTMLElement | null;
      const slot = (leaf?.parentElement?.closest?.('.chat-split-child, .chat-window-slot') as HTMLElement | null)
        ?? (leaf?.parentElement as HTMLElement | null);
      if (slot) slot.style.display = 'none';
      else if (leaf) leaf.style.display = 'none';
    } catch {
      /* ignore */
    }
    onDragState(null);
    // Run the tree update as a macrotask AFTER paint: rAF fires BEFORE paint,
    // so scheduling there would still block the sync hide above from painting
    // and the press would feel laggy. setTimeout lets the collapsed slot paint
    // first; the React commit (incl. remaining-panel remount) follows.
    setTimeout(() => {
      try {
        useStore.getState().closeWindow(chatId);
      } finally {
        minimizeArmedRef.current = false;
      }
    }, 0);
  }, [chatId, onDragState]);
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
      {editing ? (
        <ChatRenameInput
          initialValue={title === "New chat" ? "" : title}
          dir={dir}
          className="chat-rename-input chat-window-title-input"
          ariaLabel={`Rename ${title}`}
          onCommit={(v) => {
            useStore.getState().renameChat(chatId, normalizeRenameValue(v));
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span
          className="chat-window-title"
          draggable={multi}
          onDragStart={beginDrag}
          onDragEnd={() => onDragState(null)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {title}
        </span>
      )}
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
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              doMinimize(e.currentTarget as HTMLElement);
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // Fallback for keyboard / touch without pointerdown.
              doMinimize(e.currentTarget as HTMLElement);
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
        // Root edge wins over leaf zones, except external drags at max:
        // root drops always add a window, so a full grid cannot take one —
        // fall through to leaf center replace instead of a stale strip.
        if (drag.dragId || hasExternal) {
          const rootActive = drag.drop?.id === CHAT_ROOT_DROP_ID;
          const rootPos = rootEdgeForPoint(e, e.currentTarget as HTMLElement, rootActive ? 24 : 0);
          if (rootPos) {
            if (!drag.dragId) {
              const st = useStore.getState();
              const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds;
              if (ids.length < CHAT_WINDOW_MAX) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                drag.setDrop((prev) => (prev?.id === CHAT_ROOT_DROP_ID && prev.pos === rootPos ? prev : { id: CHAT_ROOT_DROP_ID, pos: rootPos }));
                return;
              }
            } else {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              drag.setDrop((prev) => (prev?.id === CHAT_ROOT_DROP_ID && prev.pos === rootPos ? prev : { id: CHAT_ROOT_DROP_ID, pos: rootPos }));
              return;
            }
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
        const prevPos = drag.drop?.id === chatId ? drag.drop.pos : null;
        const rawPos = posForPoint(e, e.currentTarget as HTMLElement, prevPos);
        // Center drops swap/replace: internal moves swap windows, external
        // tab/sidebar drags replace the target (no new window, works at max).
        let pos = rawPos;
        // Full: a new chat cannot split in, so an external edge becomes a
        // center replace — the empty page still shows instead of vanishing.
        if (!internal) {
          const st = useStore.getState();
          const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds;
          if (ids.length >= CHAT_WINDOW_MAX && pos !== 'center') {
            pos = 'center';
          }
        }
        drag.setDrop((prev) => (prev?.id === chatId && prev.pos === pos ? prev : { id: chatId, pos }));
      }}
      onDragLeave={(e) => {
        // dragleave fires between children inside the same pane and when the
        // ghost sibling inserts next to the target: the pointer "leaves" the
        // leaf for the ghost while still inside the chat area. Clearing here
        // removes the ghost, shifts layout back, re-triggers dragover, and
        // flickers rapidly — so only clear when truly leaving the chat area.
        const to = e.relatedTarget as HTMLElement | null;
        if (to && (e.currentTarget as HTMLElement).contains(to)) return;
        if (to?.closest?.(".chat-windows")) return;
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
        drag.setDragId(null);
        drag.setDrop(null);
        if (!from) return;
        if (shown?.id === CHAT_ROOT_DROP_ID && shown.pos !== "center") {
          useStore.getState().dropChatOntoRoot(from, shown.pos);
          return;
        }
        if (shown?.id === chatId && from !== chatId) {
          useStore.getState().dropChatOnto(from, chatId, shown.pos);
          return;
        }
        const rootPos = rootEdgeForPoint(e, e.currentTarget as HTMLElement);
        if (rootPos) {
          useStore.getState().dropChatOntoRoot(from, rootPos);
          return;
        }
        if (from === chatId) return;
        const pos = posForPoint(e, e.currentTarget as HTMLElement);
        useStore.getState().dropChatOnto(from, chatId, pos);
      }}
    >
      {multi && (
        <WindowHeader chatId={chatId} focused={focused} multi={multi} fullscreen={isFullscreen} onDragState={drag.setDragId} />
      )}
      <div className="chat-window-body" onClick={() => {
        useStore.getState().focusWindow(chatId);
      }}>
        <MemoChatPanel chatId={chatId} dimmed={multi && !focused} />
      </div>
    </section>
  );
}, leafDragEqual);

/** Unified drop overlay: one persistent element for the whole stack that
 *  glides between target rects (leaf panes, root strips) via CSS transitions.
 *  Per-pane overlays cannot animate — they mount/unmount on every target
 *  change, and a freshly mounted element has no previous geometry to
 *  transition from. The target rect is re-measured every frame while the
 *  overlay is visible because ghost insertion and the vacated source shift
 *  the layout under a steady cursor. */
function ChatDropOverlay({ mark, title, dragging, ghost }: { mark: DropMark | null; title: string; dragging: boolean; ghost?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Tracks whether the overlay is currently visible, so the first frame after
  // (re)appearing can place the geometry instantly (no slide from stale
  // coordinates) and only then fade in.
  const visibleRef = useRef(false);
  const active = !!mark;
  // Callers render with a non-null mark while active; the fallback keeps types strict.
  const { id, pos } = mark ?? { id: CHAT_ROOT_DROP_ID, pos: "center" as ChatDropPos };
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) {
      // Hide via opacity only: the element stays mounted for the whole drag
      // session, so it never remounts (a remount is what reads as a jump).
      if (el) {
        el.style.opacity = "0";
        visibleRef.current = false;
      }
      return;
    }
    let raf = 0;
    const tick = () => {
      const stack = (el.parentElement ?? null) as HTMLElement | null;
      const target = !stack
        ? null
        : ghost
          ? (stack.querySelector(".chat-drop-ghost") as HTMLElement | null)
          : id === CHAT_ROOT_DROP_ID
            ? stack
            : (stack.querySelector(`[data-chat-window="${CSS.escape(id)}"]`) as HTMLElement | null);
      const r = target?.getBoundingClientRect();
      if (stack && r && r.width > 0 && r.height > 0) {
        const s = stack.getBoundingClientRect();
        let left = r.left - s.left;
        let top = r.top - s.top;
        let width = r.width;
        let height = r.height;
        if (!ghost) {
          if (pos === "left") width /= 2;
          else if (pos === "right") { left += width / 2; width /= 2; }
          else if (pos === "top") height /= 2;
          else if (pos === "bottom") { top += height / 2; height /= 2; }
        }
        const st = el.style;
        if (!visibleRef.current) {
          // First frame after appearing: jump to the new rect with transitions
          // disabled, then fade in — gliding from an old hidden rect would
          // read as a jump from the wrong place.
          st.transition = "none";
          st.left = `${left}px`;
          st.top = `${top}px`;
          st.width = `${width}px`;
          st.height = `${height}px`;
          void el.offsetWidth;
          st.transition = "";
          st.opacity = "1";
          visibleRef.current = true;
        } else {
          st.left = `${left}px`;
          st.top = `${top}px`;
          st.width = `${width}px`;
          st.height = `${height}px`;
        }
      } else if (visibleRef.current) {
        el.style.opacity = "0";
        visibleRef.current = false;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, id, pos, ghost]);
  return (
    <div ref={ref} className="chat-drop-overlay" aria-hidden="true">
      <div className="chat-drop-empty-page">
        <span className="chat-drop-empty-title">{title}</span>
        <span className="chat-drop-hint">
          {id !== CHAT_ROOT_DROP_ID && pos === "center" ? (dragging ? "Release to swap" : "Release to replace") : "Release to open here"}
        </span>
      </div>
    </div>
  );
}

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
  // Sibling ghost: an edge drop along this split's axis inserts a real flex
  // sibling next to the target, so the preview shows N equal windows (e.g.
  // 3 stay 3 equal) instead of an overlay that reads as an extra window.
  const ghostTargetIdx = node.children.findIndex((c) => c.kind === "leaf" && !!drag.drop && drag.drop.id === c.chatId && drag.drop.pos !== "center");
  const ghostPos = ghostTargetIdx >= 0 ? drag.drop!.pos : null;
  const showGhost = ghostTargetIdx >= 0 && ghostPos !== null && !fullscreenId && shouldShowSiblingGhost(node.dir, ghostPos, true);
  const showNestedGhost = ghostTargetIdx >= 0 && ghostPos !== null && !fullscreenId && shouldShowNestedGhost(node.dir, ghostPos, true);
  const anyGhost = showGhost || showNestedGhost;
  const ghostAt = showGhost ? ghostInsertIndex(ghostTargetIdx, ghostPos!) : -1;
  const ghostTitle = drag.dragId ? chatTitleOf(drag.dragId) : "Chat";
  // Ghost uses equal flex (1) and siblings equalize too, so the preview
  // shows N equal panes (e.g. dragging the 3rd window shows 3 equal).
  const ghostEl = showGhost ? (
    <div
      key="__drop-ghost__"
      className="chat-split-child chat-drop-ghost"
      style={{ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties}
      aria-hidden="true"
    >
      <div className="chat-drop-ghost-page">
        <span className="chat-drop-empty-title">{ghostTitle}</span>
        <span className="chat-drop-hint">Release to open here</span>
      </div>
    </div>
  ) : null;
  const nestedGhostInner = showNestedGhost ? (
    <div
      key="__drop-ghost-nested__"
      className="chat-split-child chat-drop-ghost"
      style={{ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties}
      aria-hidden="true"
    >
      <div className="chat-drop-ghost-page">
        <span className="chat-drop-empty-title">{ghostTitle}</span>
        <span className="chat-drop-hint">Release to open here</span>
      </div>
    </div>
  ) : null;
  // Suppress the half-pane overlay only on the ghost target: the ghost sibling
  // already shows the landing zone with equal flex, so keeping both would
  // read as an extra window. Other children keep the original drop so a
  // nested drag source still vacates (its own space counts as empty).
  const kids: React.ReactNode[] = [];
  // Weights normalized across the children that actually take part in layout:
  // a slot hidden by fullscreen (or vacated by a drag) is display:none and
  // contributes no flex, which could drop the visible total below 1 and leave
  // the tail of the row/column blank. Normalizing keeps the panes covering the
  // whole track while preserving their relative sizes.
  const visibleSizes = node.children
    .filter((child) => {
      const ids = collectChatIds(child);
      if (fullscreenId && !ids.includes(fullscreenId)) return false;
      if (fullscreenId || !drag.drop || drag.drop.pos === "center") return true;
      return !isVacatedByDrag(ids, drag.dragId);
    })
    .map((child) => child.size);
  const weights = flexWeights(visibleSizes);
  let weightIdx = 0;
  node.children.forEach((child, i) => {
    if (showGhost && ghostAt === i) kids.push(ghostEl);
    const isGhostTarget = (showGhost || showNestedGhost) && i === ghostTargetIdx;
    const childDrag = isGhostTarget ? { ...drag, drop: null } : drag;
    // Fullscreen keeps every panel mounted: subtrees without the
    // fullscreen chat hide with CSS instead of unmounting.
    const childIds = collectChatIds(child);
    const childHidden = !!fullscreenId && !childIds.includes(fullscreenId);
    // Internal drag vacates the source slot once an edge preview shows: the dragged
    // window's own space counts as empty, so the ghost plus the remaining
    // panes show the final layout (e.g. dragging the 3rd window shows 3
    // equal panes, not 4). Gated on edge drop so center swap keeps all panes
    // (swap preserves count) and layout stays stable until a target highlights.
    // External tab/sidebar drags keep dragId null.
    const vacated = !childHidden && !fullscreenId && !!drag.drop && drag.drop.pos !== "center" && isVacatedByDrag(childIds, drag.dragId);
    const hidden = childHidden || vacated;
    kids.push(
      <div
        key={child.id}
        className={"chat-split-child" + (hidden ? " window-hidden" : "")}
        style={{ flexGrow: anyGhost && !hidden ? 1 : hidden ? child.size : weights[weightIdx++], flexShrink: 0, flexBasis: 0, ...(hidden ? { display: "none" } : null) } as CSSProperties}
        aria-hidden={hidden}
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
        {showNestedGhost && i === ghostTargetIdx && !hidden ? (
          <div className={`chat-split ${dirForPos(ghostPos!) === "row" ? "row" : "col"}`} style={{ flex: "1 1 auto", minHeight: 0, minWidth: 0 } as CSSProperties}>
            {beforePos(ghostPos!) && nestedGhostInner}
            <div className="chat-split-child" style={{ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties}>
              <SplitView node={child} activeChatId={activeChatId} multi={multi} drag={childDrag} fullscreenId={fullscreenId} startTreeResize={startTreeResize} />
            </div>
            {!beforePos(ghostPos!) && nestedGhostInner}
          </div>
        ) : (
          <SplitView node={child} activeChatId={activeChatId} multi={multi} drag={childDrag} fullscreenId={fullscreenId} startTreeResize={startTreeResize} />
        )}
      </div>
    );
  });
  if (showGhost && ghostAt >= node.children.length) kids.push(ghostEl);
  return (
    <div className={`chat-split ${isRow ? "row" : "col"}`} data-split-id={node.id}>
      {kids}
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
  /** Removers for an in-flight split-drag; run on unmount so an interrupted
   *  drag never leaves window listeners behind. */
  const treeResizeCleanupRef = useRef<(() => void) | null>(null);

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

  // App-wide Ctrl/Cmd+F: the file explorer's name filter. The explorer tab is
  // often NOT the active rail tab (opening a file switches the rail to that
  // file), and the panel is then unmounted, so this handler has to exist
  // outside it. Deliberately LAST in the chord chain: a dialog/overlay, the
  // terminal and the file viewer all keep their own find, and a press INSIDE
  // the explorer is handled by the panel itself (focus stays where the user put
  // it). Only when none of them claims the key does this activate the tab and
  // focus its box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (physicalKey(e as { code: string; key: string }) !== "f") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".files-panel")) return;
      if (t?.closest?.('[role="dialog"], .settings-modal, .search-overlay')) return;
      const st = useStore.getState();
      const chatId = st.activeChatId;
      const chat = chatId ? st.chats.find((c) => c.id === chatId) : undefined;
      if (!chat?.root) return;
      e.preventDefault();
      e.stopPropagation();
      useViewerTabs.getState().focusFilesFilter();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // Vim-style window navigation: Ctrl+H/J/K/L moves focus between windows
  // (h=left, j=down, k=up, l=right) and drops the caret into the new
  // window's composer input. LIVES ON Shift+Alt(Option)+H/J/K/L: the plain
  // `Ctrl+H/J/K/L` (App.tsx) walks the chat windows and must never swap
  // chats, and a bare j/k must stay free for sidebar/transcript scrolling.
  // Skipped in dialogs, settings and overlays (someone already consumed the
  // key when defaultPrevented).
  useEffect(() => {
     const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[role="dialog"], .settings-modal, .search-overlay')) return;
      const k = physicalKey(e as { code: string; key: string });
      // Window MOVE (swap positions): Shift+Alt(Option)+H/J/K/L. The plain
      // Ctrl+X chords move FOCUS between windows/panes (App.tsx) and never
      // swap chats; bare j/k stay free for transcript/sidebar scrolling.
      if (!e.shiftKey || !e.altKey || e.metaKey || e.ctrlKey) return;
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
      // No neighbor in this direction: let the key through instead of
      // swallowing it (other Shift+Alt sets stay free).
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      // SWAP the two windows' places (a real move, not a focus hop), then put
      // the caret into the moved window's composer so work continues there.
      st.dropChatOnto(st.activeChatId, target, 'center');
      const next = useStore.getState().activeChatId;
      if (next) requestAnimationFrame(() => focusChatInput(next));
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
  }, [visibleChatIds.length, treeLeaves, layout, chatTree]);

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
      // A drag interrupted by an unmount (window closed / layout normalized)
      // used to leave both listeners attached forever, holding the closed-over
      // store and resizing a detached tree. Hand the removers to the shared
      // cleanup effect below.
      treeResizeCleanupRef.current = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
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
    // Full grid: external root-edge drops would add a window, so suppress
    // the strip highlight — leaf center replace covers the gap instead.
    if (!dragId) {
      const st = useStore.getState();
      const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds;
      if (ids.length >= CHAT_WINDOW_MAX) {
        setDrop((prev) => (prev?.id === CHAT_ROOT_DROP_ID ? null : prev));
        return;
      }
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Gaps between panes (resize bars, split padding) also accept root-edge
    // drops so the full-width highlight works even off-leaf. Applies to both
    // internal moves and external tab/sidebar drags (which keep dragId null).
    const rootActive = drop?.id === CHAT_ROOT_DROP_ID;
    const rootPos = rootEdgeForStackPoint(e, stackRef.current, rootActive ? 24 : 0);
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
    if (curDrop && curDrop.id !== CHAT_ROOT_DROP_ID && from !== curDrop.id) {
      e.preventDefault();
      useStore.getState().dropChatOnto(from, curDrop.id, curDrop.pos);
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
    // A split-drag interrupted by unmount: detach the window listeners the
    // pointer-down handler installed (see startTreeResize).
    treeResizeCleanupRef.current?.();
    treeResizeCleanupRef.current = null;
  }, []);

  // Fullscreen keeps every ChatPanel mounted: non-fullscreen windows hide
  // with CSS (display:none) so toggling never remounts panels (no lag).
  // A drop target implies an active drag (cleared on dragend/drop), so the
  // root preview also covers external tab/sidebar drags (dragId stays null).
  const rootDropPos = drop?.id === CHAT_ROOT_DROP_ID ? drop.pos : null;
  // Ghost layout preview (sibling/nested slot) for edge drops: when it renders
  // it already shows the landing zone, so the unified overlay stays hidden
  // (both at once would read as an extra window).
  const ghostTargetIdx = visibleChatIds.findIndex((id) => !!drop && drop.id === id && drop.pos !== "center");
  const ghostTargetPos = ghostTargetIdx >= 0 ? drop!.pos : null;
  const ghostParentDir = horizontal ? "row" : "col";
  const showSiblingGhost = ghostTargetIdx >= 0 && ghostTargetPos !== null && !fullscreenId && shouldShowSiblingGhost(ghostParentDir, ghostTargetPos, true);
  const showNestedGhost = ghostTargetIdx >= 0 && ghostTargetPos !== null && !fullscreenId && shouldShowNestedGhost(ghostParentDir, ghostTargetPos, true);
  // The overlay element stays mounted for the whole drag session; hiding is
  // opacity-only, so reappearing never remounts and never jumps. While a
  // ghost slot represents the landing zone, the overlay glides onto the
  // ghost's rect instead of hiding (hide-here + show-there read as a jump).
  const rootPreview = (
    <ChatDropOverlay
      mark={drop}
      ghost={showSiblingGhost || showNestedGhost}
      title={dragId ? chatTitleOf(dragId) : "Chat"}
      dragging={!!dragId}
    />
  );
  // Tree path: recursive splits with edge highlights.
  if (chatTree && treeLeaves > 0) {
    const single = treeLeaves <= 1;
    if (single) {
      // Prefer the tree leaf over the legacy mirror so a stale visible list
      // never shows the wrong chat next to the tree window.
      const only = collectChatIds(chatTree)[0] ?? visibleChatIds[0] ?? activeChatId;
      if (!only) return null;
      // Single window renders through the same SplitView as multi (not a
      // separate slot branch): after a minimize the tree keeps its split
      // wrapper (see removeChat), so the remaining LeafView keeps its React
      // key/parent and is never remounted (the minimize lag). Single styling
      // comes from the container class; multi=false hides the header.
      return (
        <div
          ref={stackRef}
          className={"chat-windows single tree" + (fullscreenId ? " window-full" : "") + (rootDropPos ? ` root-drop-active root-drop-${rootDropPos}` : "")}
          data-testid="chat-windows"
          data-layout={layout}
          onDragOver={onStackDragOver}
          onDragLeave={onStackDragLeave}
          onDrop={onStackDrop}
        >
          <SplitView node={chatTree} activeChatId={activeChatId} multi={false} drag={drag} fullscreenId={fullscreenId} startTreeResize={startTreeResize} />
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
      {(() => {
        // Legacy flat preview mirrors the tree path: the dragged window's own
        // space counts as empty (vacated slot collapses) and an edge drop
        // along the stack axis inserts a real flex sibling ghost with equal
        // size, so 2 windows preview as 2 equal (not 3) and dragging the 3rd
        // previews 3 equal. External tab/sidebar drags keep dragId null.
        // Ghost geometry is hoisted above (shared with overlay suppression).
        const targetIdx = ghostTargetIdx;
        const targetPos = ghostTargetPos;
        const showGhost = showSiblingGhost;
        const ghostAt = showGhost ? ghostInsertIndex(targetIdx, targetPos!) : -1;
        const ghostTitle = drag.dragId ? chatTitleOf(drag.dragId) : "Chat";
        const ghostSlot = showGhost ? (
          <div key="__drop-ghost__" className="chat-window-slot chat-drop-ghost" style={multi ? ({ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties) : undefined} aria-hidden="true">
            <div className="chat-drop-ghost-page">
              <span className="chat-drop-empty-title">{ghostTitle}</span>
              <span className="chat-drop-hint">Release to open here</span>
            </div>
          </div>
        ) : null;
        const slots: React.ReactNode[] = [];
        visibleChatIds.forEach((id, i) => {
          if (showGhost && ghostAt === i) slots.push(ghostSlot);
          const focused = id === activeChatId;
          const vacated = !fullscreenId && !!drag.drop && drag.drop.pos !== "center" && isVacatedByDrag([id], drag.dragId);
          if (vacated) {
            slots.push(
              <div key={id} className="chat-window-slot window-hidden" style={multi ? ({ flexGrow: 1, flexShrink: 0, flexBasis: 0, display: "none" } as CSSProperties) : ({ display: "none" } as CSSProperties)} aria-hidden="true" />
            );
            return;
          }
          // Suppress the half-pane overlay only on the ghost target: the ghost
          // sibling already shows the landing zone, so keeping both would read
          // as an extra window. Other children keep the original drop.
          const isGhostTarget = (showGhost || showNestedGhost) && i === targetIdx;
          const leafDrag = isGhostTarget ? { ...drag, drop: null } : drag;
          if (showNestedGhost && i === targetIdx) {
            const nestedDirIsRow = dirForPos(targetPos!) === "row";
            const ghostFirst = beforePos(targetPos!);
            const nestedGhostSlot = (
              <div key="__drop-ghost-nested__" className="chat-window-slot chat-drop-ghost" style={multi ? ({ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties) : undefined} aria-hidden="true">
                <div className="chat-drop-ghost-page">
                  <span className="chat-drop-empty-title">{ghostTitle}</span>
                  <span className="chat-drop-hint">Release to open here</span>
                </div>
              </div>
            );
            slots.push(
              <div key={id} className="chat-window-slot" style={multi ? ({ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties) : undefined}>
                <div className={`chat-split ${nestedDirIsRow ? "row" : "col"}`} style={{ flex: "1 1 auto", minHeight: 0, minWidth: 0 } as CSSProperties}>
                  {ghostFirst && nestedGhostSlot}
                  <div className="chat-split-child" style={{ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties}>
                    <LeafView chatId={id} focused={focused} multi={multi} drag={leafDrag} fullscreenId={fullscreenId} />
                  </div>
                  {!ghostFirst && nestedGhostSlot}
                </div>
              </div>
            );
            return;
          }
          slots.push(
            <div key={id} className="chat-window-slot" style={multi ? ({ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties) : undefined}>
              <LeafView chatId={id} focused={focused} multi={multi} drag={leafDrag} fullscreenId={fullscreenId} />
            </div>
          );
        });
        if (showGhost && ghostAt >= visibleChatIds.length) slots.push(ghostSlot);
        return slots;
      })()}
      {rootPreview}
    </div>
  );
}
