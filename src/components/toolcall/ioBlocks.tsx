import { fixZwsp } from '../../lib/bidi'
import type { ToolActivity } from '../../types'
import { HIDDEN_KEYS, REDUNDANT_ARG_KEYS, fmtArgValue } from './args'
import { canonicalTool, isBatchTool, toolLabel } from './naming'
import { FileResultLinks, MEDIA_TOOLS, MediaResultLinks, TerminalResultText, isWebRow, resultRows } from './results'

/**
 * Request / Response blocks of an opened tool card (user request).
 *
 * A tool call reads as two labelled panels: **Request** — the arguments the
 * model sent, one `key  value` row each — and **Response** — the text the tool
 * returned. Older cards printed a raw `Args` JSON-ish dump and a bare `Result`
 * blob; splitting them into two framed blocks makes an opened card scannable
 * and matches the surrounding transcript chrome.
 */

/** Args worth printing: never the payloads the diff already shows (file
 *  contents) and never an arg the row head/label already states verbatim. */
export function requestEntries(
  activity: ToolActivity,
): Array<[string, string]> {
  const args = activity.args
  if (!args) return [];
  const skip = REDUNDANT_ARG_KEYS[canonicalTool(activity.tool)];
  // A batch's `ops` are rendered op by op (see BatchOps), not as one JSON blob.
  const batch = isBatchTool(activity.tool);
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(args)) {
    if (HIDDEN_KEYS.has(k) || skip?.has(k) || (batch && k === "ops")) continue;
    const text = fmtArgValue(v).trim();
    if (!text) continue;
    out.push([k, text]);
  }
  return out;
}

function IOBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="trace-io">
      <div className="trace-io-head">{title}</div>
      <div className="trace-io-body">{children}</div>
    </div>
  );
}

/** The inner calls of a `batch` / `batch_search` wrapper, in order. `ops` may
 *  arrive double-encoded (a stringified array) — decoded like the backend. */
function batchOps(
  activity: ToolActivity,
): Array<{ tool: string; args: Record<string, unknown> }> {
  let ops: unknown = activity.args?.ops;
  if (typeof ops === "string") {
    try {
      ops = JSON.parse(ops);
    } catch {
      ops = undefined;
    }
  }
  if (!Array.isArray(ops)) return [];
  const out: Array<{ tool: string; args: Record<string, unknown> }> = [];
  for (const op of ops) {
    const o = (op && typeof op === "object" ? op : {}) as {
      tool?: unknown;
      args?: unknown;
    };
    if (typeof o.tool !== "string" || !o.tool.trim()) continue;
    const args =
      o.args && typeof o.args === "object" && !Array.isArray(o.args)
        ? (o.args as Record<string, unknown>)
        : {};
    out.push({ tool: o.tool.trim(), args });
  }
  return out;
}

/** One op arg as readable text: a list of ranges / paths becomes one line each
 *  (`path:offset–end`) instead of a JSON dump. */
function fmtOpValue(v: unknown): string {
  if (!Array.isArray(v)) return fmtArgValue(v);
  return v
    .map((it) => {
      if (it && typeof it === "object" && "path" in it) {
        const r = it as { path?: unknown; offset?: unknown; limit?: unknown };
        const off = Number(r.offset);
        const lim = Number(r.limit);
        const range =
          Number.isFinite(off) && Number.isFinite(lim) && lim > 0
            ? `:${off}–${off + lim - 1}`
            : Number.isFinite(off) && r.offset != null
              ? `:${off}`
              : "";
        return `${String(r.path)}${range}`;
      }
      return fmtArgValue(it);
    })
    .join("\n");
}

/** The ops of a batch as numbered steps, each with its own `key  value` rows. */
function BatchOps({ activity }: { activity: ToolActivity }) {
  const ops = batchOps(activity);
  return (
    <>
      {ops.map((op, i) => {
        const rows = Object.entries(op.args).filter(
          ([k, v]) => !HIDDEN_KEYS.has(k) && fmtOpValue(v).trim() !== "",
        );
        return (
          <div key={i} className="trace-io-op">
            <div className="trace-io-op-head">
              <span className="trace-io-op-n">{i + 1}</span>
              {toolLabel(canonicalTool(op.tool))}
            </div>
            {rows.map(([k, v]) => (
              <div key={k} className="trace-io-row">
                <span className="trace-io-key">{k}</span>
                <span className="trace-io-val" dir="auto">
                  {fixZwsp(fmtOpValue(v).trim())}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

/** The call's arguments as a `key  value` table. Renders nothing when the tool
 *  carried no printable arg (a bare `list_files`, a skill load). */
export function TraceRequestBlock({ activity }: { activity: ToolActivity }) {
  const entries = requestEntries(activity);
  const hasOps = isBatchTool(activity.tool) && batchOps(activity).length > 0;
  if (entries.length === 0 && !hasOps) return null;
  return (
    <IOBlock title="Request">
      {hasOps && <BatchOps activity={activity} />}
      {entries.map(([k, v]) => (
        <div key={k} className="trace-io-row">
          <span className="trace-io-key">{k}</span>
          <span className="trace-io-val" dir="auto">
            {fixZwsp(v)}
          </span>
        </div>
      ))}
    </IOBlock>
  );
}

/** The tool's plain-text result. File/web result LISTS keep their own
 *  components — this block is only for prose output, and a terminal call keeps
 *  its coloured output in the `Results` section instead. */
export function TraceResponseBlock({ activity }: { activity: ToolActivity }) {
  const terminal = canonicalTool(activity.tool) === "run_terminal";
  // A terminal's output renders through TerminalResultText below, not as prose.
  const text = terminal ? "" : (activity.resultText?.trim() ?? "");
  // Web hits render inside their own row (InlineWebResults), never here.
  const rows = isWebRow(activity) ? [] : resultRows(activity);
  // The files the call touched (icon + name) sit in the SAME Response panel as
  // its text output — a read / batch carries both, and showing only the names
  // hid the actual result (user request).
  const filesNode = terminal ? (
    activity.resultText ? (
      <TerminalResultText
        items={activity.items ?? activity.results}
        fallbackText={activity.resultText}
      />
    ) : null
  ) : rows.length > 0 ? (
    MEDIA_TOOLS.has(activity.tool) ? (
      <MediaResultLinks items={rows} />
    ) : (
      <FileResultLinks tool={activity.tool} items={rows} />
    )
  ) : null;
  if (!text && !filesNode) return null;
  // A batch answers with one `=== [i/n] tool ===` section per op: show each as
  // its own labelled step instead of one undivided wall of text.
  if (text && isBatchTool(activity.tool)) {
    const parts = text.split(/^(=== \[\d+\/\d+\] .*? ===)\s*$/m);
    if (parts.length > 2) {
      const sections: Array<{ n: string; head: string; body: string }> = [];
      for (let i = 1; i < parts.length; i += 2) {
        const m = /\[(\d+)\/\d+\]\s+([A-Za-z0-9_]+)(.*?)\s*===$/.exec(parts[i]);
        sections.push({
          n: m ? m[1] : "",
          head: m
            ? `${toolLabel(canonicalTool(m[2]))}${m[3] ? ` ${m[3].trim()}` : ""}`
            : parts[i],
          body: (parts[i + 1] ?? "").trim(),
        });
      }
      return (
        <IOBlock title="Response">
          {filesNode && <div className="trace-io-files">{filesNode}</div>}
          {sections.map((s, i) => (
            <div key={i} className="trace-io-op">
              <div className="trace-io-op-head">
                {s.n && <span className="trace-io-op-n">{s.n}</span>}
                {s.head}
              </div>
              {s.body && (
                <pre className="trace-io-pre" dir="auto">
                  {fixZwsp(s.body)}
                </pre>
              )}
            </div>
          ))}
        </IOBlock>
      );
    }
  }
  return (
    <IOBlock title="Response">
      {filesNode && <div className="trace-io-files">{filesNode}</div>}
      {text && (
        <pre className="trace-io-pre" dir="auto">
          {fixZwsp(text)}
        </pre>
      )}
    </IOBlock>
  );
}

/** Any other labelled text panel of an opened card (a diff, a summary). Same
 *  frame as Request/Response so every block of the body reads alike. */
export function TraceTextBlock({
  title,
  text,
  pre = true,
}: {
  title: string;
  text: string;
  pre?: boolean;
}) {
  if (!text.trim()) return null;
  return (
    <IOBlock title={title}>
      {pre ? (
        <pre className="trace-io-pre" dir="auto">
          {fixZwsp(text)}
        </pre>
      ) : (
        <div className="trace-io-val" dir="auto">
          {fixZwsp(text)}
        </div>
      )}
    </IOBlock>
  );
}
