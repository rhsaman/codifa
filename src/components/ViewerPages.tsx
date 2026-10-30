import type { ReactNode } from "react";
import { ScheduleSection } from "./SchedulePanel";
import { TerminalsSection, TodosPageEmptyHint, TodosSection } from "./TodosPanel";
import { TurnUsagePanel } from "./TurnUsagePanel";

/** Scroll shell shared by every full pane page (todos, schedule). One place
 *  owns the scroll box and the reading-width cap, so a page never re-derives
 *  the layout the panel-mode body already established.
 *
 *  `.panel-pane` (global.css) supplies the scroll box and the outer padding;
 *  `.panel-page-inner` caps the width so a wide pane does not stretch a card
 *  edge to edge. */
export function ViewerPage({ children }: { children: ReactNode }) {
  return (
    <div
      className="panel-pane panel-page"
      style={{
        flex: "1 1 0",
        display: "block",
        boxSizing: "border-box",
        height: "100%",
        maxHeight: "100%",
        minHeight: 0,
        minWidth: 0,
        overflowY: "auto",
        overscrollBehavior: "contain",
      }}
    >
      <div className="panel-page-inner">{children}</div>
    </div>
  );
}

/** Todos page: what the turn ran with (skills / MCP connectors / plugins)
 *  first, then the agent's live background terminals (each with its
 *  "Running for …" timer and Stop button), then the plan checklist. Every card
 *  renders NOTHING while it is empty, and the quiet page hint below is the
 *  `:only-child` fallback that shows only when all three are empty at once.
 *  Schedules own their page. */
export function TodosPage() {
  return (
    <ViewerPage>
      <TurnUsagePanel />
      <TerminalsSection />
      <TodosSection />
      <TodosPageEmptyHint />
    </ViewerPage>
  );
}

/** Schedule page: cron tasks (create form + rows) as a real pane tab. */
export function SchedulePage() {
  return (
    <ViewerPage>
      <ScheduleSection />
    </ViewerPage>
  );
}
