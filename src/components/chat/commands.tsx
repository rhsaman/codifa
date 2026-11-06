import type { ScheduleFlags } from '../../lib/slash'

export const COMMANDS: Array<{ name: string; hint: string }> = [
  { name: "help", hint: "List all commands" },
  { name: "compact", hint: "Summarize & compact the chat context" },
  { name: "clear", hint: "Clear all messages in this chat (stops a running turn)" },
  { name: "new", hint: "Start a new chat" },
  { name: "plan", hint: "Switch this chat to Plan mode (describe the work after the command to plan it)" },
  { name: "undo", hint: "Undo the last exchange (stops a running turn first)" },
  { name: "redo", hint: "Redo the last undone exchange" },
  {
    name: "plugin",
    hint: "Create, install, edit, toggle or delete a plugin — skills + connectors as one bundle (e.g. /plugin install <repo>)",
  },
  {
    name: "artifact",
    hint: "Build or manage an artifact — a previewable HTML/Markdown document (e.g. /artifact create <description>)",
  },
  {
    name: "schedule",
    hint: "Create, edit, run or delete a scheduled task (e.g. /schedule create every day at 9am …)",
  },
  { name: "goal", hint: "Set a persistent goal (e.g. /goal all tests pass); /goal clear clears it" },
];

/** The argument a sub-command's token expects, and where it lives in the line. */
export type CmdArg = "name" | "repo" | "url" | "free";

/**
 * Permissions the Computer Use card has to report, plus the signing identity
 * macOS keyed them to. `identity` is null off macOS, where there is no TCC.
 */
export type PermInfo = {
  screen: boolean;
  accessibility: boolean;
  identity: { id: string; name: string; path: string; adhoc: boolean } | null;
};

/** How long the named values behind the third level are reused before a refetch.
 *  Short enough that a plugin just installed appears, long enough that opening
 *  the palette costs no request. */
export const ARG_VALUE_TTL_MS = 15_000;

/** The `--plugins` picks, spelled out for the schedule prompt.
 *
 *  The composer let the user PICK the values, so handing the model a sentence it
 *  may re-interpret loses the choice; naming the array verbatim makes it pass
 *  the list straight to the tool. Empty when the line carried no flags. */
export function describeScheduleFlags(flags: ScheduleFlags): string {
  return flags.plugins.length ? `plugins=[${flags.plugins.join(", ")}]` : "";
}

/** True when a message asks to create/edit/install/import skills or MCP connectors,
 *  so the agent gets the `create_skill` / `create_mcp` tools for the turn.
 *  Matches English AND Persian intent words (نصب/ساخت/بساز/ایجاد/ذخیره/اضافه/ویرایش/ادیت/اصلاح/تغییر/حذف/آپدیت/بروز →
 *  action; اسکیل/مهارت → skill target) so Persian-only prompts work too.
 *  `create_skill` overwrites an existing skill with the same name, so the same
 *  grant covers both creating AND editing a skill. */
export function wantsSkillOrMcp(text: string): boolean {
  const low = text.toLowerCase();
  const action =
    /\b(install|add|create|import|save|set up|setup|copy|edit|update|modify|change|fix|delete|remove)\b|(نصب|ساخت|بساز|ایجاد|ذخیره|اضافه|ویرایش|ادیت|اصلاح|تغییر|حذف|آپدیت|بروز)/.test(
      low,
    );
  const target = /\b(skill|mcp|connector)s?\b|(اسکیل|مهارت|کانکتور|ام‌سی‌پی)/.test(low);
  return action && target;
}

/** True when a message asks to create/edit/pause/delete a scheduled task, so
 *  the agent gets the `schedule` tool for the turn. */
export function wantsSchedule(text: string): boolean {
  const low = text.toLowerCase();
  const action =
    /\b(create|add|make|set up|setup|edit|update|change|pause|resume|enable|disable|delete|remove|schedule)\b|(بساز|ساخت|ایجاد|ویرایش|ادیت|اصلاح|تغییر|حذف|متوقف|فعال|غیرفعال|زمان‌بندی|زمانبندی)/.test(
      low,
    );
  const target = /\b(schedule|scheduled|cron|recurring|reminder)s?\b|(تسک|کرون|تکرار|یادآور|زمان‌بندی)/.test(
    low,
  );
  return action && target;
}

/** True when a message asks to create/edit/toggle/delete a plugin bundle. */
export function wantsPlugin(text: string): boolean {
  const low = text.toLowerCase();
  const action =
    /\b(install|add|create|make|edit|update|change|toggle|enable|disable|delete|remove)\b|(نصب|ساخت|بساز|ایجاد|ویرایش|ادیت|اصلاح|تغییر|حذف|روشن|خاموش|فعال|غیرفعال)/.test(
      low,
    );
  const target = /\bplugin(s)?\b|(پلاگین|افزونه)/.test(low);
  return action && target;
}

/** The only commands whose `update <name>` pick opens a pinned session. */
