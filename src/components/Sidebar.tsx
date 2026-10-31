import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, workspaceKey } from "../lib/store";
export { useStore };
import { themeById } from "../lib/themes";
import type { Chat, Workspace } from "../types";
import { api } from "../lib/fs";
import { prepareContent } from "../lib/bidi";
import { fmtAgo, fmtClockFull } from "../lib/time";
import { shouldFocusSearch } from "../lib/shortcuts";
import { edgeScroll, menuLeft, menuTop, slideHeight, tabForPoint, tabMove } from "../lib/tabBar";
import { previewOrder, previewShifts } from "../lib/tabOrder";
import { WindowStripCluster } from "./WindowStripCluster";

type ChatSummary = {
  id: string;
  title: string;
  root: string;
  updatedAt: number;
  createdAt: number;
  hasStreaming: boolean;
  pendingPermission: { action: string; path?: string } | null;
  pendingAsk: { question: string } | null;
  firstUser: string;
};

function titleOf(chat: Pick<Chat, "title" | "messages"> | ChatSummary): string {
  if (chat.title && chat.title !== "New chat") return chat.title;
  if ("firstUser" in chat && typeof chat.firstUser === "string") {
    return chat.firstUser ? chat.firstUser : "New chat";
  }
  const firstUser = (chat as Chat).messages.find((m) => m.role === "user");
  return firstUser ? firstUser.content.slice(0, 48) : "New chat";
}

/** Last path segment of a root folder, for a compact group label. */
function rootName(root: string): string {
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last || root;
}

interface Group<T = Chat | ChatSummary> {
  key: string;
  label: string;
  root: string | null;
  chats: T[];
}

/** The group shape the sidebar actually renders: buildGroups output over the
 *  lightweight chat summaries (Chat has no streaming/pending flags). */
type SummaryGroup = Group<ChatSummary>;

/** Persisted sidebar UI state (localStorage `coder:sidebarUi`): WHICH workspace
 *  the sidebar is drilled into, so the layout the user left comes back exactly
 *  as it was after a restart. The list itself is projects-only — chats live one
 *  click deeper, inside the opened folder. (Todos moved to the floating
 *  TodosPanel — its state lives in `coder:todoPanel`.) */
interface SidebarUiState {
  openWorkspace?: string | null;
}

function readOpenWorkspace(): string | null {
  try {
    const raw = localStorage.getItem("coder:sidebarUi");
    return raw ? ((JSON.parse(raw) as SidebarUiState).openWorkspace ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Build sidebar groups from the PERSISTED workspace list (workspaces are
 * first-class and outlive their chats), then attach chats by workspace key.
 * Workspace order is user-controlled — only the chats INSIDE each workspace
 * sort by recency. Pinned workspaces float to the very top (in pin order).
 */
export function buildGroups<T extends { id: string; root?: string | null; updatedAt: number; createdAt: number }>(
  chats: T[],
  workspaces: Workspace[],
  pinnedWorkspaces: string[],
  pinnedChats: string[],
): Group<T>[] {
  const chatsByRoot = new Map<string, T[]>();
  for (const c of chats) {
    const key = workspaceKey(c.root ?? "");
    if (!chatsByRoot.has(key)) chatsByRoot.set(key, []);
    chatsByRoot.get(key)!.push(c);
  }

  // Pinned chats float to the top of their group (most-recently-pinned first),
  // then the rest sort by recency.
  const pinRankChat = (id: string) => {
    const i = pinnedChats.indexOf(id);
    return i === -1 ? Infinity : i;
  };
  const sortChats = (list: T[]) => {
    list.sort((a, b) => {
      const ar = pinRankChat(a.id);
      const br = pinRankChat(b.id);
      if (ar !== br) return ar - br;
      return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
    });
  };

  const groups: Group<T>[] = [];
  for (const ws of workspaces) {
    const list = chatsByRoot.get(ws.key) ?? [];
    sortChats(list);
    // Don't show a "No project" bucket when it has nothing in it — the
    // sidebar stays empty instead of rendering a point-less heading.
    if (!ws.root && list.length === 0) {
      chatsByRoot.delete(ws.key);
      continue;
    }
    groups.push({
      key: ws.key,
      label: ws.label || (ws.root ? rootName(ws.root) : "No project"),
      root: ws.root,
      chats: list,
    });
    chatsByRoot.delete(ws.key);
  }

  // Workspaces not yet in the persisted list (e.g. chats created before the
  // first-class workspace feature, or new roots) — appended after the ordered
  // ones so they never jump around the user's layout.
  const pinRank = (key: string) => {
    const i = pinnedWorkspaces.indexOf(key);
    return i === -1 ? Infinity : i;
  };
  const leftovers = [...chatsByRoot.entries()].map(([key, list]) => {
    sortChats(list);
    const root = list.find((c) => c.root)?.root ?? "";
    return {
      key,
      label: root ? rootName(root) : "No project",
      root: root || null,
      chats: list,
    };
  });
  leftovers.sort((a, b) => {
    const ar = pinRank(a.key);
    const br = pinRank(b.key);
    if (ar !== br) return ar - br;
    const aLatest = Math.max(...a.chats.map((c) => c.updatedAt), 0);
    const bLatest = Math.max(...b.chats.map((c) => c.updatedAt), 0);
    return bLatest - aLatest;
  });

  const ordered = [...groups, ...leftovers];
  // Pinned float to top, in pin order; the rest keep the persisted order.
  ordered.sort((a, b) => {
    const ar = pinRank(a.key);
    const br = pinRank(b.key);
    if (ar !== br) return ar - br;
    return 0;
  });
  return ordered;
}

/**
 * Toggle select-all for one workspace group: selects every id when at least
 * one is unselected, otherwise deselects the whole group. Keeps selections
 * from other groups untouched.
 */
export function toggleGroupSelection(prev: Set<string>, groupIds: string[]): Set<string> {
  const next = new Set(prev);
  const allSelected = groupIds.length > 0 && groupIds.every((id) => next.has(id));
  if (allSelected) {
    groupIds.forEach((id) => next.delete(id));
  } else {
    groupIds.forEach((id) => next.add(id));
  }
  return next;
}

/** Root-level search matches the FOLDER row (label or root path), not chats —
 *  chats are searched inside their opened folder. Case-insensitive substring. */
export function matchesFolder(
  group: Pick<Group, "label" | "root">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    group.label.toLowerCase().includes(q) ||
    (group.root ?? "").toLowerCase().includes(q)
  );
}

export function Sidebar() {
  // Lightweight shell: subscribes ONLY to the open flag so Cmd/Ctrl+B flips
  // instantly without touching chats/workspaces. The aside itself stays
  // MOUNTED so open/close runs as a real width+fade transition (the closed
  // class collapses it to zero); the heavy content (all chat subscriptions,
  // grouping, search) mounts when open and unmounts only AFTER the close
  // animation, so the collapse never flashes an empty strip.
  const open = useStore((s) => s.sidebarOpen);
  // Animated open/close: the aside stays MOUNTED so the width+fade transition
  // runs in BOTH directions; the heavy content (all chat subscriptions,
  // grouping, search) unmounts only after the close transition, so the
  // collapse never flashes an empty strip. The arrival ring is NOT part of
  // this — opening/closing lands silently (rings ride on Ctrl+X hops only).
  const [contentMounted, setContentMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setContentMounted(true);
      return;
    }
    const t = window.setTimeout(() => setContentMounted(false), 300);
    return () => window.clearTimeout(t);
  }, [open]);
  // Which workspace the sidebar is drilled into (null = the projects list).
  // Lives in the SHELL, not the content: the shell never unmounts, so the
  // persistence listeners below survive sidebar close/open and the drill-in
  // survives a quick toggle without racing the debounce.
  const [openWsKey, setOpenWsKey] = useState<string | null>(readOpenWorkspace);
  // Persist the drill-in whenever it changes, so the layout survives restarts.
  // Debounced: the write lands 250ms after the change settles; the flush
  // listeners guarantee the final value on quit (the main process dispatches
  // `coder:flush-ui` before every store flush, including quit).
  useEffect(() => {
    const write = () => {
      try {
        localStorage.setItem(
          "coder:sidebarUi",
          JSON.stringify({ openWorkspace: openWsKey } satisfies SidebarUiState),
        );
      } catch {
        /* quota / serialization errors — the layout just won't persist */
      }
    };
    const t = window.setTimeout(write, 250);
    window.addEventListener("coder:flush-ui", write);
    window.addEventListener("beforeunload", write);
    window.addEventListener("pagehide", write);
    return () => {
      clearTimeout(t);
      window.removeEventListener("coder:flush-ui", write);
      window.removeEventListener("beforeunload", write);
      window.removeEventListener("pagehide", write);
    };
  }, [openWsKey]);
  // Sidebar width lives HERE (the shell owns the aside); the content only
  // receives the drag handler. Previously the width sat below the shell,
  // which produced a nested .sidebar whose fixed var() width clipped the
  // resizable one.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("coder:sidebarWidth");
    const n = saved ? parseInt(saved, 10) : 264;
    return Number.isFinite(n) ? Math.max(180, Math.min(480, n)) : 264;
  });
  const sidebarDrag = useRef<{ startX: number; startW: number } | null>(null);
  // Track the per-drag listeners so we can clean them up if the component
  // unmounts mid-drag (e.g. user pressed ⌘B to toggle the sidebar off while
  // still holding the resize handle — without this, the listeners would
  // leak on `window` and keep firing against a torn-down state).
  const sidebarDragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      sidebarDragCleanup.current?.();
      sidebarDragCleanup.current = null;
    };
  }, []);
  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDrag.current = { startX: e.clientX, startW: sidebarWidth };
    // 1:1 tracking: the open/close width transition must not ease the
    // per-move steps (the class is stripped again in onUp, which also runs
    // from the unmount cleanup below).
    document.body.classList.add("coder-resizing");
    const onMove = (ev: MouseEvent) => {
      if (!sidebarDrag.current) return;
      const w = Math.max(
        180,
        Math.min(
          480,
          sidebarDrag.current.startW +
          (ev.clientX - sidebarDrag.current.startX),
        ),
      );
      setSidebarWidth(w);
      localStorage.setItem("coder:sidebarWidth", String(w));
    };
    const onUp = () => {
      sidebarDrag.current = null;
      document.body.classList.remove("coder-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      sidebarDragCleanup.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    sidebarDragCleanup.current = onUp;
  };
  return (
    <aside
      className={"sidebar" + (open ? "" : " closed")}
      aria-hidden={!open}
      style={
        {
          flexBasis: open ? sidebarWidth : 0,
          width: open ? sidebarWidth : 0,
          "--sidebar-w": `${sidebarWidth}px`,
        } as React.CSSProperties
      }
    >
      {contentMounted ? (
        <SidebarContent
          onResizeStart={startSidebarResize}
          openWsKey={openWsKey}
          setOpenWsKey={setOpenWsKey}
        />
      ) : null}
    </aside>
  );
}

function SidebarContent({
  onResizeStart,
  openWsKey,
  setOpenWsKey,
}: {
  /** Drag-resize handler owned by the shell (which owns the animated aside). */
  onResizeStart: (e: React.MouseEvent) => void;
  /** The workspace the sidebar is drilled into (null = projects list).
   *  Owned by the shell so it persists across sidebar close/open. */
  openWsKey: string | null;
  setOpenWsKey: (key: string | null) => void;
}) {
  // Subscribe to a lightweight chat SUMMARY (id/title/root/timestamps + flags),
  // not the full chat objects: message/stream/draft edits rebuild the chat
  // record but leave the summary identical, so the sidebar list does not
  // re-render on every streamed token or composer keystroke.
  const chats = useStore((s) =>
    // Empty (message-less) chats are in-memory tabs only until the first
    // message is sent — never sidebar rows, never files on disk.
    s.chats.filter((c) => (c.messageCount ?? c.messages?.length ?? 0) > 0).map((c) => ({
      id: c.id,
      title: c.title,
      root: c.root ?? "",
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
      // A chat whose body is not in memory cannot be "streaming": the flag
      // lives on the message objects, which are still on disk.
      hasStreaming: c.hydrated === false ? false : c.messages.some(
        (m) => m.streaming || m.retry?.reconnecting === true,
      ),
      pendingPermission: c.pendingPermission
        ? {
            action: c.pendingPermission.action,
            path: c.pendingPermission.path,
          }
        : null,
      pendingAsk: c.pendingAsk ? { question: c.pendingAsk.question } : null,
      firstUser: (() => {
        // The index row carries the first-user preview (written by the store),
        // so a title never costs reading the whole transcript.
        if (typeof c.firstUser === 'string' && c.firstUser) return c.firstUser.slice(0, 48);
        const m = c.messages.find((x) => x.role === "user");
        return m ? m.content.slice(0, 48) : "";
      })(),
    })),
  );
  const workspaces = useStore((s) => s.workspaces);
  const activeChatId = useStore((s) => s.activeChatId);
  const workspaceColors = useStore((s) => s.workspaceColors);
  const theme = useStore((s) => s.theme);
  const pinnedWorkspaces = useStore((s) => s.pinnedWorkspaces);
  const pinnedChats = useStore((s) => s.pinnedChats);
  const unreadChats = useStore((s) => s.unreadChats);
  // Clock for the relative "Xm ago" activity ages below: refreshed every 30s
  // so a stale label never sits for long. One integer state, one interval.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const [colorOpen, setColorOpen] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Multi-select state for bulk-deleting chats within a workspace.
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set());
  const toggleChatSelected = (id: string) => {
    setSelectedChats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelected = () => setSelectedChats(new Set());

  // Right-click chat menu: opens at the cursor, closes on outside mousedown
  // or after an action. The row's left-click (open chat) never fires for
  // right buttons, so no extra guarding is needed.
  const [chatMenuId, setChatMenuId] = useState<string | null>(null);
  const [chatMenuPos, setChatMenuPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!chatMenuId) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!(t instanceof Element) || !t.closest(".chat-menu")) {
        setChatMenuId(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [chatMenuId]);

  // Workspace 3-dot / context menu and chat-selection mode. The old two-step
  // delete popup is gone: chat deletion happens via checkbox selection inside
  // the folder, and Delete workspace lives on the projects list's right-click
  // menu.
  const [wsMenuOpenKey, setWsMenuOpenKey] = useState<string | null>(null);
  const [wsMenuPos, setWsMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [selectingWsKey, setSelectingWsKey] = useState<string | null>(null);
  const [renamingWsKey, setRenamingWsKey] = useState<string | null>(null);
  const [wsRenameValue, setWsRenameValue] = useState("");
  const commitWsRename = () => {
    if (renamingWsKey) {
      const v = wsRenameValue.trim();
      if (v) useStore.getState().renameWorkspace(renamingWsKey, v);
    }
    setRenamingWsKey(null);
    setWsRenameValue("");
  };
  useEffect(() => {
    if (!wsMenuOpenKey) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!(t instanceof Element) || !t.closest(".ws-menu")) {
        setWsMenuOpenKey(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [wsMenuOpenKey]);

  // ⌘K / Ctrl+K focuses the chat search — the natural "find my chat" shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // shouldFocusSearch کوردهایی را رد می‌کند که یک پیکرِ در فوکوس قبلاً
      // بلعیده است (هندلرش preventDefault + stopPropagation زده)؛ پس Ctrl+K
      // داخل پیکر @mention/پالت فرمان هایلایت را جابه‌جا می‌کند، نه اینکه
      // فوکوس را از کامپوزر بدزدد.
      // سایدبار Ctrl+K را فقط وقتی ادعا می‌کند که فوکوس همین حالا داخل خودش
      // است («پیدا کردن چتم» از داخل لیست). جای دیگر این کورد مال پرش فوکوس
      // پنجره‌های چت است (Ctrl+K = بالا، App.tsx) و نباید سراسری دزدیده شود.
      const t0 = e.target as HTMLElement | null;
      if (!t0?.closest?.(".sidebar")) return;
      if (shouldFocusSearch(e)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dir = useStore((s) => s.dir);

  // `buildGroups` walks every chat + sorts; memoize it so it only re-runs when
  // the underlying data actually changes (not on every unrelated re-render such
  // as hover/scroll state). `chats` is rebuilt by the store on each streamed
  // token, so this still recomputes during streaming.
  const groups = useMemo(
    () => buildGroups(chats, workspaces, pinnedWorkspaces, pinnedChats),
    [chats, workspaces, pinnedWorkspaces, pinnedChats],
  );

  // The drilled-into workspace. The find-guard doubles as deletion handling:
  // once the workspace is gone the sidebar falls back to the projects list
  // (the stale persisted key stays harmless until the user navigates).
  const openGroup = useMemo(
    () => (openWsKey ? groups.find((g) => g.key === openWsKey) ?? null : null),
    [groups, openWsKey],
  );

  // Drill in / back. Both clear the search: a query typed for folder filtering
  // must not silently become a chat filter inside the opened folder.
  const openWorkspace = (key: string) => {
    setOpenWsKey(key);
    setSearch("");
  };
  const closeWorkspace = () => {
    setOpenWsKey(null);
    setSearch("");
  };

  // Sidebar search: debounced, title-only (never scans message bodies — that
  // walks every token of every chat on each keystroke). Contextual: on the
  // projects list it filters FOLDER rows; inside an opened folder it filters
  // that workspace's chats.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);
  const searching = debouncedSearch.trim().length > 0;
  const matchesQuery = (chat: ChatSummary, q: string): boolean => {
    const query = q.trim().toLowerCase();
    if (!query) return true;
    if ((chat.title || "").toLowerCase().includes(query)) return true;
    return chat.firstUser.toLowerCase().includes(query);
  };
  const visibleFolders = useMemo(
    () => (searching && !openGroup ? groups.filter((g) => matchesFolder(g, debouncedSearch)) : groups),
    [groups, searching, openGroup, debouncedSearch],
  );
  const openChats = useMemo(() => {
    if (!openGroup) return [];
    return searching
      ? openGroup.chats.filter((c) => matchesQuery(c, debouncedSearch))
      : openGroup.chats;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openGroup, searching, debouncedSearch]);

  const newWorkspace = async () => {
    const dir = await api.selectFolder();
    if (dir) useStore.getState().createWorkspace(dir);
  };

  // ---------------------------------------------------------------------------
  // Folder drag & drop — the same slide-preview mechanics as the chat tab bar:
  // the dragged row stays as a muted landing slot and its neighbours glide one
  // slot toward the freed hole via animated transforms (no mid-drag reflow).
  // ---------------------------------------------------------------------------
  const listRef = useRef<HTMLDivElement>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  // Slide geometry measured once at drag start: how far "one slot" is (the
  // dragged row's height + the list's row gap). Vertical lists flow top→bottom
  // in both ltr and rtl, so no flow-sign mirroring is needed.
  const [dragGeom, setDragGeom] = useState<{ slot: number } | null>(null);

  const clearDrag = () => {
    setDragKey(null);
    setDropTarget(null);
    setDragGeom(null);
  };

  const folderKeys = visibleFolders.map((g) => g.key);
  const shifts = dragKey && dropTarget
    ? previewShifts(folderKeys, dragKey, dropTarget.id, dropTarget.after)
    : null;
  const slot = dragGeom?.slot ?? 0;

  /** Physical extents of the rendered folder rows, for geometric drop checks. */
  const rowExtents = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-ws-id]") ?? []).map(
      (el) => ({
        id: el.dataset.wsId ?? "",
        top: el.getBoundingClientRect().top,
        bottom: el.getBoundingClientRect().bottom,
      }),
    );

  const onFolderDragStart = (e: React.DragEvent, key: string) => {
    setDragKey(key);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", key);
    } catch {
      /* ignore dataTransfer restrictions (rare) */
    }
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-ws-id="${CSS.escape(key)}"]`);
    setDragGeom(el && list ? { slot: slideHeight(el, list) } : null);
  };

  const onListDragOver = (e: React.DragEvent) => {
    if (!dragKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const list = listRef.current;
    if (!list) return;
    // Dragging near a list edge scrolls it, so off-screen rows stay reachable.
    const delta = edgeScroll(e.clientY, list.getBoundingClientRect(), "y");
    if (delta) list.scrollTop += delta;
    const at = tabForPoint(rowExtents(), e.clientY, 1, "y");
    if (!at) return;
    setDropTarget((prev) =>
      prev && prev.id === at.id && prev.after === at.after ? prev : at,
    );
  };

  const onListDragLeave = (e: React.DragEvent) => {
    if (e.target !== e.currentTarget) return;
    setDropTarget(null);
  };

  const onListDrop = (e: React.DragEvent) => {
    if (!dragKey) return;
    e.preventDefault();
    const at = tabForPoint(rowExtents(), e.clientY, 1, "y");
    if (at && at.id !== dragKey) {
      const next = previewOrder(folderKeys, dragKey, at.id, at.after);
      useStore.getState().setWorkspaceOrder(next);
    }
    clearDrag();
  };

  const startRename = (chat: Chat | ChatSummary) => {
    setRenamingId(chat.id);
    setRenameValue(titleOf(chat) === "New chat" ? "" : titleOf(chat));
  };

  const commitRename = () => {
    if (renamingId)
      useStore
        .getState()
        .renameChat(renamingId, renameValue.trim() || "New chat");
    setRenamingId(null);
  };

  // Activity badges aggregated for a folder row / workspace header: live
  // streaming, pending permission/ask, unread count. With chats hidden one
  // level down, these keep a busy project visible from the projects list.
  const renderBadges = (g: SummaryGroup) => {
    const streaming = g.chats.filter((c) => c.hasStreaming).length;
    const unread = g.chats.filter(
      (c) => !c.hasStreaming && c.id !== activeChatId && unreadChats.includes(c.id),
    ).length;
    const pendingPerm = g.chats.find((c) => c.pendingPermission)?.pendingPermission ?? null;
    const pendingAsk = g.chats.find((c) => c.pendingAsk)?.pendingAsk ?? null;
    if (streaming === 0 && unread === 0 && !pendingPerm && !pendingAsk) return null;
    return (
      <span className="sidebar-folder-badges">
        {streaming > 0 && (
          <span
            className="chat-item-streaming"
            title={`Agent is working in ${streaming === 1 ? "1 chat" : `${streaming} chats`}`}
          />
        )}
        {pendingPerm && (
          <span
            className="chat-item-pending permission"
            title={`Needs permission: ${pendingPerm.action}${pendingPerm.path ? ` · ${pendingPerm.path}` : ""}`}
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
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </span>
        )}
        {pendingAsk && (
          <span
            className="chat-item-pending ask"
            title={`Asks you: ${pendingAsk.question}`}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
              <path d="M12 17h.01" />
            </svg>
          </span>
        )}
        {unread > 0 && (
          <span
            className="ws-unread-badge"
            title={`${unread} unread chat${unread === 1 ? "" : "s"}`}
          >
            {unread}
          </span>
        )}
      </span>
    );
  };

  // [+ new chat] — the only control on a folder row; the workspace menu lives
  // inside the opened folder (its header), keeping the projects list lean.
  const renderNewChatBtn = (g: SummaryGroup, hidden?: boolean) => (
    <button
      className="sidebar-group-btn"
      title="New chat in this workspace"
      aria-label="New chat in this workspace"
      style={hidden ? { display: "none" } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        useStore.getState().newChatInRoot(g.root ?? g.key);
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  );

  // The workspace popup menu, in two variants:
  //  - "row"    → right-click on a projects-list folder row: Pin/Unpin,
  //               Rename, Color, Change folder…, Delete workspace. Workspace-
  //               level management belongs OUT here, on the list of projects.
  //  - "header" → the opened folder's kebab: Rename, Color, Change folder…,
  //               Select chats. No pin/delete — those live on the list.
  const renderWsMenu = (
    g: SummaryGroup,
    variant: "row" | "header",
    pos: { top: number; left: number },
  ) => {
    const isPinned = pinnedWorkspaces.includes(g.key);
    return (
      <div
        className="ws-menu"
        role="menu"
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {variant === "row" && (
          <button
            className={`ws-menu-btn${isPinned ? " active" : ""}`}
            role="menuitem"
            onClick={() => {
              useStore.getState().togglePinWorkspace(g.key);
              setWsMenuOpenKey(null);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5M5 7h14M7 7l1-4h8l1 4M8 7v4l-2 3h12l-2-3V7" />
            </svg>
            {isPinned ? "Unpin" : "Pin to top"}
          </button>
        )}
        <button
          className="ws-menu-btn"
          role="menuitem"
          onClick={() => {
            setRenamingWsKey(g.key);
            setWsRenameValue(g.label);
            setWsMenuOpenKey(null);
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
          onClick={() => {
            setColorOpen(colorOpen === g.key ? null : g.key);
            setWsMenuOpenKey(null);
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="13.5" cy="6.5" r="1.2" fill="currentColor" />
            <circle cx="17.5" cy="10.5" r="1.2" fill="currentColor" />
            <circle cx="8.5" cy="7.5" r="1.2" fill="currentColor" />
            <circle cx="6.5" cy="12.5" r="1.2" fill="currentColor" />
            <path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.7 1.7-1.7H17a3 3 0 0 0 3-3c0-4.4-4-8-8-8z" />
          </svg>
          Color
        </button>
        <button
          className="ws-menu-btn"
          role="menuitem"
          title={g.root || "No folder set"}
          onClick={() => {
            setWsMenuOpenKey(null);
            void api.selectFolder().then((dir) => {
              if (dir) useStore.getState().moveWorkspace(g.key, dir);
            });
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
            <path d="M2 9a2 2 0 0 1 2-2h7.5l2 2H21a2 2 0 0 1 2 2v1H2Z" />
          </svg>
          Change folder…
        </button>
        {variant === "row" ? (
          <button
            className="ws-menu-btn danger"
            role="menuitem"
            title={`Deletes the workspace and its ${g.chats.length} chat${g.chats.length === 1 ? "" : "s"}`}
            onClick={() => {
              useStore.getState().deleteWorkspace(g.key);
              setWsMenuOpenKey(null);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
            </svg>
            Delete workspace
            <span style={{ opacity: 0.7, marginInlineStart: "auto", fontSize: 11 }}>
              ({g.chats.length})
            </span>
          </button>
        ) : (
          <button
            className="ws-menu-btn"
            role="menuitem"
            title="Pick chats with checkboxes, then delete them in bulk"
            onClick={() => {
              setSelectingWsKey(g.key);
              setWsMenuOpenKey(null);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            Select chats
            <span style={{ opacity: 0.7, marginInlineStart: "auto", fontSize: 11 }}>
              ({g.chats.length})
            </span>
          </button>
        )}
      </div>
    );
  };

  const renderColorPopover = (g: SummaryGroup) => (
    <div className="color-popover" onClick={(e) => e.stopPropagation()}>
      {themeById(theme).workspaceColors.map((c2) => (
        <button
          key={c2}
          className="color-swatch"
          style={{ background: c2 }}
          onClick={() => {
            useStore.getState().setWorkspaceColor(g.key, c2);
            setColorOpen(null);
          }}
        />
      ))}
      <button
        className="color-none"
        title="Remove color"
        onClick={() => {
          useStore.getState().setWorkspaceColor(g.key, "");
          setColorOpen(null);
        }}
      >
        ✕
      </button>
    </div>
  );

  // Bulk-select bar for the opened folder's header (checkbox mode): select
  // all / delete selected / cancel.
  const renderBulkBar = (g: SummaryGroup) => {
    const selectedInGroup = g.chats.filter((c) => selectedChats.has(c.id)).length;
    return (
      <div className="group-bulk-actions">
        <button
          className="group-select-all"
          title={selectedInGroup === g.chats.length && g.chats.length > 0 ? "Deselect all" : "Select all"}
          aria-label={selectedInGroup === g.chats.length && g.chats.length > 0 ? "Deselect all chats" : "Select all chats"}
          aria-pressed={g.chats.length > 0 && selectedInGroup === g.chats.length}
          onClick={() => {
            setSelectedChats((prev) =>
              toggleGroupSelection(
                prev,
                g.chats.map((c) => c.id),
              ),
            );
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {g.chats.length > 0 && selectedInGroup === g.chats.length ? (
              <path d="M9 11l3 3L22 4" />
            ) : null}
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </button>
        <button
          className="group-delete-selected"
          title={`Delete ${selectedInGroup} selected conversation(s)`}
          onClick={() => {
            const ids = g.chats
              .map((c) => c.id)
              .filter((id) => selectedChats.has(id));
            if (ids.length === 0) return;
            ids.forEach((id) =>
              useStore.getState().deleteChat(id),
            );
            setSelectedChats((prev) => {
              const next = new Set(prev);
              ids.forEach((id) => next.delete(id));
              return next;
            });
            setSelectingWsKey(null);
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          </svg>
          {selectedInGroup}
        </button>
        <button
          className="group-cancel-select"
          title="Cancel selection"
          aria-label="Cancel selection"
          onClick={() => {
            setSelectingWsKey(null);
            clearSelected();
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    );
  };

  // Right-click menu for a chat row (the ⋯ kebab is gone): pin, rename,
  // delete — the actions the kebab used to hold, now at the cursor.
  const renderChatMenu = (c: ChatSummary, pos: { top: number; left: number }) => {
    const isPinnedChat = pinnedChats.includes(c.id);
    return (
      <div
        className="ws-menu chat-menu"
        role="menu"
        style={{ position: "fixed", top: pos.top, left: pos.left }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className={`ws-menu-btn${isPinnedChat ? " active" : ""}`}
          role="menuitem"
          onClick={() => {
            useStore.getState().togglePinChat(c.id);
            setChatMenuId(null);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill={isPinnedChat ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 17v5M5 7h14M7 7l1-4h8l1 4M8 7v4l-2 3h12l-2-3V7" />
          </svg>
          {isPinnedChat ? "Unpin" : "Pin to top"}
        </button>
        <button
          className="ws-menu-btn"
          role="menuitem"
          onClick={() => {
            startRename(c);
            setChatMenuId(null);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
          Rename
        </button>
        <button
          className="ws-menu-btn danger"
          role="menuitem"
          onClick={() => {
            useStore.getState().deleteChat(c.id);
            setChatMenuId(null);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
          </svg>
          Delete
        </button>
      </div>
    );
  };

  // One chat row — identical in look and behavior to before, now rendered
  // inside the opened workspace's list instead of an inline group expansion.
  const renderChatRow = (c: ChatSummary, gKey: string) => {
    const isPinnedChat = pinnedChats.includes(c.id);
    // "Live" (agent working) comes precomputed from the summary
    // subscription — no message scan per row per render.
    const hasStreaming = c.hasStreaming;
    const hasUnread =
      !hasStreaming &&
      c.id !== activeChatId &&
      unreadChats.includes(c.id);
    return (
      <div
        key={c.id}
        className={`chat-item ${c.id === activeChatId ? "active" : ""}${isPinnedChat ? " pinned" : ""}${hasUnread ? " unread" : ""}${selectedChats.has(c.id) ? " selected" : ""}${selectingWsKey === gKey ? " selecting" : ""}`}
        draggable
        onDragStart={(e) => {
          try {
            e.dataTransfer.setData("application/x-coder-chat-id", c.id);
          } catch {
            /* drag unsupported */
          }
          try {
            e.dataTransfer.setData("text/plain", c.id);
          } catch {
            /* drag unsupported */
          }
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => useStore.getState().openChat(c.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setChatMenuId(c.id);
          setChatMenuPos({
            top: menuTop(e.clientY, 120, window.innerHeight),
            left: menuLeft(e.clientX, 150, window.innerWidth),
          });
        }}
        title={prepareContent(titleOf(c), dir)}
      >
        {selectingWsKey === gKey && (
          <div className="chat-item-select-wrap">
            <input
              type="checkbox"
              className="chat-select-checkbox"
              checked={selectedChats.has(c.id)}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleChatSelected(c.id)}
              title="Select this chat"
            />
          </div>
        )}
        {renamingId === c.id ? (
          <input
            className="chat-rename-input"
            dir={dir}
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setRenamingId(null);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="chat-item-title-row" dir={dir}>
            <span
              className="chat-item-title"
              onDoubleClick={(e) => {
                e.stopPropagation();
                startRename(c);
              }}
            >
              {prepareContent(titleOf(c), dir)}
            </span>
            {hasStreaming && (
              <span
                className="chat-item-streaming"
                title="Agent is working in this chat"
              />
            )}
            {hasUnread && (
              <span
                className="chat-item-unread"
                title="New message from the agent — click to view"
              />
            )}
            {c.pendingPermission && (
              <span
                className="chat-item-pending permission"
                title={`Needs permission: ${c.pendingPermission.action}${c.pendingPermission.path ? ` · ${c.pendingPermission.path}` : ""}`}
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
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </span>
            )}
            {c.pendingAsk && (
              <span
                className="chat-item-pending ask"
                title={`Asks you: ${c.pendingAsk.question}`}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
                  <path d="M12 17h.01" />
                </svg>
              </span>
            )}
            <span
              className="chat-item-time"
              title={fmtClockFull(c.updatedAt)}
            >
              <span dir="ltr">{fmtAgo(c.updatedAt, nowTick)}</span>
            </span>
          </span>
        )}
        {chatMenuId === c.id && chatMenuPos && renderChatMenu(c, chatMenuPos)}
      </div>
    );
  };

  return (
    <div className="sidebar-inner">
      {/* macOS traffic-light strip: with the native title bar hidden the
          window buttons overlay this corner — the window-strip cluster
          (sidebar toggle + workspace + direction) lives here so those
          controls keep their exact position while the sidebar is open.
          display:none off-mac and it collapses the strip entirely. */}
      <div className="sidebar-drag" aria-hidden="false">
        <WindowStripCluster />
      </div>
      <div
        className="sidebar-resize-handle"
        title="Drag to resize sidebar"
        onMouseDown={onResizeStart}
      />
      <div className="sidebar-head">
        <div className="sidebar-search-box">
          <svg
            className="sidebar-search-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={searchInputRef}
            className="sidebar-search-input"
            type="text"
            placeholder={openGroup ? "Search chats…" : "Search projects…"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearch("");
            }}
            spellCheck={false}
            dir={dir}
          />
          {search && (
            <button
              className="sidebar-search-clear"
              title="Clear search"
              onClick={() => setSearch("")}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <div className="sidebar-head-actions">
          <button
            className="sidebar-head-btn"
            title="New workspace"
            onClick={newWorkspace}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      {openGroup ? (
        /* ---------------------------------------------------------------
         * Opened workspace: back header + that workspace's chat list.
         * --------------------------------------------------------------- */
        <div className="sidebar-list">
          {colorOpen !== null && (
            <div className="color-backdrop" onClick={() => setColorOpen(null)} />
          )}
          <div
            className="sidebar-group sidebar-ws-open ws-colored"
            style={{ "--ws": workspaceColors[openGroup.key] || "var(--accent)" } as React.CSSProperties}
          >
            <div
              className="sidebar-group-head sidebar-ws-head"
              onContextMenu={(e) => {
                // The kebab is gone — right-clicking the folder header opens
                // its menu (Rename / Color / Change folder… / Select chats).
                e.preventDefault();
                setWsMenuOpenKey(openGroup.key);
                setWsMenuPos({
                  top: menuTop(e.clientY, 150, window.innerHeight),
                  left: menuLeft(e.clientX, 168, window.innerWidth),
                });
              }}
            >
              <button
                className="sidebar-ws-back"
                title="Back to projects"
                aria-label="Back to projects"
                onClick={closeWorkspace}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <button
                className="sidebar-group-toggle"
                onClick={closeWorkspace}
                title={openGroup.root || openGroup.label}
              >
                <svg
                  className="sidebar-group-icon"
                  style={{ color: workspaceColors[openGroup.key] || "var(--accent)" }}
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
                </svg>
                {renamingWsKey === openGroup.key ? (
                  <input
                    className="ws-rename-input"
                    autoFocus
                    value={wsRenameValue}
                    onChange={(e) => setWsRenameValue(e.target.value)}
                    onBlur={commitWsRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitWsRename();
                      else if (e.key === "Escape") {
                        setRenamingWsKey(null);
                        setWsRenameValue("");
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="sidebar-group-label">{openGroup.label}</span>
                )}
                {renderBadges(openGroup)}
              </button>
              <div className="sidebar-group-actions">
                {renderNewChatBtn(openGroup, selectingWsKey === openGroup.key)}
              </div>
              {selectingWsKey === openGroup.key && renderBulkBar(openGroup)}
              {wsMenuOpenKey === openGroup.key && wsMenuPos && renderWsMenu(openGroup, "header", wsMenuPos)}
              {colorOpen === openGroup.key && renderColorPopover(openGroup)}
            </div>
            <div
              className="sidebar-group-chats"
              style={
                workspaceColors[openGroup.key]
                  ? ({ "--ws": workspaceColors[openGroup.key] } as React.CSSProperties)
                  : undefined
              }
            >
              {openChats.map((c) => renderChatRow(c, openGroup.key))}
              {openChats.length === 0 && (
                <div className="sidebar-empty">
                  {searching
                    ? `No chats match “${search.trim()}”`
                    : "No chats in this project yet"}
                </div>
              )}
            </div>
          </div>
          {searching && openChats.length > 0 && (
            <div className="sidebar-result-count">
              {openChats.length} chats found
            </div>
          )}
        </div>
      ) : (
        /* ---------------------------------------------------------------
         * Projects list: ONE flat list of folder rows, no collapse. Click
         * a row to drill into its chats; drag rows to reorder (slide
         * preview, exactly like the chat tab bar).
         * --------------------------------------------------------------- */
        <div
          ref={listRef}
          className="sidebar-list"
          onDragOver={onListDragOver}
          onDrop={onListDrop}
          onDragLeave={onListDragLeave}
        >
          {colorOpen !== null && (
            <div className="color-backdrop" onClick={() => setColorOpen(null)} />
          )}
          {visibleFolders.length === 0 && (
            <div className="sidebar-empty">
              {searching
                ? `No projects match “${search.trim()}”`
                : "No projects yet"}
            </div>
          )}
          {visibleFolders.map((g) => {
            const color = workspaceColors[g.key] || "var(--accent)";
            const isPinned = pinnedWorkspaces.includes(g.key);
            const shift = shifts?.get(g.key) ?? 0;
            return (
              <div
                key={g.key}
                data-ws-id={g.key}
                className={`sidebar-group sidebar-folder${dragKey === g.key ? " dragging" : ""}`}
                style={
                  {
                    "--ws": color,
                    transform:
                      shift !== 0 && slot > 0
                        ? `translateY(${shift * slot}px)`
                        : undefined,
                  } as React.CSSProperties
                }
                draggable
                onDragStart={(e) => onFolderDragStart(e, g.key)}
                onDragEnd={clearDrag}
                onKeyDown={(e) => {
                  // Alt+Arrow moves the focused folder without dragging.
                  const target = tabMove(folderKeys, g.key, e.key, e.altKey, "y");
                  if (!target) return;
                  e.preventDefault();
                  useStore
                    .getState()
                    .setWorkspaceOrder(
                      previewOrder(folderKeys, g.key, target.toId, target.after),
                    );
                }}
                onContextMenu={(e) => {
                  // Row actions live here (right-click), not on the row:
                  // Delete workspace belongs on the projects list, while the
                  // row itself stays a plain click-into-the-folder target.
                  e.preventDefault();
                  setWsMenuOpenKey(g.key);
                  setWsMenuPos({
                    top: menuTop(e.clientY, 226, window.innerHeight),
                    left: menuLeft(e.clientX, 168, window.innerWidth),
                  });
                }}
              >
                <div className="sidebar-group-head">
                  <button
                    className="sidebar-group-toggle"
                    onClick={() => openWorkspace(g.key)}
                    title={g.root || g.label}
                  >
                    <svg
                      className="sidebar-group-icon"
                      style={{ color }}
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
                    </svg>
                    {renamingWsKey === g.key ? (
                      <input
                        className="ws-rename-input"
                        autoFocus
                        value={wsRenameValue}
                        onChange={(e) => setWsRenameValue(e.target.value)}
                        onBlur={commitWsRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitWsRename();
                          else if (e.key === "Escape") {
                            setRenamingWsKey(null);
                            setWsRenameValue("");
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="sidebar-group-label">{g.label}</span>
                    )}
                    {isPinned && (
                      <svg
                        className="sidebar-folder-pin"
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-label="Pinned"
                      >
                        <path d="M12 17v5M5 7h14M7 7l1-4h8l1 4M8 7v4l-2 3h12l-2-3V7" />
                      </svg>
                    )}
                    {renderBadges(g)}
                  </button>
                  <div className="sidebar-group-actions">
                    {renderNewChatBtn(g)}
                  </div>
                  {wsMenuOpenKey === g.key && wsMenuPos && renderWsMenu(g, "row", wsMenuPos)}
                  {colorOpen === g.key && renderColorPopover(g)}
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
