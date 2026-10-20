import type { ReactNode } from "react";
import { ScheduleSection } from "./SchedulePanel";
import { TodosSection } from "./TodosPanel";

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

/** Todos page: the plan checklist of the active chat. It used to render the
 *  schedule section above the list; schedules now own their own page, so this
 *  one holds exactly one card. */
export function TodosPage() {
  return (
    <ViewerPage>
      <TodosSection />
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
