import type { ToolActivity } from "../types";
import { useViewerTabs } from "../lib/viewerTabs";
import { toolLabel, useRunningClock } from "./ToolCallView";

/** Short label of an explore (sub-agent) run: the model's own description when
 *  it supplied one, else the run summary, else a plain "Explore". */
export function exploreTitle(activity: ToolActivity): string {
  const args = (activity.args ?? {}) as Record<string, unknown>;
  const desc = typeof args.description === "string" ? args.description.trim() : "";
  const summary = typeof activity.summary === "string" ? activity.summary.trim() : "";
  const first = (desc || summary).split("\n")[0] ?? "";
  return first.length > 120 ? `${first.slice(0, 120)}…` : first || "Explore";
}

/** One tally entry: how many times a tool ran inside an explore run. */
export interface ExploreToolCount {
  tool: string;
  label: string;
  count: number;
}

/** Tool tally of one run (children, nested ones included): which tools the
 *  sub-agent called and how many times. Drives both the chips on the chat card
 *  and the side panel's header summary, so the two views never disagree. */
export function exploreToolCounts(activity: ToolActivity): ExploreToolCount[] {
  const counts = new Map<string, number>();
  const walk = (list?: ToolActivity[]) => {
    for (const a of list ?? []) {
      counts.set(a.tool, (counts.get(a.tool) ?? 0) + 1);
      walk(a.children);
    }
  };
  walk(activity.children);
  return [...counts.entries()].map(([tool, count]) => ({
    tool,
    label: toolLabel(tool),
    count,
  }));
}

/** Total number of tool calls a run made (nested calls included). */
export function exploreCallTotal(activity: ToolActivity): number {
  return exploreToolCounts(activity).reduce((n, c) => n + c.count, 0);
}

function fmtMs(ms?: number): string {
  if (!ms) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Chat-side card for ONE explore (sub-agent) run.
 *
 *  The card stays a compact summary inside the chat: it names the run and
 *  chips every tool it used with its call count, so the user sees WHAT ran and
 *  HOW MANY times without reading a wall of output. The calls themselves live
 *  in the right-hand panel — clicking the card opens (or retargets) that run's
 *  tool group there via `openExplore` (user request). */
export function ExploreCard({
  activity,
  messageId,
  index,
}: {
  activity: ToolActivity;
  messageId: string;
  index: number;
}) {
  const running = activity.status === "running";
  const now = useRunningClock(running);
  const ms =
    running && activity.startedAt ? now - activity.startedAt : activity.elapsedMs;
  const title = exploreTitle(activity);
  const counts = exploreToolCounts(activity);
  const total = counts.reduce((n, c) => n + c.count, 0);

  return (
    <div className={`tool-card explore ${activity.status}${running ? " running" : ""}`}>
      <div className="tool-group explore">
        <button
          type="button"
          className="trace-head explore-card-open"
          title="Open this run's tool calls in the side panel"
          aria-label={`Open ${title} in the side panel`}
          onClick={() =>
            useViewerTabs.getState().openExplore(messageId, index, title)
          }
        >
          <span className="explore-card-icon" aria-hidden="true">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.6-3.6" />
            </svg>
          </span>
          <span className="trace-pill trace-pill-sub">Explore</span>
          <span className="trace-head-desc" dir="auto">
            {" · "}
            {title}
          </span>
          <span className="trace-head-right">
            {total > 0 && (
              <span className="explore-card-count">{`${total} calls`}</span>
            )}
            {ms ? <span className="trace-time">{fmtMs(ms)}</span> : null}
            <span className="explore-card-arrow" aria-hidden="true">
              ↗
            </span>
          </span>
        </button>
        {counts.length > 0 && (
          <div className="explore-tool-chips">
            {counts.map((c) => (
              <span key={c.tool} className="explore-tool-chip">
                <span className="explore-tool-name">{c.label}</span>
                <span className="explore-tool-n">{`×${c.count}`}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
