/**
 * File explorer for the right side pane: a lazy workspace tree.
 *
 * Only ONE directory level is read at a time (`api.fsList(root, rel)`), so a
 * huge repository costs nothing until a folder is actually opened. The
 * bookkeeping (merge/toggle/flatten) lives in src/lib/fileTree.ts; this
 * component only fetches a level and renders `flattenTree` rows.
 *
 * Rows are editable in place: right-click opens copy / rename / delete, and a
 * row dragged onto a folder moves into it. Every mutation goes through the
 * same path — run it, then re-read the tree from disk, never guess.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../lib/store";
import { api, workspaceFiles } from "../lib/fs";
import { FolderIcon } from "./MacAppIcons";
import { FileIcon } from "./FileIcon";
import { useViewerTabs } from "../lib/viewerTabs";
import { ChatRenameInput } from "./ChatRenameInput";
import { menuLeft, menuTop } from "../lib/tabBar";
import { physicalKey } from "../lib/shortcuts";
import {
  copyName,
  flattenTree,
  isLoaded,
  joinPath,
  mergeChildren,
  moveTarget,
  parentPath,
  pruneSubtree,
  toggleExpanded,
  ancestorDirs,
  filterRows,
  nextFilterIndex,
  type TreeCache,
} from "../lib/fileTree";

/** State of the explorer's right-click menu. `confirming` is the second step
 *  of Delete: the menu asks before touching the disk (no native dialog, which
 *  the webview does not reliably show). */
interface MenuState {
  /** Workspace-relative path of the row that was right-clicked. */
  path: string;
  kind: "file" | "dir" | "link";
  /** Viewport coordinates of the cursor the menu opens at. */
  x: number;
  y: number;
  confirming: boolean;
}

/** Chevron for folder rows; `open` rotates it via CSS. */
function TreeChevron({ open }: { open: boolean }) {
  return (
    <span className={"files-chevron" + (open ? " open" : "")} aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </span>
  );
}

/** The glyphs the context menu reuses; 13px like the other menu icons. */
const MENU_ICON = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function CopyIcon() {
  return (
    <svg {...MENU_ICON}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg {...MENU_ICON}>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M14.5 6.5l3 3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...MENU_ICON}>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** Header filter controls, same 13px glyph set as the context menu. */
function SearchIcon() {
  return (
    <svg {...MENU_ICON}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...MENU_ICON}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Human message from anything a rejection can carry: Tauri rejects with the
 *  plain string the command returned, JS throws Error. */
function errText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Shared empty value for the store's per-chat folder set: a stable identity
 *  so a chat with nothing open never re-renders on every store write. */
const EMPTY_DIRS: readonly string[] = [];

export function FilesPanel({ chatId }: { chatId?: string }) {
  // The explorer belongs to a chat: its root follows the owning chat so split
  // panes showing two chats never mirror each other's tree.
  const ownerChatId = chatId;
  const activeChatId = useStore((s) => s.activeChatId);
  const root = useStore(
    (s) => s.chats.find((c) => c.id === (ownerChatId ?? s.activeChatId))?.root ?? s.root,
  );

  const [cache, setCache] = useState<TreeCache>({});
  // Open folders live in the store, keyed by chat: the rail mounts only the
  // ACTIVE tab, so switching to a file and back remounted this panel blank and
  // collapsed every folder the user had opened. The store survives the remount.
  //
  // The explorer tab is GLOBAL (no `chatId`), so the key is resolved here to the
  // effective chat — read and write must use the SAME key, or the panel would
  // persist folders under one chat and look them up under another (which read
  // back as "every folder closed").
  const treeChatId = ownerChatId ?? activeChatId;
  const expandedList = useViewerTabs((s) => s.expandedByChat[treeChatId] ?? EMPTY_DIRS);
  const expandedByChat = useViewerTabs((s) => s.expandedByChat);
  const setExpandedDirs = useViewerTabs((s) => s.setExpandedDirs);
  const expanded = useMemo(() => new Set(expandedList), [expandedList]);
  const setExpanded = useCallback(
    (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
      setExpandedDirs(treeChatId, [...fn(expanded)]);
    },
    [setExpandedDirs, treeChatId, expanded],
  );
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set<string>());
  // A failed read replaces the tree (there is nothing else to show); a failed
  // MUTATION only adds a strip above it — blanking the tree on a refused move
  // would hide the very rows the user was working with.
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Bumped on every root change; an in-flight listing from the previous root
  // checks it before writing, so a slow fetch can't populate the wrong tree.
  const genRef = useRef(0);
  // Right-click menu (copy / rename / delete) and the row being renamed.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Drag & drop: the row being dragged and the folder it currently hovers.
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  // Name filter (Ctrl/Cmd+F): null = off, otherwise the live query. It HIDES
  // rows without touching `expanded`, so the plain tree is back the moment the
  // filter clears — and folder chains on the way to a hit auto-open.
  const [filter, setFilter] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const filterOpen = filter !== null;
  // The full workspace path list (`fs_walk`), used by the filter so a deep
  // folder/file the lazy tree never loaded is still findable by name.
  const [walked, setWalked] = useState<readonly string[]>([]);
  // File the header asked to reveal (see `revealFile` in the viewer store): it
  // is highlighted and its folder chain is opened, so the row is on screen.
  const [revealed, setRevealed] = useState<string | null>(null);
  // Keyboard-highlighted row while the filter is active (Ctrl+K/J navigation).
  const [filterIdx, setFilterIdx] = useState(0);
  const filterRowRef = useRef<HTMLButtonElement>(null);
  // The row the file header asked to reveal; scrolled into view once.
  const revealRowRef = useRef<HTMLButtonElement>(null);
  // Reading the cache from a menu/mutation callback must not go through a
  // stale closure: those callbacks are created once per render, the menu lives
  // on until the user picks something.
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  // Same reason as `cacheRef`: the reveal effect runs ONCE per request (its
  // dependency is the request alone), so it must read the CURRENT open folders
  // without re-running when the user opens or closes one — otherwise folding a
  // folder on the revealed file's path was undone by the effect reopening it.
  const expandedRef = useRef<ReadonlySet<string>>(expanded);
  expandedRef.current = expanded;

  /** Read ONE level. `quiet` swallows a failure: after a rename/delete the
   *  level we cached under the OLD path is expected to be gone, and reporting
   *  that as the panel's error would blank the tree for a successful edit. */
  const loadDir = useCallback(
    async (dir: string, gen: number, quiet = false) => {
      if (!root) return;
      setLoading((prev) => new Set(prev).add(dir));
      try {
        const entries = await api.fsList(root, dir);
        if (gen !== genRef.current) return;
        setCache((prev) => mergeChildren(prev, dir, entries));
        if (!quiet) setError(null);
      } catch {
        if (gen !== genRef.current) return;
        // A failed read must stay OUT of the cache: caching it as empty would
        // render as a genuinely empty folder and never retry.
        if (!quiet) setError(dir ? `Could not read ${dir}` : "Could not read the workspace folder");
      } finally {
        if (gen === genRef.current) {
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(dir);
            return next;
          });
        }
      }
    },
    [root],
  );

  // New root (or first mount): the cache is per-mount, so it always starts
  // empty — but the chat's OPEN FOLDERS survive in the store, and every one of
  // them must be re-read from disk here or a folder the user had opened comes
  // back as an empty row (its children were never fetched). Switching from a
  // file tab back to the explorer therefore restores the exact same tree.
  useEffect(() => {
    genRef.current += 1;
    const gen = genRef.current;
    setCache({});
    setLoading(new Set<string>());
    setError(null);
    setActionError(null);
    setMenu(null);
    setDragPath(null);
    setDropDir(null);
    if (!root) return;
    // A stale open folder from ANOTHER root would read the wrong project, so
    // the level is dropped when its parent directory no longer matches. The
    // set itself is left alone: same-root remounts keep every open folder.
    const open = expandedByChat[treeChatId] ?? [];
    for (const dir of open) void loadDir(dir, gen, true);
    void loadDir("", gen);
    // `expandedByChat` is read as a snapshot on purpose: this effect restores
    // state for a root/chat change, not for every folder toggle afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, loadDir]);

  const toggleDir = useCallback(
    (dir: string) => {
      const opening = !expanded.has(dir);
      setExpanded((prev) => toggleExpanded(prev, dir));
      if (opening && !isLoaded(cache, dir)) void loadDir(dir, genRef.current);
      // Collapsing forgets the children: reopening re-reads from disk, so a
      // folder that changed underneath the panel is never shown stale.
      if (!opening) setCache((prev) => pruneSubtree(prev, dir));
    },
    [cache, expanded, loadDir],
  );

  /** Re-read every directory that is currently loaded, keeping the expanded
   *  set — a refresh must not collapse the tree under the user. Called after
   *  every mutation (rename, copy, move, delete) so the tree reflects disk. */
  const refreshTree = useCallback(() => {
    genRef.current += 1;
    const gen = genRef.current;
    const dirs = Object.keys(cacheRef.current);
    setCache({});
    setError(null);
    void Promise.all(dirs.map((d) => loadDir(d, gen, true)));
  }, [loadDir]);

  /** Run one filesystem mutation and re-read the tree afterwards. Every
   *  failure is surfaced as the panel's action strip instead of an unhandled
   *  rejection: a refused move (destination exists, folder into itself) is a
   *  normal outcome the user must be told about, not a crash. */
  const mutate = useCallback(
    async (op: () => Promise<boolean>, label: string) => {
      setMenu(null);
      try {
        const ok = await op();
        setActionError(ok ? null : label);
      } catch (err) {
        setActionError(`${label}: ${errText(err)}`);
      } finally {
        refreshTree();
      }
    },
    [refreshTree],
  );

  // Close the context menu on any click outside it, Escape, or a scroll/resize
  // (its position is viewport-fixed, so it must not stay glued to a stale spot).
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // A right-click on another row closes this menu on mousedown and reopens
      // it on contextmenu, which is exactly the wanted swap.
      if (!t.closest(".files-ctx-menu")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onScroll = () => setMenu(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  // The menu opens at the cursor and must stay fully inside the viewport, so it
  // is measured once rendered and nudged back in (same rule as the rail menus).
  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    const left = menuLeft(menu.x, r.width, window.innerWidth);
    const top = menuTop(menu.y, r.height, window.innerHeight, 8);
    if (left !== menu.x || top !== menu.y) setMenu((m) => (m ? { ...m, x: left, y: top } : m));
  }, [menu]);

  /** Clear the filter: drop the query, give the head its title back. */
  const closeFilter = useCallback(() => {
    setFilter(null);
    setMenu(null);
  }, []);

  // The box mounts via Ctrl/Cmd+F (or the filter button) and must grab focus —
  // an effect, because the ref is null until the render that mounts it commits.
  useEffect(() => {
    if (filterOpen) filterRef.current?.focus();
  }, [filterOpen]);

  // Ctrl/Cmd+F routed through the viewer store: the app-wide handler activates
  // the explorer tab (an open file, Git or todos may have been showing) and
  // bumps `filesFilterFocusAt`. Consuming the counter here is what opens AND
  // focuses the box, so the shortcut works no matter which rail tab was up.
  const filterFocusAt = useViewerTabs((s) => s.filesFilterFocusAt);
  useEffect(() => {
    if (filterFocusAt === 0) return;
    setFilter((prev) => (prev === null ? "" : prev));
    // The input mounts on the render this schedule, so focus after the commit.
    requestAnimationFrame(() => filterRef.current?.focus());
  }, [filterFocusAt]);

  // Panel-scoped Ctrl/Cmd+F: focus the filter box. Strictly containment-gated
  // (same guard style as the split-pane chords): a find pressed inside a
  // dialog, the search overlay or the terminal — or with focus in another
  // pane's document, which runs its OWN in-viewer search — is not ours. When
  // NO rail surface holds focus (the composer, the transcript) the app-wide
  // handler covers it by activating this tab, so only the in-panel case is
  // handled here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Another handler already claimed this find (the file viewer's in-document
      // search runs on the same node when a split view shows both panes).
      if (e.defaultPrevented) return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (physicalKey(e) !== "f") return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.(".files-panel")) return;
      e.preventDefault();
      e.stopPropagation();
      setFilter((prev) => (prev === null ? "" : prev));
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  /** Copy a row next to itself under a free "… copy" name: the explorer has no
   *  clipboard, and duplicating in place is what the action is for. */
  const copyRow = useCallback(
    async (path: string) => {
      const dir = parentPath(path);
      const name = path.slice(path.lastIndexOf("/") + 1);
      const taken = new Set((cacheRef.current[dir] ?? []).map((e) => e.name));
      await mutate(
        () => api.fsCopy(root, path, joinPath(dir, copyName(name, taken))),
        "Could not copy",
      );
    },
    [root, mutate],
  );

  const renameRow = useCallback(
    async (path: string, nextName: string) => {
      setRenaming(null);
      const name = nextName.trim();
      // A no-op rename (or an empty one) must not touch the disk.
      if (!name || name === path.slice(path.lastIndexOf("/") + 1)) return;
      await mutate(() => api.fsRename(root, path, joinPath(parentPath(path), name)), "Could not rename");
    },
    [root, mutate],
  );

  const deleteRow = useCallback(
    async (path: string) => {
      await mutate(() => api.fsDelete(root, path), "Could not delete");
    },
    [root, mutate],
  );

  /** Move a dragged row into a folder (drag & drop). `ontoDir` is the folder
   *  the row was dropped on, '' meaning the workspace root. */
  const moveRow = useCallback(
    async (from: string, ontoDir: string) => {
      setDropDir(null);
      const dir = moveTarget(from, ontoDir);
      if (dir === null) return;
      const name = from.slice(from.lastIndexOf("/") + 1);
      await mutate(() => api.fsRename(root, from, joinPath(dir, name)), "Could not move");
      // Reveal the destination: an entry dropped into a closed folder would
      // otherwise seem to vanish (the folder stays collapsed).
      if (dir) {
        setExpanded((prev) => (prev.has(dir) ? prev : toggleExpanded(prev, dir)));
        void loadDir(dir, genRef.current, true);
      }
    },
    [root, mutate, loadDir],
  );

  // The full path list behind the filter: `workspaceFiles` caches a `fs_walk`
  // result for a few seconds, so opening the box (or typing in it) does not
  // re-walk the tree. Only fetched while the filter is actually open.
  useEffect(() => {
    if (!filterOpen || !root) return;
    let cancelled = false;
    void workspaceFiles(root).then((files) => {
      if (!cancelled) setWalked(files.map((f) => f.rel));
    });
    return () => {
      cancelled = true;
    };
  }, [filterOpen, root]);

  const plainRows = flattenTree(cache, expanded);
  const query = (filter ?? "").trim();
  // With a query the lazy tree is swapped for the matches: `filterRows` walks
  // every LOADED level and auto-opens the chain to each hit (laziness intact —
  // unread folders simply have nothing to search yet). The `walked` path list
  // extends that beyond the cache, so a deep folder/file is findable too.
  const rows = query ? filterRows(cache, query, walked) : plainRows;
  const rootLoaded = isLoaded(cache, "");
  const busy = loading.has("");

  // Every new query restarts the keyboard highlight at the first hit; a query
  // that shrinks the result list pulls a stale index back in range.
  useEffect(() => {
    setFilterIdx((prev) => (prev < rows.length ? prev : 0));
  }, [query, rows.length]);

  // Keep the Ctrl+K/J-highlighted row in view while the filter navigates.
  useEffect(() => {
    if (filterOpen) filterRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [filterOpen, filterIdx]);

  // Reveal request from a file header: open every ancestor folder (loading the
  // levels that were never read) and highlight the file's own row.
  const revealAt = useViewerTabs((s) => s.filesReveal);
  useEffect(() => {
    if (!revealAt || !root) return;
    // Only the chat that owns the request reveals it: a split pane in another
    // chat must not jump its tree to a file it never asked about.
    if (revealAt.chatId && revealAt.chatId !== (ownerChatId ?? useStore.getState().activeChatId)) return;
    const rel = revealAt.path;
    const chain = ancestorDirs(rel);
    // Snapshot of the open folders: a fold made by the user while this file is
    // revealed must STICK, so the effect never depends on `expanded`.
    const open = expandedRef.current;
    // The chain is opened, plus any ancestor the request does not name but the
    // chat already had open. Already-open folders are dropped before writing,
    // so revealing a second time does not rewrite an identical set.
    const next = [...new Set([...chain, ...open])].sort();
    if (next.length !== open.size || next.some((d, i) => !open.has(d) || i !== next.indexOf(d))) {
      setExpandedDirs(treeChatId, next);
    }
    // Every folder that is open must have its level loaded, or it renders as an
    // empty row — the remount case above, and the first reveal after a switch.
    const gen = genRef.current;
    for (const d of next) if (!isLoaded(cacheRef.current, d)) void loadDir(d, gen, true);
    setRevealed(rel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealAt, root, treeChatId, setExpandedDirs, loadDir]);

  // The revealed row may mount a beat after the reveal request (its folder
  // level is still loading), so scroll once it actually exists.
  useEffect(() => {
    if (revealed) revealRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [revealed, plainRows]);

  return (
    <div className="files-panel" dir="ltr">
      <div className="files-panel-head">
        {filterOpen ? (
          <div className="files-filter" role="search">
            <input
              ref={filterRef}
              className="files-filter-input"
              dir="auto"
              type="text"
              placeholder="Filter by name…"
              value={filter ?? ""}
              spellCheck={false}
              aria-label="Filter the file tree by name"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  closeFilter();
                } else if (e.key === "Enter") {
                  // Open the highlighted hit — a file directly, a folder by
                  // loading it (its level joins the cached tree the filter
                  // searches).
                  const hit = rows[filterIdx] ?? rows[0];
                  if (!hit) return;
                  if (hit.kind === "dir") toggleDir(hit.path);
                  else {
                    void useViewerTabs.getState().openFile(hit.path, undefined, root, ownerChatId);
                    closeFilter();
                  }
                } else if (
                  (e.ctrlKey || e.metaKey) &&
                  !e.shiftKey &&
                  !e.altKey &&
                  (physicalKey(e) === "k" || physicalKey(e) === "j")
                ) {
                  // Neovim-style Ctrl+K (up) / Ctrl+J (down) over the matches,
                  // wrapping at both ends.
                  e.preventDefault();
                  e.stopPropagation();
                  const delta = physicalKey(e) === "k" ? -1 : 1;
                  setFilterIdx((prev) => nextFilterIndex(prev, delta, rows.length));
                }
              }}
            />
            <button
              type="button"
              className="files-panel-action"
              title="Clear filter (Esc)"
              aria-label="Clear the filter"
              onClick={closeFilter}
            >
              <CloseIcon />
            </button>
          </div>
        ) : (
          <span className="files-panel-title">Files</span>
        )}
        <button
          className="files-panel-action"
          title="Filter files (Ctrl+F / Cmd+F)"
          aria-label="Filter files by name"
          aria-pressed={filterOpen}
          disabled={!root}
          onClick={() => setFilter((prev) => (prev === null ? "" : null))}
        >
          <SearchIcon />
        </button>
        <button
          className="files-panel-action"
          title="Refresh"
          aria-label="Refresh the file tree"
          disabled={!root}
          onClick={refreshTree}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
          </svg>
        </button>
      </div>

      {actionError ? (
        <div className="files-panel-error" role="alert">
          {actionError}
        </div>
      ) : null}

      {!root ? (
        <div className="viewer-empty">
          No workspace folder is open for this chat. Open one from the chat header
          to browse its files here.
        </div>
      ) : error ? (
        <div className="viewer-empty">{error}</div>
      ) : rows.length === 0 ? (
        query && rootLoaded && !busy ? (
          <div className="viewer-empty">No name matches “{query}” in the loaded folders.</div>
        ) : (
          <div className="viewer-empty">
            {rootLoaded && !busy ? "This folder is empty." : "Reading the workspace…"}
          </div>
        )
      ) : (
        <div
          className="files-list"
          // The empty space past the rows drops into the workspace root.
          onDragOver={(e) => {
            if (!dragPath || moveTarget(dragPath, "") === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropDir("");
          }}
          onDragLeave={(e) => {
            // Only a leave of the LIST itself clears the root highlight; a
            // leave that lands on a row belongs to that row.
            if (e.target === e.currentTarget) setDropDir((prev) => (prev === "" ? null : prev));
          }}
          onDrop={(e) => {
            if (!dragPath) return;
            e.preventDefault();
            const from = e.dataTransfer.getData("text/plain") || dragPath;
            void moveRow(from, "");
            setDragPath(null);
          }}
        >
          {rows.map((row, pos) => {
            const isDir = row.kind === "dir";
            const indent = { paddingLeft: 6 + row.depth * 13 };
            // Two independent highlights: the filter's Ctrl+K/J cursor, and the
            // row a file header asked to reveal (kept until another reveal).
            const filterActive = query ? pos === filterIdx : false;
            const revealActive = revealed === row.path;
            const active = filterActive || revealActive;

            // Renaming swaps the row's button for a plain row: an <input> can
            // never live inside a <button>, and the click-to-open handler must
            // stay out of the way while the name is edited.
            if (renaming === row.path) {
              return (
                <div key={row.path} className="files-row files-row-renaming" style={indent}>
                  <span className="files-row-caret" />
                  <span className="files-row-icon">
                    {isDir ? <FolderIcon /> : <FileIcon path={row.path} size={16} />}
                  </span>
                  <ChatRenameInput
                    initialValue={row.name}
                    className="files-rename-input"
                    ariaLabel={`Rename ${row.name}`}
                    onCommit={(value) => void renameRow(row.path, value)}
                    onCancel={() => setRenaming(null)}
                  />
                </div>
              );
            }

            return (
              <button
                key={row.path}
                ref={filterActive ? filterRowRef : revealActive ? revealRowRef : undefined}
                className={
                  "files-row" +
                  (isDir ? " files-row-dir" : "") +
                  (active ? " files-row-active" : "") +
                  (dropDir === row.path ? " files-row-drop" : "") +
                  (dragPath === row.path ? " files-row-dragging" : "")
                }
                // Indentation is per-level, so the tree reads as a hierarchy
                // without any nested DOM (flat rows keep scrolling cheap).
                style={indent}
                title={row.path}
                aria-expanded={isDir ? row.expanded : undefined}
                draggable
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    path: row.path,
                    kind: row.kind,
                    x: e.clientX,
                    y: e.clientY,
                    confirming: false,
                  });
                }}
                onClick={() => {
                  if (isDir) {
                    toggleDir(row.path);
                    return;
                  }
                  // Explicit root + chatId: the tab must belong to THIS chat's
                  // tree, not to whichever chat happens to be focused.
                  useViewerTabs.getState().openFile(row.path, undefined, root, ownerChatId);
                }}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", row.path);
                  setDragPath(row.path);
                  setMenu(null);
                }}
                onDragEnd={() => {
                  setDragPath(null);
                  setDropDir(null);
                }}
                onDragOver={(e) => {
                  // Only a FOLDER accepts a drop, and only a move that would
                  // really change something: dropping onto a file, onto the
                  // row's own folder, or into the dragged folder itself must
                  // not light up as if it were going to work.
                  if (!isDir || !dragPath) return;
                  if (moveTarget(dragPath, row.path) === null) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  setDropDir(row.path);
                }}
                onDragLeave={() => {
                  setDropDir((prev) => (prev === row.path ? null : prev));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  // The list container also accepts drops (the workspace root):
                  // a drop handled here must not be handled twice.
                  e.stopPropagation();
                  const from = e.dataTransfer.getData("text/plain") || dragPath || "";
                  if (from) void moveRow(from, row.path);
                  setDragPath(null);
                }}
              >
                <span className="files-row-caret">
                  {isDir && row.expandable ? <TreeChevron open={row.expanded} /> : null}
                </span>
                <span className="files-row-icon">
                  {isDir ? <FolderIcon /> : <FileIcon path={row.path} size={16} />}
                </span>
                <span className="files-row-name">{row.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Portalled: the panel clips its overflow, a cursor-anchored menu must
          not be clipped with it. */}
      {menu
        ? createPortal(
            <div
              ref={menuRef}
              className="ws-menu files-ctx-menu"
              role="menu"
              style={{ position: "fixed", top: menu.y, left: menu.x }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              {menu.confirming ? (
                <>
                  <div className="files-ctx-confirm">
                    Delete {menu.kind === "dir" ? "this folder" : "this file"}?
                    <span className="files-ctx-path">{menu.path}</span>
                  </div>
                  <div className="files-ctx-actions">
                    <button
                      type="button"
                      className="ws-menu-btn danger"
                      onClick={() => void deleteRow(menu.path)}
                    >
                      Delete
                    </button>
                    <button type="button" className="ws-menu-btn" onClick={() => setMenu(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ws-menu-btn"
                    role="menuitem"
                    onClick={() => void copyRow(menu.path)}
                  >
                    <CopyIcon />
                    Copy
                  </button>
                  <button
                    type="button"
                    className="ws-menu-btn"
                    role="menuitem"
                    onClick={() => {
                      setRenaming(menu.path);
                      setMenu(null);
                    }}
                  >
                    <RenameIcon />
                    Rename
                  </button>
                  <button
                    type="button"
                    className="ws-menu-btn danger"
                    role="menuitem"
                    onClick={() => setMenu((m) => (m ? { ...m, confirming: true } : m))}
                  >
                    <TrashIcon />
                    Delete
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
