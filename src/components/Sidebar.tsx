import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { APP_DIR, useStore, workspaceKey } from "../lib/store";
export { useStore };
import { themeById } from "../lib/themes";
import type { Chat, Workspace } from "../types";
import { api } from "../lib/fs";
import { copyToClipboard } from "../lib/clipboard";
import { detectDir, prepareContent } from "../lib/bidi";
import { fmtAgo, fmtClockFull } from "../lib/time";
import { shouldFocusSearch } from "../lib/shortcuts";
import { focusChatInput, focusChatInputSoon } from "../lib/chatFocus";
import { menuLeft, menuTop } from "../lib/tabBar";
import { WindowStripCluster } from "./WindowStripCluster";
import { useSidebarView, type SidebarView } from "../lib/sidebarView";
import { clampSidebarWidth } from "../lib/sidebarLayout";

// The explorer is only parsed once the Files view is first shown.
const FilesPanel = lazy(() => import("./FilesPanel").then((m) => ({ default: m.FilesPanel })));

/** The open-workspace chat list. A component of its own because it mounts and
 *  unmounts with the drilled-in folder; its key handler walks the chat ROWS
 *  (j/k, gg/G, Ctrl+D/U) rather than scrolling the box, so Enter can open the
 *  focused chat. */
function SidebarChatList({
  className,
  children,
  focusSeq = 0,
  landChatId = null,
  onKeyDown,
}: {
  className: string;
  children: React.ReactNode;
  /** Bumped by the sidebar after drilling INTO a workspace: land the caret
   *  on the active chat row so j/k work without a second click (the clicked
   *  workspace row unmounts, so WebKit would leave the caret on <body>). */
  focusSeq?: number;
  /** The chat that should take the caret on that landing. When the workspace
   *  has no chats (or the id is stale) the first chat, then the header, then
   *  the list itself is used. */
  landChatId?: string | null;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const served = useRef(0);
  useEffect(() => {
    if (!focusSeq || focusSeq === served.current) return;
    served.current = focusSeq;
    const host = ref.current;
    if (!host) return;
    const target =
      (landChatId &&
        host.querySelector<HTMLElement>(
          `[data-chat-id="${CSS.escape(landChatId)}"]`,
        )) ||
      host.querySelector<HTMLElement>("[data-chat-id]") ||
      host.querySelector<HTMLElement>("[data-open-ws]") ||
      host;
    // Land once now, then confirm on the next frames: WebKit sometimes hands
    // the caret back to the input that was focused before the drill-in (the
    // sidebar search box) when the clicked row unmounts.
    let tries = 0;
    const land = () => {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
      if (document.activeElement !== target && tries++ < 2) {
        requestAnimationFrame(land);
      }
    };
    requestAnimationFrame(land);
  }, [focusSeq]);
  return (
    <div ref={ref} className={className} tabIndex={-1} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

/** Last workspace-focus request this module has acted on. The sidebar content
 *  UNMOUNTS while the panel is collapsed, so an effect keyed on the store
 *  counter would replay the last Ctrl+X W on every remount — opening the
 *  sidebar with Ctrl+X E would then bounce back to the workspace list. Each
 *  request value is consumed exactly once, like FilesPanel does for its
 *  filter-focus counter. */
let servedWorkspaceListFocusSeq = useStore.getState().workspaceListFocusSeq;

/** Same one-shot guard for the OPEN-sidebar landing: bumping `sidebarFocusSeq`
 *  (e.g. Cmd/Ctrl+B opening the sidebar) must focus the ACTIVE workspace row
 *  exactly once, not again every time the sidebar content remounts. */
let servedSidebarFocusSeq = useStore.getState().sidebarFocusSeq;

/** The two views of the sidebar switch, in display order. */
const SIDEBAR_VIEWS: ReadonlyArray<{ id: SidebarView; label: string; icon: React.ReactNode }> = [
  {
    id: "chats",
    label: "Chats",
    icon: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  },
  {
    id: "files",
    label: "Files",
    icon: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  },
];

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
 * Pinned workspaces float to the very top (in pin order); everything else is
 * ordered by last activation (newest first), falling back to the newest chat
 * timestamp for workspaces not touched since this ordering was introduced.
 * Chats INSIDE each workspace sort by pin, then recency.
 */
export function buildGroups<T extends { id: string; root?: string | null; updatedAt: number; createdAt: number }>(
  chats: T[],
  workspaces: Workspace[],
  pinnedWorkspaces: string[],
  pinnedChats: string[],
  lastUsedAt: Record<string, number> = {},
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
  const latestByKey = new Map<string, number>();
  for (const [key, list] of chatsByRoot) {
    latestByKey.set(key, Math.max(0, ...list.map((c) => c.updatedAt)));
  }
  for (const g of groups) {
    latestByKey.set(g.key, Math.max(latestByKey.get(g.key) ?? 0, ...g.chats.map((c) => c.updatedAt)));
  }
  const recency = (key: string) => lastUsedAt[key] ?? latestByKey.get(key) ?? 0;
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

  const ordered = [...groups, ...leftovers];
  // Pinned float to top, in pin order; then most recently activated wins.
  // Array#sort is stable, so equal timestamps keep the persisted order.
  ordered.sort((a, b) => {
    const ar = pinRank(a.key);
    const br = pinRank(b.key);
    if (ar !== br) return ar - br;
    return recency(b.key) - recency(a.key);
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
  // resizable one. The limits are shared with the window-strip cluster: below
  // SIDEBAR_MIN_WIDTH the persona switch + icon cluster would be cut.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("coder:sidebarWidth");
    const n = saved ? parseInt(saved, 10) : 264;
    return clampSidebarWidth(Number.isFinite(n) ? n : 264);
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
      const w = clampSidebarWidth(
        sidebarDrag.current.startW + (ev.clientX - sidebarDrag.current.startX),
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
  /** Incremented when the sidebar is REVEALED (Cmd/Ctrl+B): the content lands
   *  the caret on the ACTIVE workspace row instead of the search box. */
  const sidebarFocusSeq = useStore((s) => s.sidebarFocusSeq);
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
  const activeWorkspaceKey = useStore((s) => s.activeWorkspaceKey);
  const workspaceLastUsedAt = useStore((s) => s.workspaceLastUsedAt);
  const workspaceListFocusSeq = useStore((s) => s.workspaceListFocusSeq);
  const workspaceColors = useStore((s) => s.workspaceColors);
  const theme = useStore((s) => s.theme);
  const pinnedWorkspaces = useStore((s) => s.pinnedWorkspaces);
  const pinnedChats = useStore((s) => s.pinnedChats);
  const unreadChats = useStore((s) => s.unreadChats);
  const view = useSidebarView((s) => s.view);
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
  // Bumped when the user drills INTO a workspace: the ACTIVE CHAT row takes
  // the caret (the clicked folder row unmounted with the projects list, and
  // WebKit does not move focus to the new list on its own). Falling back to
  // the first chat / header keeps an empty workspace usable.
  const [openListFocusSeq, setOpenListFocusSeq] = useState(0);
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
  // right buttons, so no extra guarding is needed. `chatMenuMove` swaps the
  // menu's content for the "Move to group" workspace list.
  const [chatMenuId, setChatMenuId] = useState<string | null>(null);
  const [chatMenuPos, setChatMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [chatMenuMove, setChatMenuMove] = useState(false);
  const closeChatMenu = () => {
    setChatMenuId(null);
    setChatMenuMove(false);
  };
  useEffect(() => {
    if (!chatMenuId) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!(t instanceof Element) || !t.closest(".chat-menu")) {
        closeChatMenu();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const dir = APP_DIR;

  // `buildGroups` walks every chat + sorts; memoize it so it only re-runs when
  // the underlying data actually changes (not on every unrelated re-render such
  // as hover/scroll state). `chats` is rebuilt by the store on each streamed
  // token, so this still recomputes during streaming.
  const groups = useMemo(
    () => buildGroups(chats, workspaces, pinnedWorkspaces, pinnedChats, workspaceLastUsedAt),
    [chats, workspaces, pinnedWorkspaces, pinnedChats, workspaceLastUsedAt],
  );

  // The drilled-into workspace. The find-guard doubles as deletion handling:
  // once the workspace is gone the sidebar falls back to the projects list
  // (the stale persisted key stays harmless until the user navigates).
  const openGroup = useMemo(
    () => (openWsKey ? groups.find((g) => g.key === openWsKey) ?? null : null),
    [groups, openWsKey],
  );

  // Drill in / back. Both clear the search: a query typed for folder filtering
  // must not silently become a chat filter inside the opened folder. Clicking
  // a row also ACTIVATES that workspace: the chat area (tabs + windows) follows
  // the project whose chats the user is browsing.
  const openWorkspace = (key: string) => {
    useStore.getState().switchWorkspace(key);
    setOpenWsKey(key);
    setOpenListFocusSeq((n) => n + 1);
    setSearch("");
  };
  const closeWorkspace = () => {
    setOpenWsKey(null);
    setSearch("");
    // The back button unmounts with the drilled-in header: park the caret on
    // the projects list so j/k (and gg/G, Ctrl+D/U) keep walking it after a
    // mouse trip into a workspace and back.
    let tries = 0;
    const land = () => {
      const list = listRef.current;
      if (list) list.focus({ preventScroll: true });
      else if (tries++ < 10) requestAnimationFrame(land);
    };
    requestAnimationFrame(land);
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
  // Workspace list keyboard navigation (Ctrl+X W lands on the active row).
  // Workspaces are ordered by pin, then recency, so drag-reorder is gone: the
  // list would just snap back on the next activation. Plain j/k and Up/Down
  // move the row focus; Ctrl/Cmd+J enters at the first row and Ctrl/Cmd+K
  // returns to the search. Enter activates + opens the folder, Escape hands
  // the caret back to the chat.
  // ---------------------------------------------------------------------------
  const listRef = useRef<HTMLDivElement>(null);
  const [wsFocusKey, setWsFocusKey] = useState<string | null>(null);
  // First `g` of `gg` (Neovim: jump to the first row) for each list.
  const wsGAt = useRef(0);
  const chatGAt = useRef(0);

  const focusWorkspaceRow = (key: string) => {
    setWsFocusKey(key);
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-ws-id="${CSS.escape(key)}"]`,
      );
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest" });
    });
  };

  const focusWorkspaceSearch = () => {
    const box = searchInputRef.current;
    if (!box) return;
    box.focus({ preventScroll: true });
    box.select?.();
  };

  const moveWorkspaceFocus = (delta: number) => {
    const keys = visibleFolders.map((g) => g.key);
    if (keys.length === 0) return;
    const current =
      wsFocusKey && keys.includes(wsFocusKey)
        ? wsFocusKey
        : activeWorkspaceKey && keys.includes(activeWorkspaceKey)
          ? activeWorkspaceKey
          : keys[0];
    const idx = keys.indexOf(current);
    // Plain k / ArrowUp stops at the top row; the search box is reached with
    // Ctrl/Cmd+K (handled by the list keydown), never by a bare k.
    const next = Math.max(
      0,
      Math.min(keys.length - 1, idx + delta),
    );
    focusWorkspaceRow(keys[next]);
  };

  /** Hand the caret from the search box to the FIRST row of the current
   *  sidebar view — a workspace row in the projects list, or the opened
   *  workspace's header while drilled in. Pinned workspaces sort first, so
   *  this honours them instead of jumping to the active (possibly unpinned)
   *  workspace further down the list. `Ctrl+K` comes back to the search box
   *  from either view. */
  const focusFirstWorkspace = () => {
    const host = document.querySelector<HTMLElement>(".sidebar .sidebar-list");
    const first =
      (activeChatId &&
        host?.querySelector<HTMLElement>(
          `[data-chat-id="${CSS.escape(activeChatId)}"]`,
        )) ||
      host?.querySelector<HTMLElement>("[data-ws-id]") ||
      host?.querySelector<HTMLElement>("[data-chat-id]") ||
      host?.querySelector<HTMLElement>("[data-open-ws]") ||
      null;
    if (first) {
      const key = first.getAttribute("data-ws-id");
      if (key) setWsFocusKey(key);
      first.focus({ preventScroll: true });
      first.scrollIntoView({ block: "nearest" });
      return;
    }
    // Empty list (or it has not committed yet): the list itself still owns
    // the key handler, so the next j/k keeps working instead of typing into
    // the search field.
    host?.focus({ preventScroll: true });
  };

  /** `gg` / `G`: first and last workspace row (Neovim's jumps). */
  const focusWorkspaceEdge = (edge: "top" | "bottom") => {
    const keys = visibleFolders.map((g) => g.key);
    if (keys.length === 0) return;
    focusWorkspaceRow(edge === "top" ? keys[0] : keys[keys.length - 1]);
  };

  /** How many rows a Ctrl+D / Ctrl+U step covers: half a screenful. Measured
   *  from a real row so the list's spacing is included. */
  const workspaceHalfPage = () => {
    const host = listRef.current;
    const row = host?.querySelector<HTMLElement>("[data-ws-id]");
    const rowH = Math.max(1, row?.getBoundingClientRect().height || 34);
    return Math.max(1, Math.floor((host?.clientHeight ?? 320) / rowH / 2));
  };

  const onWorkspaceListKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    // j/k must never steal keystrokes from the rename input or the search box.
    const typing = target?.closest("input, textarea, select, [contenteditable='true']");
    const k = (e.code || "").replace(/^Key/, "").toLowerCase() || e.key.toLowerCase();
    // Plain j/k (Vim style) step the row focus. Modified J/K are NOT row
    // movement: Ctrl/Cmd+J enters the list from the search box and Ctrl/Cmd+K
    // returns there, so workspaces move up/down with plain j/k only.
    const modifier = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const down =
      e.key === "ArrowDown" ||
      (plain && k === "j");
    const up =
      e.key === "ArrowUp" ||
      (plain && k === "k");
    // Ctrl/Cmd+K from ANY row hands the caret back to the search box — the
    // list's top entry. Mirrors Ctrl/Cmd+J, which enters the list at its
    // first (pinned-first) row. A bare k/ArrowUp never leaves the list.
    if (modifier && k === "k" && !typing) {
      e.preventDefault();
      focusWorkspaceSearch();
      return;
    }
    if (typing) return;
    // Neovim jumps and half-page steps over the SAME row focus as j/k:
    // gg = first workspace, G = last, Ctrl+D / Ctrl+U = half a screenful.
    if (!e.ctrlKey && !e.metaKey && !e.altKey && k === "g") {
      if (e.shiftKey) {
        e.preventDefault();
        wsGAt.current = 0;
        focusWorkspaceEdge("bottom");
        return;
      }
      const now = Date.now();
      if (now - wsGAt.current <= 800) {
        wsGAt.current = 0;
        e.preventDefault();
        focusWorkspaceEdge("top");
        return;
      }
      wsGAt.current = now;
      e.preventDefault();
      return;
    }
    // Any other key ends a pending `gg` (Neovim's timeout_leave).
    wsGAt.current = 0;
    if (modifier && (k === "d" || k === "u")) {
      e.preventDefault();
      moveWorkspaceFocus((k === "d" ? 1 : -1) * workspaceHalfPage());
      return;
    }
    if (down || up) {
      e.preventDefault();
      moveWorkspaceFocus(down ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      // A nested action (the row's + button, rename input, …) owns Enter.
      if (target?.closest("button, a, input, textarea, select, [contenteditable='true']")) return;
      const keys = visibleFolders.map((g) => g.key);
      const key =
        wsFocusKey && keys.includes(wsFocusKey)
          ? wsFocusKey
          : activeWorkspaceKey && keys.includes(activeWorkspaceKey)
            ? activeWorkspaceKey
            : keys[0];
      if (!key) return;
      e.preventDefault();
      openWorkspace(key);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      const chatId = useStore.getState().activeChatId;
      setWsFocusKey(null);
      if (chatId) requestAnimationFrame(() => focusChatInput(chatId));
    }
  };

  // ---------------------------------------------------------------------------
  // Chat list keyboard navigation (inside an opened workspace): plain j/k and
  // Up/Down walk the CHAT rows, Enter opens the focused chat and parks the
  // caret in its composer, gg/G jump to the edges, Ctrl+D/U step half a screen.
  // Ctrl+K returns to the search box, exactly like the projects list.
  // ---------------------------------------------------------------------------
  const chatRowElements = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(".sidebar .sidebar-list [data-chat-id]"),
    );

  /** Step the row focus. With no row focused yet, the ACTIVE chat is the
   *  starting point; an empty focus starts at the first (j) or last (k) row. */
  const moveChatFocus = (delta: number) => {
    const rows = chatRowElements();
    if (rows.length === 0) return;
    const focused = (document.activeElement as HTMLElement | null)
      ?.closest?.("[data-chat-id]")
      ?.getAttribute("data-chat-id");
    let idx = rows.findIndex(
      (r) => r.getAttribute("data-chat-id") === focused,
    );
    if (idx === -1) {
      idx = rows.findIndex(
        (r) => r.getAttribute("data-chat-id") === activeChatId,
      );
      if (idx === -1) idx = delta > 0 ? -1 : rows.length;
    }
    const next = Math.max(0, Math.min(rows.length - 1, idx + delta));
    rows[next].focus({ preventScroll: true });
    rows[next].scrollIntoView({ block: "nearest" });
  };

  const focusChatEdge = (edge: "top" | "bottom") => {
    const rows = chatRowElements();
    if (rows.length === 0) return;
    const row = edge === "top" ? rows[0] : rows[rows.length - 1];
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  };

  const chatHalfPage = () => {
    const rows = chatRowElements();
    const host = document.querySelector<HTMLElement>(".sidebar .sidebar-list");
    const rowH = Math.max(1, rows[0]?.getBoundingClientRect().height || 34);
    return Math.max(1, Math.floor((host?.clientHeight ?? 320) / rowH / 2));
  };

  const onChatListKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    // A rename field / the bulk-select checkbox keeps its own keystrokes.
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    const k = (e.code || "").replace(/^Key/, "").toLowerCase() || e.key.toLowerCase();
    const modifier = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (modifier && k === "k") {
      e.preventDefault();
      focusWorkspaceSearch();
      return;
    }
    if (e.key === "Enter") {
      // A nested action (header back/new-chat button, …) owns Enter.
      if (target?.closest("button, a")) return;
      const id =
        target?.closest<HTMLElement>("[data-chat-id]")?.getAttribute("data-chat-id") ||
        activeChatId ||
        chatRowElements()[0]?.getAttribute("data-chat-id");
      if (!id) return;
      e.preventDefault();
      useStore.getState().openChat(id);
      // The chat window commits a frame or two after openChat; the helper
      // probes CHAT-SCOPED until its composer exists.
      focusChatInputSoon(id);
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && k === "g") {
      if (e.shiftKey) {
        e.preventDefault();
        chatGAt.current = 0;
        focusChatEdge("bottom");
        return;
      }
      const now = Date.now();
      if (now - chatGAt.current <= 800) {
        chatGAt.current = 0;
        e.preventDefault();
        focusChatEdge("top");
        return;
      }
      chatGAt.current = now;
      e.preventDefault();
      return;
    }
    chatGAt.current = 0;
    if (modifier && (k === "d" || k === "u")) {
      e.preventDefault();
      moveChatFocus((k === "d" ? 1 : -1) * chatHalfPage());
      return;
    }
    const down = e.key === "ArrowDown" || (plain && k === "j");
    const up = e.key === "ArrowUp" || (plain && k === "k");
    if (down || up) {
      e.preventDefault();
      moveChatFocus(down ? 1 : -1);
    }
  };

  // Ctrl+X W: reveal the WORKSPACE LIST (the projects list) and put the caret
  // on the active workspace's ROW — never on the search box, and never on the
  // workspace the user had drilled into. W is also the way BACK to the list:
  // the request closes the drill-in first, so the rows only mount on a later
  // commit. The landing therefore retries for a short window, then falls back
  // to the first row and finally to the list itself. The search box is
  // deliberately NOT a fallback: landing there made the chord look inert and
  // made j/k type into the query instead of walking the rows.
  //
  // The effect never touches the Chats/Files view: App.tsx owns that switch,
  // and replaying it here would pull a freshly revealed Files view back.
  // Ctrl/Cmd+K is what returns to the search box.
  const landedSeq = useRef(0);
  useEffect(() => {
    if (!workspaceListFocusSeq) return;
    if (workspaceListFocusSeq === servedWorkspaceListFocusSeq) return;
    servedWorkspaceListFocusSeq = workspaceListFocusSeq;
    setSearch("");
    setOpenWsKey(null);
    const startedAt = Date.now();
    const land = () => {
      if (landedSeq.current === workspaceListFocusSeq) return;
      const active = useStore.getState().activeWorkspaceKey;
      const host = listRef.current;
      const row =
        (active &&
          host?.querySelector<HTMLElement>(
            `[data-ws-id="${CSS.escape(active)}"]`,
          )) ||
        host?.querySelector<HTMLElement>("[data-ws-id]") ||
        null;
      if (row) {
        row.focus({ preventScroll: true });
        row.scrollIntoView({ block: "nearest" });
        setWsFocusKey(row.getAttribute("data-ws-id"));
        landedSeq.current = workspaceListFocusSeq;
        return;
      }
      // The projects list has not committed yet (the drill-in is closing) or
      // it is empty. Retry briefly, then park the caret on the list itself so
      // the next keys still belong to the workspace view.
      if (Date.now() - startedAt < 400) {
        requestAnimationFrame(land);
        return;
      }
      host?.focus({ preventScroll: true });
      landedSeq.current = workspaceListFocusSeq;
    };
    requestAnimationFrame(() => requestAnimationFrame(land));
  }, [workspaceListFocusSeq]);

  // Opening the sidebar (Cmd/Ctrl+B, the titlebar toggle, …) lands the caret on
  // the ACTIVE workspace row — the workspace the user is in — instead of the
  // search box. The request counter is bumped by App.tsx when the sidebar is
  // revealed from the keyboard; it is consumed once per value.
  useEffect(() => {
    if (!sidebarFocusSeq) return;
    if (sidebarFocusSeq === servedSidebarFocusSeq) return;
    servedSidebarFocusSeq = sidebarFocusSeq;
    const key = useStore.getState().activeWorkspaceKey;
    if (openGroup) {
      // Drilled in: the opened workspace's header button is the row here.
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-open-ws="${CSS.escape(openGroup.key)}"]`,
      );
      const btn =
        row?.querySelector<HTMLElement>("button, [tabindex='0'], [tabindex='-1']") ??
        row;
      btn?.focus({ preventScroll: true });
      return;
    }
    if (!key) return;
    if (visibleFolders.some((g) => g.key === key)) focusWorkspaceRow(key);
    else requestAnimationFrame(() => focusWorkspaceSearch());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarFocusSeq]);

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

  // Right-click menu for a chat row (the ⋯ kebab is gone): pin, rename, move
  // to another workspace, delete — the actions the kebab used to hold, now at
  // the cursor. "Move to group" swaps the menu's content for the workspace
  // list instead of nesting a submenu.
  const renderChatMenu = (c: ChatSummary, pos: { top: number; left: number }) => {
    const isPinnedChat = pinnedChats.includes(c.id);
    if (chatMenuMove) {
      const currentKey = workspaceKey(c.root ?? "");
      const targets = groups.filter((g) => g.key !== currentKey);
      return (
        <div
          className="ws-menu chat-menu"
          role="menu"
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="ws-menu-title">Move to group</div>
          {targets.length === 0 && (
            <div className="ws-menu-title">No other projects</div>
          )}
          {targets.map((g) => (
            <button
              key={g.key}
              className="ws-menu-btn"
              role="menuitem"
              onClick={() => {
                useStore.getState().setChatRoot(c.id, g.root ?? "");
                closeChatMenu();
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
      );
    }
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
            closeChatMenu();
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
            closeChatMenu();
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
          title={c.id}
          onClick={() => {
            void copyToClipboard(c.id);
            closeChatMenu();
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
          onClick={() => setChatMenuMove(true)}
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
            useStore.getState().deleteChat(c.id);
            closeChatMenu();
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
        data-chat-id={c.id}
        tabIndex={-1}
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
        onMouseDown={(e) => {
          // WebKit does not focus a clicked div: move the row focus here so
          // j/k keep walking the chat list after a mouse click (fields and
          // nested buttons keep their own clicks).
          const t = e.target as HTMLElement | null;
          if (t?.closest("input, textarea, select, [contenteditable='true'], button, a")) return;
          e.currentTarget.focus({ preventScroll: true });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // WebKit grabs the word under the pointer on right-mousedown; clear
          // it so the label never shows a stale selection behind the menu.
          document.getSelection()?.removeAllRanges();
          setChatMenuMove(false);
          setChatMenuId(c.id);
          setChatMenuPos({
            top: menuTop(e.clientY, 190, window.innerHeight),
            left: menuLeft(e.clientX, 170, window.innerWidth),
          });
        }}
        title={prepareContent(titleOf(c))}
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
            dir="auto"
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
          /* dir lives on the title span only: the row itself stays LTR so
             the trailing time badge keeps one fixed position (right edge)
             for both Persian and English titles. */
          <span className="chat-item-title-row">
            <span
              className="chat-item-title"
              dir={detectDir(titleOf(c))}
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

  // While the Files view is up the chat list is hidden, so a chat that needs
  // the user (working, asking, unread) would go unnoticed: the Chats segment
  // carries a dot instead.
  const chatsAttention = chats.some(
    (c) =>
      c.hasStreaming ||
      c.pendingPermission !== null ||
      c.pendingAsk !== null ||
      (c.id !== activeChatId && unreadChats.includes(c.id)),
  );

  // Window chrome shared by BOTH views (drag strip, resize handle, switch). It
  // sits first in each return below, so the switch keeps its DOM node when the
  // view changes and its thumb slides instead of remounting.
  const chrome = (
    <>
      {/* macOS traffic-light strip: with the native title bar hidden the
          window buttons overlay this corner — the window-strip cluster
          (sidebar toggle + workspace + direction) lives here so those
          controls keep their exact position while the sidebar is open.
          display:none off-mac and it collapses the strip entirely.
          data-tauri-drag-region: mousedown drags the window, double-click
          maximizes/restores it (Tauri's injected drag script); the cluster's
          buttons are clickable elements, so they block the drag themselves. */}
      <div className="sidebar-drag" data-tauri-drag-region="deep" aria-hidden="false">
        <WindowStripCluster />
      </div>
      <div
        className="sidebar-resize-handle"
        title="Drag to resize sidebar"
        onMouseDown={onResizeStart}
      />
      {/* Chats ⇄ Files switch: a segmented control whose thumb slides under the
          active segment (data-view drives the CSS transform). */}
      <div
        className="sidebar-switch"
        role="tablist"
        aria-label="Sidebar view"
        data-view={view}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const next = view === "chats" ? "files" : "chats";
          useSidebarView.getState().setView(next);
          e.currentTarget.querySelector<HTMLElement>(`[data-view-id="${next}"]`)?.focus();
        }}
      >
        <span className="sidebar-switch-thumb" aria-hidden="true" />
        {SIDEBAR_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            data-view-id={v.id}
            className={"sidebar-switch-btn" + (view === v.id ? " active" : "")}
            aria-selected={view === v.id}
            tabIndex={view === v.id ? 0 : -1}
            aria-label={v.label}
            title={v.label}
            onClick={() => useSidebarView.getState().setView(v.id)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {v.icon}
            </svg>
            {v.id === "chats" && view === "files" && chatsAttention ? (
              <span className="sidebar-switch-dot" title="A chat needs your attention" />
            ) : null}
          </button>
        ))}
      </div>
    </>
  );

  if (view === "files") {
    return (
      <div className="sidebar-inner">
        {chrome}
        <div className="sidebar-files-view">
          <Suspense fallback={null}>
            <FilesPanel />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="sidebar-inner">
      {chrome}
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
              const k =
                (e.code || "").replace(/^Key/, "").toLowerCase() ||
                e.key.toLowerCase();
              const modifier =
                (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
              const plain =
                !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
              // Plain j/k stay ordinary search text (a query may start with
              // "j" or "k"). Ctrl/Cmd+J (or ArrowDown) enters the list at the
              // FIRST workspace row — pinned workspaces sort first — and the
              // list's own handler walks from there; Ctrl/Cmd+K comes back
              // here from any row.
              const navDown =
                (plain && e.key === "ArrowDown") || (modifier && k === "j");
              if (navDown) {
                e.preventDefault();
                focusFirstWorkspace();
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                // First Esc clears the query; an already-empty box hands the
                // caret back to the chat, like Esc on a workspace row.
                if (search) {
                  setSearch("");
                  return;
                }
                const chatId = useStore.getState().activeChatId;
                setWsFocusKey(null);
                if (chatId) requestAnimationFrame(() => focusChatInput(chatId));
              }
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
        {/* "New workspace" belongs to the PROJECTS list only: inside an opened
            workspace the header's + (new chat) is the one action, and two +
            buttons side by side read as the same control. */}
        <div className="sidebar-head-actions">
          <button
            className="sidebar-head-btn"
            title="New workspace"
            hidden={!!openGroup}
            style={openGroup ? { display: "none" } : undefined}
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
        <SidebarChatList
          className="sidebar-list"
          focusSeq={openListFocusSeq}
          landChatId={activeChatId}
          onKeyDown={onChatListKeyDown}
        >
          {colorOpen !== null && (
            <div className="color-backdrop" onClick={() => setColorOpen(null)} />
          )}
          <div
            className="sidebar-group sidebar-ws-open ws-colored"
            style={{ "--ws": workspaceColors[openGroup.key] || "var(--accent)" } as React.CSSProperties}
          >
            <div
              className="sidebar-group-head sidebar-ws-head"
              data-open-ws={openGroup.key}
              tabIndex={-1}
              onContextMenu={(e) => {
                // The kebab is gone — right-clicking the folder header opens
                // its menu (Rename / Color / Change folder… / Select chats).
                e.preventDefault();
                // WebKit grabs the word under the pointer on right-mousedown;
                // clear it so the label never shows a stale selection.
                document.getSelection()?.removeAllRanges();
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
                {/* Open-folder icon: this workspace is "entered", so the icon
                    reads open — folder rows in the projects list stay closed. */}
                <svg
                  className="sidebar-group-icon"
                  style={{ color: workspaceColors[openGroup.key] || "var(--accent)" }}
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.9}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
                  <path d="M2 9a2 2 0 0 1 2-2h7.5l2 2H21a2 2 0 0 1 2 2v1H2Z" />
                </svg>
                {renamingWsKey === openGroup.key ? (
                  <input
                    className="ws-rename-input"
                    dir={dir}
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
                  <span className="sidebar-group-label" dir={detectDir(openGroup.label)}>{openGroup.label}</span>
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
            <div className="sidebar-group-chats">
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
        </SidebarChatList>
      ) : (
        /* ---------------------------------------------------------------
         * Projects list: ONE flat list of folder rows, no collapse. Click
         * a row (or press Enter on the focused row) to activate the
         * workspace and drill into its chats. Ordering is automatic:
         * pinned first, then most recently activated.
         * --------------------------------------------------------------- */
        <div
          ref={listRef}
          className="sidebar-list sidebar-ws-list"
          role="list"
          tabIndex={-1}
          aria-label="Workspaces"
          onKeyDown={onWorkspaceListKeyDown}
          onMouseDown={(e) => {
            // WebKit does not focus a clicked div/button. Focus the row
            // explicitly so j/k (and gg/G, Ctrl+D/U) work after a mouse click,
            // exactly like the explorer. Fields keep their own clicks.
            const t = e.target as HTMLElement | null;
            if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
            t?.closest<HTMLElement>("[data-ws-id]")?.focus({ preventScroll: true });
          }}
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
            const isActive = g.key === activeWorkspaceKey;
            const isKeyboardFocus = g.key === wsFocusKey;
            return (
              <div
                key={g.key}
                data-ws-id={g.key}
                role="listitem"
                tabIndex={-1}
                className={`sidebar-group sidebar-folder${isActive ? " active" : ""}${isKeyboardFocus ? " kbd-focus" : ""}`}
                style={
                  {
                    "--ws": color,
                  } as React.CSSProperties
                }
                onFocus={() => setWsFocusKey(g.key)}
                onContextMenu={(e) => {
                  // Row actions live here (right-click), not on the row:
                  // Delete workspace belongs on the projects list, while the
                  // row itself stays a plain click-into-the-folder target.
                  e.preventDefault();
                  // WebKit grabs the word under the pointer on right-mousedown;
                  // clear it so the label never shows a stale selection.
                  document.getSelection()?.removeAllRanges();
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
                        dir={dir}
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
                      <span className="sidebar-group-label" dir={detectDir(g.label)}>{g.label}</span>
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
