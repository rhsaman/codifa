import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useStore } from "../lib/store";
import type { ChatLayout } from "../lib/store";
import type { ChatDropPos, ChatTreeNode } from "../lib/chatTree";
import { buildFromList, CHAT_WINDOW_MAX, CHAT_WINDOW_MIN_H, CHAT_WINDOW_MIN_W, collectChatIds, findNodeById, leafCount, normalizeTree, pickNeighborWindow } from "../lib/chatTree";
import { focusChatInput } from "../lib/chatFocus";
import { physicalKey } from "../lib/shortcuts";
import { syncViewerToChat } from "../lib/viewerTabs";
import { ChatPanel } from "./Chat";

/** MIME type for dragging a chat id from tabs/sidebar into the chat stack. */
export const CHAT_DRAG_MIME = "application/x-coder-chat-id";

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

/** Header drag handle: reorders stacked windows (HTML5 DnD, no extra deps).
 *  Only the title starts a drag so the close button always clicks. */
function WindowHeader({
  chatId,
  focused,
  multi,
  onDragState,
}: {
  chatId: string;
  focused: boolean;
  multi: boolean;
  onDragState: (dragId: string | null) => void;
}) {
  const title = chatTitleOf(chatId);
  const beginDrag = (e: DragEvent) => {
    if (!multi) return;
    e.stopPropagation();
    setChatDragData(e, chatId);
    onDragState(chatId);
  };
  const focus = () => useStore.getState().focusWindow(chatId);
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
      <span
        className="chat-window-title"
        draggable={multi}
        onDragStart={beginDrag}
        onDragEnd={() => onDragState(null)}
      >
        {title}
      </span>
      {multi && (
        <button
          type="button"
          className="chat-window-close"
          title="Hide window (chat stays in sidebar)"
          aria-label={`Hide ${title}`}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDragState(null);
            useStore.getState().closeWindow(chatId);
          }}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}

type DropMark = { id: string; pos: ChatDropPos } | null;

interface DragState {
  dragId: string | null;
  drop: DropMark;
  setDragId: (id: string | null) => void;
  setDrop: (d: DropMark | ((prev: DropMark) => DropMark)) => void;
}

/** Single chat leaf with 5-way edge highlight (left/right/top/bottom/center). */
function LeafView({
  chatId,
  focused,
  multi,
  drag,
}: {
  chatId: string;
  focused: boolean;
  multi: boolean;
  drag: DragState;
}) {
  const dropPos = drag.drop?.id === chatId ? drag.drop.pos : null;
  return (
    <section
      className={
        "chat-window" +
        (focused ? " focused" : " dimmed") +
        (dropPos ? ` drop-active drop-${dropPos}` : "")
      }
      data-chat-window={chatId}
      aria-label={chatTitleOf(chatId)}
      style={multi ? ({ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties) : undefined}
      onDragOver={(e) => {
        const internal = drag.dragId && drag.dragId !== chatId;
        let hasExternal = false;
        try {
          const types = Array.from(e.dataTransfer.types ?? []);
          hasExternal = types.includes(CHAT_DRAG_MIME) || types.includes("text/plain");
        } catch {
          hasExternal = false;
        }
        if (!internal && !hasExternal) return;
        // Full: external drags would open a new window, so reject them here
        // (no preview, drop disallowed). Internal moves only reorder.
        if (!internal) {
          const st = useStore.getState();
          const ids = st.chatTree ? collectChatIds(st.chatTree) : st.visibleChatIds;
          if (ids.length >= CHAT_WINDOW_MAX) return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        const pos = posForPoint(e, e.currentTarget as HTMLElement);
        drag.setDrop((prev) => (prev?.id === chatId && prev.pos === pos ? prev : { id: chatId, pos }));
      }}
      onDragLeave={() => drag.setDrop((prev) => (prev?.id === chatId ? null : prev))}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const from = readChatDragId(e) || drag.dragId;
        const pos = posForPoint(e, e.currentTarget as HTMLElement);
        drag.setDragId(null);
        drag.setDrop(null);
        if (!from || from === chatId) return;
        useStore.getState().dropChatOnto(from, chatId, pos);
      }}
    >
      {multi && (
        <WindowHeader chatId={chatId} focused={focused} multi={multi} onDragState={drag.setDragId} />
      )}
      <div className="chat-window-body" onClick={() => useStore.getState().focusWindow(chatId)}>
        <ChatPanel chatId={chatId} dimmed={multi && !focused} />
      </div>
      {dropPos && (
        <div className={`chat-drop-preview preview-${dropPos}`} aria-hidden="true">
          <div className="chat-drop-empty-page">
            <span className="chat-drop-empty-title">{drag.dragId ? chatTitleOf(drag.dragId) : "Chat"}</span>
            <span className="chat-drop-hint">
              {dropPos === "center" ? "Release to focus here" : "Release to open here"}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

/** Recursive split node: row = side-by-side, col = stacked. */
function SplitView({
  node,
  activeChatId,
  multi,
  drag,
  startTreeResize,
}: {
  node: ChatTreeNode;
  activeChatId: string;
  multi: boolean;
  drag: DragState;
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
    return (
      <LeafView chatId={node.chatId} focused={node.chatId === activeChatId} multi={multi} drag={drag} />
    );
  }
  const isRow = node.dir === "row";
  return (
    <div className={`chat-split ${isRow ? "row" : "col"}`} data-split-id={node.id}>
      {node.children.map((child, i) => (
        <div
          key={child.id}
          className="chat-split-child"
          style={{ flexGrow: child.size, flexShrink: 0, flexBasis: 0 } as CSSProperties}
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
          <SplitView node={child} activeChatId={activeChatId} multi={multi} drag={drag} startTreeResize={startTreeResize} />
        </div>
      ))}
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
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: ChatDropPos } | null>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ parentId: string; firstId: string; secondId: string; startX: number; startY: number; firstSize: number; secondSize: number; totalFlex: number; childCount: number; isRow: boolean } | null>(null);

  const treeLeaves = chatTree ? leafCount(chatTree) : 0;
  const multi = treeLeaves > 1 || (!chatTree && visibleChatIds.length > 1);
  const horizontal = layout === "horizontal";

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
        const r = el.getBoundingClientRect();
        centers[id] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const target = pickNeighborWindow(centers, st.activeChatId, dir);
      // No neighbor in this direction: let the key through (Ctrl+J toggles
      // the terminal, Ctrl+K stays free) instead of swallowing it.
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      st.focusWindow(target);
      requestAnimationFrame(() => focusChatInput(target));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

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
      const onMove = (ev: MouseEvent) => {
        const r = resizeRef.current;
        if (!r) return;
        // Measure the split parent so the minimum is enforced in real pixels.
        const parentEl = document.querySelector(`[data-split-id="${r.parentId}"]`);
        const parentRect = parentEl?.getBoundingClientRect();
        const parentSpan = r.isRow ? (parentRect?.width ?? 0) : (parentRect?.height ?? 0);
        const span = parentSpan > 0 ? parentSpan : (r.isRow ? (stackRef.current?.getBoundingClientRect().width ?? 800) : (stackRef.current?.getBoundingClientRect().height ?? 600));
        const travelled = r.isRow ? ev.clientX - r.startX : ev.clientY - r.startY;
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
        // Single store update per frame keeps multi-window resize cheap.
        useStore.getState().resizeTreePair(r.parentId, r.firstId, r.secondId, nextFirst, nextSecond);
      };
      const onUp = () => {
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
    if (!dragId && !hasExternalChat(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const onStackDrop = (e: DragEvent) => {
    const from = readChatDragId(e) || dragId;
    setDragId(null);
    setDrop(null);
    if (!from) return;
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

  const drag: DragState = {
    dragId,
    drop,
    setDragId: (id) => setDragId(id),
    setDrop: (updater) => setDrop((prev) => (typeof updater === "function" ? (updater as (p: DropMark) => DropMark)(prev) : updater)),
  };

  // Tree path: recursive splits with edge highlights.
  if (chatTree && treeLeaves > 0) {
    const single = treeLeaves <= 1;
    if (single) {
      const only = visibleChatIds[0] ?? activeChatId;
      if (!only) return null;
      // Single window still accepts a split drop: LeafView shows the
      // empty-page edge preview so the user sees where the pane lands.
      return (
        <div
          ref={stackRef}
          className="chat-windows single vertical"
          data-testid="chat-windows"
          data-layout={layout}
          onDragOver={onStackDragOver}
          onDrop={onStackDrop}
        >
          <div className="chat-window-slot" style={{ flex: "1 1 auto" } as CSSProperties}>
            <LeafView chatId={only} focused multi={false} drag={drag} />
          </div>
        </div>
      );
    }
    return (
      <div
        ref={stackRef}
        className="chat-windows multi tree"
        data-testid="chat-windows"
        data-layout={layout}
        onDragOver={onStackDragOver}
        onDrop={onStackDrop}
      >
        <SplitView node={chatTree} activeChatId={activeChatId} multi drag={drag} startTreeResize={startTreeResize} />
      </div>
    );
  }

  if (visibleChatIds.length === 0) return null;

  // Legacy flat fallback (no persisted tree yet): linear stack.
  return (
    <div
      ref={stackRef}
      className={"chat-windows" + (multi ? " multi" : " single") + (horizontal ? " horizontal" : " vertical")}
      data-testid="chat-windows"
      data-layout={layout}
      onDragOver={onStackDragOver}
      onDrop={onStackDrop}
    >
      {visibleChatIds.map((id) => {
        const focused = id === activeChatId;
        return (
          <div key={id} className="chat-window-slot" style={multi ? ({ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties) : undefined}>
            <LeafView chatId={id} focused={focused} multi={multi} drag={drag} />
          </div>
        );
      })}
    </div>
  );
}
