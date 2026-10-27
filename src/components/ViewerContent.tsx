import { Suspense, lazy } from "react";
import { useViewerTabs, useViewerScope, visibleTabs } from "../lib/viewerTabs";
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
const ArtifactsPanel = lazy(() =>
  import("./ArtifactsPanel").then((m) => ({ default: m.ArtifactsPanel })),
);
const ArtifactPanel = lazy(() =>
  import("./ArtifactPanel").then((m) => ({ default: m.ArtifactPanel })),
);
// A terminal tab pulls xterm, fit and the pty bridge with it — exactly the kind
// of weight a chat-only session must never parse, hence the lazy() boundary.
const TerminalTabPanel = lazy(() =>
  import("./TerminalTabPanel").then((m) => ({ default: m.TerminalTabPanel })),
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
  const activeChatId = useStore((s) => s.activeChatId);
  // Scope-filtered viewers: the focused workspace's tabs, that chat's
  // trace/browser, and the global pages. Same resolution as `shownViewerTabId`
  // in the store — that helper is the shared spelling of this rule behind the
  // rail icons' pressed state, so keep the two in step.
  const scope = useViewerScope();
  const visible = visibleTabs(tabs, scope);
  // Same rule as `shownViewerTabId`: the chat's own tab beats a shared page tab
  // (schedule/inbox/…), so an open file never loses the pane to Schedule.
  const active =
    visible.find((t) => t.id === activeId) ??
    visible.find((t) => t.chatId === activeChatId) ??
    visible[0] ??
    null;

  // Empty pane (no tab of this chat): the todos checklist, no chooser.
  // Schedules and the rest are their own tabs, so they are not stacked here.
  if (!active) return <TodosPage />;

  if (active.kind === "todos") {
    // The checklist page opened from the rail's "+": an ordinary tab now, so
    // it can be closed like any other.
    return <TodosPage key={active.id} />;
  }

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
    // The trace follows ITS TAB's chat: for an ordinary tab that equals the
    //  focused chat (the tab is only visible there), while a schedule-run
    //  trace tab pins the synthetic `schedule-<sid>` chat wherever it was
    //  opened from. A sub-agent tab carries traceTaskId: same TracePanel,
    //  server-filtered to that job's entries (separate from the main trace).
    return (
      <TracePanel
        key={active.id}
        docked
        chatId={active.chatId}
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
        tabId={active.id}
        chatId={active.chatId ?? ""}
        initialUrl={active.browserUrl ?? ""}
      />
    );
  }

  if (active.kind === "artifact") {
    return (
      <ArtifactPanel
        key={active.id}
        title={active.title}
        kind={active.artifactKind ?? "html"}
        body={active.artifactBody ?? ""}
        chatId={active.chatId}
        id={active.artifactId}
      />
    );
  }

  if (active.kind === "artifacts") {
    // Every document the agent built, across chats. A row opens the same
    // sandboxed preview the transcript card does.
    return <ArtifactsPanel key={active.id} />;
  }

  if (active.kind === "terminal") {
    // An ORDINARY tab, not a dock: it keeps its own pty session
    // (src/lib/terminalSessions.ts) fully separate from the bottom panel
    // (Cmd/Ctrl+J). Switching away only unmounts the screen — the shell and its
    // scrollback stay alive, so coming back shows the same buffer.
    return (
      <TerminalTabPanel
        key={active.id}
        tabId={active.id}
        cwd={active.terminalCwd ?? ""}
        program={active.terminalProgram ?? ""}
        args={active.terminalArgs ?? []}
        shell={active.terminalShell ?? ""}
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
