import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { prepareContent } from "../lib/bidi";
import {
  barFlowSign,
  edgeScroll,
  slideWidth,
  tabForPoint,
  tabMove,
  type TabExtent,
} from "../lib/tabBar";
import { previewShifts } from "../lib/tabOrder";
import { shownViewerTabId, TAB_STRIP_KINDS, useViewerScope, useViewerTabs, viewerTabRows, viewerTabTitle, visibleTabs, type ClosedViewerTab, type ViewerKind, type ViewerScope, type ViewerTab } from "../lib/viewerTabs";
import { setViewerDragData } from "./ViewerWindows";
import { CompressIcon, ExpandIcon } from "./ViewerFullscreenButton";
import { TabListButton, type TabListSection } from "./TabListMenu";
import { FileIcon } from "./FileIcon";
import { fmtAgo } from "../lib/time";

/** Width (px) of the tab-list dropdown, mirrored from `.tab-list-menu`. */
const TAB_LIST_MENU_WIDTH = 410;

function ReviewIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="8" r="2.4" />
      <path d="M6 8.4v7.2M18 10.4c0 4.2-4.5 3.6-8.6 3.6" />
    </svg>
  );
}

function TraceIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16M4 12h10M4 18h7" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function PlanIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
    </svg>
  );
}

/** Calendar glyph: the Schedule page (cron tasks). Deliberately not a clock —
 *  a clock reads as "running now", a calendar reads as "runs on a schedule". */
function ScheduleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.4 2" />
    </svg>
  );
}

/** Magnifier: an explore tab shows one sub-agent run's tool group. */
function ExploreIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  );
}

/** Package-box glyph for the Artifacts page (everything the agent built).
 *  A closed box reads as "container of built things" — distinct from the
 *  plain file glyphs next to it on the rail and from ArtifactIcon, which
 *  marks ONE open document tab. */
function ArtifactsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.3 7 12 12l8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

/** Folder glyph for the file-explorer tab. */
const FilesIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M3 13h18" opacity="0.6" />
  </svg>
);

/** Document glyph for a chat artifact tab (a page the agent built). A page
 *  with a folded corner and text lines — distinct from TerminalIcon's prompt
 *  chevron and from ArtifactsIcon's container box. */
function ArtifactIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  );
}

/** Terminal prompt glyph (`>_` inside a pane) — shared by a terminal tab's rail
 *  row and the "+" menu entry. Deliberately a currentColor stroke glyph rather
 *  than MacAppIcons' TerminalIcon: that one is a filled app badge with fixed hex
 *  fills, so it would sit off the rail's icon grid and ignore its pressed
 *  colour. */
export function TerminalIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 9.4l2.7 2.6L7 14.6" />
      <path d="M12.4 14.6h4.6" />
    </svg>
  );
}

const KIND_ICON: Record<ViewerKind, () => React.JSX.Element> = {
  review: ReviewIcon,
  trace: TraceIcon,
  inbox: InboxIcon,
  schedule: ScheduleIcon,
  todos: TodosIcon,
  plan: PlanIcon,
  browser: BrowserIcon,
  // File tabs render their own per-path icon (see the map below); this
  // placeholder only satisfies the Record type.
  file: () => <ReviewIcon />,
  text: PlanIcon,
  explore: ExploreIcon,
  files: FilesIcon,
  artifact: ArtifactIcon,
  artifacts: ArtifactsIcon,
  terminal: TerminalIcon,
};

/** Plus glyph for the rail's page menu trigger. */
function AddIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
    </svg>
  );
}

/** Icon for one viewer tab (file tabs use their per-path icon). Shared by
 *  the header dropdown and the inline empty-state list. */
export function viewerTabIcon(t: ViewerTab): React.ReactNode {
  if (t.kind === "file") {
    return <FileIcon path={t.filePath ?? t.title} size={20} />;
  }
  const Icon = KIND_ICON[t.kind];
  return <Icon />;
}

/** Build the viewer tab-list sections (visible open tabs, then recently
 *  closed tabs). Single source of truth for the header dropdown and the
 *  inline empty-state list. DOCK PAGES NEVER APPEAR HERE: the bottom dock's
 *  fixed icons own those pages (they toggle from there), so the tab list —
 *  and its close buttons — stay purely about the top strip's tabs. */
export function buildViewerTabListSections(
  tabs: ViewerTab[],
  closed: ClosedViewerTab[],
  activeId: string | null,
  scope: ViewerScope,
): TabListSection[] {
  return [
    {
      label: "Open tabs",
      entries: visibleTabs(tabs, scope)
        .filter((t) => TAB_STRIP_KINDS.has(t.kind))
        .map((t) => ({
          key: t.id,
          title: viewerTabTitle(t),
          icon: viewerTabIcon(t),
          age: t.createdAt,
          active: t.id === activeId,
          onOpen: () => useViewerTabs.getState().setActiveViewer(t.id),
          onClose: () => useViewerTabs.getState().closeViewer(t.id),
        })),
    },
    {
      label: "Recently closed tabs",
      entries: closed
        .filter((c) => TAB_STRIP_KINDS.has(c.tab.kind))
        .map((c) => ({
          key: `closed-${c.tab.id}`,
          title: viewerTabTitle(c.tab),
          icon: viewerTabIcon(c.tab),
          age: c.closedAt,
          onOpen: () => useViewerTabs.getState().reopenClosedViewerTab(c.tab.id),
        })),
    },
  ];
}

/** Inline rendering of `sections[].entries[]` for the side pane body: the
 *  same open/recent tab entries as the header dropdown, without the popup.
 *  Empty sections are skipped; null when the whole list is empty. */
export function ViewerTabListInline({ sections }: { sections: TabListSection[] }) {
  const visible = sections.filter((s) => s.entries.length > 0);
  if (visible.length === 0) return null;
  return (
    <div className="viewer-tablist-inline">
      {visible.map((s) => (
        <div key={s.label} className="tab-list-section">
          <div className="tab-list-section-label">{s.label}</div>
          {s.entries.map((e) => (
            <div key={e.key} className={`tab-list-item${e.active ? " active" : ""}`}>
              <button type="button" className="tab-list-open" onClick={e.onOpen}>
                {e.icon && <span className="tab-list-icon">{e.icon}</span>}
                <span className="tab-list-title">{e.title}</span>
              </button>
              {e.age !== undefined && <span className="tab-list-age">{fmtAgo(e.age)}</span>}
              {e.onClose && (
                <button
                  type="button"
                  className="tab-list-close"
                  title="Close tab"
                  aria-label={`Close ${e.title}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    e.onClose?.();
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Chevron at the pane header's start: the searchable full tab list (open
 *  tabs with ages + close buttons, then recently closed tabs). The bar
 *  itself never scrolls — tabs squeeze — so this is how every tab stays
 *  reachable when there are many. */
export function ViewerTabListButton() {
  const tabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const closed = useViewerTabs((s) => s.closedTabs);
  const scope = useViewerScope();
  const sections = buildViewerTabListSections(tabs, closed, activeId, scope);
  // The count (and the bulk close) covers the STRIP tabs only — dock pages are
  // toggled from the dock, never swept by the tab list.
  const stripTabs = visibleTabs(tabs, scope).filter((t) => TAB_STRIP_KINDS.has(t.kind));
  return (
    <TabListButton
      sections={sections}
      label="Tab list"
      placement="bottom"
      menuWidth={TAB_LIST_MENU_WIDTH}
      footer={{
        label: stripTabs.length > 0 ? `Close all tabs (${stripTabs.length})` : "No open tabs",
        title: "Close every open tab of the active chat (kept in Recently closed)",
        disabled: stripTabs.length === 0,
        onPress: () => {
          for (const t of stripTabs) useViewerTabs.getState().closeViewer(t.id);
        },
      }}
    />
  );
}

/**
 * Toggle the terminal's presence in the side pane: dock it along the pane's
 * bottom edge (revealing the pane if it was hidden), or close it when it
 * already lives here. Exported and DOM-free so the rail icon's behaviour is
 * unit-testable — the button below is a thin wrapper around it.
 */
export function openTerminalTab(): void {
  useViewerTabs.getState().openTerminal({ cwd: useStore.getState().root });
}

/** VSCode-style tab strip for the right editor group (diff / trace / files /
 * pages) — a horizontal, titled tab row along the pane's TOP edge. Tabs
 * squeeze instead of scrolling; the tab-list chevron beside it reaches the
 * rest. */
export function ViewerTabBar() {
  const allTabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const scope = useViewerScope();
  // Every visible tab is a row — pages included, since the dock opens them
  // as ordinary tabs, so each one can be closed from its own row. Terminal tabs
  // are the exception: they collapse into ONE row (their shells are listed in
  // the panel's own chip strip), and the single row highlights the ACTIVE
  // shell.
  const tabs = viewerTabRows(allTabs, scope, activeId);
  // Same rule the pane body uses, so the highlighted row is the painted page.
  // NO fallback to the first tab: when a DOCK page (todos/git/terminal…) is on
  // screen the strip highlights nothing — the dock's own button carries the
  // pressed state, and the two surfaces stay separate.
  const activeRowId = shownViewerTabId(allTabs, activeId, scope);
  const shownActiveId = tabs.some((t) => t.id === activeRowId) ? activeRowId : null;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  // Slide geometry measured once at drag start (slot width + visual flow
  // direction), mirroring ChatTabBar's transform-slide preview.
  const [dragGeom, setDragGeom] = useState<{ slot: number; sign: 1 | -1 } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);


  // Keep the active tab visible when the bar overflows.
  useEffect(() => {
    barRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [shownActiveId]);

  const clearDrag = () => {
    setDragId(null);
    setDropTarget(null);
    setDragGeom(null);
  };

  // The bar previews the landing by SLIDING tabs aside with transforms — no
  // mid-drag reflow, animated slide (same design as ChatTabBar).
  const shifts = (() => {
    if (!dragId || !dropTarget) return null;
    return previewShifts(
      tabs.map((t) => t.id),
      dragId,
      dropTarget.id,
      dropTarget.after,
    );
  })();
  const slot = dragGeom?.slot ?? 0;
  const sign = dragGeom?.sign ?? 1;

  /** Landing preview for a pointer x: nearest tab by geometry — tabs, gaps
   *  and the space past the ends in one rule. */
  const previewAt = (clientX: number) => {
    const bar = barRef.current;
    if (!bar) return;
    const extents: TabExtent[] = Array.from(
      bar.querySelectorAll<HTMLElement>("[data-tab-id]"),
    ).map((el) => ({
      id: el.dataset.tabId ?? "",
      left: el.getBoundingClientRect().left,
      right: el.getBoundingClientRect().right,
    }));
    const next = tabForPoint(extents, clientX, dragGeom?.sign ?? barFlowSign(bar));
    if (!next) return;
    setDropTarget((prev) =>
      prev && prev.id === next.id && prev.after === next.after ? prev : next,
    );
  };

  return (
    <div
      ref={barRef}
      className="tab-bar viewer-tabs viewer-tabs-top"
      role="tablist"
      aria-label="Viewers"
      aria-orientation="horizontal"
      onDragOver={(e) => {
        if (!dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const bar = barRef.current;
        if (!bar) return;
        // Dragging near the rail's edge scrolls it, so off-screen tabs stay reachable.
        const delta = edgeScroll(e.clientX, bar.getBoundingClientRect(), "x");
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
          const extents: TabExtent[] = Array.from(
            bar.querySelectorAll<HTMLElement>("[data-tab-id]"),
          ).map((el) => ({
            id: el.dataset.tabId ?? "",
            left: el.getBoundingClientRect().left,
            right: el.getBoundingClientRect().right,
          }));
          const at = tabForPoint(extents, e.clientX, dragGeom?.sign ?? barFlowSign(bar));
          if (at && at.id !== from) {
            useViewerTabs.getState().moveViewerTab(from, at.id, at.after);
          }
        }
        clearDrag();
      }}
    >
      {tabs.map((t) => {
        const active = t.id === shownActiveId;
        // File/text tabs show their own title; sub-agent trace tabs keep
        // their own title so they never look like the main chat trace.
        const title = prepareContent(viewerTabTitle(t), "ltr");
        const Icon = KIND_ICON[t.kind];
        const shift = shifts?.get(t.id) ?? 0;
        return (
          <div
            key={t.id}
            data-tab-id={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            draggable
            className={`editor-tab viewer-tab kind-${t.kind}${active ? " active" : ""}${dragId === t.id ? " dragging drop-preview" : ""}`}
            style={
              shift !== 0 && slot > 0
                ? { transform: `translateX(${shift * slot * sign}px)` }
                : undefined
            }
            aria-label={title}
            title={title}
            onClick={() => useViewerTabs.getState().setActiveViewer(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                useViewerTabs.getState().setActiveViewer(t.id);
                return;
              }
              // Alt+Arrow moves the focused tab without dragging the mouse.
              const target = tabMove(tabs.map((x) => x.id), t.id, e.key, e.altKey, "x");
              if (!target) return;
              e.preventDefault();
              useViewerTabs.getState().moveViewerTab(t.id, target.toId, target.after);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) useViewerTabs.getState().closeViewer(t.id);
            }}
            onDragStart={(e) => {
              setViewerDragData(e, t.id);
              const bar = barRef.current;
              const el = bar?.querySelector<HTMLElement>(`[data-tab-id="${t.id}"]`);
              setDragGeom(el && bar ? { slot: slideWidth(el, bar), sign: barFlowSign(bar) } : null);
              setDragId(t.id);
            }}
            onDragEnd={clearDrag}
          >
            <span className="viewer-tab-icon" aria-hidden="true">
              {t.kind === "file" ? (
                <FileIcon path={t.filePath ?? t.title} size={20} />
              ) : (
                <Icon />
              )}
            </span>
            {/* The label holds the name (clicking it activates the tab — the
                event bubbles to the row) and the ✕ at its right end, which
                closes THIS tab: the strip shows one ✕ per tab, like the chat
                bar. A middle-click closes too. */}
            <span className="editor-tab-label" dir="ltr">
              <span className="viewer-tab-name">{title}</span>
              <button
                type="button"
                className="editor-tab-close"
                aria-label={`Close ${title}`}
                draggable={false}
                onClick={(e) => {
                  e.stopPropagation();
                  useViewerTabs.getState().closeViewer(t.id);
                }}
              >
                <CloseIcon />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Fullscreen toggle for the whole side pane — lives in the pane's top strip,
 *  at its right end (after the tab rows). ALWAYS rendered: the pane itself can
 *  be expanded with no tab open (its body then shows the todos fallback). */
export function ViewerPaneFullscreenButton() {
  const viewerFull = useViewerTabs((s) => s.fullscreen);
  return (
    <button
      type="button"
      className="editor-tab-full viewer-pane-full"
      title={viewerFull ? "Exit fullscreen" : "Fullscreen viewer"}
      aria-label={viewerFull ? "Exit viewer fullscreen" : "Fullscreen viewer"}
      aria-pressed={viewerFull}
      onClick={() => {
        const vt = useViewerTabs.getState();
        const next = !vt.fullscreen;
        vt.setFullscreen(next);
        if (next) useStore.getState().setChatFullscreen(false);
      }}
    >
      {viewerFull ? <CompressIcon /> : <ExpandIcon />}
    </button>
  );
}

/** Checklist glyph for the Todos page (the plan of the active chat). */
function TodosIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6.4l1.5 1.5L8.4 5" />
      <path d="M4 12.4l1.5 1.5L8.4 11" />
      <path d="M4 18.4l1.5 1.5L8.4 17" />
      <path d="M12 7h8M12 13h8M12 19h8" />
    </svg>
  );
}

/** Rail trigger: the "+" page menu. Every page reachable in the pane is
 *  listed here and opens as an ORDINARY tab — closable from its own rail row
 *  exactly like a file tab, so no page owns a fixed icon any more.
 *
 *  OPEN ONLY. Picking an entry never closes another tab: closing belongs to
 *  the tab strip (its ✕ / the tab list), so the menu can never make a page
 *  vanish under the user. */
export function ViewerAddButton() {
  const activeChatId = useStore((s) => s.activeChatId);
  const vt = () => useViewerTabs.getState();
  // ONLY the chat-owned pages live here: everything else is a permanent dock
  // icon at the pane's bottom edge (ViewerDockBar), so the menu stays two
  // entries small.
  const sections: TabListSection[] = [
    {
      label: "Chat pages",
      entries: [
        { key: "browser", title: "Browser", icon: <BrowserIcon />, onOpen: () => vt().openBrowser(activeChatId) },
        { key: "trace", title: "Trace", icon: <TraceIcon />, onOpen: () => vt().openTraces(activeChatId) },
      ],
    },
  ];
  return (
    <TabListButton
      sections={sections}
      label="Open a page"
      className="viewer-add-btn"
      icon={<AddIcon />}
    />
  );
}

/** Fixed launcher dock along the pane's BOTTOM edge — a slim, always-present
 *  icon row (one button per page, T3-Code style). COMPLETELY SEPARATE from the
 *  top tab strip: these pages never become tab rows up there. A click opens
 *  the page; clicking again (while its page is on screen) closes it, so the
 *  dock is a switcher, not a launcher that litters the strip. Browser/Trace
 *  are chat-owned TABS and come from the strip's "+" menu instead. */
export function ViewerDockBar() {
  const allTabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const scope = useViewerScope();
  // Same rule the pane body uses: the pressed dock button mirrors the page
  // that is actually painted right now.
  const shownTab = allTabs.find((t) => t.id === shownViewerTabId(allTabs, activeId, scope));
  const vt = () => useViewerTabs.getState();
  const dock: Array<{ kind: ViewerKind; title: string; icon: React.ReactNode; onPress: () => void }> = [
    { kind: "files", title: "Files", icon: <FilesIcon />, onPress: () => vt().openFiles() },
    { kind: "todos", title: "Todos", icon: <TodosIcon />, onPress: () => vt().openTodos(scope.chatId) },
    { kind: "review", title: "Git diff", icon: <ReviewIcon />, onPress: () => vt().openGitDiff(scope.chatId) },
    { kind: "artifacts", title: "Artifacts", icon: <ArtifactsIcon />, onPress: () => vt().openArtifacts() },
    { kind: "schedule", title: "Schedule", icon: <ScheduleIcon />, onPress: () => vt().openSchedule() },
    { kind: "inbox", title: "Inbox", icon: <InboxIcon />, onPress: () => vt().openInbox() },
    { kind: "terminal", title: "Terminal", icon: <TerminalIcon />, onPress: openTerminalTab },
  ];
  return (
    <div className="viewer-dock" role="toolbar" aria-label="Pane pages">
      {dock.map((d) => {
        const active = shownTab?.kind === d.kind;
        return (
          <button
            key={d.kind}
            type="button"
            className={`viewer-dock-btn${active ? " active" : ""}`}
            title={d.title}
            aria-label={d.title}
            aria-pressed={active}
            onClick={() => {
              // Toggle: the page is on screen → close it (the pane falls back
              // to the next tab or the todos page). Otherwise open/focus it.
              if (active && shownTab) {
                vt().closeViewer(shownTab.id);
                return;
              }
              d.onPress();
            }}
          >
            {d.icon}
          </button>
        );
      })}
      <span className="viewer-dock-spacer" aria-hidden="true" />
    </div>
  );
}

/** Hide-side-pane toggle for the TOP strip's right end — sits to the right of
 *  the fullscreen button. */
export function ViewerPaneToggleButton() {
  return (
    <button
      type="button"
      className="titlebar-icon-btn viewer-pane-toggle"
      title="Hide side pane"
      aria-label="Hide side pane"
      onClick={() => useViewerTabs.getState().setPaneOpen(false)}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M15 4v16" />
        <rect x="16.2" y="6.5" width="4.1" height="11" rx="1.2" fill="currentColor" stroke="none" opacity="0.55" className="panel-toggle-fill" />
      </svg>
    </button>
  );
}

/** Plus glyph for the rail's page menu trigger. */