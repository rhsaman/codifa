import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { prepareContent } from "../lib/bidi";
import { dropSide, edgeScroll, tabMove } from "../lib/tabBar";
import { previewSlot } from "../lib/tabOrder";
import { shownViewerTabId, useViewerTabs, viewerTabRows, viewerTabTitle, visibleTabs, type ClosedViewerTab, type ViewerKind, type ViewerTab } from "../lib/viewerTabs";
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

/** Window/gem glyph for a chat artifact tab (a document the agent built). */
function ArtifactIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9h18" />
      <path d="m8 13 2 2-2 2" />
      <path d="M13 17h3" />
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
 *  inline empty-state list. */
export function buildViewerTabListSections(
  tabs: ViewerTab[],
  closed: ClosedViewerTab[],
  activeId: string | null,
  activeChatId: string,
): TabListSection[] {
  return [
    {
      label: "Open tabs",
      entries: visibleTabs(tabs, activeChatId).map((t) => ({
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
      entries: closed.map((c) => ({
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
  const activeChatId = useStore((s) => s.activeChatId);
  const sections = buildViewerTabListSections(tabs, closed, activeId, activeChatId);
  const visibleCount = visibleTabs(tabs, activeChatId).length;
  return (
    <TabListButton
      sections={sections}
      label="Tab list"
      placement="left"
      menuWidth={TAB_LIST_MENU_WIDTH}
      footer={{
        label: visibleCount > 0 ? `Close all tabs (${visibleCount})` : "No open tabs",
        title: "Close all tabs of the active chat (kept in Recently closed)",
        disabled: visibleCount === 0,
        onPress: () => useViewerTabs.getState().closeAllViewers(activeChatId),
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

/** Publish a rail row's box to CSS so its floating name can be positioned by
 *  the stylesheet: `--viewer-tab-hint-top` (vertical center) and
 *  `--viewer-tab-hint-right` (distance from the viewport's right edge to the
 *  row's left edge). The rail scrolls, so both are measured per hover instead
 *  of being hard-coded; the rail's own width is never touched. */
function publishHintAnchor(row: HTMLElement): void {
  const rect = row.getBoundingClientRect();
  row.style.setProperty("--viewer-tab-hint-top", `${Math.round(rect.top + rect.height / 2)}px`);
  row.style.setProperty(
    "--viewer-tab-hint-right",
    `${Math.round(window.innerWidth - rect.right)}px`,
  );
}

/** VSCode-style tab bar for the right editor group (diff / trace / inbox). */
export function ViewerTabBar() {
  const allTabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const activeChatId = useStore((s) => s.activeChatId);
  // Every visible tab is a row — pages included, since the "+" menu opens them
  // as ordinary tabs, so each one can be closed from its own row.
  const tabs = viewerTabRows(allTabs, activeChatId);
  // Same rule the pane body uses, so the highlighted row is the painted page.
  const activeRowId = shownViewerTabId(allTabs, activeId, activeChatId);
  const shownActiveId = tabs.some((t) => t.id === activeRowId) ? activeRowId : tabs[0]?.id ?? null;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
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
  };

  // The rail previews the landing slot instead of drawing an insertion line: the
  // DOM never moves (a mid-drag re-render of the dragged node cancels the native
  // drag in Chromium), only its CSS `order` does, and the dragged tab is drawn as
  // a ghost outline so it reads as "this is where you drop".
  const dragPreview = (() => {
    if (!dragId || !dropTarget) return null;
    const slot = previewSlot(
      tabs.map((t) => t.id),
      dragId,
      dropTarget.id,
      dropTarget.after,
    );
    // The visible last tab follows the PREVIEW, not the DOM: with inline `order`
    // the last DOM node may no longer be the last row on screen.
    let tailId: string | null = null;
    let tailMax = -1;
    slot.forEach((index, id) => {
      if (index > tailMax) {
        tailMax = index;
        tailId = id;
      }
    });
    return { slot, tailId };
  })();
  // With an inline `order` the DOM's last tab is no longer the visible last one,
  // so the "drop past the end" target has to come from the previewed order.
  const tailId = dragPreview?.tailId ?? tabs[tabs.length - 1]?.id ?? null;

  // No early null return: with the pane open the header must stay reachable
  // even when every tab is closed.

  return (
    <div
      ref={barRef}
      className="tab-bar viewer-tabs viewer-tabs-rail"
      role="tablist"
      aria-label="Viewers"
      aria-orientation="vertical"
      onDragOver={(e) => {
        if (!dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const bar = barRef.current;
        if (!bar) return;
        // Dragging near the rail's edge scrolls it, so off-screen tabs stay reachable.
        const delta = edgeScroll(e.clientY, bar.getBoundingClientRect(), "y");
        if (delta) bar.scrollTop += delta;
        // Empty space past the visible last tab previews a landing at the very end.
        if (!tailId || tailId === dragId) return;
        const tailEl = bar.querySelector<HTMLElement>(`[data-tab-id="${tailId}"]`);
        if (!tailEl || e.clientY <= tailEl.getBoundingClientRect().bottom) return;
        setDropTarget((prev) =>
          prev?.id === tailId && prev.after ? prev : { id: tailId, after: true },
        );
      }}
      onDragLeave={(e) => {
        if (e.target !== e.currentTarget) return;
        setDropTarget(null);
      }}
      onDrop={(e) => {
        // Tabs handle their own drop; empty space past the last tab drops at the end.
        if (e.target !== e.currentTarget || !dragId) return;
        const tailEl = tailId
          ? barRef.current?.querySelector<HTMLElement>(`[data-tab-id="${tailId}"]`)
          : null;
        if (!tailId || !tailEl || e.clientY <= tailEl.getBoundingClientRect().bottom) return;
        const from = e.dataTransfer.getData("text/plain") || dragId;
        if (!from || from === tailId) return;
        e.preventDefault();
        useViewerTabs.getState().moveViewerTab(from, tailId, true);
        clearDrag();
      }}
    >
      {tabs.map((t) => {
        const active = t.id === shownActiveId;
        // File/text tabs show their own title; sub-agent trace tabs keep
        // their own title so they never look like the main chat trace.
        const title = prepareContent(viewerTabTitle(t), "ltr");
        const dropCls =
          dropTarget?.id === t.id ? (dropTarget.after ? " drop-after" : " drop-before") : "";
        const Icon = KIND_ICON[t.kind];
        const order = dragPreview?.slot.get(t.id);
        return (
          <div
            key={t.id}
            data-tab-id={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            draggable
            className={`editor-tab viewer-tab kind-${t.kind}${active ? " active" : ""}${dragId === t.id ? " dragging drop-preview" : ""}${dropCls}`}
            style={order === undefined ? undefined : { order }}
            aria-label={title}
            // No `title`: while hovered the name is painted on the tab itself,
            // so a native tooltip would repeat it.
            // The row publishes where the floating name must land: vertically
            // centered on the hovered row and flush against its left edge. Both
            // are measured here (not in CSS) because the rail scrolls.
            onMouseEnter={(e) => publishHintAnchor(e.currentTarget)}
            // Keyboard focus shows the same name; React's focus event bubbles,
            // so focusing the row or its ✕ both land here.
            onFocus={(e) => publishHintAnchor(e.currentTarget)}
            onClick={() => useViewerTabs.getState().setActiveViewer(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                useViewerTabs.getState().setActiveViewer(t.id);
                return;
              }
              // Alt+Arrow moves the focused tab without dragging the mouse.
              const target = tabMove(tabs.map((x) => x.id), t.id, e.key, e.altKey, "y");
              if (!target) return;
              e.preventDefault();
              useViewerTabs.getState().moveViewerTab(t.id, target.toId, target.after);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) useViewerTabs.getState().closeViewer(t.id);
            }}
            onDragStart={(e) => {
              setViewerDragData(e, t.id);
              setDragId(t.id);
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === t.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const after = dropSide(e.clientY, rect, "y") === "after";
              setDropTarget((prev) =>
                prev?.id === t.id && prev.after === after ? prev : { id: t.id, after },
              );
            }}
            onDragLeave={() => {
              setDropTarget((prev) => (prev?.id === t.id ? null : prev));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = e.dataTransfer.getData("text/plain") || dragId;
              if (from && from !== t.id) {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const after = dropSide(e.clientY, rect, "y") === "after";
                useViewerTabs.getState().moveViewerTab(from, t.id, after);
              }
              clearDrag();
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
            {/* One card holds BOTH halves: the name (clicking it activates the
                tab — the event bubbles to the row) and the ✕ at its right end
                (which closes, and sits where the kind icon was). The card is
                only painted while hovered; at rest the rail stays icon-only.
                Because that ✕ covers the row's square, it only closes the tab
                that is ON SCREEN — an inactive row is switched to instead. */}
            <span className="editor-tab-label" dir="ltr">
              <span className="viewer-tab-name">{title}</span>
              <button
                type="button"
                className="editor-tab-close"
                aria-label={`Close ${title}`}
                draggable={false}
                onClick={(e) => {
                  e.stopPropagation();
                  // The card's ✕ sits exactly on the row's icon square (hover
                  // replaces the kind icon), so the click that was meant to
                  // SWITCH to this tab lands on the ✕. Closing the tab the user
                  // meant to open is how open files kept disappearing from the
                  // rail. Only the SHOWN tab's ✕ closes; an inactive row is
                  // activated instead. Other rows close from the tab list
                  // (its own ✕) or with a middle-click.
                  if (!active) {
                    useViewerTabs.getState().setActiveViewer(t.id);
                    return;
                  }
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

/** Fullscreen toggle for the whole side pane — lives in the pane header,
 *  directly below the tab-list chevron and above the "+" page menu (not inside
 *  the tab bar). Canonical rail order, top to bottom: [collapse | tab list |
 *  fullscreen | "+" | tab rows]. ALWAYS rendered: the pane itself can be
 *  expanded with no tab open (its body then shows the todos fallback). */
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
  const sections: TabListSection[] = [
    {
      label: "Pane",
      entries: [
        {
          key: "terminal",
          title: "Terminal",
          icon: <TerminalIcon />,
          onOpen: openTerminalTab,
        },
      ],
    },
    {
      label: "Open a page",
      entries: [
        { key: "files", title: "Files", icon: <FilesIcon />, onOpen: () => vt().openFiles(activeChatId) },
        { key: "todos", title: "Todos", icon: <TodosIcon />, onOpen: () => vt().openTodos(activeChatId) },
        { key: "artifacts", title: "Artifacts", icon: <ArtifactsIcon />, onOpen: () => vt().openArtifacts() },
        { key: "review", title: "Git diff", icon: <ReviewIcon />, onOpen: () => vt().openGitDiff(activeChatId) },
        { key: "trace", title: "Trace", icon: <TraceIcon />, onOpen: () => vt().openTraces(activeChatId) },
        { key: "browser", title: "Browser", icon: <BrowserIcon />, onOpen: () => vt().openBrowser(activeChatId) },
        { key: "schedule", title: "Schedule", icon: <ScheduleIcon />, onOpen: () => vt().openSchedule() },
        { key: "inbox", title: "Inbox", icon: <InboxIcon />, onOpen: () => vt().openInbox() },
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

/** Plus glyph for the rail's page menu trigger. */