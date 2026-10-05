import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { prepareContent } from "../lib/bidi";
import { dropSide, edgeScroll, tabMove } from "../lib/tabBar";
import { useViewerTabs, viewerTabTitle, visibleTabs, type ViewerKind, type ViewerTab } from "../lib/viewerTabs";
import { CompressIcon, ExpandIcon } from "./ViewerFullscreenButton";
import { TabListButton, type TabListSection } from "./TabListMenu";
import { FileIcon } from "./FileIcon";

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

const KIND_ICON: Record<ViewerKind, () => React.JSX.Element> = {
  review: ReviewIcon,
  trace: TraceIcon,
  inbox: InboxIcon,
  plan: PlanIcon,
  browser: BrowserIcon,
  // File tabs render their own per-path icon (see the map below); this
  // placeholder only satisfies the Record type.
  file: () => <ReviewIcon />,
  text: PlanIcon,
};

/** "+" button in the side pane header: dropdown that opens any pane tab
 *  (git diff, trace, plan, inbox, browser) or flips the pane into panel
 *  mode — the single entry point, no separate per-panel icons. */
export function ViewerAddButton() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".viewer-add-wrap") && !t.closest(".viewer-add-menu")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) {
      // Clamp inside the viewport: near the window's right edge (RTL) the
      // dropdown must never poke out.
      const left = Math.max(12, Math.min(r.left, window.innerWidth - 242));
      setPos({ top: r.bottom + 6, left });
    }
    setOpen(true);
  };

  const items: Array<{ key: string; label: string; icon: () => React.JSX.Element; run: () => void }> = [
    { key: "review", label: "Review — git diff", icon: ReviewIcon, run: () => useViewerTabs.getState().openGitDiff() },
    { key: "trace", label: "Trace", icon: TraceIcon, run: () => useViewerTabs.getState().openTraces() },
    { key: "inbox", label: "Schedule inbox", icon: InboxIcon, run: () => useViewerTabs.getState().openInbox() },
    { key: "browser", label: "Browser", icon: BrowserIcon, run: () => useViewerTabs.getState().openBrowser() },
  ];

  return (
    <span className="viewer-add-wrap" ref={wrapRef}>
      <button
        type="button"
        className="editor-tab-new viewer-add-btn"
        title="Open a tab in the side pane"
        aria-label="Open a tab in the side pane"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        +
      </button>
      {open && pos && (
        <div
          className="ws-menu viewer-add-menu"
          role="menu"
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.key}
                type="button"
                className="ws-menu-btn"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  it.run();
                }}
              >
                <Icon />
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}



function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
    </svg>
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
  const iconFor = (t: ViewerTab) =>
    t.kind === "file" ? (
      <FileIcon path={t.filePath ?? t.title} size={20} />
    ) : (
      (() => {
        const Icon = KIND_ICON[t.kind];
        return <Icon />;
      })()
    );
  const sections: TabListSection[] = [
    {
      label: "Open tabs",
      entries: visibleTabs(tabs, activeChatId).map((t) => ({
        key: t.id,
        title: viewerTabTitle(t),
        icon: iconFor(t),
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
        icon: iconFor(c.tab),
        age: c.closedAt,
        onOpen: () => useViewerTabs.getState().reopenClosedViewerTab(c.tab.id),
      })),
    },
  ];
  return <TabListButton sections={sections} label="Tab list" />;
}

/** VSCode-style tab bar for the right editor group (diff / trace / inbox).
 *  Tabs can be reordered with drag & drop; order persists across restarts. */
export function ViewerTabBar() {
  const allTabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const activeChatId = useStore((s) => s.activeChatId);
  const viewerFull = useViewerTabs((s) => s.fullscreen);
  // Chat-scoped tabs: only the active chat's group is rendered in this bar.
  const tabs = visibleTabs(allTabs, activeChatId);
  const shownActiveId = tabs.find((t) => t.id === activeId)?.id ?? tabs[0]?.id ?? null;
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

  // No early null return: with the pane open the header (and its "+" menu)
  // must stay reachable even when every tab is closed.

  return (
    <div
      ref={barRef}
      className="tab-bar viewer-tabs"
      role="tablist"
      aria-label="Viewers"
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
        const lastTab = tabs[tabs.length - 1];
        if (!lastEl || !lastTab || e.clientX <= lastEl.getBoundingClientRect().right) return;
        const from = e.dataTransfer.getData("text/plain") || dragId;
        if (!from || from === lastTab.id) return;
        e.preventDefault();
        useViewerTabs.getState().moveViewerTab(from, lastTab.id, true);
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
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            draggable
            className={`editor-tab viewer-tab kind-${t.kind}${active ? " active" : ""}${dragId === t.id ? " dragging" : ""}${dropCls}`}
            title={title}
            onClick={() => useViewerTabs.getState().setActiveViewer(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                useViewerTabs.getState().setActiveViewer(t.id);
                return;
              }
              // Alt+Arrow moves the focused tab without dragging the mouse.
              const target = tabMove(tabs.map((x) => x.id), t.id, e.key, e.altKey);
              if (!target) return;
              e.preventDefault();
              useViewerTabs.getState().moveViewerTab(t.id, target.toId, target.after);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) useViewerTabs.getState().closeViewer(t.id);
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", t.id);
              e.dataTransfer.effectAllowed = "move";
              setDragId(t.id);
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === t.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const after = dropSide(e.clientX, rect) === "after";
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
                const after = dropSide(e.clientX, rect) === "after";
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
            <span className="editor-tab-label" dir="ltr">{title}</span>
            <button
              type="button"
              className="editor-tab-close"
              title="Close viewer"
              aria-label={`Close ${title}`}
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                useViewerTabs.getState().closeViewer(t.id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Fullscreen toggle for the whole side pane — lives in the pane header
 *  AFTER the "+" opener (not inside the tab bar), so the header reads
 *  [tabs | + | fullscreen | panel | collapse]. Hidden with no tabs. */
export function ViewerPaneFullscreenButton() {
  const tabs = useViewerTabs((s) => s.tabs);
  const activeChatId = useStore((s) => s.activeChatId);
  const viewerFull = useViewerTabs((s) => s.fullscreen);
  if (visibleTabs(tabs, activeChatId).length === 0) return null;
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
