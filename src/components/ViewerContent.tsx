import { useViewerTabs } from "../lib/viewerTabs";
import { useStore } from "../lib/store";
import { ReviewPanel } from "./ReviewPanel";
import { TracePanel } from "./TracePanel";
import { ScheduleInboxDocked } from "./ScheduleInbox";
import { PlanPanel } from "./PlanPanel";

/** Active viewer content for the right editor group (docked, no overlay). */
export function ViewerContent() {
  const tabs = useViewerTabs((s) => s.tabs);
  const activeId = useViewerTabs((s) => s.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? null;

  if (!active) {
    return <div className="viewer-empty">No viewer open — open a diff, trace or inbox.</div>;
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
    return (
      <TracePanel
        key={active.id}
        docked
        initialTab={active.traceTab ?? "all"}
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
        onClose={() => useViewerTabs.getState().closeViewer(active.id)}
      />
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
