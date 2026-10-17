export type ProviderKind = 'openrouter' | 'ollama' | 'custom' | 'google' | 'nvidia' | 'cloudflare' | 'tokenrouter' | 'anthropic'

export type AgentMode = string

/** A recently used model, tied to the provider it was used on so it can be
 *  re-selected unambiguously (models are shown as provider/model). */
export interface RecentModel {
  providerId: string
  model: string
  /** Epoch ms when this model was last used — used to sort recents by usage time. */
  lastUsed?: number
  /** مدل پین‌شده همیشه بالای لیست اخیر می‌ماند و از حذف خودکار مصون است (سقف ۳). */
  pinned?: boolean
}

/** Per-mode tool access. Sent to the backend so tool gating is data-driven
 *  instead of hardcoded to mode names — lets anyone add custom modes. */
export interface ModeCapabilities {
  readFiles: boolean // list / search (grep/glob)
  writeFiles: boolean // write_file / edit_file
  runTerminal: boolean // run_terminal
  web: boolean // web_search / fetch_url
}

/** One agent mode: built-in (ask / plan / build) or user-created. */
export interface AgentModeDef {
  id: AgentMode
  label: string
  icon?: string
  description: string
  capabilities: ModeCapabilities
}

export type ThinkingLevel =
  | ''
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** Transport type for an MCP tool connector. */
export type McpTransport = 'stdio' | 'http' | 'sse'

/** One MCP server connector (stored in the app's user data folder). */
export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  /** Explicit transport hint (e.g. `stdio`); inferred from command/url otherwise. */
  type?: string
}

/** A web-search engine backend selectable in Settings → Plugins. Order decides
 *  the primary (order 0) and the fallbacks (higher order = tried later). Add a
 *  new engine later by adding a `SearchPluginKind` + a row in the backend
 *  registry `SEARCH_BACKENDS`; no other code changes. */
export type SearchPluginKind = 'duckduckgo' | 'tavily'

export interface SearchPluginConfig {
  kind: SearchPluginKind
  label: string
  enabled: boolean
  /** Lower = tried first. order 0 = primary, higher = fallback. */
  order: number
  /** Tavily API key (duckduckgo needs none). */
  apiKey?: string
}

/** Google Search Console integration (Settings → Plugins): OAuth client from
 *  the Google Cloud Console + the site whose search-analytics data the
 *  `search_console` tool queries. */
export interface SearchConsoleConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  siteUrl: string
}

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  /** Ordered API keys, top = tried first (9router-style fallback). */
  apiKeys: string[]
  /** Legacy single key (migrated into apiKeys on load). */
  apiKey?: string
  baseUrl: string
  model: string
  enabled?: boolean
  /** Live per-model context windows (tokens) reported by the provider's /models endpoint. */
  contextMap?: Record<string, number>
  /** مقادیر دستی کانتکست که کاربر برای مدل‌های کاستوم وارد کرده؛ بر contextMap اولویت دارد. */
  manualContextMap?: Record<string, number>
  /** مقادیر دستی reasoning که کاربر برای مدل‌ها وارد کرده؛ بر reasoningMap و
   *  heuristic نام مدل اولویت دارد. */
  manualReasoningMap?: Record<string, boolean>
  /** Live per-model USD-per-million-token pricing reported by the provider's /models endpoint. */
  pricingMap?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>
  reasoningMap?: Record<string, boolean>
  thinkingLevel?: ThinkingLevel
  models?: string[]
  /** Models the user explicitly removed; hidden from the live /models catalog. */
  removedModels?: string[]
  /** Models the user manually added; always kept even when the live /models
   *  catalog is unreachable or doesn't list them (e.g. a gateway that hides
   *  its catalog from unknown clients). */
  addedModels?: string[]
}

/** One STT fallback target: 'local' = on-device Whisper, otherwise a settings.providers id. */
export interface SttFallback {
  providerId: string
  model: string
}

/** One TTS fallback target: a settings.providers id plus model/voice. */
export interface TtsFallback {
  providerId: string
  model: string
  voice: string
}

/** Live voice session state for the realtime speech-to-speech UI. */
export type LiveVoiceState = 'idle' | 'connecting' | 'live' | 'speaking' | 'closed' | 'error'

/** Request for a realtime voice session (ephemeral token mint). */
export interface RealtimeSessionRequest {
  kind: string
  baseUrl: string
  apiKeys?: string[]
  model?: string
  voice?: string
}

/** Ephemeral realtime session minted by the sidecar (never contains the master key). */
export interface RealtimeSessionResponse {
  ephemeralToken: string
  websocketUrl: string
  expiresAt: string
}

export interface Settings {
  providers: ProviderConfig[]
  activeProviderId: string
  systemPrompts?: Record<string, string>
  /** User-created modes; built-ins live in `src/lib/modes.ts`. */
  modes?: AgentModeDef[]
  /** MCP tool connectors (key = connector name), sent to the agent each run. */
  mcpServers?: Record<string, McpServerConfig>
  /** MCP connector names switched on via the composer popup. Applied to every
   *  message; defaults to none. */
  mcpEnabled?: string[]
  fontSize?: number
  root?: string
  dir?: 'rtl' | 'ltr'
  compact?: boolean
  recentModels?: RecentModel[]
  sidebarOpen?: boolean
  /** Docked right panel (todos + future sections) — persisted like sidebarOpen. */
  rightPanelOpen?: boolean
  /** User-level data root: skills/plans/mcp files live under this folder.
   *  Default: ~/.codifa. */
  dataPath?: string
  /** On-device Whisper (voice) model: HuggingFace repo id + optional mirror. */
  whisperModel?: string
  whisperBaseUrl?: string
  /** STT source: 'local' = on-device Whisper, otherwise a settings.providers id. */
  sttProviderId?: string
  /** Remote STT model id sent to {base_url}/audio/transcriptions (e.g. whisper-1). */
  sttModel?: string
  /** Ordered STT fallback targets, tried after the primary STT source fails. */
  sttFallbacks?: SttFallback[]
  /** TTS source: 'local' = on-device Piper fa, otherwise a settings.providers id. */
  ttsProviderId?: string
  /** TTS model: Piper voice id when local (default fa_IR-amir-medium), remote model id otherwise. */
  ttsModel?: string
  /** Optional mirror base URL for downloading the local Piper voice model. */
  ttsBaseUrl?: string
  /** Remote TTS voice id sent to {base_url}/audio/speech (e.g. alloy). */
  ttsVoice?: string
  /** Ordered TTS fallback targets, tried after the primary TTS source fails. */
  ttsFallbacks?: TtsFallback[]
  /** Live voice (realtime speech-to-speech) model id (e.g. gpt-realtime). */
  liveModel?: string
  /** Live voice id used for the realtime session (e.g. alloy). */
  liveVoice?: string
  /** How many top web_search results get their page content auto-fetched
   *  before answering (0 = off, snippet-only). Default: 3. */
  webSearchAutoFetch?: number
  /** Web-search engines for the web_search tool (Settings → Plugins). Order
   *  decides primary vs fallback. Empty = DuckDuckGo only (backward compat). */
  searchPlugins?: SearchPluginConfig[]
  /** Google Search Console OAuth + site for the search_console tool. */
  searchConsole?: SearchConsoleConfig
  /** Per-workspace accent color, keyed by workspace key (root path, "" for no project). */
  workspaceColors?: Record<string, string>
  /** Workspace keys pinned to the top of the sidebar, most-recently-pinned first. */
  pinnedWorkspaces?: string[]
  /** Chat ids pinned to the top of their workspace group, most-recently-pinned first. */
  pinnedChats?: string[]
  /** Persisted workspace list — workspaces outlive their chats (deleting all a
   *  workspace's chats does NOT remove the workspace itself). Empty workspaces
   *  still render. Order is user-controlled (drag-and-drop in the sidebar). */
  workspaces?: Workspace[]
  /** Per-subagent model overrides (namespace / explorer / vision / compact).
   *  Each key maps to a model from the active provider, or empty = use the
   *  parent model. */
  subagentModels?: Record<string, string>
  /** Single auto-compaction threshold as a percentage of the RAW context window.
   *  Auto-compaction fires once `total_tokens >= ctx * compactAtPercent / 100`.
   *  The reserved headroom is implicit: `(100 - compactAtPercent)%` of the window
   *  is left free. 80 = compact at 80% of the window (20% headroom). Range 1–99.
   *  Default 80. The context meter shows `total_tokens`, so the meter and the
   *  trigger always agree (the bar hits the threshold exactly when compaction
   *  fires). */
  compactAtPercent?: number
  /** History turn limit sent to the model. 0 = full history (default). N > 0 =
   *  last N turns verbatim + a compact summary of the rest. Works with
   *  auto-compact (summary is merged, not re-expanded). */
  historyLimit?: number
  /** Tool result cache TTL in minutes (default 60). */
  cacheTtlMinutes?: number
  /** Schedule run ids already seen in the inbox (badge state). Persisted so
   *  read runs stay read across restarts. */
  scheduleRunsSeen?: string[]
  /** Persisted hard switch for desktop control (the `computer` tool). Like an
   *  MCP connector: when false the backend never binds the tool — the agent
   *  cannot touch the desktop even if the prompt asks for it. When true the
   *  tool binds and per-action runtime permission prompting still applies. */
  computerUse?: boolean
}

/** A first-class workspace in the sidebar. ``root`` is the project folder; may
 *  be null for the "No project" bucket. Workspaces are only removed via the
 *  sidebar trash button, never by deleting their chats. */
export interface Workspace {
  key: string
  root: string | null
  label: string
}

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface SearchResultItem {
  title: string
  url: string
  snippet?: string
}

export interface DiffStats { adds: number; dels: number }

/** یک فایل در نمای Review به سبک کدکس: مسیر + شمارش + دیف یکپارچه. */
export interface ReviewFile { path: string; adds: number; dels: number; diff: string }

/** یک ترن در نمای Review: لیست فایل‌ها + جمع +N -M. */
export interface ReviewTurn { id: string; files: ReviewFile[]; adds: number; dels: number }

export interface ToolActivity {
  tool: string
  args?: Record<string, unknown>
  summary?: string
  status: 'running' | 'done' | 'error' | 'denied'
  diff?: string
  /** شمارش +N -M استخراج‌شده از diff (برای هدر Review). */
  diffStats?: DiffStats
  elapsedMs?: number
  startedAt?: number
  reverted?: boolean
  /** شماره‌ی snapshot (checkpoint seq) پشت این کارت — backend آن را روی
   *  eventهای diff می‌فرستد تا Undo به‌جای reverse-diff شکننده، از
   *  snapshot مطمئن restore کند. */
  checkpoint?: number
  /** Per-call correlation id (backend-assigned) so a tool_result resolves the
   *  exact card it belongs to even when the same tool runs many times. May
   *  be a number (LangChain auto-incremented ``call_id``) or a string
   *  (Anthropic-native ``tool_use.id``). */
  callId?: number | string
  /** True for tool calls emitted by a SUB-AGENT (e.g. explore's internal
   *  read/grep/glob). Rendered nested inside the parent explore card, not as a
   *  top-level timeline card. */
  sub?: boolean
  /** Parallel explore fan-out branch id (0-based). Lets the UI nest each
   *  branch's sub-agent events under ITS OWN explore card instead of dumping
   *  every branch into one card. */
  branch?: number
  /** Nested sub-agent tool calls when this is an explore card. */
  children?: ToolActivity[]
  /** Which model executed this specific tool call. Empty/absent = the main
   *  conversation model; set for calls issued by a sub-agent (e.g. explore's
   *  own resolved model from Settings → Tools). */
  model?: string
  /** Structured result rows (e.g. web_search hits) shown in the tool card. */
  items?: SearchResultItem[]
  /** Alias of `items` — the backend emits `results` on tool_result events, and
   *  the UI stores them here so a reconnect can replay the tool without
   *  re-executing it (re-execution wastes context). */
  results?: SearchResultItem[]
  /** Which web-search provider produced these results (e.g. 'tavily'). */
  engine?: string
  /** Verbatim plain-text result of a text-output tool (LSP lookups, memory
   *  search). Those results carry no file paths, so `items` stays empty and
   *  the text is rendered as-is instead of being dropped. */
  resultText?: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  contextTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** One cumulative usage entry for a single (provider, model) pair used by a
 *  chat. `providerId` and `model` are stored EXPLICITLY (not encoded in a key
 *  string) so the sidebar shows the exact provider/model with no parsing or
 *  guessing — and any future provider/model displays correctly. */
export interface ChatUsageEntry {
  /** The provider that ACTUALLY ran this model (its id). */
  providerId: string
  /** The model id as reported by the backend (may itself carry a namespace,
   *  e.g. "anthropic/claude-3.5-sonnet" — that is part of the model, NOT a
   *  provider). */
  model: string
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  /** Epoch ms of the last token accrual for this model — used to sort "most
   *  recently used" first in the sidebar usage panel. */
  lastUsed?: number
}

/** Per-chat cumulative token usage (session totals). A flat list of explicit
 *  (provider, model) entries — survives compacts and reloads and only ever
 *  grows, unlike a single message's `TokenUsage` which is per-turn. */
export interface ChatUsage {
  entries: ChatUsageEntry[]
}

/** Chronological unit of an assistant message. Text is split into slices around
 *  each tool call so the UI can interleave tool cards with the reply (Claude
 *  style) instead of stacking all tools at the top/bottom. `tool` segments
 *  reference `ChatMessage.toolActivity[index]`. */
export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; index: number }
  | { kind: 'user'; id: string }
  | { kind: 'compact'; id: string }

export interface ChatMessage {
  id: string
  role: Role
  content: string
  mode?: AgentMode
  toolActivity?: ToolActivity[]
  /** Interleaved render order (text slices + tool call positions). Absent on
   *  messages persisted before this feature; they fall back to legacy layout. */
  segments?: MessageSegment[]
  plan?: Array<{ id?: string; content: string; status: string }>
  /** Full implementation plan document produced by Plan mode (kind:"plan_card").
   *  The chat bubble hides the plan portion of `content` and renders this as a
   *  collapsed Plan card instead; "View full plan" opens it in the Plan viewer
   *  tab. `preamble` is the prose the planner wrote before the plan header. */
  planDoc?: { title: string; body: string; preamble?: string }
  thinking?: string
  /** True while this assistant message is still being generated (live status line). */
  streaming?: boolean
  /** True only while the backend has confirmed the model is actually
   *  producing reasoning content (driven by the {kind:"thinking",active:true}
   *  event). Gates the in-message "Thinking" indicator. */
  thinkingActive?: boolean
  /** Wall-clock timestamp when thinking started — survives remounts so the
   *  elapsed timer doesn't reset when the user switches chats. */
  thinkingStartedAt?: number
  /** Wall-clock timestamp when the "Working" indicator (streaming without
   *  active thinking) started — same remount-survival rationale as
   *  `thinkingStartedAt`: switching chats must not reset the elapsed timer. */
  workingStartedAt?: number
  /** Final turn duration in ms, stamped when the turn ends (success, stop or
   *  error) from `workingStartedAt`. Rendered statically in the message footer
   *  so every finished turn keeps its working time visible in the chat. */
  turnElapsedMs?: number
  /** True when this message was persisted mid-stream (heartbeat snapshot) and
   *  the app died before the turn completed — shown as "interrupted" after a
   *  crash/power cut instead of looking like a complete reply. Cleared by the
   *  final write once the turn ends normally. */
  interrupted?: boolean
  /** True for a user message steered into a RUNNING agent (typed mid-run). It
   *  is visible immediately; the backend confirms delivery with `steer_applied`
   *  (flag cleared) or, if the turn ends without injecting it, it is re-sent as
   *  the next turn reusing this same message. */
  steerPending?: boolean
  /** True for a user message steered into a RUNNING agent once the backend
   *  confirmed delivery (`steer_applied`): the message's own bubble is hidden
   *  and it is instead rendered inline, right after the tool call that carried
   *  it, via a `{ kind: 'user' }` segment on the assistant message. */
  steerInterleaved?: boolean
  /** Transient stage label while streaming (e.g. preparing context, contacting
   *  model). Cleared on first real text/tool/thinking content. Never persisted
   *  as model history. */
  statusText?: string
  /** Live LSP install/update progress shown in the thinking/working row with a
   *  loading state so a pause reads as waiting, not stuck. Cleared on turn end. */
  lspStatus?: LspStatus
  attachments?: string[]
  images?: Array<{ path: string; name: string; dataUrl?: string }>
  mcpServers?: Record<string, McpServerConfig>
  skills?: string[]
  /** Skills auto-loaded by the decision router this turn ('skill' event,
   *  manual:false) — rendered as chips under the assistant bubble. */
  autoSkills?: string[]
  usage?: TokenUsage
  error?: boolean
  retry?: { attempt: number; maxAttempts: number; delay: number; reason: string; gaveUp?: boolean; watchdog?: boolean; model?: string; agent?: string; fallback?: boolean; reconnecting?: boolean; startedAt?: number } | null
  /** True once this message has been folded into a compact summary (kept in the
   *  UI as a greyed, collapsible entry but NOT re-sent to the model). */
  compacted?: boolean
  modeSwitch?: boolean
  /** Tool-output recap from a previously interrupted turn. NEVER rendered in
   *  the UI; sent to the model so a retry knows what was already done without
   *  re-executing the tools. The visible transcript is kept clean of the
   *  warning text. */
  preservedToolSummary?: string
  createdAt: number
}

/** Pending composer state scoped to one chat (labels below the input), so
 *  mentions / MCP chips picked in one chat never leak into another. */
export interface ChatDraft {
  input?: string
  attachments?: string[]
  images?: Array<{ path: string; name: string; dataUrl?: string }>
  /** Long texts pasted into the composer, kept as collapsed cards instead of
   *  flooding the textarea. Joined back into the prompt on send. */
  pasted?: PastedText[]
}

/** A long paste captured by the composer as a collapsed card. */
export interface PastedText {
  id: string
  text: string
  createdAt: number
}

/** A message typed while the chat's agent is already working. `kind: 'steer'`
 *  is delivered to the RUNNING agent (via /chat/steer, injected at the next
 *  tool call, no abort); `kind: 'queue'` waits and auto-sends one-by-one after
 *  the current turn completes. `sent` is set once the message has been turned
 *  into a real chat turn (either consumed mid-run or drained). */
export interface QueuedMessage {
  id: string
  text: string
  attachments?: string[]
  images?: Array<{ path: string; name: string; dataUrl?: string }>
  mcpServers?: Record<string, McpServerConfig>
  skills?: string[]
  kind: 'steer' | 'queue'
  createdAt: number
  sent?: boolean
}

/** Persistent per-chat goal (Codex Goal mode / Claude /goal style).
 *  Lives on the chat so it survives reload via the existing chats persistence.
 *  When active and not paused, the condition is prefixed to every model prompt.
 *  `stopped` is the Codex-style halt flag: set by an explicit Stop so the
 *  auto-continue loop stays idle until the user presses Resume. Unlike
 *  `paused` it does NOT detach the goal from manual sends — a user-typed
 *  message still carries the goal, but the loop never auto-fires while set. */
export interface GoalState {
  condition: string
  active: boolean
  paused?: boolean
  stopped?: boolean
  startedAt: number
  turns?: number
}

export interface Chat {
  id: string
  title: string
  mode: AgentMode
  /** Per-chat reasoning effort override (defaults to the provider default). */
  thinkingLevel?: ThinkingLevel
  /** Per-chat provider override (defaults to the global active provider). */
  providerId?: string
  /** Per-chat model override (defaults to the global active provider's model). */
  model?: string
  root?: string
  messages: ChatMessage[]
  /** Cumulative per-model token usage for this chat (session totals). */
  usage?: ChatUsage
  draft?: ChatDraft
  /** Messages typed while this chat's agent was working, sent/steered later. */
  queued?: QueuedMessage[]
  /** A pending `ask_user` request from a RUNNING agent turn. Lives on the chat
   *  (not local component state) because `<ChatPanel key={activeChatId} />`
   *  fully unmounts/remounts on every chat switch — local state would silently
   *  lose the request (and the popup would never appear) if the user isn't
   *  looking at this exact chat when the `ask` event arrives, or switches away
   *  and back while the agent is still waiting for a response. */
  pendingAsk?: { id: string; question: string; options: string[]; style?: string } | null
  /** A pending `permission` request from a RUNNING agent turn. Same rationale
   *  as `pendingAsk`: lives on the chat so it survives the ChatPanel remount
   *  on chat switch. `folder` = the backend-normalized approved folder (the
   *  nearest existing parent of `path`) — what "Always allow" registers. */
  pendingPermission?: { id: string; action: string; path?: string; reason?: string; scope?: string; folder?: string } | null
  /** Transient compact/command/stall banners, kept on the chat (not local
   *  component state) for the same reason as `pendingAsk`: `<ChatPanel
   *  key={activeChatId} />` remounts on every chat switch, so local state would
   *  silently drop these the moment the user looks at another chat and comes
   *  back. Cleared on load — nothing is running after a restart. */
  compacting?: boolean
  compactNotice?: string | null
  compactError?: string | null
  cmdError?: string | null
  /** Live voice error shown in the transcript banner under messages (never in the composer). */
  liveError?: string | null
  /** TTS playback error shown in the transcript banner under messages (never beside the speaker icon). */
  ttsError?: string | null
  /** Warning that an @mentioned skill was not found (deleted/renamed) — the
   *  'skill' event's `note` field. Per-chat so it survives the ChatPanel
   *  remount on chat switch (same rationale as compactNotice). */
  skillNotice?: string | null
  stalled?: boolean
  /** Persistent goal for this chat (null = none). New goal replaces the old one. */
  goal?: GoalState | null
  /** Per-chat scroll restoration anchor: the message id at the top of the
   *  viewport when the user last scrolled, plus the pixel offset from that
   *  message's top to the viewport top. `atBottom` means the user was pinned
   *  to the newest messages. Restored on chat switch / app restart. */
  scrollPos?: { id: string; offset: number; atBottom: boolean } | null
  createdAt: number
  updatedAt: number
}

/** یک ورودی لاگ چت جاری برای پنل Trace (لایا / LLM / پرامپت / ابزار) — مثل لنگ‌اسمیت. */
export type TraceKind = 'llm' | 'prompt' | 'tool'

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
  kind: 'text' | 'thinking' | 'tool' | 'tool_result' | 'diff' | 'error' | 'done' | 'usage' | 'retry' | 'retry_giveup' | 'compact' | 'compact_start' | 'compact_failed' | 'plan' | 'plan_card' | 'mode_changed' | 'ctx_parts' | 'permission' | 'ask' | 'skill' | 'mcp' | 'subagent_models' | 'steer_applied' | 'steer_dropped' | 'status' | 'keepalive'
  /** Status stage (e.g. 'lsp' for language-server install/update progress). */
  stage?: string
  content?: string
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
  /** Per-subagent model routing (the 'subagent_models' event kind): which model actually ran for explore/search/web/compact/vision. */
  models?: Record<string, string>
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
   *  per-usage entries by this id. Empty on legacy events. */
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
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
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
}

/** یک تسک زمان‌بندی‌شده (مثل Codex): پرامپت + تکرار کرون + اجرای پس‌زمینه. */
export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  /** کرون ۵ فیلدی نرمال‌شده (UTC)؛ رشته خالی یعنی اجرای یک‌باره. */
  cron: string
  /** توصیف فارسی کوتاه برای نمایش (از بک‌اند می‌آید). */
  cron_label?: string
  enabled: boolean
  root: string
  mode: string
  provider_id?: string
  model?: string
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
