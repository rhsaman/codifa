import { useState } from "react";
import { useViewerTabs, type ViewerKind } from "../lib/viewerTabs";

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

const KIND_ICON: Record<ViewerKind, () => React.JSX.Element> = {
  review: ReviewIcon,
  trace: TraceIcon,
  inbox: InboxIcon,
};

/** VSCode-style tab bar for the right editor group (diff / trace / inbox).
 *  Tabs can be reordered with drag & drop; order persists across restarts. */
export function ViewerTabBar() {
  const tabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);

  const clearDrag = () => {
    setDragId(null);
    setDropTarget(null);
  };

  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar viewer-tabs" role="tablist" aria-label="Viewers">
      {tabs.map((t) => {
        const active = t.id === activeId;
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
            title={t.title}
            onClick={() => useViewerTabs.getState().setActiveViewer(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                useViewerTabs.getState().setActiveViewer(t.id);
              }
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
              const after = e.clientX - rect.left > rect.width / 2;
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
                const after = e.clientX - rect.left > rect.width / 2;
                useViewerTabs.getState().moveViewerTab(from, t.id, after);
              }
              clearDrag();
            }}
            onDragEnd={clearDrag}
          >
            <span className="viewer-tab-icon" aria-hidden="true">
              <Icon />
            </span>
            <span className="editor-tab-label">{t.title}</span>
            <button
              type="button"
              className="editor-tab-close"
              title="Close viewer"
              aria-label={`Close ${t.title}`}
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                useViewerTabs.getState().closeViewer(t.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
