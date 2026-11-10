import type { McpServerConfig } from './mcp.ts'
import type { AgentMode, ThinkingLevel } from './providers.ts'
import type { Settings } from './settings.ts'
import type { ChatCompactProgress, LspStatus } from './trace.ts'


export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface SearchResultItem {
  title: string
  url: string
  snippet?: string
  /** Web results only: did the real page body get fetched for this row?
   *  `false` means the model only received the ~200-char search snippet, so a
   *  thin answer may be a fetch failure rather than a bad result. Absent on
   *  transcripts recorded before the backend started sending the flag. */
  fetched?: boolean
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
  /** Net unified diff of this card's file since the turn's FIRST edit of it
   *  (sent by the backend as a `turn_diff` event). `diff` is only THIS call's
   *  change; the Review panel's "Last Turn" view reads this so its +N/-M match
   *  `git diff`. `""` = later edits undid the earlier ones; `undefined` = the
   *  backend sent none (older transcripts) and Review falls back to summing. */
  turnDiff?: string
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
  /** The sub-agent's own narration ("now opening the profile…"), folded from
   *  branch-tagged text events. UI-only: it never enters the parent model's
   *  history, and the chat card shows the latest line while the side panel
   *  keeps the full log. */
  narration?: string
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
  /** Live output tail of a still-RUNNING `run_terminal` call (`tool_output`
   *  events). Rendered as a live feed in the running card with a download
   *  progress bar parsed out of it; cleared when the card resolves — the
   *  final output arrives on the tool_result event. */
  liveTail?: string
}

export interface TokenUsage {
  /** INCLUSIVE billed input — the cache share is inside it for every provider. */
  inputTokens: number
  outputTokens: number
  totalTokens: number
  contextTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** The provider payload carried the field at all (unknown ≠ 0). */
  cacheReadReported?: boolean
  cacheWriteReported?: boolean
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
  /** An artifact the agent built: the card sits in the transcript, the body
   *  opens in the sandboxed preview tab. The content rides along so the card
   *  still previews after a reload, before anything is fetched from disk. */
  | {
      kind: 'artifact'
      id: string
      title: string
      artifactKind: 'html' | 'md'
      content: string
      version: number
      /** Names of the supporting files saved with this version (backend source,
       *  data, config). The bodies are fetched by the preview panel. */
      assets?: string[]
    }

export interface ChatMessage {
  id: string
  role: Role
  content: string
  mode?: AgentMode
  toolActivity?: ToolActivity[]
  /** Interleaved render order (text slices + tool call positions). Absent on
   *  messages persisted before this feature; they fall back to legacy layout. */
  segments?: MessageSegment[]
  plan?: Array<{ id?: string; content: string; status: string; progress?: number }>
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
  /** The failure text of a turn that ended in an error, kept so the footer's
   *  retry line can show WHY even on turns that never entered a retry ladder.
   *  Stored decoded (the provider body is escaped JSON) so both the truncated
   *  line and the hover tooltip can render it directly. */
  errorReason?: string
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
  /** Connectors the model actually loaded with `use_mcp` this turn (the
   *  `mcp_loaded` stream event). Enabled-but-never-loaded is the common case and
   *  the one worth showing: it cost the turn an index line, not its schemas. */
  mcpLoaded?: string[]
  skills?: string[]
  /** Plugin slugs attached to this turn (one unit: its skills + connectors). */
  plugins?: string[]
  usage?: TokenUsage
  error?: boolean
  retry?: { attempt: number; maxAttempts: number; delay: number; reason: string; gaveUp?: boolean; watchdog?: boolean; model?: string; providerId?: string; agent?: string; tool?: string; branch?: number; fallback?: boolean; reconnecting?: boolean; startedAt?: number; /** Rendered as a compact line in the message footer, never as the transcript-end banner. */ inline?: boolean; /** A plain STATUS row (no ladder): compact progress, an interrupted reply. Shares the footer slot so every notice lives in one place. */ status?: boolean; /** Determinate 0-100 for a measurable status (compaction). Drives the footer progress bar; absent means indeterminate. */ percent?: number; attempts?: number } | null
  /** Footer status overrides owned by the chat body (e.g. live compaction
   *  progress). Rendered in the LAST assistant message's footer, in the same
   *  slot as the retry/error line, so no banner is needed above the composer. */
  footerStatus?: {
    kind: "compact" | "info" | "error"
    text: string
    /** 0-100 when the status is a measurable job (compaction). Drives the
     *  determinate progress bar in the footer; absent means indeterminate. */
    percent?: number
    /** "elapsed / budget" seconds, shown beside the bar. */
    elapsedSecs?: number
    budgetSecs?: number
    /** "try 2/3" — only when the run may retry. */
    attempt?: number
    attempts?: number
    /** One-click recovery this row owns. Absent = informational; the footer
     *  must NOT show a Retry button for it. `compact-retry` re-runs the
     *  summarizer, while a failed TURN resumes through the message's own
     *  `error`/`interrupted` fields. */
    action?: "compact-retry"
  } | null
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
  plugins?: string[]
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

/** What an open "editing" badge is keeping a chat pointed at: the folder one
 *  plugin/skill/connector/artifact update session lives in. Pinned when the
 *  agent UPDATES one (never on create/install), cleared only by the badge's ×
 *  — so follow-up turns keep targeting the same folder without re-asking.
 *  Lives on the chat (persisted) so it survives turns and restarts. */
export interface ChatEditTarget {
  target: 'plugin' | 'skill' | 'mcp' | 'artifact'
  action: string
  name: string
  /** Absolute folder on disk — sent as the turn's workspace root. */
  path: string
}

/** An OPEN PLUGIN-USE session (the \`/slug mt5-trading\` badge): keeps the
 *  named bundle attached to every send until the user closes it with ×.
 *  Unlike ChatEditTarget this pins NO folder, NO mode and NO authoring right —
 *  using a plugin's skills/connectors is not editing it. */
export interface PluginSession {
  /** The bundle's slug — the command word (\`mt5\`). */
  slug: string
  /** Display name from the bundle (\`MT5 demo trading\`). */
  label: string
  /** Skills of the bundle at pin time — re-attached on every send. */
  skills: string[]
  /** Connector ids of the bundle at pin time, when it ships any. */
  mcpServers?: string[]
  /** Full connector configs (when available) so sends need no re-resolve. */
  mcpConfig?: Record<string, McpServerConfig>
}

/** One facet of a multi-part `ask_user` card: its own heading and choices.
 *  The model fills `sections` (instead of flat question+options) when one
 *  decision has several independent sub-questions. */
export interface AskSection {
  title: string
  options: string[]
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
  /** Per-chat auto-compaction threshold override, 1–99 (percent of the raw
   *  window). Undefined = follow Settings → General → Auto-compaction
   *  threshold; set from the context popover's slider for THIS chat only. */
  compactAtPercent?: number
  root?: string
  /** Open "editing" badge (see ChatEditTarget): while set, sends go to this
   *  folder in Build mode until the user closes the badge. The chat's mode is
   *  forced to "build" for the whole session (so retries, resume and the
   *  composer's mode selector all agree); pinChatEditTarget saves the previous
   *  mode and × (clearChatEditTarget) restores it. */
  editTarget?: ChatEditTarget
  /** The mode the chat had BEFORE the edit badge forced Build (undefined =
   *  no session open). × on the badge restores it. */
  editTargetPrevMode?: AgentMode
  /** Open plugin-USE session (see PluginSession): pinned by invoking the
   *  bundle through its / command; every send keeps the bundle attached and
   *  the badge shows only the plugin name until × closes it. */
  pluginSession?: PluginSession
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
  pendingAsk?: {
    id: string
    question: string
    options: string[]
    style?: string
    selected?: number[]
    freeText?: string
    /** Multi-part form: 2-4 related sub-questions shown in ONE card; every
     *  section is answered before the card submits them all in one answer.
     *  Present only when the model used `sections` instead of flat options. */
    sections?: AskSection[]
    /** Per-section selection (parallel to `sections`), persisted like
     *  `selected` so the card survives chat switches. */
    secSelected?: number[][]
  } | null
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
  /** Live progress of the running compaction (`compact_progress`). Kept on the
   *  chat for the same reason as `compacting`: the panel remounts on a chat
   *  switch, and a bare spinner says nothing about whether it will ever end. */
  compactProgress?: ChatCompactProgress | null
  compactError?: string | null
  cmdError?: string | null
  /** Connectors the model already loaded with `use_mcp`, persisted per chat so
   *  a connector is asked for ONCE per conversation instead of once per turn.
   *  The backend rebuilds its in-turn `activated` set from this on every
   *  request — without it the model re-loaded a 342-tool connector on every
   *  single turn (measured: two identical `use_mcp` calls in one trace).
   *  Intersected with the live enable map on the backend, so a connector the
   *  user switched OFF does not come back through this list. */
  mcpActive?: string[]
  /** Live voice error shown in the transcript banner under messages (never in the composer). */
  liveError?: string | null
  /** TTS playback error shown in the transcript banner under messages (never beside the speaker icon). */
  ttsError?: string | null
  /** Warning that an @mentioned skill was not found (deleted/renamed) — the
   *  'skill' event's `note` field. Per-chat so it survives the ChatPanel
   *  remount on chat switch (same rationale as compactProgress). */
  skillNotice?: string | null
  /** Transient feedback for /undo and /redo ("Undid the last exchange.").
   *  Lives on the chat instead of being a permanent assistant turn so the ack
   *  never becomes part of the history the next undo would swallow. */
  undoNotice?: string | null
  stalled?: boolean
  /** Persistent goal for this chat (null = none). New goal replaces the old one. */
  goal?: GoalState | null
  /** Per-chat scroll restoration anchor: the message id at the top of the
   *  viewport when the user last scrolled, plus the pixel offset from that
   *  message's top to the viewport top. `atBottom` means the user was pinned
   *  to the newest messages. Restored on chat switch / app restart. */
  scrollPos?: { id: string; offset: number; atBottom: boolean } | null
  /** Message count of this chat. The renderer's `chats` array holds INDEX rows
   *  (metadata only) loaded from settings.json; the message bodies live in a
   *  per-chat file on disk and are pulled in on demand via `chatGet`. */
  messageCount?: number
  /** Preview of the first user message, carried on the index row so the
   *  sidebar/tab titles never need the message body in memory. */
  firstUser?: string
  /** Body file path relative to the data root
   *  (`chats/<workspace>/<id>.json`), written by the store onto the index row;
   *  the Rust side resolves the body from it. */
  dir?: string
  /** True once `messages` holds a real transcript window. `false` means the
   *  body has not been fetched yet: the transcript shows a loader instead of an
   *  empty chat, and message-mutating actions refuse to write — a partial
   *  in-memory transcript would overwrite the real body file on the next
   *  persist. */
  hydrated?: boolean
  /** Absolute index (in the full on-disk transcript) of `messages[0]`.
   *  Non-zero means older messages still exist on disk and are paged in on
   *  scroll. Persisting such a window writes metadata only, never the body. */
  bodyStart?: number
  /** Total number of messages in the full on-disk transcript. Lets the UI say
   *  how much history remains without loading it. */
  bodyTotal?: number
  /** Runtime-only: a freshly FORKED chat that has not seen its first user
   *  message yet. It holds only the compacted system seed, so persisting it
   *  would pin every exploratory fork into the sidebar forever — the same
   *  "in-memory until first send" treatment an untouched new chat already gets
   *  (sanitizeChats drops empty chats). Cleared in addMessage as soon as a user
   *  message lands; never serialized. NOT the composer's saved `draft` above. */
  pendingFirstMessage?: boolean
  createdAt: number
  updatedAt: number
}

