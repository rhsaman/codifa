import type { ToolActivity } from "../types";
import { useViewerTabs } from "../lib/viewerTabs";
import { StatusIcon, toolLabel, useRunningClock } from "./ToolCallView";

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
  // Keyed by LABEL, not raw tool name: `grep` and `glob` both render as
  // "Search Files", so keying on the name produced two chips with an identical
  // label ("Search Files ×2" twice) instead of one tallied chip.
  const counts = new Map<string, ExploreToolCount>();
  const walk = (list?: ToolActivity[]) => {
    for (const a of list ?? []) {
      const label = toolLabel(a.tool);
      const cur = counts.get(label);
      if (cur) {
        cur.count += 1;
      } else {
        counts.set(label, { tool: a.tool, label, count: 1 });
      }
      walk(a.children);
    }
  };
  walk(activity.children);
  return [...counts.values()];
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

/** One-line state word for the status badge's title/aria-label. */
function statusLabel(status: ToolActivity["status"]): string {
  if (status === "running") return "Working…";
  if (status === "error") return "Failed";
  if (status === "denied") return "Blocked";
  return "Done";
}

/** Chat-side card for ONE explore (sub-agent) run.
 *
 *  The card stays a compact summary inside the chat: a live status badge
 *  (spinner while the run works, a check once it lands), the run title, and
 *  one chip per tool with its call count — so the user sees WHAT ran and HOW
 *  MANY times without reading a wall of output. The calls themselves live in
 *  the right-hand panel — clicking the card opens (or retargets) that run's
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
  const total = exploreCallTotal(activity);
  const state = statusLabel(activity.status);

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
          <span
            className={`explore-card-status ${activity.status}`}
            role="img"
            title={state}
            aria-label={state}
          >
            <StatusIcon status={activity.status} />
          </span>
          <span className="trace-pill trace-pill-sub">Explore</span>
          <span className="trace-head-desc" dir="auto" title={title}>
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
        {running && <div className="explore-card-progress" aria-hidden="true" />}
        {counts.length > 0 && (
          <div className="explore-tool-chips">
            {counts.map((c) => (
              <span key={c.label} className="explore-tool-chip" title={c.label}>
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
