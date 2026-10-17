import { useState } from "react";
import type { ToolActivity } from "../types";
import { useStore } from "../lib/store";
import { terminalOutputText } from "../lib/toolActivity";
import { exploreTitle, exploreToolCounts } from "./ExploreCard";
import { StatusIcon } from "./ToolCallView";

/** One argument line ("path: src/a.ts") for a call row's body. */
function argsText(activity: ToolActivity): string {
  const args = activity.args ?? {};
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

/** Short, human line for a call: its first meaningful argument. */
function callDetail(activity: ToolActivity): string {
  const args = (activity.args ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  return (
    pick("path") ||
    pick("filePath") ||
    pick("command") ||
    pick("pattern") ||
    pick("query") ||
    pick("description") ||
    ""
  ).split("\n")[0];
}

/** Everything a call produced: search/terminal output, diff, or result text. */
function callBody(activity: ToolActivity): string {
  const parts: string[] = [];
  const out = terminalOutputText(activity.items ?? activity.results);
  if (out) parts.push(out);
  if (activity.diff) parts.push(activity.diff);
  if (activity.resultText) parts.push(activity.resultText);
  return parts.join("\n\n");
}

/** One tool call of the run — collapsible, so a long run stays scannable: the
 *  head names the tool and its target, the body carries args, diff and output. */
function ExploreCallRow({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const detail = callDetail(activity);
  const body = callBody(activity);
  const args = argsText(activity);
  const hasBody = Boolean(body || args);
  return (
    <div className={`explore-call ${activity.status}`}>
      <button
        type="button"
        className="explore-call-head"
        disabled={!hasBody}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`explore-call-dot ${activity.status}`} aria-hidden="true" />
        <span className="explore-call-tool">{activity.tool}</span>
        {detail && (
          <span className="explore-call-detail" dir="auto" title={detail}>
            {detail}
          </span>
        )}
        <span className="explore-call-chev" aria-hidden="true">
          {hasBody ? (open ? "▾" : "▸") : ""}
        </span>
      </button>
      {open && hasBody && (
        <div className="explore-call-body">
          {args && (
            <pre className="trace-expand-pre" dir="auto">
              {args}
            </pre>
          )}
          {body && (
            <pre className="trace-expand-pre explore-call-out" dir="auto">
              {body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Side-panel body of ONE explore run: that run's tool group — every call the
 *  sub-agent made, each one collapsible — plus a per-tool tally of how often
 *  each tool ran. The final report is deliberately NOT the payload here:
 *  clicking the chat card is about inspecting what ran, not re-reading the
 *  answer (user request). */
export function ExplorePanel({
  chatId,
  messageId,
  index,
}: {
  chatId: string;
  messageId: string;
  index: number;
}) {
  const activity = useStore((s) => {
    const chat = s.chats.find((c) => c.id === chatId);
    const msg = chat?.messages.find((m) => m.id === messageId);
    return msg?.toolActivity?.[index] ?? null;
  });

  if (!activity) {
    return (
      <div className="viewer-empty">
        This explore run is no longer in memory (e.g. after a restart).
      </div>
    );
  }

  const counts = exploreToolCounts(activity);
  const total = counts.reduce((n, c) => n + c.count, 0);
  const kids = activity.children ?? [];

  return (
    <div className="explore-panel">
      <div className="explore-panel-head">
        <span
          className={`explore-card-status ${activity.status}`}
          role="img"
          aria-label={`Explore run: ${activity.status}`}
        >
          <StatusIcon status={activity.status} />
        </span>
        <span className="trace-pill trace-pill-sub">Explore</span>
        <span className="explore-panel-title" dir="auto">
          {exploreTitle(activity)}
        </span>
        {total > 0 && <span className="explore-panel-count">{`${total} tool calls`}</span>}
      </div>
      {counts.length > 0 && (
        <div className="explore-tool-chips">
          {counts.map((c) => (
            // Keyed by LABEL (`exploreToolCounts` tallies by label), not the raw
            // tool name: `read` and an alias like `read_client` share one label,
            // so a name-based key emitted two identical chips ("Read File ×4"
            // next to "read_client ×2") instead of one merged tally.
            <span key={c.label} className="explore-tool-chip">
              <span className="explore-tool-name">{c.label}</span>
              <span className="explore-tool-n">{`×${c.count}`}</span>
            </span>
          ))}
        </div>
      )}
      {activity.status === "running" && (
        <div className="explore-card-progress" aria-hidden="true" />
      )}
      {activity.status === "running" && (
        <div className="explore-panel-running">
          <span className="spinner" /> Working…
        </div>
      )}
      {kids.length === 0 ? (
        <div className="viewer-empty">No tool calls recorded for this run yet.</div>
      ) : (
        <div className="explore-call-list">
          {kids.map((call, i) => (
            <ExploreCallRow key={call.callId ?? `${call.tool}-${i}`} activity={call} />
          ))}
        </div>
      )}
    </div>
  );
}
