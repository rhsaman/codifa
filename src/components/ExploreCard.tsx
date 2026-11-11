import type { ToolActivity } from "../types";
import { toolLabel } from "./ToolCallView";
import { batchOpTools, isBatchTool } from "./toolcall/naming";

/** Short label of a sub-agent run: the model's own description when it supplied
 *  one, else the run summary, else the sub-agent's own name. */
export function exploreTitle(activity: ToolActivity, fallback = "Explore"): string {
  const args = (activity.args ?? {}) as Record<string, unknown>;
  const desc = typeof args.description === "string" ? args.description.trim() : "";
  const summary = typeof activity.summary === "string" ? activity.summary.trim() : "";
  const first = (desc || summary).split("\n")[0] ?? "";
  return first.length > 120 ? `${first.slice(0, 120)}…` : first || fallback;
}

/** One tally entry: how many times a tool ran inside an explore run. */
export interface ExploreToolCount {
  tool: string;
  label: string;
  count: number;
}

/** Tool tally of one run (children, nested ones included): which tools the
 *  sub-agent called and how many times. Drives the side panel's header
 *  summary and the thinking strip's "N searches, M reads" line, so the two
 *  views never disagree.
 *
 *  (The chat card itself no longer uses these tallies: it renders as a
 *  ToolGroupView with the agent's name in the header — see renderSegments in
 *  ChatMessage.tsx.) */
export function exploreToolCounts(activity: ToolActivity): ExploreToolCount[] {
  // Keyed by LABEL, not raw tool name: `grep` and `glob` both render as
  // "Search Files", so keying on the name produced two chips with an identical
  // label ("Search Files ×2" twice) instead of one tallied chip.
  const counts = new Map<string, ExploreToolCount>();
  const walk = (list?: ToolActivity[]) => {
    for (const a of list ?? []) {
      // A `batch` call IS its inner ops on the UI: a bare "Batch ×3" chip says
      // nothing about what ran (user request). Tally each op's tool as its own
      // chip. `batchOpTools` reads the call's args and, for a transcript whose
      // args were lost, the op labels the executor echoes in the result — so an
      // older run never falls back to a plain "batch" chip.
      if (isBatchTool(a.tool)) {
        const ops = batchOpTools(a);
        if (ops.length > 0) {
          for (const tool of ops) {
            const label = toolLabel(tool);
            const cur = counts.get(label);
            if (cur) {
              cur.count += 1;
            } else {
              counts.set(label, { tool, label, count: 1 });
            }
          }
          continue;
        }
      }
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
