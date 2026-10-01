import { useViewerTabs } from "../lib/viewerTabs";
import { ReviewPanel } from "./ReviewPanel";
import { TracePanel } from "./TracePanel";
import { ScheduleInboxDocked } from "./ScheduleInbox";

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
        key={active.id}
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
    return (
      <TracePanel
        key={active.id}
        docked
        chatId={active.traceChatId}
        initialTab={active.traceTab ?? "all"}
        onClose={() => useViewerTabs.getState().closeViewer(active.id)}
      />
    );
  }

  return (
    <ScheduleInboxDocked
      key={active.id}
      onClose={() => useViewerTabs.getState().closeViewer(active.id)}
    />
  );
}
