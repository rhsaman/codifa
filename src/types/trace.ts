import type { AskSection, Chat, SearchResultItem } from './chat.ts'


/** یک ورودی لاگ چت جاری برای پنل Trace (لایا / LLM / پرامپت / ابزار) — مثل لنگ‌اسمیت. */
export type TraceKind = 'llm' | 'prompt' | 'tool' | 'fold'

/** یک صفحه از لاگ Trace + شمارش کل لاگ برای نشان‌های تب‌ها.
 *
 *  `total` is the entry count under the ACTIVE filter (so the panel knows
 *  whether an older page exists); `counts` always describes the whole log. */
export interface TracePage {
  traces: TraceEntry[]
  total: number
  counts: { all: number; llm: number; prompt: number; tool: number; fold: number }
}

export interface TraceEntry {
  id: string
  /** زمان ثبت (epoch ثانیه). */
  at: number
  /** Background sub-agent job id (empty for main-agent entries). */
  task_id?: string
  kind: TraceKind
  /** Chat turn number (1-based, from backend). 0/missing = legacy entry. */
  turn?: number
  /** خلاصه یک‌خطی ردیف تاشو. */
  summary: string
  /** جزئیات ساخت‌یافته (مسیر/اطمینان/دلیل لایا، توکن LLM، آرگومان ابزار، …). */
  detail?: Record<string, unknown>
  model?: string
  tokens?: { input?: number; output?: number; total?: number }
  error?: string
  /** متن کامل پرامپت (پرامپت نوبت، پرامپت تک‌شات LLM، یا آرگومان ابزار). */
  prompt?: string
  /** نتیجه ابزار (فقط kind=tool). */
  result?: string
}

/** One live tick of a running context compaction.
 *
 *  Deliberately NOT a completion percentage: a model call reports nothing until
 *  it answers, so the only truthful numbers are the phase, which attempt is
 *  running, and how much of the backend's wall-clock budget is already spent. */
export interface ChatCompactProgress {
  /** `waiting` (manual /compact queued behind a live stream — nothing has
   *  started yet) | `preparing` (selecting the verbatim tail) | `summarizing`
   *  | `merging`. */
  phase: string
  /** 1-based attempt across the primary + fallback chain; 0 before the first. */
  attempt: number
  /** Attempts this run may still make in total (0 when unknown). */
  attempts: number
  /** Model running the current attempt. */
  model: string
  /** Provider ROW the model is routed to (id), so the banner can name the
   *  provider the user configured instead of its wire kind. */
  providerId: string
  /** Share of the budget already spent, 0-100. */
  percent: number
  /** Wall-clock budget for the WHOLE compaction, in seconds. */
  budgetSecs: number
  /** Seconds elapsed since the compaction started. */
  elapsedSecs: number
  /** Local wall-clock stamp (ms) of the last tick. The banner counts on from it
   *  so the clock keeps moving between ticks — a summarizer can sit silent for
   *  a minute inside a single attempt. */
  at: number
}

export type LspProgressPhase = 'installing' | 'updating' | 'done' | 'error'

/** Live LSP install/update progress for one assistant message. Kept on the
 *  message so the thinking/working row can explain a pause (server install
 *  blocks tool results). Transient: never sent as model history. */
export interface LspStatus {
  phase: LspProgressPhase
  language?: string
  message?: string
}

export interface SidecarEvent {
  kind: 'text' | 'thinking' | 'tool' | 'tool_result' | 'tool_output' | 'diff' | 'turn_diff' | 'error' | 'done' | 'usage' | 'retry' | 'retry_giveup' | 'compact' | 'compact_start' | 'compact_progress' | 'compact_failed' | 'plan' | 'plan_card' | 'artifact' | 'edit_target' | 'mode_changed' | 'ctx_parts' | 'permission' | 'ask' | 'skill' | 'mcp' | 'mcp_loaded' | 'steer_applied' | 'steer_interrupt' | 'steer_dropped' | 'status' | 'keepalive'
  /** Status stage (e.g. 'lsp' for language-server install/update progress). */
  stage?: string
  /** edit_target: what an update session pins on the composer badge (the
   *  existing `action`/`name`/`path` fields below carry the rest). */
  target?: 'plugin' | 'skill' | 'mcp' | 'artifact'
  name?: string
  content?: string
  /** Tool name on a tool-card event; on a retry/retry_giveup event it names the
   *  tool that owns the retry (e.g. "explore"), empty for the main agent. */
  tool?: string
  args?: Record<string, unknown>
  summary?: string
  /** Tool-result status: 'error' marks a failed tool call (renders red ✗); 'denied' marks a cap-blocked call (renders ⏹). */
  status?: 'error' | 'done' | 'denied'
  /** Per-call correlation id pairing a 'tool' event with its 'tool_result'. */
  call_id?: number
  /** Number of recent turns the backend preserved verbatim on a 'compact'
   *  event, so the frontend folds exactly the same older turns. */
  keep?: number
  /** `compact_progress`: which phase the summarizer is in (`preparing` /
   *  `summarizing` / `merging`) — lets the banner name what is happening. */
  phase?: string
  /** `compact_progress`: total attempts this run may make (primary + fallback). */
  attempts?: number
  /** `compact_progress`: share of the backend's wall-clock budget already spent. */
  percent?: number
  /** `compact_progress`: wall-clock budget for the whole compaction, seconds. */
  budget_secs?: number
  /** `compact_progress`: seconds elapsed since the compaction started. */
  elapsed_secs?: number
  diff?: string
  path?: string
  /** شماره‌ی snapshot (checkpoint seq) پشت این تغییر — روی eventهای diff
   *  ارسال می‌شود تا Undo از snapshot مطمئن restore کند. */
  checkpoint?: number
  /** Skill names attached for this turn via @mention (the 'skill' event kind). */
  skills?: string[]
  /** True when the skills were attached manually by the user (@mention). */
  manual?: boolean
  /** Informational note on a 'skill' event with an empty skills list (e.g. an attached skill wasn't found). */
  note?: string
  /** True on a 'retry' event emitted by the client's self-healing reconnect:
   * the stream dropped and is being resumed from the on-disk checkpoint. The
   * frontend shows a transient "reconnecting" pill WITHOUT wiping streamed text. */
  reconnecting?: boolean
  /** MCP connector names active for this turn (the 'mcp' event kind). */
  servers?: string[]
  /** update_plan items: [{ content, status }] */
  items?: Array<{ id?: string; content: string; status: string }>
  /** Steer messages the running agent consumed (injected into a tool result);
   *  the frontend removes these ids from the chat's pending queue. */
  ids?: string[]
  /** Structured tool results (web_search hits) shown in the tool card. */
  results?: SearchResultItem[]
  /** Plain-text tool result from the native (Rust) tool loop — the UI
   *  extracts file paths from it and renders clickable file chips instead
   *  of dumping the raw text. */
  result?: string
  /** tool_output: live output tail of a still-RUNNING `run_terminal` call
   *  (streamed every ~500 ms while the command runs). Pairs with `id`. */
  tail?: string
  /** Which web-search provider produced the results (e.g. 'tavily'). */
  engine?: string
  /** True for events emitted by a sub-agent (explore's internal read/grep/glob)
   *  — the parent nests these inside the explore card instead of a top-level card. */
  sub?: boolean
  /** Parallel explore fan-out branch id (0-based). The backend emits one explore
   *  card per branch and tags each branch's sub-events with its id, so the UI
   *  nests each branch's read/grep/glob under ITS OWN card. */
  branch?: number
  /** Which model executed this specific event: for 'tool'/'tool_result' kinds,
   *  the model that ran the call; for 'usage' events, the model the usage
   *  belongs to. Empty/absent = the main conversation model. */
  model?: string
  /** The provider that actually executed this usage event (e.g. 'openrouter',
   *  'anthropic').  Absent on legacy events — the frontend falls back to the
   *  chat's own provider when missing. */
  provider?: string
  /** The user-configured provider id for this usage event — distinct from
   *  `provider` (the kind). Several providers can share the same kind
   *  (e.g. two openrouter accounts with different ids), so the sidebar groups
   *  per-usage entries by this id. Empty on legacy events.
   *  On a `compact_progress` event it names the provider ROW the running
   *  summarizer is routed to, so the banner can show the provider the user
   *  configured instead of its wire kind. */
  provider_id?: string
  /** permission/ask request id (echoed back via /permission/respond or /ask/respond) */
  id?: string
  action?: string
  /** 'confirm' for a generic confirm_action request; 'computer' for desktop-app control; absent/'outside' for the original outside-workspace permission prompt */
  scope?: string
  /** Outside-workspace permission: the backend-normalized folder the grant
   *  applies to (nearest existing parent of `path`). Empty when the request
   *  has no path or the path could not be normalized. */
  folder?: string
  /** ask_user: the question text and, when multiple-choice, its options */
  question?: string
  options?: string[]
  /** ask_user multi-part form: 2-4 related sub-questions in ONE card, each its
   *  own heading + choices. Present only when the model sent `sections`
   *  instead of flat options (same shape as Chat['pendingAsk']['sections']). */
  sections?: AskSection[]
  /** 'plan_approval' marks the deterministic end-of-plan approval card
   *  (Approve / edit / dismiss); absent for regular agent questions. */
  style?: string
  /** plan_card: the full implementation plan document (+ the prose written
   *  before its header) and its display title. */
  title?: string
  body?: string
  preamble?: string
  /** mode_changed: the backend switched the chat's workflow mode mid-run
   *  (plan approval → build); the frontend syncs chat.mode silently. */
  mode?: string
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  context_tokens?: number
  /** INCLUSIVE billed input: the cache share is inside it for every provider
   *  (see llm::NormalizedUsage) — the cost math subtracts read+write. */
  cache_read_tokens?: number
  cache_write_tokens?: number
  /** The payload carried the cache field at all — "not reported" stays
   *  distinguishable from a real zero (the cache genuinely missed). */
  cache_read_reported?: boolean
  cache_write_reported?: boolean
  reasoning_tokens?: number
  /** Characters of reasoning content the backend actually observed in this
   *  response (0 = none). Positive evidence that the model reasons, recorded
   *  against provider+model by `learnModelReasoning`. */
  reasoning_chars?: number
  /** Overflow events are REJECTED (unbilled) requests — never counted in billed totals. */
  unbilled?: boolean
  attempt?: number
  max_attempts?: number
  delay?: number
  reason?: string
  /** Agent label for retry events (e.g. "main agent", "explore subagent") — so the user knows WHICH model to change. */
  agent?: string
  /** True on a retry-family event when a sub-agent model hard-failed and the
   *  tool fell back to the MAIN model — the UI renders a distinct
   *  'sub-agent failed — using main model' banner instead of a spinner. */
  fallback?: boolean
  /** Thinking signal: true when the model starts reasoning, false when it
   *  stops. The backend emits this instead of streaming raw thinking text
   *  (which slowed the UI); the frontend uses it to glow the composer. */
  active?: boolean
  /** artifact: the document format. Named `artifact_kind` because `kind` is the
   *  event's own discriminator. */
  artifact_kind?: 'html' | 'md'
  /** artifact: which save of that document this is (v1, v2, …). */
  version?: number
  /** artifact: names of the supporting files saved with this version (backend
   *  source, data, config). The preview panel fetches their bodies itself. */
  assets?: string[]
}

