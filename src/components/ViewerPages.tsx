import type { ReactNode } from "react";
import { ScheduleSection } from "./SchedulePanel";
import { TodosSection } from "./TodosPanel";
import { TurnUsageSection } from "./TurnUsagePanel";
import { useStore } from "../lib/store";

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

/** Todos page: the plan checklist of the active chat, followed by what that
 *  turn ran with (skills / MCP connectors / plugins). Both cards read the
 *  ACTIVE chat's messages, so switching chats switches both. Schedules now own
 *  their own page, so this one holds only per-chat cards. */
export function TodosPage() {
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId) ?? null);
  const dir = useStore((s) => s.dir);
  return (
    <ViewerPage>
      <TodosSection />
      <TurnUsageSection messages={chat?.messages ?? []} dir={dir} />
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
