import type { ChatUsage } from './chat.ts'
import type { Settings } from './settings.ts'


/** One marketplace the user added: a repo holding an index of plugins.
 *
 *  The three address fields mirror what an install needs, so a row browsed here
 *  can be installed (and later updated) without any translation.
 *  `kind` is the tab the catalogue shows FIRST when this marketplace is opened —
 *  a skills repo is browsed looking for skills, not plugins.
 */
export interface MarketplaceSource {
  /** `owner/repo`, a GitHub URL, or a local folder. */
  repo: string
  /** Display name; falls back to the repo when absent. */
  label?: string
  /** Sub-folder holding the index. */
  path?: string
  /** Branch/tag/commit of the index. */
  git_ref?: string
  /** Which catalogue kind this repo is browsed for. */
  kind?: MarketplaceKind
}

/** What a marketplace's rows are browsed as. Every kind still lists the same
 *  index rows — a skills repo's bundles happen to carry skills, an MCP one
 *  carries connectors — the kind only picks the default tab and the wording. */
export type MarketplaceKind = 'plugins' | 'skills' | 'mcp'

/** One plugin folder: skills + MCP connectors bundled behind a single switch. */
export interface PluginInfo {
  name: string
  slug: string
  /** Absolute folder of the bundle, when the list carries it — what an update
   *  session pins the composer badge to. */
  dir?: string
  description?: string
  version?: string
  enabled: boolean
  /** Skill names the folder currently holds. */
  skills?: string[]
  /** Connector names the folder currently holds. */
  mcp?: string[]
  /** Names of the runnable scripts the folder holds. The assistant runs one
   *  during a turn through its `plugin` tool (`action: "run"`). */
  scripts?: string[]
  /** Slash commands the folder ships. Each one is typed in the composer as
   *  `/name args`, and its body receives the arguments where it writes
   *  `$ARGUMENTS` / `$1`..`$9`. */
  commands?: string[]
  /** Sub-agent profiles the folder ships. Each is offered to the model as a
   *  delegation tool, and they ALL run on the Explore row of Settings → Tools. */
  agents?: string[]
  /** Shell guards declared in `hooks/hooks.json`, as `Event: command` rows.
   *  They run while the bundle itself is enabled — the switch on its card. */
  hooks?: Array<{ event: string; matcher?: string; command: string; dispatched?: boolean }>
  /** Repo (or folder) the bundle was installed from, when it was. */
  source?: string
  /** The install ARGUMENTS of `source`, re-runnable as-is. `source` alone is a
   *  display string and cannot be fed back to an install, so "update from
   *  source" needs these. */
  source_repo?: string
  source_path?: string
  source_ref?: string
  created_at?: number
  updated_at?: number
}

/** Result of installing a plugin bundle out of a repo. */
export interface PluginInstallResult {
  installed: 'created' | 'updated'
  slug: string
  source?: string
  skills?: string[]
  mcp?: string[]
  scripts?: string[]
  commands?: string[]
  agents?: string[]
  hooks?: Array<{ event: string; matcher?: string; command: string; dispatched?: boolean }>
  /** One line naming what actually landed — a bundle carrying only commands
   *  used to answer with three empty arrays, which reads like a failed install. */
  summary?: string
  plugin?: PluginInfo
}

/** یک تسک زمان‌بندی‌شده (مثل Codex): پرامپت + تکرار کرون + اجرای پس‌زمینه. */
export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  /** کرون ۵ فیلدی نرمال‌شده (به زمان لوکال ماشین ارزیابی می‌شود)؛ رشته خالی یعنی اجرای یک‌باره. */
  cron: string
  /** توصیف فارسی کوتاه برای نمایش (از بک‌اند می‌آید). */
  cron_label?: string
  enabled: boolean
  root: string
  mode: string
  provider_id?: string
  model?: string
  /** اسکیل/کانکتور/پلاگین ضمیمهشده به هر اجرا (اسمها و slug). */
  skills?: string[]
  mcp_servers?: string[]
  plugins?: string[]
  /** اجازه‌ی مروربر برای هر اجرا: روشن = ایجنتِ زمان‌بندی‌شده می‌تواند مرورگر
   *  داخلی (و پروفایل مشترک با لاگین‌های ذخیره‌شده) را براند. پیش‌فرض خاموش. */
  allow_browser?: boolean
  /** نوبت بعدی اجرا (epoch ثانیه)؛ null یعنی بدون نوبت بعدی. */
  next_run?: number | null
  last_run?: number | null
  run_count?: number
  created_at?: number
  updated_at?: number
}

/** یک اجرای ثبت‌شده‌ی تسک زمان‌بندی (تاریخچه). */
export interface ScheduleRun {
  id: string
  schedule_id: string
  status: 'running' | 'done' | 'error'
  output?: string
  error?: string
  started_at: number
  finished_at?: number
  /** مصرف توکن تجمیع‌شده‌ی این اجرا (همان شکل ChatUsage) — برای model usage. */
  usage?: ChatUsage
}
