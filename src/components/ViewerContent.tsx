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

/** "Open tab" screen: shown when the side pane is open with no viewer tab.
 *  Same entries as the pane header "+" menu (review, trace, inbox, browser)
 *  — clicking one opens/focuses it. Plan opens from the panel's saved-plan
 *  button and panel mode has its own header toggle, so neither is here. */
function ViewerChooser() {
  const vt = useViewerTabs.getState();
  const items: Array<{ key: string; label: string; icon: React.ReactNode; run: () => void }> = [
    {
      key: "review",
      label: "Review — git diff",
      run: () => vt.openGitDiff(),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="6" cy="6" r="2.4" />
          <circle cx="6" cy="18" r="2.4" />
          <circle cx="18" cy="8" r="2.4" />
          <path d="M6 8.4v7.2M18 10.4c0 4.2-4.5 3.6-8.6 3.6" />
        </svg>
      ),
    },
    {
      key: "trace",
      label: "Trace",
      run: () => vt.openTraces(),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6h16M4 12h10M4 18h7" />
        </svg>
      ),
    },
    {
      key: "inbox",
      label: "Schedule inbox",
      run: () => vt.openInbox(),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
      ),
    },
    {
      key: "browser",
      label: "Browser",
      run: () => vt.openBrowser(),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="viewer-chooser">
      <h2 className="viewer-chooser-title">Open tab</h2>
      <p className="viewer-chooser-sub">Choose a tab to open in the side pane.</p>
      <div className="viewer-chooser-list">
        {items.map((it) => (
          <button key={it.key} type="button" className="viewer-chooser-item" onClick={it.run}>
            {it.icon}
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

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

  if (!active) return <ViewerChooser />;

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
