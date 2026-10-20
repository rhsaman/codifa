import { Suspense, lazy } from "react";
import { useViewerTabs, visibleTabs } from "../lib/viewerTabs";
import { useStore } from "../lib/store";
import { SchedulePage, TodosPage } from "./ViewerPages";

// The single-pane viewer shows ONE tab at a time, so only that tab's panel is
// ever mounted — but they were all static imports, i.e. always in the startup
// chunk together with the viewer shell. Splitting each into its own chunk keeps
// a session that only chats from parsing the diff viewer, the file tree and the
// syntax-highlighted file/text viewers at all.
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
const FilesPanel = lazy(() => import("./FilesPanel").then((m) => ({ default: m.FilesPanel })));
const ExplorePanel = lazy(() =>
  import("./ExplorePanel").then((m) => ({ default: m.ExplorePanel })),
);

/** Active viewer content for the right editor group (docked, no overlay). */
export function ViewerContent() {
  // The panel below is a lazy() import: the fallback is intentionally empty
  // (the pane background) rather than a spinner, so switching between an
  // already-cached tab and a fresh one does not flash chrome.
  return (
    <Suspense fallback={null}>
      <ViewerContentInner />
    </Suspense>
  );
}

function ViewerContentInner() {
  const tabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const panelMode = useViewerTabs((s) => s.panelMode);
  const activeChatId = useStore((s) => s.activeChatId);
  // Chat-scoped viewers: only the active chat's tabs (plus global inbox) show.
  // Same resolution as `shownViewerTabId` in the store — that helper is the
  // shared spelling of this rule behind the rail icons' pressed state, so keep
  // the two in step.
  const visible = visibleTabs(tabs, activeChatId);
  const active = visible.find((t) => t.id === activeId) ?? visible[0] ?? null;

  // Panel mode replaces ALL viewer tab content; the header's panel toggle
  // flips back to tabs mode.
  if (panelMode) return <TodosPage />;

  // Empty pane shows EXACTLY the panel-toggle view (same page the top-right
  // icon opens): the todos checklist, no chooser. Schedules live on their own
  // tab now, so they are not stacked here.
  if (!active) return <TodosPage />;

  if (active.kind === "text") {
    const body = active.textBody ?? "";
    if (!body) {
      return (
        <div className="viewer-empty">
          This text is no longer in memory (e.g. after a restart) — reopen it
          from the chat.
        </div>
      );
    }
    return (
      <TextViewerPanel
        key={active.id}
        title={active.title}
        body={body}
        format={active.textFormat}
      />
    );
  }

  // Only the active tab mounts: hidden file tabs cost no RAM/CPU, and each
  // file tab carries its owning chat so live edits + comments stay in it.
  if (active.kind === "file") {
    return (
      <FileViewerPanel
        key={active.id}
        filePath={active.filePath ?? ""}
        fileLine={active.fileLine}
        fileRoot={active.fileRoot}
        chatId={active.chatId ?? activeChatId}
      />
    );
  }

  if (active.kind === "explore") {
    // One explore run's tool group — the calls, not the report.
    return (
      <ExplorePanel
        key={active.id}
        chatId={active.chatId ?? activeChatId}
        messageId={active.exploreMessageId ?? ""}
        index={active.exploreIndex ?? 0}
      />
    );
  }

  if (active.kind === "files") {
    // The explorer's root follows this tab's chat, so a split pane showing a
    // background chat lists THAT chat's workspace.
    return <FilesPanel key={active.id} chatId={active.chatId ?? activeChatId} />;
  }

  if (active.kind === "review") {
    return (
      <ReviewPanel
        key={`review:${active.reviewSource ?? ""}:${active.reviewMessageId ?? ""}:${active.reviewPath ?? ""}:${active.reviewRev ?? ""}`}
        docked
        messageId={active.reviewMessageId ?? null}
        initialSource={active.reviewSource ?? "uncommitted"}
        initialPath={active.reviewPath ?? ""}
        initialRev={active.reviewRev ?? "HEAD"}
        onClose={() => useViewerTabs.getState().closeViewer(active.id)}
      />
    );
  }

  if (active.kind === "trace") {
    // No chatId passed on purpose: the trace always follows the active chat,
    // so switching chats updates the trace view automatically.
    // A sub-agent tab carries traceTaskId: same TracePanel, server-filtered
    // to that job's entries (separate from the main chat trace).
    return (
      <TracePanel
        key={active.id}
        docked
        initialTab={active.traceTab ?? "all"}
        taskId={active.traceTaskId}
        traceTitle={active.traceTitle}
        onClose={() => useViewerTabs.getState().closeViewer(active.id)}
      />
    );
  }

  if (active.kind === "plan") {
    // The plan document belongs to the tab's owner chat — pass it explicitly
    // so the panel shows that chat's plan even when it was opened from a
    // background turn while another chat is active.
    return (
      <PlanPanel
        key={active.id}
        chatId={active.chatId}
      />
    );
  }

  if (active.kind === "browser") {
    return (
      <BrowserPanel
        key={active.id}
        chatId={active.chatId ?? ""}
        initialUrl={active.browserUrl ?? ""}
      />
    );
  }

  if (active.kind === "schedule") {
    // The cron task list as a page of its own (the Todos page no longer
    // carries it). Handled BEFORE the inbox fallback below, which is the
    // catch-all return of this dispatcher.
    return <SchedulePage key={active.id} />;
  }

  return (
    <ScheduleInboxDocked
      key={active.id}
      onClose={() => {
        useViewerTabs.getState().closeViewer(active.id);
        useStore.getState().setScheduleInboxOpen(false);
      }}
    />
  );
}
