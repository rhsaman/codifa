import { useViewerTabs, visibleTabs } from "../lib/viewerTabs";
import { useStore } from "../lib/store";
import { ReviewPanel } from "./ReviewPanel";
import { TracePanel } from "./TracePanel";
import { ScheduleInboxDocked } from "./ScheduleInbox";
import { PlanPanel } from "./PlanPanel";
import { BrowserPanel } from "./BrowserPanel";
import { FileViewerPanel } from "./FileViewerPanel";
import { TextViewerPanel } from "./TextViewerPanel";

/** Active viewer content for the right editor group (docked, no overlay). */
export function ViewerContent() {
  const tabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const activeChatId = useStore((s) => s.activeChatId);
  // Chat-scoped viewers: only the active chat's tabs (plus global inbox) show.
  const visible = visibleTabs(tabs, activeChatId);
  const active = visible.find((t) => t.id === activeId) ?? visible[0] ?? null;

  if (!active) {
    return <div className="viewer-empty">No viewer open — open a diff, trace, inbox, browser or file.</div>;
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
      />
    );
  }

  if (active.kind === "file") {
    return (
      <FileViewerPanel
        key={active.id}
        filePath={active.filePath ?? ""}
        fileLine={active.fileLine}
        fileRoot={active.fileRoot}
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
    // Follows the active chat too: the plan document belongs to the chat that
    // produced it (PlanPanel reads the live activeChatId from the store).
    return (
      <PlanPanel
        key={active.id}
      />
    );
  }

  if (active.kind === "browser") {
    return (
      <BrowserPanel key={active.id} />
    );
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
