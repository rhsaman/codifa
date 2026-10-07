import { useViewerTabs, visibleTabs } from "../lib/viewerTabs";
import { useStore } from "../lib/store";
import { ReviewPanel } from "./ReviewPanel";
import { TracePanel } from "./TracePanel";
import { ScheduleInboxDocked } from "./ScheduleInbox";
import { PlanPanel } from "./PlanPanel";
import { BrowserPanel } from "./BrowserPanel";
import { FileViewerPanel } from "./FileViewerPanel";
import { TextViewerPanel } from "./TextViewerPanel";
import { ScheduleSection } from "./SchedulePanel";
import { SubagentsSection, TodosSection } from "./TodosPanel";

/** Panel mode body: the docked right-panel sections (schedules, background
 *  sub-agents, todos) rendered in place of viewer tab content. */
function PanelPane() {
  return (
    <div className="panel-pane">
      <ScheduleSection />
      <SubagentsSection />
      <TodosSection />
    </div>
  );
}

/** Active viewer content for the right editor group (docked, no overlay). */
export function ViewerContent() {
  const tabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const panelMode = useViewerTabs((s) => s.panelMode);
  const activeChatId = useStore((s) => s.activeChatId);
  // Chat-scoped viewers: only the active chat's tabs (plus global inbox) show.
  const visible = visibleTabs(tabs, activeChatId);
  const active = visible.find((t) => t.id === activeId) ?? visible[0] ?? null;

  // Panel mode replaces ALL viewer tab content; the header's panel toggle
  // flips back to tabs mode.
  if (panelMode) return <PanelPane />;

  // Empty pane shows EXACTLY the panel-toggle view (same PanelPane component
  // the top-right icon opens): Schedules / Sub-agents / Todos, no chooser.
  if (!active) return <PanelPane />;

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
    return <BrowserPanel key={active.id} chatId={active.chatId ?? ""} />;
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
