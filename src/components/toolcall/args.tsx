import { fixZwsp } from '../../lib/bidi'
import type { ToolActivity } from '../../types'
import { DiffView } from './diff'
import { shortArg, subArgSummary } from './groups'
import { canonicalTool, isBatchTool } from './naming'

export const HEADER_SHOWN_KEYS = new Set([
  "command",
  "path",
  "filePath",
  "offset",
  "limit",
  "start",
  "end",
  "query",
  "pattern",
  "description",
  "subagent_type",
  "prompt",
  "task_id",
  "text",
  "subject",
  "paths",
  "engine",
]);

/** Huge payloads that are never worth showing inline (the diff shows them). */
export const HIDDEN_KEYS = new Set(["content", "old_string", "new_string"]);

export function fmtArgValue(v: unknown): string {
  if (typeof v === "string") return fixZwsp(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(fmtArgValue).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Args the row head/subtitle already states for one tool: repeating them as
 *  `key: value` chips only adds noise (`name:ponytail` beside the skill's own
 *  name). Scoped per tool so e.g. `create_skill` keeps showing its `name`. */
export const REDUNDANT_ARG_KEYS: Record<string, Set<string>> = {
  load_skill: new Set(["name", "file", "query"]),
  load_plugin: new Set(["slug", "skill", "file", "query"]),
};

/** Remaining args rendered as clean `key: value` chips inside the card head —
 *  no raw JSON blob in the body. */
export function ToolArgs({
  args,
  tool,
}: {
  args: Record<string, unknown>;
  tool?: string;
}) {
  const skip = REDUNDANT_ARG_KEYS[canonicalTool(tool ?? "")];
  // A `batch` call's args ARE its inner ops: the raw JSON dump said nothing
  // about what ran (user request), and the card label already names the tools
  // it ran (`activityLabel`) — so no chips here; the per-op detail lives in the
  // expanded body.
  if (tool === "batch" || tool === "batch_search") return null;
  const entries = Object.entries(args).filter(
    ([k]) =>
      !HEADER_SHOWN_KEYS.has(k) && !HIDDEN_KEYS.has(k) && !skip?.has(k),
  );
  if (entries.length === 0) return null;
  return (
    <span className="tool-args" dir="ltr">
      {entries.map(([k, v]) => (
        <span key={k} className="tool-arg">
          <span className="tool-arg-key">{k}</span>
          <span className="tool-arg-val">{fmtArgValue(v)}</span>
        </span>
      ))}
    </span>
  );
}

/** Expanded-body arg dump. Shared by both row variants so they can never drift,
 *  and filtered so a tool's already-stated args are not printed twice. */
export function argsTextFor(activity: ToolActivity): string {
  const args = activity.args;
  if (!args) return "";
  const skip = REDUNDANT_ARG_KEYS[canonicalTool(activity.tool)];
  return Object.entries(args)
    .filter(([k]) => !skip?.has(k))
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

/** One-line row detail: the plugin/skill a load names (its backend summary is
 *  only the tool name, which the label already shows), else the backend
 *  summary, else whatever the args say. */
export function rowDetail(activity: ToolActivity): string {
  const tool = canonicalTool(activity.tool);
  // The row's label already names the tools a batch ran; repeating them (or
  // the wrapper's own name) in the detail would only add noise.
  if (isBatchTool(tool)) return "";
  if (tool === "load_plugin") {
    const what = [activity.args?.slug, activity.args?.skill]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join(" / ");
    if (what) return shortArg(what, 60);
    const q = String(activity.args?.query ?? "");
    return q ? shortArg(q, 48) : "";
  }
  if (tool === "load_skill") {
    const name = String(activity.args?.name ?? activity.args?.file ?? "");
    if (name) return shortArg(name, 60);
  }
  return activity.summary ? fixZwsp(activity.summary) : subArgSummary(activity);
}

/** هایلایت ساده‌ی TOML: کلید نارنجی، رشته زرد-سبز، کامنت خاکستری.
 *  فقط برای فایل‌های toml اعمال می‌شود (DiffView بر اساس مسیر تصمیم می‌گیرد). */
