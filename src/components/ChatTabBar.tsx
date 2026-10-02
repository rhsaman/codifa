import { useState } from "react";
import { useStore } from "../lib/store";
import { prepareContent } from "../lib/bidi";
import { useViewerTabs } from "../lib/viewerTabs";
import { CompressIcon, ExpandIcon } from "./ViewerFullscreenButton";

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

  const clearDrag = () => {
    setDragId(null);
    setDropTarget(null);
  };

  if (openChatIds.length === 0) return null;

  return (
    <div className="tab-bar chat-tabs" role="tablist" aria-label="Open chats">
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
              }
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
              const after = e.clientX - rect.left > rect.width / 2;
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
                const after = e.clientX - rect.left > rect.width / 2;
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
