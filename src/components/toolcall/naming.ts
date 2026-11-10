import { bareToolName, mcpServerOf } from '../../lib/mcpTools'
import { diffStatsFromUnified } from '../../lib/toolActivity'
import type { CustomSubagent, ToolActivity } from '../../types'
import { DELEGATION_PREFIX, isDelegationTool, subagentIdOf } from '../../lib/subagents'
import { useEffect, useState } from 'react'
import { ToolEditGroupView } from './editGroup'
import { ToolGroupView } from './groups'

export const TICK_MS = 500;
export let sharedTickId: ReturnType<typeof setInterval> | null = null;
export const tickListeners = new Set<() => void>();

export function ensureSharedTick(): void {
  if (sharedTickId !== null) return;
  sharedTickId = setInterval(() => {
    for (const cb of tickListeners) cb();
  }, TICK_MS);
  const t = sharedTickId as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}

export function releaseSharedTick(): void {
  if (tickListeners.size === 0 && sharedTickId !== null) {
    clearInterval(sharedTickId);
    sharedTickId = null;
  }
}

/** Live clock for a running tool row. Ticks every 500ms while `running`,
 *  frozen otherwise — backed by the single shared ticker above. */
export function useRunningClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const cb = () => setNow(Date.now());
    tickListeners.add(cb);
    ensureSharedTick();
    return () => {
      tickListeners.delete(cb);
      releaseSharedTick();
    };
  }, [running]);
  return now;
}

export const TOOL_LABEL: Record<string, string> = {
  write_file: "Write File",
  edit_file: "Edit File",
  list_files: "List Directory",
  read: "Read File",
  grep: "Search Files",
  glob: "Search Files",
  find_symbol: "Find Symbol",
  web_search: "Web Search",
  run_terminal: "Ran a command",
  run_tests: "Ran related tests",
  search_memory: "Search Memory",
  memory: "Memory",
  ask_user: "Ask User",
  fetch_url: "Fetch URL",
  explore: "Explore",
  vision: "Vision",
  create_skill: "Create Skill",
  create_mcp: "Create MCP",
  load_skill: "Load Skill",
  load_plugin: "Load Plugin",
  update_plan: "Update Plan",
  git_status: "Git Status",
  git_diff: "Git Diff",
  git_commit: "Git Commit",
  git_log: "Git Log",
  current_time: "Current Time",
  system_stats: "System Stats",
  computer: "Computer",
  search_console: "Search Console",
  // Safety net only: a batch card is labelled with the tools it ran
  // (`activityLabel`), so this shows just when no op is known yet.
  batch: "Tools",
};

/** Foreign names for a tool we DO have, mapped to the canonical name.
 *
 *  Models are trained on other agents' vocabularies (`read_client`, `read_file`,
 *  `view_file`, `shell`, `todos`…), so a run can contain calls under a name that
 *  is not ours. `toolLabel` falls back to the RAW name for anything missing from
 *  TOOL_LABEL, which rendered a second, duplicate-looking chip ("Read File ×4"
 *  beside "read_client ×2"). Normalizing here merges old AND new history into
 *  one chip — the backend resolves the same aliases before dispatch. */
export const TOOL_ALIAS: Record<string, string> = {
  read_client: "read",
  read_file: "read",
  readfile: "read",
  view_file: "read",
  read_text_file: "read",
  get_file: "read",
  search_files: "grep",
  search_content: "grep",
  ripgrep: "grep",
  find_files: "glob",
  list_dir: "glob",
  ls: "glob",
  list_directory: "glob",
  shell: "run_terminal",
  bash: "run_terminal",
  sh: "run_terminal",
  run_command: "run_terminal",
  execute_command: "run_terminal",
  search_web: "web_search",
  websearch: "web_search",
  skill: "load_skill",
  create_file: "write_file",
  writefile: "write_file",
  str_replace: "edit_file",
  replace_in_file: "edit_file",
  todos: "update_plan",
  todo_write: "update_plan",
  write_todos: "update_plan",
  update_todos: "update_plan",
  ask: "ask_user",
  ask_question: "ask_user",
  permission: "confirm_action",
  request_permission: "confirm_action",
};

/** Canonical tool name for a raw one (case / dash / underscore-insensitive). */
export function canonicalTool(tool: string): string {
  const aliased =
    TOOL_ALIAS[tool] ??
    TOOL_ALIAS[tool.trim().toLowerCase().replace(/[-\s]/g, "_")] ??
    tool;
  // Case-only variants of a REAL name (`Read`, `read_File`) still normalize.
  const direct = Object.keys(TOOL_LABEL).find(
    (k) => k.toLowerCase() === aliased.trim().toLowerCase(),
  );
  return direct ?? aliased;
}

/** Small glyph per tool category, shown at the head of each collapsed-group
 *  timeline row — lets the eye scan a run of calls without reading every
 *  label (mirrors Claude-app's trace icons). */
export const TOOL_ICON: Record<string, string> = {
  run_terminal: "❯",
  run_tests: "🧪",
  list_files: "📁",
  read: "📄",
  grep: "🔍",
  glob: "🔍",
  find_symbol: "🔎",
  web_search: "🌐",
  fetch_url: "🌐",
  search_memory: "🧠",
  memory: "🧠",
  ask_user: "❓",
  explore: "🔍",
  vision: "🖼",
  create_skill: "⚙",
  create_mcp: "🔌",
  load_skill: "📘",
  load_plugin: "📦",
  update_plan: "📝",
  git_status: "🌿",
  git_diff: "📊",
  git_commit: "✅",
  git_log: "🕘",
  current_time: "🕒",
  system_stats: "📊",
  computer: "🖥",
  search_console: "🔎",
};
export function toolIcon(tool: string): string {
  return TOOL_ICON[tool] ?? "•";
}

/** MCP tools arrive as `mcp__<server>__<tool>`: show the bare tool name with
 *  the connector as a suffix so the card stays readable. A tool whose name is
 *  unique across the enabled connectors arrives BARE already. */
export function toolLabel(tool: string): string {
  const server = mcpServerOf(tool);
  if (server) return `${bareToolName(tool)} · ${server}`;
  const canonical = canonicalTool(tool);
  return TOOL_LABEL[canonical] ?? canonical;
}

/** Canonical names of the tools a `batch` call ran, one per op, in order.
 *
 *  A batch is only a wrapper: the card must say WHAT ran, never the word
 *  "batch". Preferred source is the call's own `args.ops`. Activities rebuilt
 *  from stored history can lose `args`, but the executor labels every op in its
 *  RESULT (`=== [1/2] read ===`), so the names are recoverable from there. */
export function batchOpTools(activity: ToolActivity): string[] {
  const out: string[] = [];
  const ops = activity.args?.ops;
  if (Array.isArray(ops)) {
    for (const op of ops as Array<{ tool?: unknown } | null>) {
      const name = typeof op?.tool === "string" ? op.tool.trim() : "";
      if (name) out.push(canonicalTool(name));
    }
  }
  if (out.length === 0) {
    for (const m of (activity.resultText ?? "").matchAll(
      /=== \[\d+\/\d+\] (\S+) ===/g,
    )) {
      out.push(canonicalTool(m[1]));
    }
  }
  return out;
}

/** The label a card/row shows for one activity. Same as `toolLabel`, except a
 *  `batch` is named after the tools it ran, tallied: "Search Files, Read File ×2". */
export function activityLabel(activity: ToolActivity): string {
  if (activity.tool === "batch") {
    const counts = new Map<string, number>();
    for (const tool of batchOpTools(activity)) {
      const label = toolLabel(tool);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    if (counts.size > 0) {
      return [...counts.entries()]
        .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label))
        .join(", ");
    }
  }
  return toolLabel(activity.tool);
}

/** Prefix the backend advertises every sub-agent profile under: the tool the
 *  model calls is `agent__<id>` (a custom row's stable id, or a bundle agent's
 *  frontmatter name). The builtin research agent keeps the bare `explore`.
 *
 *  Re-exported from `lib/subagents` so the event fold and the render layer
 *  share ONE predicate — a custom agent that is a sub-agent card in the chat
 *  must also nest its children and open its own panel. */
export { DELEGATION_PREFIX, isDelegationTool, subagentIdOf };

/** The name shown in the chat while a sub-agent works.
 *
 *  A custom sub-agent (Settings → Sub-agents) carries its own `name`, so the
 *  card and the Working pill say "Browser Navigator" instead of the raw tool
 *  id. A plugin profile has no row in the store — the readable form of its id
 *  is the honest fallback, and `explore` stays "Explore". */
export function subagentDisplayName(
  tool: string,
  rows: CustomSubagent[],
): string {
  if (tool === "explore") return "Explore";
  const id = subagentIdOf(tool);
  if (!id) return toolLabel(tool);
  const row = rows.find((r) => r.id === id);
  const name = row?.name?.trim();
  if (name) return name;
  const pretty = id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return pretty || "Sub-agent";
}

/** Natural-language piece per tool category for the group header sentence
 *  ("9 commands, 3 searches, 2 notes") — the Claude-app-style summary line
 *  instead of a raw tool-name tally. */
export const TOOL_NOUN: Record<string, [string, string]> = {
  run_terminal: ["command", "commands"],
  run_tests: ["test run", "test runs"],
  list_files: ["file listing", "file listings"],
  read: ["file read", "file reads"],
  grep: ["search", "searches"],
  glob: ["search", "searches"],
  find_symbol: ["symbol lookup", "symbol lookups"],
  web_search: ["web search", "web searches"],
  fetch_url: ["page fetch", "page fetches"],
  search_memory: ["memory search", "memory searches"],
  memory: ["note", "notes"],
  ask_user: ["question", "questions"],
  explore: ["explore run", "explore runs"],
  vision: ["image lookup", "image lookups"],
  create_skill: ["skill saved", "skills saved"],
  create_mcp: ["connector added", "connectors added"],
  load_plugin: ["plugin loaded", "plugins loaded"],
  update_plan: ["plan update", "plan updates"],
  git_status: ["status check", "status checks"],
  git_diff: ["diff check", "diff checks"],
  git_commit: ["commit", "commits"],
  git_log: ["log lookup", "log lookups"],
  current_time: ["time check", "time checks"],
  computer: ["desktop action", "desktop actions"],
  search_console: ["console query", "console queries"],
};
export function groupSummary(activities: ToolActivity[]): string {
  const counts: Record<string, number> = {};
  for (const a of activities) {
    // A batch is only a wrapper: count the tools it ran, never "batch" itself.
    const names = a.tool === "batch" ? batchOpTools(a) : [];
    for (const tool of names.length > 0 ? names : [a.tool]) {
      counts[tool] = (counts[tool] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([tool, n]) => {
      const name = toolLabel(tool);
      return n > 1 ? `${name} ×${n}` : name;
    })
    .join(", ");
}

/** A sub-agent card (explore) — renders with the dedicated sub-agent card
 *  layout and its "explore" CSS class. There is ONE sub-agent tool name:
 *  pre-rename transcripts that recorded the old `task`/`subagent` names are
 *  folded into `explore` at BOTH ingest points (normalizeToolName in
 *  makeToolActivity for the live stream, normalizeToolActivity for the store's
 *  load migration), so a card reaching this predicate always says `explore`. */
export const isSubagentCard = (a: ToolActivity) => isDelegationTool(a.tool);

/** Legacy alias kept for existing tests/callers. */
export const isExploreCard = isSubagentCard;

/** ابزارهای ویرایش فایل — ران‌های پشت‌سرهم آن‌ها در یک گروه ویرایش جدا
 *  (ToolEditGroupView) جمع می‌شوند و هرگز با گروه ابزارهای فقط‌خواندنی
 *  (ToolGroupView) قاطی نمی‌شوند. */
export const EDIT_TOOLS = new Set(["edit_file", "write_file"]);

export const isEditActivity = (a: ToolActivity) => EDIT_TOOLS.has(a.tool);

/** جمع +N -M چند فعالیت ویرایش (ترجیحاً diffStats ذخیره‌شده، وگرنه محاسبه
 *  از روی متن دیف) — برای هدر گروه ویرایش. */
export function editGroupStats(
  activities: { activity: ToolActivity }[],
): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const { activity } of activities) {
    if (!activity.diff) continue;
    const s = activity.diffStats ?? diffStatsFromUnified(activity.diff);
    adds += s.adds;
    dels += s.dels;
  }
  return { adds, dels };
}

/** گروه ویرایش جدا (Claude/Codex-style): ران پشت‌سرهم edit_file/write_file
 *  در یک کارت جمع با هدر «N files · +A -D» و یک ردیف تکی به‌ازای هر فایل.
 *  هر ردیف Undo و Review تکی خودش را حفظ می‌کند (کلیک روی ردیف هم ترن را در
 *  پنل Review سمت راست باز می‌کند). */
