import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useStore } from "../lib/store";
import { useViewerTabs, viewerTabTitle } from "../lib/viewerTabs";
import type { ChatDropPos, ChatTreeNode } from "../lib/chatTree";
import { buildFromList, collectChatIds, findNodeById, flexWeights, leafCount } from "../lib/chatTree";
import { SchedulePage, TodosPage } from "./ViewerPages";
import { ViewerContent } from "./ViewerContent";
// Every viewer panel is dispatched by tab kind, so at most ONE of them is ever
// on screen — yet all of them used to sit in the startup chunk with the viewer
// shell, because the imports were static. Several pull real weight (highlight.js
// in the file/text viewers, the diff renderer in ReviewPanel, the file tree in
// FilesPanel), so each one is split into its own chunk and fetched when its tab
// is first shown. Repeated opens reuse the loaded chunk via the module cache.
const ReviewPanel = lazy(() =>
  import("./ReviewPanel").then((m) => ({ default: m.ReviewPanel })),
);
const TracePanel = lazy(() => import("./TracePanel").then((m) => ({ default: m.TracePanel })));
const ScheduleInboxDocked = lazy(() =>
  import("./ScheduleInbox").then((m) => ({ default: m.ScheduleInboxDocked })),
);
const PlanPanel = lazy(() => import("./PlanPanel").then((m) => ({ default: m.PlanPanel })));
const BrowserPanel = lazy(() =>
  import("./BrowserPanel").then((m) => ({ default: m.BrowserPanel })),
);
const FileViewerPanel = lazy(() =>
  import("./FileViewerPanel").then((m) => ({ default: m.FileViewerPanel })),
);
const TextViewerPanel = lazy(() =>
  import("./TextViewerPanel").then((m) => ({ default: m.TextViewerPanel })),
);
const ArtifactsPanel = lazy(() =>
  import("./ArtifactsPanel").then((m) => ({ default: m.ArtifactsPanel })),
);
const ArtifactPanel = lazy(() =>
  import("./ArtifactPanel").then((m) => ({ default: m.ArtifactPanel })),
);
const FilesPanel = lazy(() => import("./FilesPanel").then((m) => ({ default: m.FilesPanel })));
const ExplorePanel = lazy(() =>
  import("./ExplorePanel").then((m) => ({ default: m.ExplorePanel })),
);

/** MIME type for dragging a viewer tab id onto panes to split. */
export const VIEWER_DRAG_MIME = "application/x-coder-viewer-id";

export function readViewerDragId(e: DragEvent | { dataTransfer?: DataTransfer | null }): string {
  try {
    const dt = (e as DragEvent).dataTransfer ?? (e as { dataTransfer?: DataTransfer | null }).dataTransfer;
    if (!dt) return "";
    const viaType = dt.getData(VIEWER_DRAG_MIME);
    if (viaType) return viaType;
    const plain = dt.getData("text/plain");
    if (plain && plain.trim()) return plain.trim();
    return "";
  } catch {
    return "";
  }
}

export function setViewerDragData(e: { dataTransfer: DataTransfer }, tabId: string): void {
  try {
    e.dataTransfer.setData(VIEWER_DRAG_MIME, tabId);
    e.dataTransfer.setData("text/plain", tabId);
    e.dataTransfer.effectAllowed = "move";
  } catch {
    /* drag unsupported */
  }
}

/** Map a pointer position inside a leaf to a VSCode-like drop position. */
function posForPoint(e: DragEvent, el: HTMLElement): ChatDropPos {
  const rect = el.getBoundingClientRect();
  const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
  const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
  const edge = 0.25;
  if (x < edge && x <= y && x <= 1 - y) return "left";
  if (x > 1 - edge && x >= y && x >= 1 - y) return "right";
  if (y < edge) return "top";
  if (y > 1 - edge) return "bottom";
  return "center";
}

function viewerTitleOf(tabId: string): string {
  const tab = useViewerTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return "Viewer";
  try {
    return viewerTabTitle(tab);
  } catch {
    return tab.title || "Viewer";
  }
}

/** Per-leaf body: renders the fixed tab of this pane, independent of the
 *  global activeId. Chat-scoped panels get their owner chat explicitly so two
 *  panes never mirror the focused chat. */
function ViewerLeafBody({ tabId }: { tabId: string }) {
  const tab = useViewerTabs((s) => s.tabs.find((t) => t.id === tabId));
  if (!tab) {
    return <div className="viewer-empty">Tab closed — pick another tab.</div>;
  }
  if (tab.kind === "text") {
    const body = tab.textBody ?? "";
    if (!body) {
      return (
        <div className="viewer-empty">
          This text is no longer in memory (e.g. after a restart) — reopen it from the chat.
        </div>
      );
    }
    return <TextViewerPanel key={tab.id} title={tab.title} body={body} format={tab.textFormat} />;
  }
  if (tab.kind === "file") {
    return (
      <FileViewerPanel
        key={tab.id}
        filePath={tab.filePath ?? ""}
        fileLine={tab.fileLine}
        fileRoot={tab.fileRoot}
      />
    );
  }
  if (tab.kind === "review") {
    return (
      <ReviewPanel
        key={`review:${tab.reviewSource ?? ""}:${tab.reviewMessageId ?? ""}:${tab.reviewPath ?? ""}:${tab.reviewRev ?? ""}`}
        docked
        chatId={tab.chatId}
        messageId={tab.reviewMessageId ?? null}
        initialSource={tab.reviewSource ?? "uncommitted"}
        initialPath={tab.reviewPath ?? ""}
        initialRev={tab.reviewRev ?? "HEAD"}
        onClose={() => useViewerTabs.getState().closeViewer(tab.id)}
      />
    );
  }
  if (tab.kind === "trace") {
    return (
      <TracePanel
        key={tab.id}
        docked
        chatId={tab.chatId}
        initialTab={tab.traceTab ?? "all"}
        taskId={tab.traceTaskId}
        traceTitle={tab.traceTitle}
        onClose={() => useViewerTabs.getState().closeViewer(tab.id)}
      />
    );
  }
  if (tab.kind === "plan") {
    return <PlanPanel key={tab.id} chatId={tab.chatId} />;
  }
  if (tab.kind === "browser") {
    return (
      <BrowserPanel
        key={tab.id}
        tabId={tab.id}
        chatId={tab.chatId ?? ""}
        initialUrl={tab.browserUrl ?? ""}
      />
    );
  }
  if (tab.kind === "files") {
    return <FilesPanel key={tab.id} chatId={tab.chatId} />;
  }
  // Explore was missing from this dispatcher: a split pane holding an explore
  // tab used to fall through to the schedule inbox. Same panel, this leaf's tab.
  if (tab.kind === "explore") {
    return (
      <ExplorePanel
        key={tab.id}
        chatId={tab.chatId ?? ""}
        messageId={tab.exploreMessageId ?? ""}
        index={tab.exploreIndex ?? 0}
      />
    );
  }
  // The todos page in a split pane: an ordinary tab now (`todos`), so it can be
  // closed like any other leaf.
  if (tab.kind === "todos") {
    return <TodosPage key={tab.id} />;
  }
  // The schedule page in a split pane. Must sit before the fallback below,
  // which is the catch-all inbox return of this dispatcher.
  if (tab.kind === "artifacts") {
    return <ArtifactsPanel key={tab.id} />;
  }
  if (tab.kind === "schedule") {
    return <SchedulePage key={tab.id} />;
  }
  if (tab.kind === "artifact") {
    return (
      <ArtifactPanel
        key={tab.id}
        title={tab.title}
        kind={tab.artifactKind ?? "html"}
        body={tab.artifactBody ?? ""}
        chatId={tab.chatId}
        id={tab.artifactId}
      />
    );
  }
  return (
    <ScheduleInboxDocked
      key={tab.id}
      onClose={() => {
        useViewerTabs.getState().closeViewer(tab.id);
        useStore.getState().setScheduleInboxOpen(false);
      }}
    />
  );
}

function ViewerWindowHeader({
  tabId,
  focused,
  multi,
  onDragState,
}: {
  tabId: string;
  focused: boolean;
  multi: boolean;
  onDragState: (dragId: string | null) => void;
}) {
  const title = viewerTitleOf(tabId);
  const beginDrag = (e: DragEvent) => {
    if (!multi) return;
    e.stopPropagation();
    setViewerDragData(e, tabId);
    onDragState(tabId);
  };
  const focus = () => useViewerTabs.getState().focusViewerWindow(tabId);
  return (
    <div
      className={"viewer-window-head" + (focused ? " focused" : "")}
      onClick={focus}
      title={multi ? `Drag to move — ${title}` : title}
      role="tab"
      aria-selected={focused}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          useViewerTabs.getState().focusViewerWindow(tabId);
        }
      }}
    >
      <span
        className="viewer-window-title"
        draggable={multi}
        onDragStart={beginDrag}
        onDragEnd={() => onDragState(null)}
      >
        {title}
      </span>
      {multi && (
        <button
          type="button"
          className="viewer-window-close"
          title="Hide pane (tab stays open)"
          aria-label={`Hide ${title}`}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          onMouseDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onDragState(null);
            useViewerTabs.getState().closeViewerWindow(tabId);
          }}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}

type DropMark = { id: string; pos: ChatDropPos } | null;

interface ViewerDragState {
  dragId: string | null;
  drop: DropMark;
  setDragId: (id: string | null) => void;
  setDrop: (d: DropMark | ((prev: DropMark) => DropMark)) => void;
}

function ViewerLeafView({
  tabId,
  focused,
  multi,
  drag,
}: {
  tabId: string;
  focused: boolean;
  multi: boolean;
  drag: ViewerDragState;
}) {
  const dropPos = drag.drop?.id === tabId ? drag.drop.pos : null;
  const isDragSource = !!drag.dragId && drag.dragId === tabId;
  return (
    <section
      className={
        "viewer-window" +
        (focused ? " focused" : " dimmed") +
        (dropPos ? ` drop-active drop-${dropPos}` : "") +
        (isDragSource ? " drag-source" : "")
      }
      data-viewer-window={tabId}
      aria-label={viewerTitleOf(tabId)}
      style={multi ? ({ flexGrow: 1, flexShrink: 0, flexBasis: 0 } as CSSProperties) : undefined}
      onDragOver={(e) => {
        // The moving pane itself is never a drop target: showing a preview
        // on the source suggests a wrong landing zone, so clear it instead.
        if (drag.dragId && drag.dragId === tabId) {
          drag.setDrop((prev) => (prev?.id === tabId ? null : prev));
          return;
        }
        const internal = drag.dragId && drag.dragId !== tabId;
        let hasExternal = false;
        try {
          const types = Array.from(e.dataTransfer.types ?? []);
          hasExternal = types.includes(VIEWER_DRAG_MIME) || types.includes("text/plain");
        } catch {
          hasExternal = false;
        }
        if (!internal && !hasExternal) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        const pos = posForPoint(e, e.currentTarget as HTMLElement);
        drag.setDrop((prev) => (prev?.id === tabId && prev.pos === pos ? prev : { id: tabId, pos }));
      }}
      onDragLeave={() => drag.setDrop((prev) => (prev?.id === tabId ? null : prev))}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const from = readViewerDragId(e) || drag.dragId;
        const pos = posForPoint(e, e.currentTarget as HTMLElement);
        drag.setDragId(null);
        drag.setDrop(null);
        if (!from || from === tabId) return;
        useViewerTabs.getState().dropViewerOnto(from, tabId, pos);
      }}
    >
      {multi && (
        <ViewerWindowHeader tabId={tabId} focused={focused} multi={multi} onDragState={drag.setDragId} />
      )}
      <div className="viewer-window-body" onClick={() => useViewerTabs.getState().focusViewerWindow(tabId)}>
        <Suspense fallback={null}>
          <ViewerLeafBody tabId={tabId} />
        </Suspense>
      </div>
      {dropPos && (
        <div className={`viewer-drop-preview preview-${dropPos}`} aria-hidden="true">
          <div className="viewer-drop-empty-page">
            <span className="viewer-drop-empty-title">{drag.dragId ? viewerTitleOf(drag.dragId) : "Viewer"}</span>
            <span className="viewer-drop-hint">
              {dropPos === "center" ? "Release to focus here" : "Release to open here"}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function ViewerSplitView({
  node,
  focusedId,
  multi,
  drag,
  startResize,
}: {
  node: ChatTreeNode;
  focusedId: string | null;
  multi: boolean;
  drag: ViewerDragState;
  startResize: (
    e: ReactMouseEvent,
    parentId: string,
    firstId: string,
    secondId: string,
    firstSize: number,
    secondSize: number,
    isRow: boolean,
  ) => void;
}) {
  if (node.kind === "leaf") {
    return (
      <ViewerLeafView tabId={node.chatId} focused={node.chatId === focusedId} multi={multi} drag={drag} />
    );
  }
  const isRow = node.dir === "row";
  // Weights normalized to a total of 1: a stored tree whose sizes sum below 1
  // would otherwise leave the tail of the split blank (see flexWeights).
  const weights = flexWeights(node.children.map((c) => c.size));
  return (
    <div className={`viewer-split ${isRow ? "row" : "col"}`} data-viewer-split-id={node.id}>
      {node.children.map((child, i) => (
        <div
          key={child.id}
          className="viewer-split-child"
          style={{ flexGrow: weights[i], flexShrink: 0, flexBasis: 0 } as CSSProperties}
        >
          {i > 0 && (
            <div
              className={`viewer-split-resize ${isRow ? "col-bar" : "row-bar"}`}
              title="Drag to resize"
              role="separator"
              aria-orientation={isRow ? "vertical" : "horizontal"}
              onMouseDown={(e) => {
                const prev = node.children[i - 1];
                startResize(e, node.id, prev.id, child.id, prev.size, child.size, isRow);
              }}
            />
          )}
          <ViewerSplitView node={child} focusedId={focusedId} multi={multi} drag={drag} startResize={startResize} />
        </div>
      ))}
    </div>
  );
}

/** VSCode-like split group for the right panel: single tab renders the classic
 *  ViewerContent (chat-filtered, chooser, panel mode); multiple panes render
 *  the recursive split tree with per-leaf content, edge-drop previews, resize
 *  handles and click-focus. Drag a viewer tab onto any pane edge to split. */
export function ViewerWindows() {
  const tree = useViewerTabs((s) => s.viewerTree);
  const focusedId = useViewerTabs((s) => s.focusedViewerId);
  const activeId = useViewerTabs((s) => s.activeId);
  const tabs = useViewerTabs((s) => s.tabs);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropMark>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ parentId: string; firstId: string; secondId: string; startX: number; startY: number; firstSize: number; secondSize: number; totalFlex: number; childCount: number; isRow: boolean } | null>(null);

  // Keep the tree alive: build on first tab, prune closed tabs, keep single
  // leaf in sync with the active tab so a later split starts from it.
  useEffect(() => {
    useViewerTabs.getState().ensureViewerTree();
  }, [tabs.length, activeId]);

  useEffect(() => {
    const st = useViewerTabs.getState();
    const t = st.viewerTree;
    if (!t || leafCount(t) !== 1 || !st.activeId) return;
    const ids = collectChatIds(t);
    if (ids.length === 1 && ids[0] !== st.activeId && st.tabs.some((x) => x.id === st.activeId)) {
      const next = buildFromList([st.activeId], "row");
      if (next) useViewerTabs.setState({ viewerTree: next, focusedViewerId: st.activeId });
    }
  }, [activeId, tabs.length]);

  const startResize = useCallback(
    (
      e: ReactMouseEvent,
      parentId: string,
      firstId: string,
      secondId: string,
      firstSize: number,
      secondSize: number,
      isRow: boolean,
    ) => {
      e.preventDefault();
      const current = useViewerTabs.getState().viewerTree;
      const parent = findNodeById(current, parentId);
      const totalFlex = parent && parent.kind === "split" ? parent.children.reduce((n, c) => n + c.size, 0) : firstSize + secondSize;
      const childCount = parent && parent.kind === "split" ? parent.children.length : 2;
      resizeRef.current = { parentId, firstId, secondId, startX: e.clientX, startY: e.clientY, firstSize, secondSize, totalFlex, childCount, isRow };
      const onMove = (ev: MouseEvent) => {
        const r = resizeRef.current;
        if (!r) return;
        const parentEl = document.querySelector(`[data-viewer-split-id="${r.parentId}"]`);
        const parentRect = parentEl?.getBoundingClientRect();
        const parentSpan = r.isRow ? (parentRect?.width ?? 0) : (parentRect?.height ?? 0);
        const span = parentSpan > 0 ? parentSpan : (r.isRow ? (stackRef.current?.getBoundingClientRect().width ?? 800) : (stackRef.current?.getBoundingClientRect().height ?? 600));
        const travelled = r.isRow ? ev.clientX - r.startX : ev.clientY - r.startY;
        const pairTotal = r.firstSize + r.secondSize;
        const delta = (travelled / Math.max(200, span)) * r.totalFlex;
        const minPx = r.isRow ? 280 : 220;
        const usable = Math.max(0, span - Math.max(0, r.childCount - 1) * 6);
        let nextFirst = r.firstSize + delta;
        let nextSecond = r.secondSize - delta;
        if (usable > minPx * 2 && r.totalFlex > 0) {
          const minFlex = (minPx / usable) * r.totalFlex;
          const lo = Math.max(minFlex, 0.25);
          const hi = pairTotal - Math.max(minFlex, 0.25);
          if (hi >= lo) {
            nextFirst = Math.min(Math.max(nextFirst, lo), hi);
            nextSecond = pairTotal - nextFirst;
          } else {
            return;
          }
        }
        useViewerTabs.getState().resizeViewerPair(r.parentId, r.firstId, r.secondId, nextFirst, nextSecond);
      };
      const onUp = () => {
        resizeRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );

  const leaves = tree ? leafCount(tree) : 0;
  // Single pane (or no tree yet): classic behavior with chat filtering.
  if (!tree || leaves <= 1) {
    return <ViewerContent />;
  }

  const drag: ViewerDragState = {
    dragId,
    drop,
    setDragId: (id) => setDragId(id),
    setDrop: (updater) => setDrop((prev) => (typeof updater === "function" ? (updater as (p: DropMark) => DropMark)(prev) : updater)),
  };

  return (
    <div ref={stackRef} className="viewer-windows multi tree" data-testid="viewer-windows">
      <ViewerSplitView node={tree} focusedId={focusedId ?? activeId} multi drag={drag} startResize={startResize} />
    </div>
  );
}
