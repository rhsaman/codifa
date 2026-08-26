import { useEffect, useRef, useState } from "react";
import { useStore, workspaceKey } from "../lib/store";
export { useStore };
import { themeById } from "../lib/themes";
import type { Chat, ChatMessage, ProviderConfig, Workspace } from "../types";
import { api } from "../lib/fs";
import { prepareContent } from "../lib/bidi";
import {
  formatTokens,
  formatCost,
  priceForModel,
  computeUsageCost,
  computeUsageCostBreakdown,
} from "../lib/context";

function titleOf(chat: Chat): string {
  if (chat.title && chat.title !== "New chat") return chat.title;
  const firstUser = chat.messages.find((m) => m.role === "user");
  return firstUser ? firstUser.content.slice(0, 48) : "New chat";
}

/** Last path segment of a root folder, for a compact group label. */
function rootName(root: string): string {
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last || root;
}

interface Group {
  key: string;
  label: string;
  root: string | null;
  chats: Chat[];
}

/** Persisted sidebar UI state (localStorage `coder:sidebarUi`): collapse
 *  toggles + panel heights for workspace groups, Todos and Model usage, so the
 *  layout the user left comes back exactly as it was after a restart. */
interface SidebarUiState {
  todoCollapsed?: boolean;
  usageCollapsed?: boolean;
  todoHeight?: number;
  usageHeight?: number;
  usageGroupsClosed?: string[];
  collapsedGroups?: string[];
}

/**
 * Build sidebar groups from the PERSISTED workspace list (workspaces are
 * first-class and outlive their chats), then attach chats by workspace key.
 * Workspace order is user-controlled — only the chats INSIDE each workspace
 * sort by recency. Pinned workspaces float to the very top (in pin order).
 */
export function buildGroups(
  chats: Chat[],
  workspaces: Workspace[],
  pinnedWorkspaces: string[],
  pinnedChats: string[],
): Group[] {
  const chatsByRoot = new Map<string, Chat[]>();
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
  const sortChats = (list: Chat[]) => {
    list.sort((a, b) => {
      const ar = pinRankChat(a.id);
      const br = pinRankChat(b.id);
      if (ar !== br) return ar - br;
      return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
    });
  };

  const groups: Group[] = [];
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

export function Sidebar() {
  const chats = useStore((s) => s.chats);
  const workspaces = useStore((s) => s.workspaces);
  const activeChatId = useStore((s) => s.activeChatId);
  const workspaceColors = useStore((s) => s.workspaceColors);
  const theme = useStore((s) => s.theme);
  const pinnedWorkspaces = useStore((s) => s.pinnedWorkspaces);
  const pinnedChats = useStore((s) => s.pinnedChats);
  const unreadChats = useStore((s) => s.unreadChats);
  // Persisted sidebar UI state (collapse toggles + panel heights) — read once
  // per mount, same localStorage pattern as coder:sidebarWidth below.
  const [savedUi] = useState<SidebarUiState>(() => {
    try {
      const raw = localStorage.getItem("coder:sidebarUi");
      return raw ? (JSON.parse(raw) as SidebarUiState) : {};
    } catch {
      return {};
    }
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(savedUi.collapsedGroups ?? []),
  );
  const [colorOpen, setColorOpen] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
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

  // Click-based kebab menu: opens on click, stays open while hovering the
  // popup (no hover-gap race), and closes on outside click or re-click.
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (!menuOpenId) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!(t instanceof Element) || !t.closest(".chat-item-kebab-wrap")) {
        setMenuOpenId(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpenId]);

  // Workspace 3-dot menu, delete-confirm popup, and chat-selection mode.
  const [wsMenuOpenKey, setWsMenuOpenKey] = useState<string | null>(null);
  const [wsMenuPos, setWsMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [deleteMenuKey, setDeleteMenuKey] = useState<string | null>(null);
  const [deleteMenuPos, setDeleteMenuPos] = useState<{ top: number; left: number } | null>(null);
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
    if (!wsMenuOpenKey && !deleteMenuKey) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (
        !(t instanceof Element) ||
        (!t.closest(".ws-menu-wrap") && !t.closest(".ws-delete-menu-wrap"))
      ) {
        setWsMenuOpenKey(null);
        setDeleteMenuKey(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [wsMenuOpenKey, deleteMenuKey]);

  // ⌘K / Ctrl+K focuses the chat search — the natural "find my chat" shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const open = useStore((s) => s.sidebarOpen);
  const dir = useStore((s) => s.dir);
  const provider = useStore(
    (s) =>
      s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ??
      s.settings.providers[0],
  );

  // ---- Footer panel state (todos + model usage), VSCode-style: each panel is
  // collapsible and its content height is user-resizable via a drag handle. ----
  const [todoCollapsed, setTodoCollapsed] = useState(
    () => savedUi.todoCollapsed ?? false,
  );
  const [usageCollapsed, setUsageCollapsed] = useState(
    () => savedUi.usageCollapsed ?? false,
  );
  const [todoHeight, setTodoHeight] = useState(() => savedUi.todoHeight ?? 320);
  const [usageHeight, setUsageHeight] = useState(
    () => savedUi.usageHeight ?? 200,
  );
  // Tracks CLOSED groups (not open ones) so every provider starts expanded
  // by default — the user has to collapse a group explicitly to hide it.
  const [usageGroupsClosed, setUsageGroupsClosed] = useState<Set<string>>(
    () => new Set(savedUi.usageGroupsClosed ?? []),
  );
  const todoDrag = useRef<{ startY: number; startH: number } | null>(null);
  const usageDrag = useRef<{ startY: number; startH: number } | null>(null);

  // Persist the panel/group UI state whenever it changes, so collapse toggles
  // and panel heights survive restarts. Debounced: a height drag fires
  // setTodoHeight/setUsageHeight on every mousemove, and writing localStorage
  // per frame would lag the drag — the write lands 250ms after the drag
  // settles, and the app-close flush below guarantees the final value.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          "coder:sidebarUi",
          JSON.stringify({
            todoCollapsed,
            usageCollapsed,
            todoHeight,
            usageHeight,
            usageGroupsClosed: [...usageGroupsClosed],
            collapsedGroups: [...collapsed],
          }),
        );
      } catch {
        /* quota / serialization errors — the layout just won't persist */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [
    todoCollapsed,
    usageCollapsed,
    todoHeight,
    usageHeight,
    usageGroupsClosed,
    collapsed,
  ]);

  // Flush the latest sidebar UI state synchronously on app close, so a toggle
  // or resize made right before quitting is never lost to the debounce above.
  // Also flushes on the store's `coder:flush-ui` event (dispatched before every
  // store flush, including the main process's `flush-persist` on quit) so the
  // layout survives even when the renderer's beforeunload runs late.
  useEffect(() => {
    const flush = () => {
      try {
        localStorage.setItem(
          "coder:sidebarUi",
          JSON.stringify({
            todoCollapsed,
            usageCollapsed,
            todoHeight,
            usageHeight,
            usageGroupsClosed: [...usageGroupsClosed],
            collapsedGroups: [...collapsed],
          }),
        );
      } catch {
        /* quota / serialization errors — the layout just won't persist */
      }
    };
    window.addEventListener("coder:flush-ui", flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("coder:flush-ui", flush);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, [
    todoCollapsed,
    usageCollapsed,
    todoHeight,
    usageHeight,
    usageGroupsClosed,
    collapsed,
  ]);

  // Sidebar width — drag-resizable on the right edge (VSCode-style), persisted
  // locally so the layout survives restarts.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("coder:sidebarWidth");
    const n = saved ? parseInt(saved, 10) : 264;
    return Number.isFinite(n) ? Math.max(180, Math.min(480, n)) : 264;
  });
  const sidebarDrag = useRef<{ startX: number; startW: number } | null>(null);
  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDrag.current = { startX: e.clientX, startW: sidebarWidth };
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
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const allProviders = useStore((s) => s.settings.providers);
  const recentModels = useStore((s) => s.recentModels);

  const groups = buildGroups(chats, workspaces, pinnedWorkspaces, pinnedChats);

  // Sidebar search: match chat title or any message content (case-insensitive).
  // While searching, groups keep their workspace context but only matching
  // chats are shown and empty groups are hidden.
  const searching = search.trim().length > 0;
  const matchesQuery = (chat: Chat, q: string): boolean => {
    const query = q.trim().toLowerCase();
    if (!query) return true;
    if ((chat.title || "").toLowerCase().includes(query)) return true;
    return chat.messages.some((m) => m.content.toLowerCase().includes(query));
  };
  const visibleGroups = searching
    ? groups
      .map((g) => ({
        ...g,
        chats: g.chats.filter((c) => matchesQuery(c, search)),
      }))
      .filter((g) => g.chats.length > 0)
    : groups;

  // Live plan checklist of the ACTIVE chat surfaced in the sidebar footer. Uses
  // the latest message that carries a non-empty plan; hidden only when no plan
  // exists. Completed items stay visible with ticks so the finished checklist
  // remains in view.
  const activeChat = chats.find((c) => c.id === activeChatId);
  const todos: ChatMessage["plan"] = [];
  if (activeChat) {
    for (let i = activeChat.messages.length - 1; i >= 0; i--) {
      const plan = activeChat.messages[i].plan;
      if (plan && plan.length > 0) {
        todos.push(...plan);
        break;
      }
    }
  }

  // Per-model token usage + cost for the active chat (session totals), grouped
  // by provider and sorted by most-recently-used first. Each used model is
  // attributed to a provider by matching its id/current model; ids that match
  // no provider (e.g. an old model after the user switched provider) land in a
  // dedicated "Unknown" group instead of being silently merged into the ACTIVE
  // provider — so a previous main model/provider always stays visible.
  // Gemini's API reports model ids with a literal "models/" prefix
  // ("models/gemini-3.7-flash"), which the backend strips before recording
  // usage (so usage keys are bare "gemini-3.7-flash"). Normalize the prefix
  // away on BOTH sides so a provider always matches the usage it actually ran
  // with the strong exact match instead of tying with openrouter's bare-name
  // match (its list carries "google/gemini-...") and losing on array order.
  const norm = (m: string): string => (m || "").replace(/^models\//, "");
  const bareId = (m: string): string => norm(m).split("/").pop() || m;
  const providerForModel = (model: string): ProviderConfig | undefined => {
    if (!model || model === "main") return undefined;
    const key = norm(model);
    const bare = bareId(model);
    const lower = key.toLowerCase();
    // The ALL-in-one `find` (bare-id first) misattributes a model to whichever
    // provider happens to be first in the array when two providers share a model
    // with the same last path segment (e.g. openrouter/free vs myprovider/free).
    // Resolve by decreasing specificity instead so the RIGHT provider wins.
    //
    // Many models are ALSO advertised by the opencode gateway's /models list
    // (it mirrors nearly every model), so a bare list match is too weak to
    // distinguish "ran via Google" from "listed by the opencode gateway". A
    // provider whose CURRENT configured model is the used one, or that the app
    // recently recorded actually running this model (recentModels), is a much
    // stronger signal and must outrank a plain list hit.
    const scoredBy = new Map<string, number>();
    const scoreOf = (p: ProviderConfig): number => {
      const cached = scoredBy.get(p.id);
      if (cached !== undefined) return cached;
      const pModel = norm(p.model || "");
      const pModels = (p.models ?? []).map(norm);
      const pId = (p.id || "").toLowerCase();
      const pName = (p.name || "").toLowerCase();
      let s = 0;
      // Recorded use: the app recently ran this exact model on this provider.
      if (
        recentModels.some((r) => r.providerId === p.id && norm(r.model) === key)
      )
        s = Math.max(s, 5);
      // Current configured model matches the used model.
      if (pModel === key) s = Math.max(s, 4);
      // Exact full model id in this provider's model list.
      if (pModels.includes(key)) s = Math.max(s, 3);
      // Provider id/name is a prefix of the model id.
      if (
        (pId && lower.startsWith(pId + "/")) ||
        (pName && lower.startsWith(pName + "/"))
      )
        s = Math.max(s, 2);
      // Weakest: bare-name match (last path segment) — only as a last resort.
      if (
        pModel === bare ||
        bareId(pModel) === bare ||
        pModels.some((m) => m === bare || bareId(m) === bare)
      )
        s = Math.max(s, 1);
      scoredBy.set(p.id, s);
      return s;
    };
    let best: ProviderConfig | undefined;
    let bestScore = 0;
    for (const p of allProviders) {
      const s = scoreOf(p);
      if (s < bestScore) continue;
      // Among equal scores prefer the ACTIVE provider (the one the user has
      // selected) over plain array order, so genuinely ambiguous ties land on
      // what the user currently sees rather than the first configured row.
      if (s > bestScore || (best && p.id === provider?.id)) {
        bestScore = s;
        best = p;
      }
    }
    return best;
  };
  const usageGroups = new Map<
    string,
    Array<{
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost: number | null;
      costFresh: number | null;
      costCached: number | null;
      lastUsed: number;
    }>
  >();
  if (activeChat?.usage) {
    for (const [model, u] of Object.entries(activeChat.usage)) {
      if (u.input + u.output <= 0) continue;
      const p = providerForModel(model);
      // Unmatched models (e.g. an old provider after the user switched) are
      // grouped under a name derived from the model id itself — never silently
      // merged into the ACTIVE provider and never hidden as a single "Unknown".
      const derived = (model.split("/")[0] || "unknown").trim() || "unknown";
      const key = p?.id ?? derived;
      const price = priceForModel(p?.pricingMap, model);
      // Cost bills cache-read/cache-write tokens at their own (cheaper) rate
      // when the provider advertises one — input_tokens already includes the
      // cache portion, so it must be split out before charging full input.
      const cacheRead = u.cacheRead ?? 0;
      const cacheWrite = u.cacheWrite ?? 0;
      const breakdown = computeUsageCostBreakdown(price, {
        input: u.input,
        output: u.output,
        cacheRead,
        cacheWrite,
      });
      const cost =
        breakdown?.total ??
        computeUsageCost(price, {
          input: u.input,
          output: u.output,
          cacheRead,
          cacheWrite,
        });
      const costFresh = breakdown?.fresh ?? null;
      const costCached = breakdown?.cached ?? null;
      if (!usageGroups.has(key)) usageGroups.set(key, []);
      usageGroups.get(key)!.push({
        model,
        input: u.input,
        output: u.output,
        cacheRead,
        cacheWrite,
        cost,
        costFresh,
        costCached,
        lastUsed: u.lastUsed ?? 0,
      });
    }
  }
  // Sort each provider group by total usage (heaviest first); ties by most
  // recently used so the freshest model wins when token counts are equal.
  for (const entries of usageGroups.values()) {
    entries.sort((a, b) => {
      const d = b.input + b.output - (a.input + a.output);
      if (d !== 0) return d;
      return (b.lastUsed ?? 0) - (a.lastUsed ?? 0);
    });
  }
  // Provider groups ordered by total usage (the biggest consumer on top);
  // ties by the group's most recently used model.
  const usageGroupOrder = [...usageGroups.entries()].sort((a, b) => {
    const aTotal = a[1].reduce((s, e) => s + e.input + e.output, 0);
    const bTotal = b[1].reduce((s, e) => s + e.input + e.output, 0);
    if (aTotal !== bTotal) return bTotal - aTotal;
    const aLast = Math.max(...a[1].map((e) => e.lastUsed ?? 0), 0);
    const bLast = Math.max(...b[1].map((e) => e.lastUsed ?? 0), 0);
    return bLast - aLast;
  });
  // Grand total across every provider group, shown right in the panel header
  // so the full session usage/cost is visible without expanding each group.
  let usageGrandTokens = 0;
  let usageGrandCached = 0;
  let usageGrandCost: number | null = null;
  let usageGrandCostFresh: number | null = null;
  let usageGrandCostCached: number | null = null;
  for (const [, entries] of usageGroupOrder) {
    for (const e of entries) {
      usageGrandTokens += e.input + e.output;
      usageGrandCached += e.cacheRead + e.cacheWrite;
      if (e.cost !== null) usageGrandCost = (usageGrandCost ?? 0) + e.cost;
      if (e.costFresh !== null)
        usageGrandCostFresh = (usageGrandCostFresh ?? 0) + e.costFresh;
      if (e.costCached !== null)
        usageGrandCostCached = (usageGrandCostCached ?? 0) + e.costCached;
    }
  }
  // Header shows TOTAL billed tokens (input + output) — the whole amount the
  // provider processed this session — with the cached portion called out
  // separately via the ⚡ badge. (Many sessions are cache-heavy, so showing
  // only the non-cached remainder as the main number read as "under-counted".)
  const usageGrandTotal = usageGrandTokens;
  // Tokens NOT served from the provider's prompt cache this turn/session —
  // the portion that was actually freshly processed (billed at the full,
  // non-cache rate). Shown next to the ⚡ cached badge as 🔥.
  const usageGrandFresh = Math.max(0, usageGrandTokens - usageGrandCached);

  const newWorkspace = async () => {
    const dir = await api.selectFolder();
    if (dir) useStore.getState().createWorkspace(dir);
  };

  const onDragStart = (e: React.DragEvent, key: string) => {
    setDragKey(key);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", key);
    } catch {
      /* ignore dataTransfer restrictions (rare) */
    }
  };

  const onDragOver = (e: React.DragEvent, key: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverKey(key);
  };

  const onDrop = (e: React.DragEvent, targetKey: string) => {
    e.preventDefault();
    const from =
      dragKey || (e.dataTransfer.getData("text/plain") as string) || "";
    setDragKey(null);
    setDragOverKey(null);
    if (!from || from === targetKey) return;
    const keys = groups.map((g) => g.key);
    const i = keys.indexOf(from);
    const j = keys.indexOf(targetKey);
    if (i === -1) return;
    keys.splice(i, 1);
    keys.splice(j, 0, from);
    useStore.getState().setWorkspaceOrder(keys);
  };

  const onDragEnd = () => {
    setDragKey(null);
    setDragOverKey(null);
  };

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const startRename = (chat: Chat) => {
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

  if (!open) return null;

  return (
    <aside
      className="sidebar"
      style={
        {
          flexBasis: sidebarWidth,
          width: sidebarWidth,
          "--sidebar-w": `${sidebarWidth}px`,
        } as React.CSSProperties
      }
    >
      <div
        className="sidebar-resize-handle"
        title="Drag to resize sidebar"
        onMouseDown={startSidebarResize}
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
            placeholder="Search chats…"
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

      <div className="sidebar-list">
        {colorOpen !== null && (
          <div className="color-backdrop" onClick={() => setColorOpen(null)} />
        )}
        {chats.length === 0 && (
          <div className="sidebar-empty">No conversations yet</div>
        )}
        {searching && chats.length > 0 && visibleGroups.length === 0 && (
          <div className="sidebar-empty">No chats match “{search.trim()}”</div>
        )}
        {searching && visibleGroups.length > 0 && (
          <div className="sidebar-result-count">
            {visibleGroups.reduce((n, g) => n + g.chats.length, 0)} chats found
          </div>
        )}
        {visibleGroups.map((g) => {
          const isCollapsed = collapsed.has(g.key) && !searching;
          const color = workspaceColors[g.key] || "var(--accent)";
          const isPinned = pinnedWorkspaces.includes(g.key);
          const selectedInGroup = g.chats.filter((c) =>
            selectedChats.has(c.id),
          ).length;
          return (
            <div
              key={g.key}
              className={`sidebar-group${isPinned ? " pinned" : ""} ws-colored${dragKey === g.key ? " dragging" : ""}${dragOverKey === g.key && dragKey && dragKey !== g.key ? " drop-target" : ""}`}
              style={{ "--ws": color } as React.CSSProperties}
              draggable
              onDragStart={(e) => onDragStart(e, g.key)}
              onDragOver={(e) => onDragOver(e, g.key)}
              onDrop={(e) => onDrop(e, g.key)}
              onDragEnd={onDragEnd}
            >
              <div className="sidebar-group-head">
                <button
                  className="sidebar-group-toggle"
                  onClick={() => toggleGroup(g.key)}
                  title={g.root || g.label}
                >
                  <svg
                    className={`sidebar-group-icon${isCollapsed ? " collapsed" : ""}`}
                    style={{ color }}
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill={isCollapsed ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth={isCollapsed ? 0 : 1.9}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {isCollapsed ? (
                      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
                    ) : (
                      <>
                        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
                        <path d="M2 9a2 2 0 0 1 2-2h7.5l2 2H21a2 2 0 0 1 2 2v1H2Z" />
                      </>
                    )}
                  </svg>
                  <span className="sidebar-group-label">{g.label}</span>
                </button>
                <div className="sidebar-group-actions">
                  <button
                    className="sidebar-group-btn"
                    title="New chat in this workspace"
                    aria-label="New chat in this workspace"
                    style={selectingWsKey === g.key ? { display: "none" } : undefined}
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
                  <div className="ws-menu-wrap" style={selectingWsKey === g.key ? { display: "none" } : undefined}>
                    <button
                      className="sidebar-group-btn"
                      title="Workspace options"
                      aria-label="Workspace options"
                      aria-expanded={wsMenuOpenKey === g.key}
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = wsMenuOpenKey === g.key ? null : g.key;
                        setWsMenuOpenKey(next);
                        if (next) {
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setWsMenuPos({ top: r.bottom + 6, left: r.right - 168 });
                        } else {
                          setWsMenuPos(null);
                        }
                      }}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <circle cx="12" cy="5" r="1.6" />
                        <circle cx="12" cy="12" r="1.6" />
                        <circle cx="12" cy="19" r="1.6" />
                      </svg>
                    </button>
                    {wsMenuOpenKey === g.key && wsMenuPos && (
                      <div
                        className="ws-menu"
                        role="menu"
                        style={{
                          position: "fixed",
                          top: wsMenuPos.top,
                          left: wsMenuPos.left,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
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
                          className="ws-menu-btn danger"
                          role="menuitem"
                          onClick={(e) => {
                            const btn = (e.currentTarget as HTMLElement)
                              .closest(".ws-menu-wrap")
                              ?.querySelector(".sidebar-group-btn") as HTMLElement | null;
                            const r = (btn ?? e.currentTarget).getBoundingClientRect();
                            setDeleteMenuPos({ top: r.bottom + 6, left: r.right - 180 });
                            setDeleteMenuKey(g.key);
                            setWsMenuOpenKey(null);
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                          </svg>
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {colorOpen === g.key && (
                  <div
                    className="color-popover"
                    onClick={(e) => e.stopPropagation()}
                  >
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
                )}
                {deleteMenuKey === g.key && deleteMenuPos && (
                  <div
                    className="ws-delete-menu-wrap"
                    style={{
                      position: "fixed",
                      top: deleteMenuPos.top,
                      left: deleteMenuPos.left,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="ws-delete-menu" role="menu">
                      <div className="ws-delete-menu-title">Delete…</div>
                      <button
                        className="ws-delete-menu-btn danger"
                        role="menuitem"
                        onClick={() => {
                          useStore.getState().deleteWorkspace(g.key);
                          setDeleteMenuKey(null);
                        }}
                      >
                        Delete workspace
                        <span style={{ opacity: 0.7, marginInlineStart: "auto", fontSize: 11 }}>
                          ({g.chats.length})
                        </span>
                      </button>
                      <button
                        className="ws-delete-menu-btn"
                        role="menuitem"
                        onClick={() => {
                          setSelectingWsKey(g.key);
                          setDeleteMenuKey(null);
                        }}
                      >
                        Delete chats
                        <span style={{ opacity: 0.7, marginInlineStart: "auto", fontSize: 11 }}>
                          ({g.chats.length})
                        </span>
                      </button>
                    </div>
                  </div>
                )}
                {selectingWsKey === g.key && (
                  <div className="group-bulk-actions">
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
                )}
              </div>
              {!isCollapsed && (
                <div
                  className="sidebar-group-chats"
                  style={
                    color
                      ? ({ "--ws": color } as React.CSSProperties)
                      : undefined
                  }
                >
                  {g.chats.map((c) => {
                    const isPinnedChat = pinnedChats.includes(c.id);
                    const hasStreaming = c.messages.some((m) => m.streaming);
                    const hasUnread =
                      !hasStreaming &&
                      c.id !== activeChatId &&
                      unreadChats.includes(c.id);
                    return (
                      <div
                        key={c.id}
                        className={`chat-item ${c.id === activeChatId ? "active" : ""}${isPinnedChat ? " pinned" : ""}${hasUnread ? " unread" : ""}${selectedChats.has(c.id) ? " selected" : ""}${selectingWsKey === g.key ? " selecting" : ""}`}
                        onClick={() => useStore.getState().setActiveChat(c.id)}
                        title={prepareContent(titleOf(c), dir)}
                      >
                        {selectingWsKey === g.key ? (
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
                        ) : (
                          <div
                            className={`chat-item-kebab-wrap${menuOpenId === c.id ? " open" : ""}`}
                          >
                          <button
                            className="chat-item-kebab"
                            title="Chat actions"
                            aria-label="Chat actions"
                            aria-expanded={menuOpenId === c.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenId(menuOpenId === c.id ? null : c.id);
                            }}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="currentColor"
                            >
                              <circle cx="12" cy="5" r="1.6" />
                              <circle cx="12" cy="12" r="1.6" />
                              <circle cx="12" cy="19" r="1.6" />
                            </svg>
                          </button>
                          <div
                            className={`chat-item-menu${menuOpenId === c.id ? " open" : ""}`}
                            role="menu"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              className={`chat-item-menu-btn${isPinnedChat ? " active" : ""}`}
                              role="menuitem"
                              onClick={() => {
                                useStore.getState().togglePinChat(c.id);
                                setMenuOpenId(null);
                              }}
                            >
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill={isPinnedChat ? "currentColor" : "none"}
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M12 17v5M5 7h14M7 7l1-4h8l1 4M8 7v4l-2 3h12l-2-3V7" />
                              </svg>
                              {isPinnedChat ? "Unpin" : "Pin to top"}
                            </button>
                            <button
                              className="chat-item-menu-btn"
                              role="menuitem"
                              onClick={() => {
                                startRename(c);
                                setMenuOpenId(null);
                              }}
                            >
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                              </svg>
                              Rename
                            </button>
                            <button
                              className="chat-item-menu-btn danger"
                              role="menuitem"
                              onClick={() => {
                                setSelectingWsKey(g.key);
                                setSelectedChats(new Set([c.id]));
                                setMenuOpenId(null);
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
                                <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                              </svg>
                              Delete
                            </button>
                          </div>
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
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        {todos.length > 0 && (
          <div
            className={`sidebar-panel ${todoCollapsed ? "collapsed" : ""}`}
            dir={dir}
          >
            <div
              className="sidebar-panel-head"
              onClick={() => setTodoCollapsed((v) => !v)}
              title={todoCollapsed ? "Expand Todos" : "Collapse Todos"}
            >
              <span className="sidebar-panel-chevron">
                {todoCollapsed ? "▸" : "▾"}
              </span>
              <span className="sidebar-panel-title">Todos</span>
              <span className="sidebar-panel-count">
                {todos.filter((t) => t.status === "completed").length}/
                {todos.length}
              </span>
            </div>
            {!todoCollapsed && (
              <>
                <div
                  className="sidebar-panel-resize"
                  title="Drag up to grow, down to shrink"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    todoDrag.current = {
                      startY: e.clientY,
                      startH: todoHeight,
                    };
                    const onMove = (ev: MouseEvent) => {
                      if (!todoDrag.current) return;
                      setTodoHeight(
                        Math.max(
                          60,
                          Math.min(
                            760,
                            todoDrag.current.startH -
                            (ev.clientY - todoDrag.current.startY),
                          ),
                        ),
                      );
                    };
                    const onUp = () => {
                      todoDrag.current = null;
                      window.removeEventListener("mousemove", onMove);
                      window.removeEventListener("mouseup", onUp);
                    };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                  }}
                />
                <ul
                  className="sidebar-todos-list"
                  style={{ maxHeight: todoHeight }}
                >
                  {todos.map((t, i) => (
                    <li
                      key={i}
                      className={`sidebar-todo-item ${t.status === "completed" ? "done" : t.status === "in_progress" ? "running" : ""}`}
                    >
                      <span className="sidebar-todo-mark">
                        {t.status === "completed"
                          ? "✓"
                          : t.status === "in_progress"
                            ? "●"
                            : "○"}
                      </span>
                      <span className="sidebar-todo-content">
                        {prepareContent(t.content, dir)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {usageGroups.size > 0 && (
          <div
            className={`sidebar-panel ${usageCollapsed ? "collapsed" : ""}`}
            dir="ltr"
          >
            <div
              className="sidebar-panel-head"
              onClick={() => setUsageCollapsed((v) => !v)}
              title={
                usageCollapsed ? "Expand Model usage" : "Collapse Model usage"
              }
            >
              <span
                className="sidebar-usage-grand-total"
                title={[
                  "Total billed tokens (input + output) this session",
                  usageGrandFresh > 0
                    ? `Fresh (non-cached): ${formatTokens(usageGrandFresh)} tokens${usageGrandCostFresh !== null ? ` · ${formatCost(usageGrandCostFresh)}` : ""}`
                    : "",
                  usageGrandCached > 0
                    ? `Cached: ${formatTokens(usageGrandCached)} tokens${usageGrandCostCached !== null ? ` · ${formatCost(usageGrandCostCached)}` : ""}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                {formatTokens(usageGrandTotal)}
                {usageGrandCached > 0 && (
                  <span className="sidebar-usage-grand-cache">
                    {" "}
                    · ⚡{formatTokens(usageGrandCached)}
                  </span>
                )}
                {usageGrandCost !== null && (
                  <span className="sidebar-usage-grand-cost">
                    {" "}
                    · {formatCost(usageGrandCost)}
                  </span>
                )}
              </span>
              <button
                className="sidebar-usage-reset"
                title="Reset all model usage to zero"
                onClick={(e) => {
                  e.stopPropagation();
                  if (
                    window.confirm(
                      "Reset token usage and cost for all models in this chat?",
                    )
                  ) {
                    useStore.getState().resetChatUsage(activeChatId);
                  }
                }}
              >
                ↺
              </button>
            </div>
            {!usageCollapsed && (
              <>
                <div
                  className="sidebar-panel-resize"
                  title="Drag up to grow, down to shrink"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    usageDrag.current = {
                      startY: e.clientY,
                      startH: usageHeight,
                    };
                    const onMove = (ev: MouseEvent) => {
                      if (!usageDrag.current) return;
                      // No fixed cap: the panel can grow as tall as the window
                      // allows (minus room for the sidebar header + footer).
                      setUsageHeight(
                        Math.max(
                          60,
                          Math.min(
                            window.innerHeight - 140,
                            usageDrag.current.startH -
                            (ev.clientY - usageDrag.current.startY),
                          ),
                        ),
                      );
                    };
                    const onUp = () => {
                      usageDrag.current = null;
                      window.removeEventListener("mousemove", onMove);
                      window.removeEventListener("mouseup", onUp);
                    };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                  }}
                />
                <div
                  className="sidebar-usage-groups"
                  style={{ maxHeight: usageHeight }}
                >
                  {usageGroupOrder.map(([pid, entries]) => {
                    const pcfg = allProviders.find((p) => p.id === pid) ?? null;
                    // Inverted: a group is open unless the user explicitly closed it,
                    // so every provider starts expanded by default.
                    const open = !usageGroupsClosed.has(pid);
                    const groupTokens = entries.reduce(
                      (s, e) => s + e.input + e.output,
                      0,
                    );
                    const groupCached = entries.reduce(
                      (s, e) => s + e.cacheRead + e.cacheWrite,
                      0,
                    );
                    // Fresh (non-cached) tokens — shown as the 🔥 badge, NOT as the main
                    // number (the main number is the group's TOTAL billed tokens, same
                    // basis as the header and the per-model rows below).
                    const groupFresh = Math.max(0, groupTokens - groupCached);
                    const groupCost = entries.reduce<number | null>((s, e) => {
                      if (e.cost === null) return s;
                      return (s ?? 0) + e.cost;
                    }, null);
                    const groupCostFresh = entries.reduce<number | null>(
                      (s, e) => {
                        if (e.costFresh === null) return s;
                        return (s ?? 0) + e.costFresh;
                      },
                      null,
                    );
                    const groupCostCached = entries.reduce<number | null>(
                      (s, e) => {
                        if (e.costCached === null) return s;
                        return (s ?? 0) + e.costCached;
                      },
                      null,
                    );
                    const groupTitle = [
                      "Total billed tokens (input + output) this provider",
                      groupFresh > 0
                        ? `Fresh (non-cached): ${formatTokens(groupFresh)} tokens${groupCostFresh !== null ? ` · ${formatCost(groupCostFresh)}` : ""}`
                        : "",
                      groupCached > 0
                        ? `Cached: ${formatTokens(groupCached)} tokens${groupCostCached !== null ? ` · ${formatCost(groupCostCached)}` : ""}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <div
                        key={pid}
                        className={`sidebar-usage-group${open ? " open" : ""}`}
                      >
                        <div
                          className="sidebar-usage-group-head"
                          onClick={() =>
                            setUsageGroupsClosed((prev) => {
                              const next = new Set(prev);
                              if (next.has(pid)) next.delete(pid);
                              else next.add(pid);
                              return next;
                            })
                          }
                        >
                          <span className="sidebar-panel-chevron small">
                            {open ? "▾" : "▸"}
                          </span>
                          <span
                            className="sidebar-usage-group-dot"
                            aria-hidden
                          />
                          <span className="sidebar-usage-group-name">
                            {pcfg?.name ?? pid}
                          </span>
                          <span
                            className="sidebar-usage-group-total"
                            title={groupTitle}
                          >
                            {formatTokens(groupTokens)}
                            {groupCached > 0 && (
                              <span className="sidebar-usage-cache">
                                {" "}
                                · ⚡{formatTokens(groupCached)}
                              </span>
                            )}
                            {groupCost !== null && (
                              <span className="sidebar-usage-cost">
                                {" "}
                                · {formatCost(groupCost)}
                              </span>
                            )}
                          </span>
                        </div>
                        {open && (
                          <ul className="sidebar-usage-list">
                            <li className="sidebar-usage-head" aria-hidden>
                              <span>Model</span>
                              <span>Tokens</span>
                              <span>Cost</span>
                            </li>
                            {entries.map(
                              ({
                                model,
                                input,
                                output,
                                cacheRead,
                                cacheWrite,
                                cost,
                                costFresh,
                                costCached,
                              }) => {
                                const cached = cacheRead + cacheWrite;
                                const total = input + output;
                                const fresh = Math.max(0, total - cached);
                                const itemTitle = [
                                  fresh > 0
                                    ? `Fresh (non-cached): ${formatTokens(fresh)} tokens${costFresh !== null ? ` · ${formatCost(costFresh)}` : ""}`
                                    : "",
                                  cached > 0
                                    ? `Cached: ${formatTokens(cached)} tokens${costCached !== null ? ` · ${formatCost(costCached)}` : ""}`
                                    : "",
                                ]
                                  .filter(Boolean)
                                  .join(" · ");
                                return (
                                  <li
                                    key={model}
                                    className="sidebar-usage-item"
                                  >
                                    <span
                                      className="sidebar-usage-model"
                                      title={model}
                                    >
                                      {model ? model.split("/").pop() : "main"}
                                    </span>
                                    <span
                                      className="sidebar-usage-tokens"
                                      title={itemTitle || undefined}
                                    >
                                      {formatTokens(total)}
                                      {cached > 0 && (
                                        <span className="sidebar-usage-breakdown">
                                          <span className="sidebar-usage-fresh">
                                            🔥 {formatTokens(fresh)}
                                          </span>
                                          <span className="sidebar-usage-cache">
                                            ⚡ {formatTokens(cached)}
                                          </span>
                                        </span>
                                      )}
                                    </span>
                                    <span
                                      className={`sidebar-usage-cost${cost === null ? " no-price" : ""}`}
                                      title={itemTitle || undefined}
                                    >
                                      {cost !== null ? formatCost(cost) : "—"}
                                    </span>
                                  </li>
                                );
                              },
                            )}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
        <button
          className="sidebar-foot-btn"
          title="Settings (⌘,)"
          onClick={() => useStore.getState().setSettingsOpen(true)}
        >
          ⚙️
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
