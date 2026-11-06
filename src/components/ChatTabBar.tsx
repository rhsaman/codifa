import { useEffect, useMemo, useRef, useState } from "react";
import { APP_DIR, useStore, workspaceKey } from "../lib/store";
import { detectDir, prepareContent } from "../lib/bidi";
import { collectChatIds } from "../lib/chatTree";
import { copyToClipboard } from "../lib/clipboard";
import {
  barFlowSign,
  captureDragSlots,
  edgeScroll,
  inactiveTabIds,
  liveExtents,
  menuLeft,
  menuTop,
  slotExtents,
  slotShifts,
  tabForPoint,
  tabMove,
  type DragSlots,
} from "../lib/tabBar";
import { TabListButton, CloseTabsIcon, type TabListSection } from "./TabListMenu";
import { ChatRenameInput, normalizeRenameValue } from "./ChatRenameInput";
import { buildGroups } from "./Sidebar";

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
    </svg>
  );
}

function chatTitle(chat: { title: string; messages: Array<{ role: string; content: string }> }): string {
  if (chat.title && chat.title !== "New chat") return chat.title;
  const firstUser = chat.messages.find((m) => m.role === "user");
  return firstUser ? firstUser.content.slice(0, 32) || "New chat" : "New chat";
}

export type TabPendingPermission = { action: string; path?: string } | null;
export type TabPendingAsk = { question: string } | null;

/** Ask/permission badges for a chat tab — the same shield/? language as the
 *  sidebar's `.chat-item-pending` spans, so a chat waiting on the user stays
 *  visible while the sidebar is closed. Pure props so it stays SSR-testable. */
export function TabPendingBadges({
  pendingPermission,
  pendingAsk,
}: {
  pendingPermission: TabPendingPermission;
  pendingAsk: TabPendingAsk;
}) {
  return (
    <>
      {pendingPermission && (
        <span
          className="chat-item-pending permission"
          title={`Needs permission: ${pendingPermission.action}${pendingPermission.path ? ` · ${pendingPermission.path}` : ""}`}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        </span>
      )}
      {pendingAsk && (
        <span className="chat-item-pending ask" title={`Asks you: ${pendingAsk.question}`}>
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
            <path d="M12 17h.01" />
          </svg>
        </span>
      )}
    </>
  );
}

/** Chevron at the chat tab bar's start: searchable list of open chat tabs
 *  (with ages + close) and recently closed ones — the bar itself stops
 *  scrolling, so this keeps every chat tab reachable when there are many. */
export function ChatTabListButton() {
  const openChatIds = useStore((s) => s.openChatIds);
  const activeChatId = useStore((s) => s.activeChatId);
  const recents = useStore((s) => s.recentlyClosedChatTabs);
  // Lightweight chat summaries — same shape as the tab bar's subscription.
  const chats = useStore((s) =>
    s.chats.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      firstUser: c.firstUser ?? c.messages.find((m) => m.role === "user")?.content,
    })),
  );
  const byId = new Map(chats.map((c) => [c.id, c]));
  const titleOf = (c: { title: string; firstUser?: string }): string =>
    c.title && c.title !== "New chat"
      ? c.title
      : c.firstUser
        ? c.firstUser.slice(0, 32) || "New chat"
        : "New chat";
  const icon = (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
  const sections: TabListSection[] = [
    {
      label: "Open tabs",
      entries: openChatIds
        .map((id) => {
          const c = byId.get(id);
          if (!c) return null;
          return {
            key: id,
            title: titleOf(c),
            icon,
            age: c.updatedAt,
            active: id === activeChatId,
            onOpen: () => useStore.getState().openChat(id),
            onClose: () => useStore.getState().closeChatTab(id),
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null),
    },
    {
      label: "Recently closed tabs",
      entries: recents
        .map((r) => {
          const c = byId.get(r.id);
          if (!c) return null;
          return {
            key: `closed-${r.id}`,
            title: titleOf(c),
            icon,
            age: r.at,
            onOpen: () => useStore.getState().reopenChatTab(r.id),
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null),
    },
  ];
  // Reactive cleanup count: tabs that are not active, not streaming and
  // not open in a multi-window pane. Subscribes to tree/visible/streaming
  // so the footer label refreshes when a stream starts or stops. Closing a
  // tab never deletes the chat (the sidebar keeps it), so this only clears
  // tab clutter.
  const chatTree = useStore((s) => s.chatTree);
  const visibleChatIds = useStore((s) => s.visibleChatIds);
  const streamingKey = useStore((s) =>
    s.chats
      .filter((c) => c.hydrated !== false && c.messages.some((m) => m.streaming || m.retry?.reconnecting === true))
      .map((c) => c.id)
      .sort()
      .join(","),
  );
  const visibleSet = new Set(chatTree ? collectChatIds(chatTree) : visibleChatIds);
  const streamingSet = new Set(streamingKey ? streamingKey.split(",") : []);
  const inactive = inactiveTabIds(openChatIds, activeChatId, streamingSet, visibleSet);
  // Toolbar icons inside the search row (not bar buttons): the single/multi
  // window toggle and the bulk tab closer cost the tab row zero space. Both
  // stay open on click so the state flips visibly.
  const multi = (chatTree ? collectChatIds(chatTree).length : visibleChatIds.length) > 1;
  const tools = (
    <>
      {openChatIds.length > 1 && (
        <button
          type="button"
          className="tab-list-tool-btn"
          aria-pressed={multi}
          title={
            multi
              ? "Multi-window is on: every visible chat shows in its own window. Click to show a single chat (windows come back in place, at their sizes)."
              : "Single chat is on. Click to show the open chats as windows again, in place and at their sizes."
          }
          aria-label={multi ? "Switch to single chat window" : "Switch to multi chat windows"}
          onClick={() => useStore.getState().toggleChatWindows()}
        >
          {multi ? (
            <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="1.5" y="2.5" width="9" height="7" rx="1" />
              <path d="M6 2.5v7" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="1.5" y="2.5" width="9" height="7" rx="1" />
            </svg>
          )}
        </button>
      )}
      <button
        type="button"
        className="tab-list-tool-btn"
        disabled={inactive.length === 0}
        title={
          inactive.length > 0
            ? `Close ${inactive.length} inactive tab${inactive.length === 1 ? "" : "s"} (not active, not streaming, not open in a window — chats stay in the sidebar)`
            : "No inactive tabs to close"
        }
        aria-label={`Close ${inactive.length} inactive chat tabs`}
        onClick={() => useStore.getState().closeInactiveChatTabs()}
      >
        <CloseTabsIcon />
      </button>
    </>
  );
  return (
    <TabListButton
      sections={sections}
      label="Chat tab list"
      tools={tools}
    />
  );
}

/** VSCode-style tab bar for the left editor group (chats only). Tabs can be
 *  reordered with drag & drop; order persists across restarts. */
export function ChatTabBar() {
  const openChatIds = useStore((s) => s.openChatIds);
  const activeChatId = useStore((s) => s.activeChatId);
  const dir = APP_DIR;
  const chats = useStore((s) =>
    s.chats.map((c) => ({
      id: c.id,
      title: c.title,
      // Prefer the index row's first-user preview: an unhydrated chat has no
      // messages in memory, and its tab title must still read correctly.
      messages: c.firstUser
        ? [{ role: "user", content: c.firstUser }]
        : c.messages
            .filter((m) => m.role === "user")
            .slice(0, 1)
            .map((m) => ({ role: m.role, content: m.content })),
      streaming: c.hydrated !== false && c.messages.some((m) => m.streaming || m.retry?.reconnecting === true),
      pendingPermission: c.pendingPermission
        ? {
            action: c.pendingPermission.action,
            path: c.pendingPermission.path,
          }
        : null,
      pendingAsk: c.pendingAsk ? { question: c.pendingAsk.question } : null,
      unread: s.unreadChats.includes(c.id),
      // Context-menu fields (same actions as the sidebar's chat menu).
      root: c.root ?? "",
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  // Slot boxes captured ONCE at drag start (see captureDragSlots): hit-testing
  // and the slide distances both read these, never the live boxes — the live
  // ones carry the slide transforms, which fed back into the next hit-test
  // and made the preview oscillate (the drag visibly jumped).
  const slotsRef = useRef<DragSlots | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Right-click menu on a tab: the SAME actions as the sidebar's chat menu
  // (pin, rename, copy id, move to group, delete) plus the tab-native
  // "close tab". `menuMove` swaps the content for the workspace list, exactly
  // like the sidebar menu's second level.
  const [menuChatId, setMenuChatId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [menuMove, setMenuMove] = useState(false);
  const closeMenu = () => {
    setMenuChatId(null);
    setMenuMove(false);
  };
  useEffect(() => {
    if (!menuChatId) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!(t instanceof Element) || !t.closest(".chat-menu")) {
        closeMenu();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuChatId]);

  // Workspace list for "Move to group" — the same grouping the sidebar menu
  // offers, built from the same helper so the two menus never drift apart.
  const workspaces = useStore((s) => s.workspaces);
  const pinnedWorkspaces = useStore((s) => s.pinnedWorkspaces);
  const pinnedChats = useStore((s) => s.pinnedChats);
  const workspaceColors = useStore((s) => s.workspaceColors);
  const menuGroups = useMemo(
    () => buildGroups(chats, workspaces, pinnedWorkspaces, pinnedChats),
    [chats, workspaces, pinnedWorkspaces, pinnedChats],
  );
  const menuChat = menuChatId ? chats.find((c) => c.id === menuChatId) ?? null : null;
  const menuTargets = menuChat
    ? menuGroups.filter((g) => g.key !== workspaceKey(menuChat.root))
    : [];

  // Keep the active tab visible when the bar overflows (many open tabs).
  useEffect(() => {
    barRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeChatId]);

  const clearDrag = () => {
    setDragId(null);
    setDropTarget(null);
    slotsRef.current = null;
  };

  // The bar previews the landing by SLIDING tabs aside with transforms: the
  // dragged tab stays as a muted hole, its neighbours glide into the freed
  // space, and the layout never reflows mid-drag. Shifts are exact per-tab
  // pixel deltas from the CAPTURED slots (the post-commit reflow), so every
  // tab — whatever its width — lands precisely where the commit puts it.
  const shifts = (() => {
    if (!dragId || !dropTarget || !slotsRef.current) return null;
    return slotShifts(slotsRef.current, dragId, dropTarget.id, dropTarget.after);
  })();

  /** Landing preview for a pointer x: nearest tab by geometry — read from the
   *  captured slots (scroll-compensated), array-order correct for rtl bars.
   *  Covers tabs, inter-tab gaps and the empty space past the ends in ONE
   *  rule (the old code left the gaps as dead zones). */
  const previewAt = (clientX: number) => {
    const bar = barRef.current;
    if (!bar) return;
    const extents = slotsRef.current
      ? slotExtents(slotsRef.current)
      : liveExtents(bar, "data-tab-id", "x");
    const next = tabForPoint(extents, clientX, slotsRef.current?.sign ?? barFlowSign(bar));
    if (!next) return;
    setDropTarget((prev) =>
      prev && prev.id === next.id && prev.after === next.after ? prev : next,
    );
  };

  if (openChatIds.length === 0) return null;

  return (
    <div
      ref={barRef}
      className="tab-bar chat-tabs"
      role="tablist"
      aria-label="Open chats"
      onDragOver={(e) => {
        if (!dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // Dragging near a bar edge scrolls it, so off-screen tabs stay reachable.
        const bar = barRef.current;
        if (!bar) return;
        const delta = edgeScroll(e.clientX, bar.getBoundingClientRect());
        if (delta) bar.scrollLeft += delta;
        previewAt(e.clientX);
      }}
      onDragLeave={(e) => {
        if (e.target !== e.currentTarget) return;
        setDropTarget(null);
      }}
      onDrop={(e) => {
        if (!dragId) return;
        e.preventDefault();
        const from = e.dataTransfer.getData("text/plain") || dragId;
        const bar = barRef.current;
        if (from && bar) {
          const extents = slotsRef.current
            ? slotExtents(slotsRef.current)
            : liveExtents(bar, "data-tab-id", "x");
          const at = tabForPoint(extents, e.clientX, slotsRef.current?.sign ?? barFlowSign(bar));
          if (at && at.id !== from) {
            useStore.getState().moveChatTab(from, at.id, at.after);
          }
        }
        clearDrag();
      }}
    >
      {openChatIds.map((id) => {
        const meta = chats.find((c) => c.id === id);
        const rawTitle = meta ? chatTitle({ title: meta.title, messages: meta.messages }) : "Chat";
        const title = prepareContent(rawTitle, dir);
        const active = id === activeChatId;
        const shift = shifts?.get(id) ?? 0;
        return (
          <div
            key={id}
            data-tab-id={id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            draggable={editingId !== id}
            className={`editor-tab chat-tab${active ? " active" : ""}${meta?.streaming ? " busy" : ""}${meta?.unread ? " unread" : ""}${dragId === id ? " dragging drop-preview" : ""}`}
            style={
              shift !== 0 ? { transform: `translateX(${shift}px)` } : undefined
            }
            title={title}
            onClick={() => useStore.getState().openChat(id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                useStore.getState().openChat(id);
                return;
              }
              // Alt+Arrow moves the focused tab without dragging the mouse.
              const target = tabMove(openChatIds, id, e.key, e.altKey);
              if (!target) return;
              e.preventDefault();
              useStore.getState().moveChatTab(id, target.toId, target.after);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) useStore.getState().closeChatTab(id);
            }}
            onContextMenu={(e) => {
              // Same menu as the sidebar's chat row (minus nothing): pin,
              // rename, copy id, move to group, delete — plus close tab.
              e.preventDefault();
              // WebKit grabs the word under the pointer on right-mousedown;
              // clear it so no stale selection shows behind the menu.
              document.getSelection()?.removeAllRanges();
              setMenuMove(false);
              setMenuChatId(id);
              setMenuPos({
                top: menuTop(e.clientY, 240, window.innerHeight),
                left: menuLeft(e.clientX, 170, window.innerWidth),
              });
            }}
            onDragStart={(e) => {
              try {
                e.dataTransfer.setData("application/x-coder-chat-id", id);
              } catch {
                /* drag unsupported */
              }
              e.dataTransfer.setData("text/plain", id);
              e.dataTransfer.effectAllowed = "move";
              const bar = barRef.current;
              slotsRef.current = bar
                ? captureDragSlots(
                    bar,
                    openChatIds,
                    (cid) => bar.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(cid)}"]`),
                    "x",
                    barFlowSign(bar),
                  )
                : null;
              setDragId(id);
            }}
            onDragEnd={clearDrag}
          >
            {meta?.streaming && (
              <span className="editor-tab-dot busy" aria-hidden="true" />
            )}
            {(meta?.pendingPermission || meta?.pendingAsk) && (
              <TabPendingBadges
                pendingPermission={meta.pendingPermission}
                pendingAsk={meta.pendingAsk}
              />
            )}
            {!meta?.streaming &&
              !meta?.pendingPermission &&
              !meta?.pendingAsk &&
              meta?.unread && (
                <span className="editor-tab-dot unread" aria-hidden="true" />
              )}
            {editingId === id ? (
              <ChatRenameInput
                initialValue={rawTitle === "New chat" ? "" : rawTitle}
                className="chat-rename-input editor-tab-rename-input"
                ariaLabel={`Rename ${title}`}
                onCommit={(v) => {
                  useStore.getState().renameChat(id, normalizeRenameValue(v));
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <span
                className="editor-tab-label"
                dir={detectDir(title)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingId(id);
                }}
              >
                {title}
              </span>
            )}
            <button
              type="button"
              className="editor-tab-close"
              title="Close chat tab"
              aria-label={`Close ${title}`}
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().closeChatTab(id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="editor-tab-new"
        title="New chat"
        aria-label="New chat"
        onClick={() => useStore.getState().newChat()}
      >
        +
      </button>
      {menuChat && menuPos && (
        menuMove ? (
          <div
            className="ws-menu chat-menu"
            role="menu"
            style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="ws-menu-title">Move to group</div>
            {menuTargets.length === 0 && (
              <div className="ws-menu-title">No other projects</div>
            )}
            {menuTargets.map((g) => (
              <button
                key={g.key}
                className="ws-menu-btn"
                role="menuitem"
                onClick={() => {
                  useStore.getState().setChatRoot(menuChat.id, g.root ?? "");
                  closeMenu();
                }}
              >
                <span
                  className="ws-menu-dot"
                  style={{ background: workspaceColors[g.key] || "var(--accent)" }}
                />
                {g.label}
              </button>
            ))}
          </div>
        ) : (
          <div
            className="ws-menu chat-menu"
            role="menu"
            style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className={`ws-menu-btn${pinnedChats.includes(menuChat.id) ? " active" : ""}`}
              role="menuitem"
              onClick={() => {
                useStore.getState().togglePinChat(menuChat.id);
                closeMenu();
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill={pinnedChats.includes(menuChat.id) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5M5 7h14M7 7l1-4h8l1 4M8 7v4l-2 3h12l-2-3V7" />
              </svg>
              {pinnedChats.includes(menuChat.id) ? "Unpin" : "Pin to top"}
            </button>
            <button
              className="ws-menu-btn"
              role="menuitem"
              onClick={() => {
                setEditingId(menuChat.id);
                closeMenu();
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
              Rename
            </button>
            <button
              className="ws-menu-btn"
              role="menuitem"
              title={menuChat.id}
              onClick={() => {
                void copyToClipboard(menuChat.id);
                closeMenu();
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Copy chat ID
            </button>
            <button
              className="ws-menu-btn"
              role="menuitem"
              onClick={() => setMenuMove(true)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              </svg>
              Move to group
            </button>
            <button
              className="ws-menu-btn danger"
              role="menuitem"
              onClick={() => {
                useStore.getState().deleteChat(menuChat.id);
                closeMenu();
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
              </svg>
              Delete
            </button>
            <button
              className="ws-menu-btn danger"
              role="menuitem"
              onClick={() => {
                useStore.getState().closeChatTab(menuChat.id);
                closeMenu();
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
              Close tab
            </button>
          </div>
        )
      )}
    </div>
  );
}
