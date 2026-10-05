import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { prepareContent } from "../lib/bidi";
import { dropSide, edgeScroll, tabMove } from "../lib/tabBar";
import { useViewerTabs } from "../lib/viewerTabs";
import { CompressIcon, ExpandIcon } from "./ViewerFullscreenButton";
import { TabListButton, type TabListSection } from "./TabListMenu";

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
      firstUser: c.messages.find((m) => m.role === "user")?.content,
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
  return <TabListButton sections={sections} label="Chat tab list" />;
}

/** VSCode-style tab bar for the left editor group (chats only). Tabs can be
 *  reordered with drag & drop; order persists across restarts. */
export function ChatTabBar() {
  const openChatIds = useStore((s) => s.openChatIds);
  const activeChatId = useStore((s) => s.activeChatId);
  const dir = useStore((s) => s.dir);
  const chatFull = useStore((s) => s.chatFullscreen);
  const chats = useStore((s) =>
    s.chats.map((c) => ({
      id: c.id,
      title: c.title,
      messages: c.messages
        .filter((m) => m.role === "user")
        .slice(0, 1)
        .map((m) => ({ role: m.role, content: m.content })),
      streaming: c.messages.some((m) => m.streaming || m.retry?.reconnecting === true),
      pendingPermission: c.pendingPermission
        ? {
            action: c.pendingPermission.action,
            path: c.pendingPermission.path,
          }
        : null,
      pendingAsk: c.pendingAsk ? { question: c.pendingAsk.question } : null,
      unread: s.unreadChats.includes(c.id),
    })),
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when the bar overflows (many open tabs).
  useEffect(() => {
    barRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeChatId]);

  const clearDrag = () => {
    setDragId(null);
    setDropTarget(null);
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
      }}
      onDrop={(e) => {
        // Tabs handle their own drop; empty space past the last tab drops at the end.
        if (e.target !== e.currentTarget || !dragId) return;
        const els = barRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
        const lastEl = els && els.length > 0 ? els[els.length - 1] : null;
        const lastId = openChatIds[openChatIds.length - 1];
        if (!lastEl || !lastId || e.clientX <= lastEl.getBoundingClientRect().right) return;
        const from = e.dataTransfer.getData("text/plain") || dragId;
        if (!from || from === lastId) return;
        e.preventDefault();
        useStore.getState().moveChatTab(from, lastId, true);
        clearDrag();
      }}
    >
      {openChatIds.map((id) => {
        const meta = chats.find((c) => c.id === id);
        const rawTitle = meta ? chatTitle({ title: meta.title, messages: meta.messages }) : "Chat";
        const title = prepareContent(rawTitle, dir);
        const active = id === activeChatId;
        const dropCls =
          dropTarget?.id === id ? (dropTarget.after ? " drop-after" : " drop-before") : "";
        return (
          <div
            key={id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            draggable
            className={`editor-tab chat-tab${active ? " active" : ""}${meta?.streaming ? " busy" : ""}${meta?.unread ? " unread" : ""}${dragId === id ? " dragging" : ""}${dropCls}`}
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
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", id);
              e.dataTransfer.effectAllowed = "move";
              setDragId(id);
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const after = dropSide(e.clientX, rect) === "after";
              setDropTarget((prev) =>
                prev?.id === id && prev.after === after ? prev : { id, after },
              );
            }}
            onDragLeave={() => {
              setDropTarget((prev) => (prev?.id === id ? null : prev));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = e.dataTransfer.getData("text/plain") || dragId;
              if (from && from !== id) {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const after = dropSide(e.clientX, rect) === "after";
                useStore.getState().moveChatTab(from, id, after);
              }
              clearDrag();
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
            <span className="editor-tab-label" dir={dir}>{title}</span>
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
      <button
        type="button"
        className="editor-tab-full"
        title={chatFull ? "Exit fullscreen" : "Fullscreen chat"}
        aria-label={chatFull ? "Exit chat fullscreen" : "Fullscreen chat"}
        aria-pressed={chatFull}
        onClick={() => {
          const st = useStore.getState();
          const next = !st.chatFullscreen;
          st.setChatFullscreen(next);
          // Fullscreen modes are exclusive: maximizing the chat restores
          // a maximized viewer.
          if (next) useViewerTabs.getState().setFullscreen(false);
        }}
      >
        {chatFull ? <CompressIcon /> : <ExpandIcon />}
      </button>
    </div>
  );
}
