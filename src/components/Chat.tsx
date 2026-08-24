import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  getActiveProvider,
  getChatProvider,
  useStore,
  defaultMaxHistoryFor,
} from "../lib/store";
import { api } from "../lib/fs";
import { PROVIDER_META } from "../lib/provider-meta";
import {
  contextPercent,
  computeContextUsed,
  formatCost,
  formatTokens,
  formatTokensK,
  modelContextWindow,
  modelReasoning,
} from "../lib/context";
import {
  addMemoryNote,
  steerChat,
  streamChat,
  fetchModels,
  fetchCredits,
  transcribeAudio,
  respondPermission,
  respondAsk,
  listSkills,
  triggerCompact,
  type CompactResult,
} from "../lib/api";

import type { SkillRow } from "../lib/api";
import { supportsReasoning } from "../lib/thinking";
import { allModes, getMode } from "../lib/modes";
import {
  extractMentionSkills,
  getSkillsList,
  ensureSkillsList,
  invalidateSkillsList,
  setSkillsFetcher,
} from "../lib/skills";
import { detectDir, prepareContent } from "../lib/bidi";
import {
  registerChatSend,
  sendPendingSteerNext,
  sendQueuedNext,
  uid2,
} from "../lib/chatSends";
import { composerScrollPadding } from "../lib/scrollPadding";
import {
  GLOBAL_SHORTCUTS,
  PREFIX_LABEL,
  PREFIX_SHORTCUTS,
  formatGlobalShortcut,
  formatShortcut,
  physicalKey,
} from "../lib/shortcuts";
import type {
  AgentMode,
  ChatMessage,
  MessageSegment,
  NvimDiagnostic,
  SidecarEvent,
  ThinkingLevel,
  ToolActivity,
} from "../types";
import { ChatMessageView, RetryBanner, LiveWorkingStatus } from "./ChatMessage";
import { ModeIcon } from "./ModeIcon";
import { ModeSelect } from "./ModeSelect";
import { ProviderModelSelect } from "./ProviderModelSelect";
import { ToolCallView } from "./ToolCallView";

const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDER_META).map((m) => [m.kind, m.label]),
);

const THINKING_OPTIONS: Array<[ThinkingLevel, string]> = [
  ["none", "None"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
];
const THINKING_LABELS = Object.fromEntries(THINKING_OPTIONS) as Record<
  ThinkingLevel,
  string
>;
const THINKING_DESCS: Record<ThinkingLevel, string> = {
  "": "Default reasoning",
  none: "No reasoning — fastest replies",
  minimal: "Minimal reasoning — quick replies",
  low: "Light reasoning — faster replies",
  medium: "Balanced reasoning — default",
  high: "Deep reasoning — better answers",
  xhigh: "Maximum effort — best answers",
};

const COMMANDS: Array<{ name: string; hint: string }> = [
  { name: "help", hint: "List all commands" },
  { name: "compact", hint: "Summarize & compact the chat context" },
  { name: "clear", hint: "Clear all messages in this chat" },
  { name: "new", hint: "Start a new chat" },
  { name: "undo", hint: "Undo the last user/assistant exchange" },
  { name: "redo", hint: "Redo the last undone exchange" },
  {
    name: "skill",
    hint: "Create a skill (describe what you want after the command)",
  },
  {
    name: "mcp",
    hint: "Create an MCP connector (describe what you want after the command)",
  },
];

/** True when a message asks to create/install/import skills or MCP connectors,
 *  so the agent gets the `create_skill` / `create_mcp` tools for the turn.
 *  Matches English AND Persian intent words (نصب/ساخت/بساز/ایجاد/ذخیره/اضافه →
 *  action; اسکیل/مهارت → skill target) so Persian-only prompts work too. */
function wantsSkillOrMcp(text: string): boolean {
  const low = text.toLowerCase();
  const action =
    /(install|add|create|import|save|set up|setup|copy|نصب|ساخت|بساز|ایجاد|ذخیره|اضافه)\b/.test(
      low,
    );
  const target = /\b(skill|mcp|connector)s?\b|(اسکیل|مهارت|سورس)/.test(low);
  return action && target;
}

/**
 * Extract @skill mentions from a prompt and return the matched skill names plus
 * the prompt with those @mentions stripped (the model must not see raw @tokens;
 * the stored transcript keeps the original text with the @mentions).
 *
 * The canonical mention token is the skill's slug (e.g.
 * "@anthropic-frontend-design") — space-free and unambiguous. A legacy fallback
 * also matches display names that contain spaces (e.g. "@Anthropic Frontend
 * Design") for text pasted from before the slug-based flow. The actual
 * extraction logic lives in ../lib/skills (extractMentionSkills) so it can be
 * unit-tested independently of the React component.
 */
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "heic",
  "heif",
]);

function relFromRoot(root: string, p: string): string | null {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root).split("/");
  const f = norm(p).split("/");
  let i = 0;
  while (i < r.length && i < f.length && r[i] === f[i]) i++;
  if (i < r.length) return null;
  const rel = f.slice(i).join("/");
  return rel || null;
}

const CHARS_PER_TOKEN = 4;

function sliceToBudget(
  history: Array<{
    role: string;
    content: string;
    thinking?: string;
    plan?: Array<{ content: string; status: string }>;
    mode?: string;
    toolActivity?: Array<{
      tool: string;
      args?: Record<string, unknown>;
      summary?: string;
      status: string;
    }>;
  }>,
  maxHistory: number,
  contextWindow?: number,
  mode?: AgentMode,
  headroom?: number,
): Array<{
  role: string;
  content: string;
  thinking?: string;
  plan?: Array<{ content: string; status: string }>;
  mode?: string;
  toolActivity?: Array<{
    tool: string;
    args?: Record<string, unknown>;
    summary?: string;
    status: string;
  }>;
}> {
  // opencode's tail budget: usable = ctx - reserved, keep a recent tail of
  // min(15000, max(2000, usable*0.25)) tokens verbatim (~4 chars/token).
  // `headroom` is the UI's compaction headroom (opencode's `reserved`).
  const ctx = contextWindow && contextWindow > 0 ? contextWindow : 32000;
  const reserved = Math.max(0, Math.min(headroom ?? 20000, ctx));
  const usable = Math.max(0, ctx - reserved);
  const MAX_PRESERVE = 15000;
  const MIN_PRESERVE = 2000;
  const tailTokens = Math.min(
    MAX_PRESERVE,
    Math.max(MIN_PRESERVE, Math.floor(usable * 0.25)),
  );
  const tailChars = tailTokens * 4;
  // Absolute per-mode ceilings mirror the backend's own history trimmer so the
  // frontend pre-slice and the backend's post-trim agree on the recent tail.
  const MODE_HISTORY_CAPS: Record<string, number> = {
    ask: 60000,
    plan: 120000,
    coder: 140000,
  };
  const capped = Math.min(
    tailChars,
    MODE_HISTORY_CAPS[mode ?? "ask"] ?? tailChars,
  );
  // Compact summaries (system role) stand in for the folded older turns — they
  // must ALWAYS survive the maxHistory slice, or the model loses the whole
  // compacted context once the chat grows past maxHistory after a compact and
  // "starts from scratch". Slice only the non-system turns to maxHistory, then
  // re-prepend every system message (the budget loop below already keeps them).
  const systems = history.filter((m) => m.role === "system");
  const recent = [
    ...systems,
    ...history.filter((m) => m.role !== "system").slice(-maxHistory),
  ];
  const kept: typeof history = [];
  let acc = 0;
  for (const m of [...recent].reverse()) {
    // System-role messages (a compact summary) are small but crucial: always
    // keep them even if the char budget would otherwise trim the oldest turn.
    if (
      m.role !== "system" &&
      kept.length > 0 &&
      acc + m.content.length > capped
    )
      break;
    kept.push(m);
    acc += m.content.length;
  }
  return kept.reverse();
}

export function ChatPanel() {
  const chat = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId) ?? null,
  );
  const provider = useStore((s) => {
    // Per-chat provider override: a chat that picked its own provider/model in
    // the composer runs on that, falling back to the global active provider.
    const ch = s.chats.find((c) => c.id === s.activeChatId) ?? null;
    const overrideId = ch?.providerId;
    return (
      s.settings.providers.find(
        (x) => x.id === (overrideId ?? s.settings.activeProviderId),
      ) ?? s.settings.providers[0]
    );
  });
  const activeModel = chat?.model ?? provider.model;
  const allProviders = useStore((s) => s.settings.providers);

  // Live provider balance (OpenRouter), polled every 60s. Queried for every
  // configured provider so the header always surfaces a real remaining balance
  // (OpenRouter) even when the active provider has no balance endpoint.
  // `balanceTick` is bumped right after each completed turn, so the chip also
  // refreshes immediately whenever usage actually changes — without hammering
  // the provider while idle.
  const [creditMap, setCreditMap] = useState<
    Record<
      string,
      Partial<{ balance: number; total_credits: number; total_usage: number }>
    >
  >({});
  const [balanceTick, setBalanceTick] = useState(0);
  useEffect(() => {
    if (!allProviders || allProviders.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const settled = await Promise.allSettled(
        allProviders.map((p) => fetchCredits(p)),
      );
      if (cancelled) return;
      const map: Record<
        string,
        Partial<{ balance: number; total_credits: number; total_usage: number }>
      > = {};
      allProviders.forEach((p, i) => {
        const r = settled[i];
        if (r.status === "fulfilled") map[p.id] = r.value;
      });
      setCreditMap(map);
      timer = setTimeout(poll, 60_000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    // Rerun only when the provider shape (id/kind/key base) changes.
    allProviders
      .map(
        (p) =>
          `${p.id}|${p.kind}|${p.apiKey ?? ""}|${p.envVar ?? ""}|${p.baseUrl ?? ""}|${p.authType ?? ""}|${p.oauthRefreshToken ?? ""}`,
      )
      .join(";"),
    balanceTick,
  ]);

  // Which provider's balance the header chip displays: only the active provider
  // (the one the main model belongs to). If it has no balance endpoint, show
  // nothing — never fall back to another provider.
  let shownBal: {
    provider: (typeof allProviders)[number];
    amount: number;
  } | null = null;
  const activeBal = provider ? creditMap[provider.id] : undefined;
  if (activeBal && activeBal.balance !== undefined) {
    shownBal = { provider, amount: activeBal.balance };
  }
  const root = useStore((s) => s.root);
  const dir = useStore((s) => s.dir);
  const workspaces = useStore((s) => s.workspaces);
  const toggleDir = useStore((s) => s.toggleDir);
  const settings = useStore((s) => s.settings);
  const modes = useStore((s) => allModes(s.settings));
  const maxHistory = defaultMaxHistoryFor(provider.kind);
  const nvimFile = useStore((s) => s.nvimFile);
  const nvimDiags = useStore((s) => s.nvimDiagnostics);
  const nvimDiagCounts = useMemo(() => {
    const counts = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const d of nvimDiags) {
      const sev = d.severity;
      if (sev === 1 || sev === "Error" || sev === "error") counts.error++;
      else if (sev === 2 || sev === "Warning" || sev === "warning")
        counts.warning++;
      else if (sev === 3 || sev === "Information" || sev === "information")
        counts.info++;
      else counts.hint++;
    }
    return counts;
  }, [nvimDiags]);

  const wroot = chat?.root || root;
  const nvimRel = useMemo(() => {
    if (!nvimFile || !wroot) return null;
    return relFromRoot(wroot, nvimFile);
  }, [nvimFile, wroot]);
  // The label always shows when a Neovim file is detected; outside the workspace
  // we display the absolute path (it just can't be mentioned to the agent).
  const nvimLabel = nvimFile ? nvimRel || nvimFile : null;
  // Badge shows only the file name (last path segment); the full path stays in
  // the tooltip. Trailing slashes are stripped so fugitive://.../.git// → .git.
  const nvimBadge = nvimLabel
    ? nvimLabel
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || nvimLabel
    : null;
  const systemPrompt = useStore((s) =>
    chat ? (s.settings.systemPrompts?.[chat.mode] ?? "") : "",
  );

  const [input, setInput] = useState(chat?.draft?.input ?? "");
  const [busyLocal, setBusy] = useState(false);
  // This chat is busy when THIS chat has a streaming assistant message (so
  // another chat streaming in the background doesn't lock this composer). The
  // message-level streaming flag is the source of truth — the global
  // isStreaming flag stays in the store only as the persist gate.
  const chatHasStreaming = chat?.messages.some((m) => m.streaming) ?? false;
  const queuedMsgs = chat?.queued?.filter((q) => !q.sent) ?? [];
  const busy = busyLocal || chatHasStreaming;
  /** The assistant message currently being rate-limited/retried by the provider,
   *  if any. Its RetryBanner is rendered once, at the END of the message list
   *  (not inline inside the message) so it never sits "above the agent's reply"
   *  between the user's message and the incoming content. */
  const retryingMsg = chat?.messages.find((m) => m.retry) ?? null;
  const [sidecarStatus, setSidecarStatus] = useState<"ok" | "fail">("ok");
  const [attachments, setAttachments] = useState<string[]>(
    chat?.draft?.attachments ?? [],
  );
  const [attLen, setAttLen] = useState(0);
  const [images, setImages] = useState<
    Array<{
      path: string;
      name: string;
      dataUrl?: string;
      origPath?: string;
    }>
  >(chat?.draft?.images ?? []);
  const [cmdOpen, setCmdOpen] = useState<{ at: number } | null>(null);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [noRootHint, setNoRootHint] = useState("");
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillIdx, setSkillIdx] = useState(0);
  // Manual @skill mention: position of the "@" that opened the picker, the
  // partial query after it, the highlighted row, and the loaded skill list.
  const [skillMention, setSkillMention] = useState<{ at: number } | null>(null);
  const [skillMentionQuery, setSkillMentionQuery] = useState("");
  const [skillMentionIdx, setSkillMentionIdx] = useState(0);
  const [skillsList, setSkillsList] = useState<SkillRow[]>(getSkillsList());
  const [skillsLoading, setSkillsLoading] = useState(
    getSkillsList().length === 0,
  );
  const [titlebarEl, setTitlebarEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // The titlebar mounts in the same commit as this panel, so resolve the
    // portal target only after the DOM is actually committed.
    setTitlebarEl(document.getElementById("titlebar-toolbar"));
  }, []);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  // Mirror of `recording` so the global keydown handler (which lives in a
  // useEffect with a stable closure) can read the latest value without
  // re-subscribing on every render.
  const recordingRef = useRef(false);
  // Pending ask/permission requests live on the chat in the store
  // (Chat.pendingAsk / Chat.pendingPermission), NOT local state:
  // `<ChatPanel key={activeChatId} />` fully unmounts/remounts on every chat
  // switch, so local state would silently lose a request that arrives while
  // the user is viewing another chat (the popup would never appear). Deriving
  // from the reactive `chat` object re-renders this panel whenever the store
  // updates the field.
  const askReq = chat?.pendingAsk ?? null;
  const permissionReq = chat?.pendingPermission ?? null;
  const [askFreeText, setAskFreeText] = useState("");
  const mcpConnectors = useStore((s) => s.settings.mcpServers ?? {});
  const mcpEnabled = useStore((s) => s.settings.mcpEnabled ?? []);
  const setMcpEnabled = useStore((s) => s.setMcpEnabled);
  const skillQ = skillQuery.trim().toLowerCase();
  const filteredMcp = Object.keys(mcpConnectors).filter(
    (name) => !skillQ || name.toLowerCase().includes(skillQ),
  );
  const skillOptions = filteredMcp.map((name) => ({
    kind: "mcp" as const,
    name,
  }));
  const atQuery = skillMentionQuery.trim().toLowerCase();
  const filteredSkills = skillsList.filter(
    (s) =>
      !atQuery ||
      s.name.toLowerCase().includes(atQuery) ||
      (s.slug && s.slug.toLowerCase().includes(atQuery)) ||
      s.description.toLowerCase().includes(atQuery),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // Per-chat scroll restoration: captured once per mount (the panel remounts on
  // every chat switch via key={activeChatId}). If the user last left this chat
  // scrolled up, don't auto-pin to the bottom on return.
  const [initialScrollPos] = useState(() => chat?.scrollPos ?? null);
  const stickToBottom = useRef(!initialScrollPos || initialScrollPos.atBottom);
  const [showJump, setShowJump] = useState(false);
  /** Lazy transcript: only the last MSG_PAGE messages render on mount (and on
   *  every chat switch — the panel is keyed by activeChatId). Older messages
   *  load progressively on scroll-to-top or via the "load older" button, so a
   *  long history never blocks the first paint of a chat.
   *  The slice is applied at render time over `chat.messages`, so streaming
   *  appends at the bottom always show. */
  const MSG_PAGE = 30;
  // Extra messages rendered ABOVE the restore anchor so the saved viewport can
  // be positioned exactly: the anchor isn't the first rendered message, so the
  // restore has real content above it to scroll against (and the messages the
  // user saw above the anchor are actually there).
  const SCROLL_RESTORE_BUFFER = 5;
  const [msgLimit, setMsgLimit] = useState(() => {
    // Restoring a scrolled-up position: render enough history so the anchor
    // message exists on the first paint (no flash of the wrong viewport), plus
    // a small buffer above it for an exact restore.
    const pos = chat?.scrollPos;
    if (pos && !pos.atBottom && chat) {
      const idx = chat.messages.findIndex((m) => m.id === pos.id);
      if (idx >= 0) {
        const start = Math.max(0, idx - SCROLL_RESTORE_BUFFER);
        return Math.max(MSG_PAGE, chat.messages.length - start);
      }
    }
    return MSG_PAGE;
  });
  /** When older messages are prepended above the viewport, remember the
   *  pre-append scrollHeight so a layout effect can re-anchor the scroll
   *  position (otherwise the content visibly jumps). */
  const prependAnchorRef = useRef<number | null>(null);
  /** True once the saved scroll position has been restored this mount. */
  const restoredRef = useRef(false);
  /** Last computed scroll anchor (updated on every user scroll; flushed to the
   *  store on unmount / app close so a quick chat switch never loses the
   *  viewport). */
  const lastScrollPosRef = useRef<{
    id: string;
    offset: number;
    atBottom: boolean;
  } | null>(null);
  /** While a saved viewport is being restored, keep re-anchoring to it as the
   *  content around the anchor actually renders (content-visibility placeholders
   *  → real heights, images, code blocks). Cleared once stable or when the user
   *  scrolls away. */
  const restoreTargetRef = useRef<{ id: string; offset: number } | null>(null);
  /** The scrollTop the restore last set — used to tell programmatic re-anchors
   *  apart from a real user scroll (which cancels the restore). */
  const restoreScrollRef = useRef<number | null>(null);
  /** Bumped to force the transcript to the bottom even when the user scrolled
   *  up (send / queue / steer). The auto-scroll effect depends on it. */
  const [scrollTick, setScrollTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const chatIdRef = useRef(chat?.id ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skillPopupRef = useRef<HTMLDivElement>(null);
  const lastEventAt = useRef(0);
  const toolRunningRef = useRef(false);
  /** When the stall hint first turned on (see the watchdog in `send`); null
   *  while not stalled. Used to escalate a passive hint into a forced abort
   *  after a further grace period. */
  const stalledSinceRef = useRef<number | null>(null);
  /** True when the CURRENT request was aborted by the stall watchdog itself
   *  (not by the user clicking Stop) — so the catch block can show a real
   *  error instead of silently treating it like a user-initiated cancel. */
  const watchdogAbortedRef = useRef(false);
  /** Number of times the stall watchdog has auto-retried the current turn, so
   *  it retries on a bounded loop (then escalates to a forced abort) instead of
   *  looping forever on a genuinely dead connection. */
  const watchdogAutoRetriedRef = useRef(0);
  const toggleRecordingRef = useRef<() => void>(() => { });
  /** Whether the open Neovim file is selected to be mentioned on the next send. */
  const [nvimMentioned, setNvimMentioned] = useState(false);
  /** Whether the LSP diagnostics popover under the nvim label is open. */
  const [lspOpen, setLspOpen] = useState(false);
  // Transient compact/command/stall banners live on the chat record in the
  // store (not local component state) for the same reason as pendingAsk:
  // `<ChatPanel key={activeChatId} />` remounts on every chat switch, so local
  // state would silently drop these the moment the user looks at another chat
  // and comes back. Deriving from the reactive `chat` object re-renders this
  // panel whenever the store updates the field.
  const compactNotice = chat?.compactNotice ?? null;
  const compactError = chat?.compactError ?? null;
  const compacting = chat?.compacting ?? false;
  const cmdError = chat?.cmdError ?? null;
  const stalled = chat?.stalled ?? false;
  /** The Ctrl+X prefix is app-wide (managed in App.tsx), so its hint lives at
   *  the store root — it survives chat switches too. */
  const prefixNotice = useStore((s) => s.prefixNotice ?? null);
  const thinkingLevel = chat?.thinkingLevel ?? "medium";
  const setThinkingLevel = (lv: ThinkingLevel) => {
    if (chat) useStore.getState().setChatThinkingLevel(chat.id, lv);
  };

  // Reasoning-effort popup (replaces the native <select>): open state + close
  // on outside click / Escape.
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const thinkingRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!thinkingOpen) return;
    function onDocClick(e: MouseEvent) {
      if (
        thinkingRef.current &&
        !thinkingRef.current.contains(e.target as Node)
      ) {
        setThinkingOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setThinkingOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [thinkingOpen]);

  // While recording, Space stops the recording from anywhere — even when the
  // textarea is focused (a focused input would otherwise swallow the key and
  // just insert a space). Only a plain Space toggles; modifier combos fall
  // through to normal handling. Registered unconditionally so it works in the
  // normal (non-thinking) state too.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        recordingRef.current &&
        e.key === " " &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        toggleRecordingRef.current();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Auto-dismiss the "Context compacted" notice: show it ~4.5s, fade out over
  // 0.5s, then clear it from the store. Per-chat, so switching away and back
  // restarts the countdown instead of leaving a stale banner forever.
  const [noticeLeaving, setNoticeLeaving] = useState(false);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!chat?.compactNotice) {
      setNoticeLeaving(false);
      return;
    }
    setNoticeLeaving(false);
    noticeTimerRef.current = setTimeout(() => {
      setNoticeLeaving(true);
      noticeTimerRef.current = setTimeout(() => {
        useStore.getState().setChatCompactNotice(chat.id, null);
      }, 500);
    }, 4500);
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, [chat?.id, chat?.compactNotice]);

  // Switch the CURRENT chat's mode. No UI toast — the agent knows which mode the
  // next message runs in; the user doesn't need a visible confirmation.
  const changeMode = (mode: AgentMode) => {
    if (!chat) return;
    useStore.getState().setChatMode(chat.id, mode);
  };

  // Cycle to the next/previous mode in the current chat (Tab / ⌘M).
  const cycleMode = (dir: 1 | -1) => {
    if (!chat) return;
    const ids = allModes(useStore.getState().settings).map((m) => m.id);
    const idx = ids.indexOf(chat.mode);
    const next = ids[(idx + dir + ids.length) % ids.length] ?? "ask";
    changeMode(next);
  };

  // Stable ref so the global coder:cmd listener below always invokes the latest
  // handleCommand (fresh closures over chat/compact/busy state).
  const handleCommandRef = useRef<(v: string) => Promise<void>>(() =>
    Promise.resolve(),
  );

  useEffect(() => {
    const onCmd = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      if (typeof cmd === "string") void handleCommandRef.current(cmd);
    };
    const onPrefix = (e: Event) => {
      const active = (e as CustomEvent<boolean>).detail === true;
      useStore.getState().setPrefixNotice(
        active
          ? `Prefix ${PREFIX_LABEL} active — press ${Object.keys(
            PREFIX_SHORTCUTS,
          )
            .map((k) => (k === " " ? "Space" : k))
            .join(" / ")}`
          : null,
      );
    };
    window.addEventListener("coder:cmd", onCmd);
    window.addEventListener("coder:prefix", onPrefix);
    return () => {
      window.removeEventListener("coder:cmd", onCmd);
      window.removeEventListener("coder:prefix", onPrefix);
    };
  }, []);

  // Close the skills/MCP popup when clicking outside of it.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (
        skillPopupRef.current &&
        !skillPopupRef.current.contains(e.target as Node)
      ) {
        setSkillOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    window.coder
      .getSidecarUrl()
      .then((url) => setSidecarStatus(url ? "ok" : "fail"));
  }, []);

  // Track the file currently open in Neovim (fed by the main-process watcher,
  // which queries the nvim RPC socket). Only the path is stored here; the label
  // is shown automatically and the file is sent to the agent only when the user
  // explicitly clicks/selects it for that message.
  useEffect(() => {
    let cancelled = false;
    window.coder
      .getNvimFile()
      .then((f) => {
        if (cancelled) return;
        useStore.getState().setNvimFile(f.abs);
        useStore
          .getState()
          .setNvimDiagnostics((f.diagnostics ?? []) as NvimDiagnostic[]);
      })
      .catch(() => undefined);
    const unsub = window.coder.onNvimFile((f) => {
      if (cancelled) return;
      useStore.getState().setNvimFile(f.abs);
      useStore
        .getState()
        .setNvimDiagnostics((f.diagnostics ?? []) as NvimDiagnostic[]);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Keep the pending composer state (input text + chips) scoped to THIS chat by
  // persisting it into the chat's draft whenever it changes. The ChatPanel is
  // keyed by activeChatId so switching chats remounts with that chat's own draft.
  useEffect(() => {
    if (!chat) return;
    useStore.getState().setChatDraft(chat.id, {
      input,
      attachments,
      images,
    });
  }, [chat?.id, input, attachments, images]);
  // Keep the model context window (and pricing, when the provider advertises
  // it) fresh from the provider's live /models list, so the context meter
  // reflects the model's real capacity and cost (not a hardcoded default).
  // Refetch only when the provider's identity changes.
  useEffect(() => {
    let cancelled = false;
    if (!provider.kind) return;
    void fetchModels(provider)
      .then((res) => {
        if (cancelled) return;
        useStore.getState().setProviderContextMap(provider.id, res.context);
        useStore.getState().setProviderPricingMap(provider.id, res.pricing);
        useStore.getState().setProviderReasoningMap(provider.id, res.reasoning);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    provider.id,
    provider.kind,
    provider.baseUrl,
    provider.apiKey,
    provider.envVar,
  ]);

  useEffect(() => {
    if (!wroot || attachments.length === 0) {
      setAttLen(0);
      return;
    }
    let total = 0;
    attachments.forEach((a) => {
      void api
        .fsRead(wroot, a)
        .then((r) => {
          total += r.content.length;
          setAttLen(total);
        })
        .catch(() => undefined);
    });
  }, [wroot, attachments]);

  /** Distance from the bottom still treated as "at bottom". Kept small (8px) so
   *  a slight scroll-up is saved exactly instead of snapping back to the bottom
   *  on return; the ResizeObserver reconcile re-pins while streaming anyway. */
  const AT_BOTTOM_EPS = 8;
  /** Snapshot the current viewport as a message-anchored scroll position. */
  const computeScrollPos = (
    el: HTMLDivElement,
  ): { id: string; offset: number; atBottom: boolean } | null => {
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_EPS;
    // At the bottom (the common case while streaming) there is nothing to scan:
    // the id is unused for atBottom restores, so return without touching the DOM.
    if (atBottom) return { id: "", offset: 0, atBottom: true };
    const msgs = el.querySelectorAll<HTMLElement>("[data-msg-id]");
    if (msgs.length === 0) return null;
    const containerRect = el.getBoundingClientRect();
    let anchor: HTMLElement | null = null;
    for (const m of msgs) {
      if (m.getBoundingClientRect().bottom >= containerRect.top) {
        anchor = m;
        break;
      }
    }
    if (!anchor) anchor = msgs[msgs.length - 1];
    return {
      id: anchor.dataset.msgId ?? "",
      offset: anchor.getBoundingClientRect().top - containerRect.top,
      atBottom: false,
    };
  };

  /** Coalesce the (DOM-scanning) position capture to at most once per frame —
   *  scroll events can fire many times per frame, and querySelectorAll +
   *  getBoundingClientRect on every event is the main CPU cost of scrolling. */
  const scrollRafRef = useRef<number | null>(null);
  const syncScrollPos = () => {
    if (scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    const el = scrollRef.current;
    if (!el) return;
    const pos = computeScrollPos(el);
    if (pos) lastScrollPosRef.current = pos;
  };

  const onChatScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // If the user scrolls away from the position the restore set, stop
    // re-anchoring (the restore is only for the initial viewport).
    if (
      restoreTargetRef.current &&
      restoreScrollRef.current !== null &&
      el.scrollTop !== restoreScrollRef.current
    ) {
      restoreTargetRef.current = null;
      restoreScrollRef.current = null;
    }
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_EPS;
    stickToBottom.current = atBottom;
    // Bail out when unchanged so scrolling doesn't re-render the whole panel on
    // every tick — the jump button only flips once per boundary crossing.
    setShowJump((prev) => (prev === !atBottom ? prev : !atBottom));
    // Reached the top with older messages still unrendered → load the previous
    // page. Anchored via prependAnchorRef so the viewport doesn't jump.
    if (el.scrollTop < 40 && chat && chat.messages.length > msgLimit) {
      prependAnchorRef.current = el.scrollHeight;
      setMsgLimit((n) => Math.min(chat.messages.length, n + MSG_PAGE));
    }
    // Remember where the user left this chat — in-memory only. The cheap parts
    // run here; the DOM scan is deferred to the next frame (and flushed
    // synchronously on chat switch / app close via syncScrollPos).
    if (scrollRafRef.current == null) {
      scrollRafRef.current = requestAnimationFrame(syncScrollPos);
    }
  };

  /** Force the transcript to the bottom regardless of where the user scrolled
   *  (used when the user sends / queues / steers a message). */
  const forceScrollToBottom = () => {
    stickToBottom.current = true;
    setShowJump(false);
    setScrollTick((t) => t + 1);
    // The user is pinned to the newest messages — record it so a later chat
    // switch / restart restores the bottom instead of a stale scrolled-up spot.
    // The id is unused for atBottom restores, so no DOM scan is needed here.
    if (chat?.id) {
      const lastId = chat.messages.length
        ? (chat.messages[chat.messages.length - 1].id ?? "")
        : "";
      lastScrollPosRef.current = { id: lastId, offset: 0, atBottom: true };
      useStore.getState().setChatScrollPos(chat.id, lastScrollPosRef.current);
    }
  };

  useEffect(() => {
    if (!stickToBottom.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat?.messages, scrollTick]);

  // The jump-to-bottom button is driven by onChatScroll, which only fires on
  // user scrolls. Async growth of the transcript (images decoding, fonts, code
  // highlighting) can silently push the viewport off-bottom — on mount or
  // while pinned — without any scroll event, leaving the button hidden until
  // the user scrolls. Watch the message list's size and reconcile: re-pin when
  // the user never scrolled up, otherwise surface the jump button.
  useEffect(() => {
    const el = scrollRef.current;
    const content = el?.firstElementChild;
    if (!el) return;
    const reconcile = () => {
      // While restoring a saved viewport, re-anchor to it on every content
      // resize — content-visibility: auto lays off-screen messages out with
      // 140px placeholders on a fresh mount, and images/code blocks settle
      // later, so the anchor's real position only stabilizes over time.
      const target = restoreTargetRef.current;
      if (target) {
        const a = el.querySelector<HTMLElement>(`[data-msg-id="${target.id}"]`);
        if (a) {
          const cRect = el.getBoundingClientRect();
          const aRect = a.getBoundingClientRect();
          const desired =
            el.scrollTop + (aRect.top - cRect.top - target.offset);
          if (Math.abs(desired - el.scrollTop) > 1) {
            restoreScrollRef.current = desired;
            el.scrollTop = desired;
          } else {
            restoreTargetRef.current = null;
            restoreScrollRef.current = null;
          }
        } else {
          restoreTargetRef.current = null;
          restoreScrollRef.current = null;
        }
        return;
      }
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_EPS;
      if (stickToBottom.current) {
        el.scrollTop = el.scrollHeight;
      } else if (!atBottom) {
        setShowJump(true);
      }
    };
    const ro = new ResizeObserver(reconcile);
    if (content) ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
    // The observed nodes (.chat-scroll and its .chat-messages child) are stable
    // across renders, so subscribe once on mount — re-subscribing on every
    // message append (streaming) only churned the observer for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The composer floats over the conversation (position: absolute; bottom: 0)
  // and the ask/perm cards anchor above it (bottom: calc(100% + 10px)), so the
  // fixed 210px padding-bottom on .chat-scroll only clears the idle composer.
  // When a card is open (up to 46vh) or the textarea grows (up to 200px), the
  // floating UI extends higher and would cover the last messages. Measure the
  // real floating height and grow the scroll padding to match.
  useEffect(() => {
    const el = scrollRef.current;
    const composer = composerRef.current;
    if (!el || !composer) return;
    const update = () => {
      const card = composer.querySelector<HTMLElement>(".ask-card, .perm-card");
      const composerH = composer.getBoundingClientRect().height;
      const cardH = card ? card.getBoundingClientRect().height : null;
      el.style.paddingBottom = `${composerScrollPadding(composerH, cardH)}px`;
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(composer);
    const card = composer.querySelector<HTMLElement>(".ask-card, .perm-card");
    if (card) ro.observe(card);
    return () => {
      ro.disconnect();
      el.style.paddingBottom = "";
    };
  }, [askReq, permissionReq]);

  // Keep the viewport pinned when older messages are prepended above it
  // (lazy paging on scroll-to-top / "load older"): the browser grows the
  // scrollHeight by exactly the height of the new content, so re-anchor by
  // that delta BEFORE paint to avoid a visible jump.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || prependAnchorRef.current == null) return;
    el.scrollTop += el.scrollHeight - prependAnchorRef.current;
    prependAnchorRef.current = null;
  }, [msgLimit]);

  // Restore the saved scroll position once the anchor message is rendered.
  // Runs before paint, so the viewport lands where the user left it without a
  // visible jump. Fires once per mount (restoredRef).
  useLayoutEffect(() => {
    if (restoredRef.current) return;
    const pos = initialScrollPos;
    if (!pos || pos.atBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    let anchor = el.querySelector<HTMLElement>(`[data-msg-id="${pos.id}"]`);
    let anchorId = pos.id;
    if (!anchor) {
      // Anchor gone (compacted away, truncated by /undo or retry, or a message
      // that no longer renders) → land on the nearest surviving message instead
      // of jumping to the bottom, so the user returns as close as possible to
      // where they left off.
      const rendered = new Set(
        Array.from(el.querySelectorAll<HTMLElement>("[data-msg-id]")).map(
          (n) => n.dataset.msgId ?? "",
        ),
      );
      const msgs = chat?.messages ?? [];
      const idx = msgs.findIndex((m) => m.id === pos.id);
      if (idx >= 0) {
        // The anchor still exists but isn't rendered → nearest rendered message above it.
        for (let i = idx - 1; i >= 0; i--) {
          if (rendered.has(msgs[i].id)) {
            anchorId = msgs[i].id;
            break;
          }
        }
      } else {
        // The anchor was removed entirely → oldest surviving rendered message
        // (closest to where the compacted/truncated range used to be).
        anchorId = rendered.values().next().value ?? "";
      }
      anchor = anchorId
        ? el.querySelector<HTMLElement>(`[data-msg-id="${anchorId}"]`)
        : null;
    }
    if (!anchor) {
      // Nothing left to anchor to → fall back to the newest messages.
      restoredRef.current = true;
      stickToBottom.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    restoredRef.current = true;
    const containerRect = el.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    el.scrollTop += anchorRect.top - containerRect.top - pos.offset;
    setShowJump(false);
    // content-visibility: auto skips off-screen messages on a fresh mount, so
    // the first pass lands near the anchor using 140px placeholders — the
    // restored viewport can be off by the difference between placeholder and
    // real heights. Keep re-anchoring (via the ResizeObserver reconcile above)
    // as the browser actually renders the content around the anchor, until the
    // position stabilizes or the user scrolls away.
    restoreTargetRef.current = { id: anchorId, offset: pos.offset };
    restoreScrollRef.current = el.scrollTop;
  }, [initialScrollPos, msgLimit, chat]);

  // Flush the saved scroll position on unmount (chat switch) and on app close
  // (pagehide/beforeunload) so the last viewport is never lost. The store write
  // is cheap here — it happens once per switch/close, not per scroll.
  useEffect(() => {
    const cid = chat?.id;
    // Push the ref-held position into the store WITHOUT persisting. Used by the
    // `coder:flush-ui` event (dispatched by the store right before any flush,
    // including the main process's `flush-persist` on quit — which runs before
    // this component's beforeunload handler) so the snapshot always includes it.
    const pushToStore = () => {
      if (!cid) return;
      // If a scroll happened in the last frame, its rAF capture may not have
      // fired yet — compute synchronously so the position saved is exactly the
      // viewport at flush time (cheap: no-op unless a capture is pending).
      syncScrollPos();
      if (lastScrollPosRef.current) {
        useStore.getState().setChatScrollPosMem(cid, lastScrollPosRef.current);
      }
    };
    // Unmount (chat switch): push + persist so the position survives.
    const flush = () => {
      pushToStore();
      if (cid && lastScrollPosRef.current) {
        useStore.getState().persist();
      }
    };
    // App close: push the position into the store AND force an immediate write,
    // so it survives even if the store's own beforeunload flush already ran.
    const flushOnClose = () => {
      pushToStore();
      useStore.getState().flushNow();
    };
    window.addEventListener("coder:flush-ui", pushToStore);
    window.addEventListener("pagehide", flushOnClose);
    window.addEventListener("beforeunload", flushOnClose);
    return () => {
      window.removeEventListener("coder:flush-ui", pushToStore);
      window.removeEventListener("pagehide", flushOnClose);
      window.removeEventListener("beforeunload", flushOnClose);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // forkSection (reading mode → "سوال از این بخش") sets this flag so the
  // freshly-created chat's composer is focused on mount, letting the user type
  // their follow-up question immediately. The panel remounts per chat
  // (key={activeChatId}), so a mount-only effect is the right hook.
  useEffect(() => {
    const s = useStore.getState();
    if (!s.focusComposer) return;
    s.setFocusComposer(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onToggleMode = () => {
      cycleMode(1);
    };
    const onAttachFile = (e: Event) => {
      const rel = (e as CustomEvent<{ rel: string }>).detail?.rel;
      if (!rel || !wroot) return;
      setAttachments((a) => (a.includes(rel) ? a : [...a, rel]));
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    const onToggleVoice = () => {
      toggleRecordingRef.current();
    };
    window.addEventListener("coder:toggle-mode", onToggleMode);
    window.addEventListener("coder:toggle-voice", onToggleVoice);
    window.addEventListener("coder:attach-file", onAttachFile as EventListener);
    return () => {
      window.removeEventListener("coder:toggle-mode", onToggleMode);
      window.removeEventListener("coder:toggle-voice", onToggleVoice);
      window.removeEventListener(
        "coder:attach-file",
        onAttachFile as EventListener,
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id, chat?.mode, wroot]);

  const filteredCmds = useMemo(() => {
    if (!cmdOpen) return [];
    const q = cmdQuery.toLowerCase();
    return COMMANDS.filter(
      (c) => c.name.includes(q) || c.hint.toLowerCase().includes(q),
    ).slice(0, 10);
  }, [cmdOpen, cmdQuery]);

  const ctxWindow = modelContextWindow(provider, activeModel);

  // Context count for the titlebar meter — see `computeContextUsed`: the latest
  // assistant turn's token total (input + output + cache), matching opencode's
  // `overflow.ts` accounting, with the full-conversation estimate as a fallback
  // before the first usage event.
  const contextUsed = useMemo(
    () =>
      computeContextUsed(
        chat,
        systemPrompt,
        maxHistory,
        ctxWindow ?? undefined,
        chat?.mode,
      ),
    [chat, systemPrompt, maxHistory, ctxWindow],
  );

  const ctxPct = contextPercent(contextUsed, ctxWindow);

  // This chat's CUMULATIVE token usage & cost per model (main + explore /
  // compact / vision sub-agents). Tracked in the chat record itself so it
  // survives compacts and chat switches — session totals only ever grow. Each
  // model is priced with its OWN advertised rate when the provider publishes
  // one — never the parent model's rate (would silently misprice old models).
  const sessionUsage = useMemo(() => {
    const usage = chat?.usage ?? {};
    const out: Array<{
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost: number | null;
    }> = [];
    for (const [model, u] of Object.entries(usage)) {
      if (u.input + u.output <= 0) continue;
      const price = provider.pricingMap?.[model] ?? null;
      // input_tokens already includes the cache-read/write portion; bill the
      // cache lines at their own cheaper rate when advertised, else full input.
      const cacheRead = u.cacheRead ?? 0;
      const cacheWrite = u.cacheWrite ?? 0;
      const cost = price
        ? ((u.input - cacheRead - cacheWrite) / 1_000_000) * price.input +
        (cacheRead / 1_000_000) * (price.cacheRead ?? price.input) +
        (cacheWrite / 1_000_000) * (price.cacheWrite ?? price.input) +
        (u.output / 1_000_000) * price.output
        : null;
      out.push({
        model,
        input: u.input,
        output: u.output,
        cacheRead,
        cacheWrite,
        cost,
      });
    }
    out.sort((a, b) => b.input + b.output - (a.input + a.output));
    return out;
  }, [chat?.usage, provider.pricingMap]);

  const send = async (
    text: string,
    atts: string[] = [],
    imgs: Array<{ path: string; name: string; dataUrl?: string }> = [],
    allowCreate = false,
    reuseMsgId?: string,
    forceScroll = false,
  ) => {
    const s = useStore.getState();
    // Use THIS panel's chat (captured at render), never s.activeChatId: a
    // queued turn drained while the user is viewing ANOTHER chat must still
    // target this chat's messages/usage.
    const chat = s.chats.find((c) => c.id === chatIdRef.current) ?? null;
    if (!chat) return;
    // Messages that ask to create/install skills or MCP connectors also grant
    // the create_skill/create_mcp tools — in EVERY mode (ask, plan, coder).
    // The grant is sticky across the conversation: check the current message AND
    // the last several chat messages, so a follow-up like "ادامه بده" keeps the
    // tools it was originally granted (the user's install request is still in
    // history and matches the intent).
    if (!allowCreate) {
      if (wantsSkillOrMcp(text)) {
        allowCreate = true;
      } else {
        const recent = chat.messages.slice(-6);
        for (const m of recent) {
          if (m.role === "user" && m.content && wantsSkillOrMcp(m.content)) {
            allowCreate = true;
            break;
          }
        }
      }
    }
    const rootDir = chat.root || s.root;
    if (!rootDir) return;
    const activeProvider = getChatProvider(chat.id);
    if (!activeProvider.model) {
      s.setSettingsOpen(true);
      return;
    }
    s.addRecentModel(activeProvider.model, activeProvider.id);

    // Enabled MCP connectors (persistent switches) become an explicit
    // instruction on this turn.
    const skillNotes: string[] = [];
    for (const name of s.settings.mcpEnabled ?? []) {
      if (s.settings.mcpServers?.[name]) {
        skillNotes.push(
          `Use the MCP tools from server "${name}" where relevant.`,
        );
      }
    }
    // Manual @skill mentions: extract the skill names the user attached with
    // @, pass them to the backend (only those are loaded — there is no
    // auto-selection) and strip the @mentions from the prompt so the model
    // doesn't see raw @tokens. The stored transcript keeps the original text
    // with the @mentions. The canonical token is the skill slug (space-free);
    // a legacy display-name fallback is also supported.
    // Guard: ensure the skill list is loaded before matching, so a mention
    // typed/pasted before the picker opened (or before the async fetch
    // resolved) is never missed.
    if (getSkillsList().length === 0) {
      await ensureSkillsList();
    }
    const { skills: mentionSkills, cleaned: cleanedText } =
      extractMentionSkills(text, getSkillsList());
    const finalPrompt =
      skillNotes.length > 0
        ? `${cleanedText}\n\n=== USER-SELECTED SKILLS/TOOLS FOR THIS TURN ===\n${skillNotes.join(
          "\n",
        )}`
        : cleanedText;

    // If a previous run was interrupted mid-task (its checklist isn't fully
    // completed), remind the model of the current plan state so it continues
    // ticking the same steps instead of re-planning from scratch. The note is
    // only sent to the model — the stored user message keeps just `text`.
    let promptWithResume = finalPrompt;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const plan = chat.messages[i].plan;
      if (
        plan &&
        plan.length > 0 &&
        (!chat.messages[i].mode || chat.messages[i].mode === chat.mode)
      ) {
        if (!plan.every((t) => t.status === "completed")) {
          const lines = plan
            .map(
              (t) =>
                `- [${t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : " "}] ${t.content}`,
            )
            .join("\n");
          promptWithResume += `\n\n[SYSTEM: a task was interrupted mid-way in this chat. Its checklist currently is:\n${lines}\nIf this message continues that task, PRESERVE this exact checklist and mark progress via update_plan (same items, update statuses) — do not create a new one. If this message is a new, unrelated task, ignore this note.]`;
        }
        break;
      }
    }
    setSkillOpen(false);

    // When draining an undelivered steer, REUSE the user message that is
    // already visible in the transcript instead of creating a new bubble, and
    // clear its steerPending flag so the drain can't re-pick it.
    let userMsg: ReturnType<typeof s.addMessage> | undefined;
    if (reuseMsgId) {
      userMsg = chat.messages.find((m) => m.id === reuseMsgId);
      if (userMsg) s.updateMessage(userMsg.id, { steerPending: false });
    }
    if (!userMsg) {
      userMsg = s.addMessage(chat.id, {
        role: "user",
        content: text,
        attachments: atts,
        images: imgs,
      });
    }
    const assistantMsg = s.addMessage(chat.id, {
      role: "assistant",
      content: "",
      mode: chat.mode,
      toolActivity: [],
      segments: [],
      streaming: true,
    });
    // User-initiated sends jump to the bottom even if they scrolled up (the
    // auto-drain path passes forceScroll=false so it never yanks the user away
    // from history they are reading).
    if (forceScroll) forceScrollToBottom();

    // Clear any lingering retry banner from a previous message before sending.
    for (const m of chat.messages) {
      if (m.retry) s.updateMessage(m.id, { retry: null });
    }

    const allHistory = chat.messages
      .filter(
        (m) =>
          m.id !== userMsg.id &&
          !m.compacted &&
          (m.role === "user" || m.role === "assistant" || m.role === "system"),
      )
      // The summary is stored last (so it renders below the conversation), but
      // the model must receive it FIRST — it stands in for the older turns.
      .sort(
        (a, b) =>
          (a.role === "system" ? -1 : 0) - (b.role === "system" ? -1 : 0),
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
        thinking: m.thinking,
        plan: m.plan,
        mode: m.mode,
        toolActivity: (m.toolActivity ?? []).filter(
          (a) => a.status !== "running",
        ),
      }));
    const history = sliceToBudget(
      allHistory,
      maxHistory,
      ctxWindow ?? undefined,
      chat.mode,
      useStore.getState().settings.compactHeadroom ?? 20000,
    );

    const abort = new AbortController();
    abortRef.current = abort;
    useStore.getState().setChatAbort(chat.id, abort);
    setBusy(true);
    useStore.getState().setChatStalled(chat.id, false);
    lastEventAt.current = Date.now();
    stalledSinceRef.current = null;
    watchdogAbortedRef.current = false;
    watchdogAutoRetriedRef.current = 0;
    useStore.getState().setStreaming(true, false);

    // Append a text slice to the message's segment list, merging into the
    // trailing text segment when there is one so tool boundaries stay clean.
    const appendTextSegment = (
      segs: MessageSegment[] | undefined,
      chunk: string,
    ): MessageSegment[] => {
      const cur = segs && segs.length ? [...segs] : [];
      if (!chunk) return cur;
      const last = cur[cur.length - 1];
      if (last && last.kind === "text") {
        cur[cur.length - 1] = { kind: "text", text: last.text + chunk };
      } else {
        cur.push({ kind: "text", text: chunk });
      }
      return cur;
    };

    // Watchdog: if the provider stalls (no SSE event at all), auto-retry ONCE
    // after a short silence instead of hanging. 30s because the backend's own
    // retry loop already covers transient 5xx/throttle blips with a 30s backoff
    // and emits a `retry` event — so reaching 30s of TOTAL silence means the
    // backend isn't even retrying (dead socket / crashed process / a thinking
    // model that's genuinely stuck). Auto-retry re-sends the last user turn and
    // lets the backend's retry loop take over if it's a real failure. We retry
    // on a LOOP with exponential backoff (not just once) so a flaky connection
    // self-heals instead of leaving the user stuck — but only force-abort if
    // the silence continues well past the final retry (truly dead socket /
    // crashed backend). A truly dead connection produces NO event ever, so
    // handleEvent's own "error" path can never fire on its own — without this,
    // `busy` stays true and the composer's Send button stays stuck on the stop
    // icon forever, with no visible error at all.
    const HARD_STALL_GRACE_MS = 120_000;
    const WATCHDOG_MAX_RETRIES = 5;
    const WATCHDOG_BASE_BACKOFF_MS = 30_000;
    const stallTimer = setInterval(() => {
      // While the agent is waiting for the user to answer a permission /
      // confirm / ask request, it is legitimately paused — never treat that
      // as a stall and never force-abort, no matter how long the user takes.
      const chatState = useStore.getState().chats.find((c) => c.id === chat.id);
      if (chatState?.pendingPermission || chatState?.pendingAsk) {
        stalledSinceRef.current = null;
        useStore.getState().setChatStalled(chat.id, false);
        return;
      }
      // A tool that's still running gets a much longer leash — it's doing real
      // work, not stalled on the provider.
      const limit = toolRunningRef.current ? 900_000 : 180_000;
      const elapsed = Date.now() - lastEventAt.current;
      if (elapsed <= limit) {
        stalledSinceRef.current = null;
        return;
      }
      useStore.getState().setChatStalled(chat.id, true);
      if (stalledSinceRef.current == null) stalledSinceRef.current = Date.now();
      // Auto-retry on a loop with exponential backoff. Each retry re-sends the
      // last user turn; the backend's own retry loop handles transient failures.
      // Only force-abort if we've exhausted the retries AND the silence drags on
      // far past the last one (a genuinely dead connection).
      if (watchdogAutoRetriedRef.current < WATCHDOG_MAX_RETRIES) {
        watchdogAutoRetriedRef.current += 1;
        const msgs = chat?.messages ?? [];
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        if (lastUser) {
          // RESUME the same user turn WITHOUT truncating: retryMessage() would
          // call truncateTo() here because the stalled assistant turn isn't
          // flagged failed/error yet (the stream is still alive, just silent),
          // which deletes every message after the user turn. Abort the stalled
          // stream first, then re-send the same user message so the backend
          // continues from where it was cut off — no messages are lost.
          if (!abort.signal.aborted) abort.abort();
          setTimeout(
            () =>
              send(
                lastUser.content,
                lastUser.attachments ?? [],
                lastUser.images ?? [],
                false,
                lastUser.id,
              ),
            0,
          );
        }
        return;
      }
      if (Date.now() - stalledSinceRef.current > HARD_STALL_GRACE_MS) {
        watchdogAbortedRef.current = true;
        abort.abort();
      }
    }, 10_000);

    // Preserve tool-call context on a FAILED turn so the next one doesn't redo
    // it. `toolActivity` is a frontend-only render field and never part of the
    // `history` sent to the backend (only role/content travel), so without
    // folding the completed tool calls into `content`, the next turn would not
    // know what this turn already did and would redo it from scratch. Fire it
    // on EVERY failure path: the streamChat catch below AND inline SSE "error"
    // events (a backend fatal arrives as a normal event, not a throw).
    // A turn's stream can end without a tool_result for every started card
    // (backend crash, stop, error, lost SSE). Force any still-"running" card to
    // "done" so the spinner/tick never hangs forever.
    const resolveStuckCards = () => {
      const msg = useStore
        .getState()
        .chats.find((c) => c.id === chat.id)
        ?.messages.find((m) => m.id === assistantMsg.id);
      if (!msg || !msg.toolActivity?.some((a) => a.status === "running"))
        return;
      const now = Date.now();
      useStore.getState().updateMessage(assistantMsg.id, {
        toolActivity: msg.toolActivity.map((a) =>
          a.status === "running"
            ? { ...a, status: "done", elapsedMs: now - (a.startedAt ?? now) }
            : a,
        ),
      });
    };

    const preserveToolActivity = () => {
      const doneActs = (
        useStore
          .getState()
          .chats.find((c) => c.id === chat.id)
          ?.messages.find((m) => m.id === assistantMsg.id)?.toolActivity ?? []
      ).filter((a) => a.status !== "running");
      if (doneActs.length === 0) return;
      const lines = doneActs
        .slice(0, 20)
        .map((a) => `- ${a.tool}${a.summary ? `: ${a.summary}` : ""}`);
      const note = `\n\n[Interrupted before finishing. Already done this turn — do NOT repeat these:\n${lines.join("\n")}]`;
      const current = useStore
        .getState()
        .chats.find((c) => c.id === chat.id)
        ?.messages.find((m) => m.id === assistantMsg.id);
      useStore.getState().updateMessage(assistantMsg.id, {
        content: (current?.content ?? "") + note,
      });
    };

    const handleEvent = (event: SidecarEvent) => {
      // Heartbeat from the backend: it arrives every ~15s while the agent is
      // legitimately silent (running a tool / thinking). Refresh the watchdog
      // clock so a long-running tool is NOT mistaken for a dead connection —
      // only a socket that stops emitting keepalives (a genuinely dead one)
      // should trip the stall watchdog. No UI work needed.
      if (event.kind === "keepalive") {
        lastEventAt.current = Date.now();
        return;
      }
      lastEventAt.current = Date.now();
      useStore.getState().setChatStalled(chat.id, false);
      const store = useStore.getState();
      const findMsg = () =>
        store.chats
          .find((c) => c.id === chat.id)
          ?.messages.find((m) => m.id === assistantMsg.id);
      if (event.kind === "text") {
        // Keep the current "isThinking" flag untouched — a text chunk must not
        // cancel the composer glow while the model is still reasoning.
        useStore.getState().setStreaming(true, useStore.getState().isThinking);
        const prev = findMsg()?.content ?? "";
        const chunk = event.content ?? "";
        store.updateMessage(assistantMsg.id, {
          content: prev + chunk,
          segments: appendTextSegment(findMsg()?.segments, chunk),
          retry: null,
        });
      } else if (event.kind === "thinking") {
        // Lightweight signal only: the backend no longer streams the raw
        // thinking text (it slowed the UI with per-token re-renders). We just
        // toggle the global "isThinking" flag so the composer can show a glow.
        useStore.getState().setStreaming(true, !!event.active);
      } else if (event.kind === "skill") {
        // Deliberately NOT rendered into the chat — the user asked for the
        // "Attached skills" / MCP notes to stay out of the transcript. The
        // attached skills are still inlined in the system prompt, so the
        // model follows them; only the visible note is dropped.
      } else if (event.kind === "mcp") {
        // Deliberately NOT rendered into the chat (same reason as "skill"
        // above): the active MCP servers are already listed in the prompt's
        // USER-SELECTED SKILLS/TOOLS section, so the note is redundant UI.
      } else if (event.kind === "subagent_models") {
        // Debug-only routing info. Deliberately NOT rendered into the chat —
        // the user asked for subagent model lists to stay out of the message.
        //
        // It IS used for one thing: registering each subagent's ACTUAL model
        // into recentModels, mirroring the addRecentModel call the parent
        // turn makes above. Sidebar's "Model usage" panel groups usage by
        // provider using recentModels as its STRONGEST signal — without
        // this, a subagent running a different model than the parent's
        // configured one (explore auto-picks a cheaper model; a manually
        // configured subagent can route through an entirely different
        // provider) has nothing but a weak bare-name match to go on, and can
        // land under the WRONG provider's group whenever two providers
        // happen to list a model with the same last path segment (e.g. the
        // opencode gateway mirrors nearly every model).
        const models = event.models ?? {};
        for (const [agent, ranModel] of Object.entries(models)) {
          // A failed subagent build is reported as "entry ⚠ build failed →
          // parent" (see agents.py:_routing_label) — not a real model id.
          if (!ranModel || ranModel.includes("⚠")) continue;
          const entry = (store.subagentModels?.[agent] || "").trim();
          // A subagent entry may be "providerId/model", routing it through a
          // DIFFERENT provider than the parent (mirrors the backend's own
          // _resolve_subagent parsing). A bare entry — or no entry at all,
          // i.e. explore's auto-pick — runs on the parent's own provider.
          const slash = entry.indexOf("/");
          const prefix = slash > 0 ? entry.slice(0, slash) : "";
          const explicitProvider = prefix
            ? store.settings.providers.find(
              (p) => p.id === prefix || p.kind === prefix,
            )
            : undefined;
          store.addRecentModel(
            ranModel,
            explicitProvider?.id ?? activeProvider.id,
          );
        }
      } else if (event.kind === "tool") {
        toolRunningRef.current = true;
        const act: ToolActivity = {
          tool: event.tool ?? "tool",
          args: event.args,
          status: "running",
          startedAt: Date.now(),
          callId: typeof event.call_id === "number" ? event.call_id : undefined,
          sub: event.sub,
          branch: typeof event.branch === "number" ? event.branch : undefined,
          model: event.model || undefined,
        };
        // Sub-agent tool calls (task/explore's internal read/grep/glob, or a
        // general sub-agent reusing the parent's tools) render NESTED inside
        // the running task card, not as top-level cards — so a task turn shows
        // one collapsible parent with its details, never a stack of collapsed
        // fragments.
        if (event.sub) {
          const prev = findMsg()?.toolActivity ?? [];
          const branch =
            typeof event.branch === "number" ? event.branch : undefined;
          const next = prev.map((a): ToolActivity => {
            if (a.tool === "task" && a.status === "running") {
              // Parallel fan-out: nest each branch's sub-events under ITS OWN
              // task card (matched by branch id). Legacy single-branch events
              // (no branch id) still nest into the running task card.
              if (branch !== undefined && a.branch !== branch) return a;
              return { ...a, children: [...(a.children ?? []), act] };
            }
            return a;
          });
          store.updateMessage(assistantMsg.id, { toolActivity: next });
        } else {
          const current = findMsg()?.toolActivity ?? [];
          store.updateMessage(assistantMsg.id, {
            toolActivity: [...current, act],
            segments: [
              ...(findMsg()?.segments ?? []),
              { kind: "tool", index: current.length } as MessageSegment,
            ],
            retry: null,
          });
        }
      } else if (event.kind === "retry") {
        store.updateMessage(assistantMsg.id, {
          retry: {
            attempt: event.attempt ?? 1,
            maxAttempts: event.max_attempts ?? 3,
            delay: event.delay ?? 0,
            reason: event.reason ?? "",
            model: event.model ?? "",
            agent: event.agent ?? "",
            fallback: event.fallback,
          },
        });
      } else if (event.kind === "retry_giveup") {
        store.updateMessage(assistantMsg.id, {
          retry: {
            attempt: event.attempt ?? 1,
            maxAttempts: event.max_attempts ?? 3,
            delay: 0,
            reason: event.reason ?? "",
            gaveUp: true,
            model: event.model ?? "",
            agent: event.agent ?? "",
            fallback: event.fallback,
          },
        });
      } else if (event.kind === "tool_result") {
        toolRunningRef.current = false;
        const current = findMsg()?.toolActivity ?? [];
        const now = Date.now();
        const gotId = typeof event.call_id === "number";
        const gotBranch = typeof event.branch === "number";
        const resolved = (act: ToolActivity, isTop: boolean): ToolActivity => {
          // Sub-agent results resolve a child INSIDE the running explore card,
          // never a top-level card (sub calls are nested, not standalone). A
          // sub-result shares the branch id with its parent card, so matching
          // it against the top level would mark the branch card "done" on its
          // FIRST sub-search — children stay stuck "running" and every later
          // sub-event is dropped (nesting only targets running explore cards).
          // That is exactly the "parallel explores freeze / only one comes"
          // symptom. So for sub-results, skip the top-level match entirely and
          // only recurse into children.
          if (event.sub && isTop) {
            if (act.children && act.children.length > 0) {
              const children = act.children.map((c) => resolved(c, false));
              if (children.some((c, i) => c !== act.children![i])) {
                return { ...act, children };
              }
            }
            return act;
          }
          // Match by per-call correlation id first (precise — the same tool
          // can run many times, and explore sub-agent events share tool names);
          // then by parallel fan-out branch id (each branch's explore card gets
          // its own result); fall back to tool-name+status matching when the
          // result has neither id nor branch.
          const target =
            gotId && act.status === "running" && act.callId === event.call_id;
          const branchMatch =
            gotBranch &&
            act.status === "running" &&
            act.branch === event.branch;
          const fallback =
            !gotId &&
            !gotBranch &&
            act.tool === event.tool &&
            act.status === "running";
          if (target || branchMatch || fallback) {
            return {
              ...act,
              status:
                event.status === "error"
                  ? "error"
                  : event.status === "denied"
                    ? "denied"
                    : "done",
              summary: event.summary,
              engine: event.engine,
              items: event.results,
              model: event.model || act.model,
              elapsedMs: now - (act.startedAt ?? now),
            };
          }
          if (act.children && act.children.length > 0) {
            const children = act.children.map((c) => resolved(c, false));
            if (children.some((c, i) => c !== act.children![i])) {
              return { ...act, children };
            }
          }
          return act;
        };
        const next = current.map((a) => resolved(a, true));
        store.updateMessage(assistantMsg.id, { toolActivity: next });
      } else if (event.kind === "diff") {
        const current = findMsg()?.toolActivity ?? [];
        const next = current.map((a) => {
          if (a.tool === event.tool && a.status === "running") {
            return { ...a, diff: event.diff ?? "", summary: event.summary };
          }
          return a;
        });
        store.updateMessage(assistantMsg.id, { toolActivity: next });
      } else if (event.kind === "compact_start") {
        // Backend is auto-compacting (summarizer running) — show the loading
        // banner under the messages until the compact/compact_failed event lands.
        // Stored per-chat so it survives a chat switch mid-compact; clear any
        // stale notice/error so the loading banner replaces them.
        useStore.getState().setChatCompacting(chat.id, true);
        useStore.getState().setChatCompactNotice(chat.id, null);
        useStore.getState().setChatCompactError(chat.id, null);
      } else if (event.kind === "compact") {
        // Auto-compact: fold the older messages into the summary. The summary
        // is persisted as a system message so the next request still sends it
        // to the backend — the agent doesn't forget the compacted context.
        // Deliberately does NOT touch scroll position: this can fire on almost
        // every turn once the window is near full, and yanking the view up to
        // the summary mid-stream (previously via scrollIntoView) is exactly
        // what caused the chat to suddenly jump away from the live reply. The
        // summary is still fully visible by scrolling up whenever the user wants.
        useStore.getState().setChatCompacting(chat.id, false);
        const chatId = chat.id;
        if (chatId) {
          // Auto-compact: the backend tells us exactly how many recent turns it
          // preserved verbatim (`keep`), so we fold the SAME older turns and keep
          // the SAME recent ones — the summary never contradicts the tail it
          // renders next. Fall back to maxHistory on older backends.
          const backendKeep =
            Number.isFinite(event.keep) && (event.keep ?? -1) >= 0
              ? event.keep
              : undefined;
          store.compactChat(
            chatId,
            event.content ?? "",
            backendKeep ?? maxHistory,
          );
          // Auto-compact completed — surface the same confirmation the manual
          // /compact path shows, so the user knows older messages were folded
          // into a summary. Stored per-chat so it's still there if the user
          // switches away and comes back (no auto-dismiss — dismissed via ✕).
          useStore
            .getState()
            .setChatCompactNotice(
              chat.id,
              "Context compacted — older messages are summarized below (after the conversation).",
            );
        }
      } else if (event.kind === "compact_failed") {
        // Auto-compact failed — the backend did NOT drop any messages. Surface
        // the retry banner so the user can compact manually (the manual path
        // runs the summarizer as a read-only ask request with the parent model,
        // which succeeds even when the compact subagent model is invalid).
        useStore.getState().setChatCompacting(chat.id, false);
        useStore
          .getState()
          .setChatCompactError(
            chat.id,
            event.reason ||
            "Automatic compaction failed — nothing was deleted.",
          );
      } else if (event.kind === "plan") {
        const incoming = event.items ?? [];
        // Get current plan from store (not stale assistantMsg.plan)
        const currentMsg = findMsg();
        const existing = currentMsg?.plan ?? [];
        const hasOverlap = incoming.some(
          (n) => n.id && existing.some((e) => e.id === n.id),
        );
        const merged = hasOverlap
          ? existing
            .map((e) => {
              const upd = incoming.find((n) => n.id && n.id === e.id);
              return upd ? { ...e, ...upd } : e;
            })
            .concat(
              incoming.filter(
                (n) => !n.id || !existing.some((e) => e.id === n.id),
              ),
            )
          : incoming;
        store.updateMessage(assistantMsg.id, {
          plan: merged,
          retry: null,
        });
      } else if (event.kind === "permission") {
        useStore.getState().setChatPendingPermission(chat.id, {
          id: event.id ?? "",
          action: event.action ?? "",
          path: event.path,
          reason: event.reason,
          scope: event.scope,
        });
      } else if (event.kind === "ask") {
        setAskFreeText("");
        useStore.getState().setChatPendingAsk(chat.id, {
          id: event.id ?? "",
          question: event.question ?? "",
          options: Array.isArray(event.options) ? event.options : [],
        });
      } else if (event.kind === "error") {
        // A backend error while the summarizer was supposedly running means the
        // compact can't complete either — never leave the "Compacting context"
        // banner stuck next to the error. Clear it defensively (the backend's
        // own compact_failed event already does this on its normal path).
        useStore.getState().setChatCompacting(chat.id, false);
        store.updateMessage(assistantMsg.id, {
          content:
            (store.chats
              .find((c) => c.id === chat.id)
              ?.messages.find((m) => m.id === assistantMsg.id)?.content ?? "") +
            `\n\n> **Error:** ${event.content}`,
          error: true,
          // A failed turn's usage is the last request before the drop — often
          // inflated to ~100% (the reason the provider cut the stream). Don't
          // persist it: the meter must fall back to the last completed turn.
          usage: undefined,
          // Surface a Retry banner for plain backend errors too (not just
          // retry_giveup/watchdog) so there's a one-click resume path.
          // retryMessage treats `error` as a failed turn, so the partial
          // stream + completed tools are kept instead of truncate-and-restart.
          retry: {
            attempt: 1,
            maxAttempts: 1,
            delay: 0,
            reason: event.content ?? "The backend returned an error.",
            gaveUp: true,
          },
        });
        // Fold the completed tool calls into content too — the backend fatal
        // arrives as an inline event, not a throw, so the catch path won't run.
        preserveToolActivity();
      } else if (event.kind === "steer_applied") {
        // The running agent consumed these steer messages (injected into a tool
        // result). Move each one inline: hide its own bottom bubble and append
        // a user segment to the CURRENT assistant message, right after the tool
        // call that carried it — so the agent's later text and tool calls all
        // render BELOW the steer, in real order. Also clearthe steerPending flag
        // so the turn's finally block does NOT re-send it as a new turn.
        const ids = Array.isArray(event.ids) ? event.ids : [];
        const segments = findMsg()?.segments ?? [];
        const nextSegments = [...segments];
        for (const id of ids) {
          const userMsg = store.chats
            .find((c) => c.id === chat.id)
            ?.messages.find((m) => m.id === id);
          if (!userMsg || userMsg.role !== "user") continue;
          nextSegments.push({ kind: "user", id });
        }
        if (nextSegments.length > segments.length) {
          store.updateMessage(assistantMsg.id, { segments: nextSegments });
        }
        for (const id of ids) {
          store.updateMessage(id, {
            steerPending: false,
            steerInterleaved: true,
          });
        }
      } else if (event.kind === "usage") {
        // `unbilled` events report a REJECTED (window-overflow) request — the
        // provider never charged those tokens, so they must not count toward
        // the message badge or the chat's billed totals.
        if (event.unbilled) return;
        const inputTokens = event.input_tokens ?? 0;
        const outputTokens = event.output_tokens ?? 0;
        const total = event.total_tokens ?? inputTokens + outputTokens;
        const model = (event.model || "").trim() || activeModel || "main";
        // Accrue into the chat-wide cumulative usage (survives compacts and
        // chat switches) so the titlebar can show main + sub-agent session
        // totals and cost separately from the shrinkable current context.
        // Attribute to THIS panel's chat (captured at render via chatIdRef),
        // never s.activeChatId — a turn finished while the user is viewing
        // another chat must still post to the chat the stream belongs to.
        store.accrueChatUsage(chat.id, model, {
          input: inputTokens,
          output: outputTokens,
          cacheRead: event.cache_read_tokens ?? 0,
          cacheWrite: event.cache_write_tokens ?? 0,
        });
        // The message badge mirrors the LAST request of this turn (each new
        // request REPLACES the previous while streaming) — it is NOT the
        // accumulated whole-turn total, which would re-count the growing
        // prompt on every tool-loop resend.
        //
        // Sub-agent usage (explore/search/web sub-models) runs in isolated
        // transcripts that are discarded when the tool returns — it never
        // enters the parent's growing context, so it must NOT replace the
        // message badge / context meter (that made the meter bounce between
        // the parent's large request and each small sub-agent request). It
        // still accrues into the chat-wide session totals above.
        if (!event.sub) {
          store.updateMessage(assistantMsg.id, {
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: total,
              cacheReadTokens: event.cache_read_tokens ?? 0,
              cacheWriteTokens: event.cache_write_tokens ?? 0,
            },
          });
        }
      } else if (event.kind === "done") {
        // The backend signals the end of the stream with a "done" event.
        // Clear the stall hint immediately and refresh the watchdog clock so a
        // queued stall-timer callback can't re-set it after the stream closes.
        useStore.getState().setChatStalled(chat.id, false);
        lastEventAt.current = Date.now();
        resolveStuckCards();
      }
    };

    try {
      await streamChat(
        {
          provider: activeProvider,
          root: rootDir,
          mode: chat.mode,
          chatId: chat.id,
          prompt: promptWithResume,
          history,
          maxHistory,
          attachments: atts.map((a) => `${rootDir}/${a.replace(/^\/+/, "")}`),
          images: imgs.map((i) =>
            i.dataUrl ? { path: i.path, dataUrl: i.dataUrl } : i.path,
          ),
          systemPrompt: s.settings.systemPrompts?.[chat.mode] ?? "",
          thinkingLevel: supportsReasoning(
            activeProvider.model,
            activeProvider.kind,
            modelReasoning(activeProvider, activeProvider.model),
          )
            ? thinkingLevel
            : "",
          modelReasoning:
            modelReasoning(activeProvider, activeProvider.model) ??
            supportsReasoning(
              activeProvider.model,
              activeProvider.kind,
              modelReasoning(activeProvider, activeProvider.model),
            ),
          mcpServers: (() => {
            const all = s.settings.mcpServers ?? {};
            const sel: Record<string, (typeof all)[string]> = {};
            for (const n of s.settings.mcpEnabled ?? [])
              if (all[n]) sel[n] = all[n];
            return sel;
          })(),
          skills: Array.from(mentionSkills),
          allowCreate,
          cap: getMode(s.settings, chat.mode).capabilities,
          allowOutside: s.outsideAllowed,
          nvimFile: nvimMentioned ? nvimRel || undefined : undefined,
          nvimDiagnostics: nvimMentioned ? nvimDiags : undefined,
          vectorDbPath: s.vectorDbPath,
          vectorConfig: {
            ttl_days: s.memoryTtlDays,
            max_docs: s.memoryMaxDocs,
            max_chunks: s.memoryMaxChunks,
          },
          subagentModels: s.subagentModels,
          providers: Object.fromEntries(
            (s.settings.providers ?? []).map((p) => [p.id, p]),
          ),
          reserved: s.settings.compactHeadroom ?? 20000,
          signal: abort.signal,
        },
        handleEvent,
      );
    } catch (err) {
      // Preserve tool-call context on ANY abort — the user pressing Stop, the
      // stall watchdog, or a backend/stream error that THROWS. `preserveToolActivity`
      // is defined above and folded tool calls into `content`, so a manual retry
      // knows what this turn already did instead of redoing it from scratch.
      if (watchdogAbortedRef.current) {
        // Forced by the stall watchdog, not the user clicking Stop — the
        // connection was silent for minutes straight. Surface a RETRY banner
        // (with a Retry button that re-sends the same message) instead of a
        // plain inline error, so the user has a one-click way to try again.
        useStore.getState().updateMessage(assistantMsg.id, {
          retry: {
            attempt: 1,
            maxAttempts: 1,
            delay: 0,
            reason:
              "The connection went silent for too long and was closed automatically — the backend may have crashed or lost connectivity. Tap Retry to try again.",
            gaveUp: true,
            watchdog: true,
          },
        });
        preserveToolActivity();
      } else if ((err as Error).name !== "AbortError") {
        handleEvent({ kind: "error", content: (err as Error).message });
        preserveToolActivity();
      } else {
        // User-initiated Stop: the request was simply cancelled (no
        // retry/resume loop). Folding the completed tool calls into content is
        // handled by preserveToolActivity() above so the next turn knows what
        // was already done.
        preserveToolActivity();
      }
    } finally {
      clearInterval(stallTimer);
      // Neutralize any stall-timer callback already queued: with a fresh clock
      // its 180s check can't fire and re-show "Still waiting" after the stream
      // has actually ended.
      lastEventAt.current = Date.now();
      stalledSinceRef.current = null;
      toolRunningRef.current = false;
      useStore.getState().setChatStalled(chat.id, false);
      setBusy(false);
      useStore.getState().setChatCompacting(chat.id, false);
      useStore.getState().setChatPendingAsk(chat.id, null);
      useStore.getState().setChatPendingPermission(chat.id, null);
      resolveStuckCards();
      abortRef.current = null;
      useStore.getState().setChatAbort(chat.id, null);
      useStore.getState().setStreaming(false, false);
      // Keep the retry banner when this turn ended in a failure the user can
      // act on (retry_giveup / watchdog / backend error). Clearing `retry`
      // here would make the banner vanish the instant the stream closes, and
      // the next Retry click would fall back to truncate-and-restart, losing
      // the partial turn. Only clear it for clean/aborted runs.
      const curMsg = useStore
        .getState()
        .chats.find((c) => c.id === chat.id)
        ?.messages.find((m) => m.id === assistantMsg.id);
      const keepRetry =
        !!curMsg?.error ||
        (!!curMsg?.retry &&
          (curMsg.retry.gaveUp === true || curMsg.retry.watchdog === true));
      useStore.getState().updateMessage(assistantMsg.id, {
        streaming: false,
        ...(keepRetry ? {} : { retry: null }),
      });
      // A turn just completed → usage changed. Refresh the balance chip now.
      setBalanceTick((t) => t + 1);
    }
    // Auto-drain: this turn ended and other messages are still queued for this
    // chat (typed while the agent was working, or unconsumed steers) — start
    // the next one immediately. Runs via the registry so it works even when
    // this panel is unmounted (user is in another chat).
    if (chat.id) {
      const st = useStore.getState();
      const cNow = st.chats.find((c) => c.id === chat.id);
      // Drain undelivered steers first (they are real user messages already in
      // the transcript, reused as the next turn), then queued items.
      if (cNow) {
        const pendingSteer = cNow.messages.find(
          (m) => m.role === "user" && m.steerPending,
        );
        if (pendingSteer) {
          setTimeout(() => sendPendingSteerNext(chat.id), 0);
        } else {
          const remaining = cNow.queued?.filter((q) => !q.sent);
          if (remaining && remaining.length > 0) {
            setTimeout(() => sendQueuedNext(chat.id), 0);
          }
        }
      }
    }
  };

  // Expose this chat's latest `send` so queued turns can be drained even while
  // this panel is unmounted (user viewing another chat). Registered every
  // render; NEVER deregistered on unmount.
  registerChatSend(chatIdRef.current, send);

  const compactContext = async () => {
    let s = useStore.getState();
    let ch = s.chats.find((c) => c.id === s.activeChatId);
    if (!ch) return;

    // Queue behind any in-flight stream on THIS chat: running the summarizer
    // concurrently with the agent interleaves two model streams (usage events,
    // text deltas), and the summarizer's completion then folds messages under
    // the still-streaming reply — which makes the context meter dip and jump.
    // Wait for the stream to finish, then compact.
    const chatId = ch.id;
    const chatStreaming = () => {
      const st = useStore.getState();
      const c = st.chats.find((x) => x.id === chatId);
      return c?.messages.some((m) => m.streaming) ?? false;
    };
    if (chatStreaming()) {
      setBusy(true);
      useStore.getState().setChatCompacting(chatId, true);
      await new Promise<void>((resolve) => {
        const unsub = useStore.subscribe((state) => {
          const c = state.chats.find((x) => x.id === chatId);
          if (!c?.messages.some((m) => m.streaming)) {
            unsub();
            resolve();
          }
        });
      });
    }

    // Re-read state after the wait — messages may have changed while streaming.
    s = useStore.getState();
    ch = s.chats.find((c) => c.id === s.activeChatId);
    if (!ch) return;
    const msgs = ch.messages.filter(
      (m) => !m.compacted && (m.role === "user" || m.role === "assistant"),
    );
    if (msgs.length === 0) {
      setBusy(false);
      useStore.getState().setChatCompacting(chatId, false);
      return;
    }
    const rootDir = ch.root || s.root;
    setBusy(true);
    useStore.getState().setChatCompactError(ch.id, null);
    useStore.getState().setChatCompactNotice(ch.id, null);
    useStore.getState().setChatCompacting(ch.id, true);

    // Serialize the live conversation — including any prior compact summary —
    // so the backend can MERGE it into the new one (opencode keeps a running
    // summary across repeated compactions instead of starting from scratch).
    const history = ch.messages
      .filter((m) => !m.compacted)
      .map((m) => ({ role: m.role, content: m.content ?? "" }));

    // Route the primary summarizer through the user's configured "compact"
    // subagent (Settings → Tools) when set, else the active provider. The
    // active provider is always the fallback — the backend retries the compact
    // subagent on it, mirroring opencode's subagent -> main-model fallback.
    const activeProvider = getChatProvider(ch.id);
    const compactEntry = (s.subagentModels?.compact || "").trim();
    let compactProvider = activeProvider;
    if (compactEntry) {
      const slash = compactEntry.indexOf("/");
      const prefix = slash > 0 ? compactEntry.slice(0, slash) : "";
      const modelName =
        slash > 0 ? compactEntry.slice(slash + 1) : compactEntry;
      const explicitProvider = prefix
        ? s.settings.providers.find((p) => p.id === prefix || p.kind === prefix)
        : undefined;
      compactProvider = {
        ...(explicitProvider ?? compactProvider),
        model: modelName,
      };
    }

    // Call the backend's opencode-style compaction (structured summary,
    // token-budgeted tail, prior-summary merge). A 60s timeout bounds the
    // call; the backend itself retries the compact subagent on the active
    // model before giving up.
    const ctr = new AbortController();
    const timeout = setTimeout(() => ctr.abort(), 60_000);
    let result: CompactResult | null = null;
    let errMsg = "";
    try {
      result = await triggerCompact({
        provider: compactProvider,
        fallback: activeProvider,
        history,
        contextWindow:
          modelContextWindow(activeProvider, activeProvider.model) ?? 0,
        reserved: useStore.getState().settings.compactHeadroom ?? 20000,
        signal: ctr.signal,
      });
    } catch (err) {
      errMsg =
        (err as Error).name === "AbortError"
          ? "timed out after 60s"
          : (err as Error).message;
    } finally {
      clearTimeout(timeout);
    }

    setBusy(false);
    useStore.getState().setChatCompacting(ch.id, false);
    // A compact call just completed → usage may have changed. Refresh the
    // balance chip now, same as a normal turn does.
    setBalanceTick((t) => t + 1);

    // A summarizer that errored, timed out, or returned nothing is a failed
    // compact — do NOT collapse the real messages behind a fake summary. Leave
    // the chat untouched and let the user retry manually.
    if (!result || !result.summary || result.error) {
      useStore
        .getState()
        .setChatCompactError(ch.id, result?.error || errMsg || "empty summary");
      return;
    }
    // The backend already returns opencode's "[Compacted earlier context]"
    // summary and the token-budgeted tail (`keep`) to preserve verbatim — no
    // extra wrapper, and no hardcoded keep=1.
    s.compactChat(ch.id, result.summary, result.keep);
    // Best-effort: stash the summary in short-term RAG (~24h) so the compressed
    // history stays recallable via memory later. Never blocks or throws.
    addMemoryNote(rootDir, result.summary).catch(() => { });
    useStore
      .getState()
      .setChatCompactNotice(
        ch.id,
        "Context compacted — older messages are summarized below (after the conversation).",
      );
    // Stay where the user is (normally the bottom, where the live conversation
    // continues). The messages-change effect below keeps the view pinned to
    // the bottom; do NOT yank the view up to the summary — that reads as the
    // chat "suddenly scrolling to top" after every compact.
  };

  const handleCommand = async (v: string) => {
    const s = useStore.getState();
    const ch = s.chats.find((c) => c.id === s.activeChatId);
    const word = v.split(/\s+/)[0].toLowerCase();
    switch (word) {
      case "/compact":
        await compactContext();
        break;
      case "/clear":
        if (ch) s.clearChat(ch.id);
        break;
      case "/new":
        s.newChat(ch?.mode);
        break;
      case "/undo":
        if (ch && s.undoMessage()) {
          s.addMessage(ch.id, { role: "assistant", content: "↩ Undone." });
        } else {
          s.addMessage(ch?.id ?? "", {
            role: "assistant",
            content: "Nothing to undo.",
          });
        }
        break;
      case "/redo":
        if (ch && s.redoMessage()) {
          s.addMessage(ch.id, { role: "assistant", content: "↪ Redone." });
        } else {
          s.addMessage(ch?.id ?? "", {
            role: "assistant",
            content: "Nothing to redo.",
          });
        }
        break;
      case "/help":
        s.addMessage(ch?.id ?? "", {
          role: "assistant",
          content:
            "**Modes**\n\n" +
            allModes(settings)
              .map((m) => `- **${m.label}** — ${m.description}`)
              .join("\n") +
            "\n\n**Commands**\n\n" +
            COMMANDS.map((c) => `- \`/${c.name}\` — ${c.hint}`).join("\n") +
            "\n\n**Keyboard shortcuts**\n\n" +
            GLOBAL_SHORTCUTS.map((s) => `- ${formatGlobalShortcut(s)}`).join(
              "\n",
            ) +
            "\n\n**Prefix shortcuts** — press `Ctrl+X`, then a key:\n\n" +
            Object.entries(PREFIX_SHORTCUTS)
              .map(([key, sc]) => `- ${formatShortcut(key, sc)}`)
              .join("\n"),
        });
        break;
      case "/skill":
      case "/mcp": {
        const target = word === "/skill" ? "skill" : "MCP connector";
        const rest = v.slice(word.length).trim();
        if (!rest) {
          s.addMessage(ch?.id ?? "", {
            role: "assistant",
            content:
              word === "/skill"
                ? `Usage: \`/skill <description>\` — describe the skill you want after the command, e.g. \`/skill summarize a project's git log into release notes\`.`
                : `Usage: \`/mcp <description>\` — describe the tool/connector you want after the command, e.g. \`/mcp a way to search YouTube\`.`,
          });
          return;
        }
        s.addMessage(ch?.id ?? "", {
          role: "user",
          content: v,
        });
        void send(
          target === "skill"
            ? `Create a new skill from this description: "${rest}". Use the create_skill tool to set it up with a good its name/slug and the instructions. Ask me only for anything essential that is genuinely missing; otherwise just create it. Do not modify files outside creating this skill.`
            : `Create a new MCP connector from this description: "${rest}". Use the create_mcp tool to add it, choosing a good name and command/URL/config that fits the description. Ask me only for anything essential that is genuinely missing; otherwise just create it. Do not modify files for this.`,
          [],
          [],
          true,
        );
        break;
      }
      default:
        useStore
          .getState()
          .setChatCmdError(
            ch?.id ?? "",
            `Unknown command \`${word}\`. Type \`/help\` to see available commands.`,
          );
    }
  };

  // Route global coder:cmd dispatches (Ctrl+X prefix shortcuts) through the
  // same handler as typing the equivalent slash command.
  handleCommandRef.current = handleCommand;

  const retryMessage = useCallback(
    (id: string) => {
      // If a previous turn is still mid-stream (auto-retry waiting on a provider
      // throttle, streaming reply, etc.), pressing Retry must cancel that run
      // FIRST — otherwise the "Retry" click is silently swallowed by the `busy`
      // guard below and nothing happens, even after the user changed the model.
      const active = useStore.getState().chatAborts[chatIdRef.current];
      if (active && !active.signal.aborted) {
        active.abort();
      }
      const s = useStore.getState();
      const ch = s.chats.find((c) => c.id === s.activeChatId);
      if (!ch) return;
      const msg = ch.messages.find((m) => m.id === id);
      if (!msg) return;
      // Resolve to the OWNING user message: a failed/error "retry" can be
      // triggered from an assistant message's banner, so find the user turn that
      // produced it before resuming/regenerating.
      let userMsg = msg;
      if (msg.role !== "user") {
        const idx = ch.messages.findIndex((m) => m.id === id);
        const prevUser = [...ch.messages.slice(0, idx)]
          .reverse()
          .find((m) => m.role === "user");
        if (!prevUser) return;
        userMsg = prevUser;
      }
      if (!userMsg.content.trim()) return;

      // RESUME, don't restart: if this user's turn left a failed assistant
      // message behind (partial content + preserved tool activity + plan),
      // keep it in the transcript and re-run the SAME user message so the
      // model continues from where it was cut off instead of redoing the
      // completed work. Only when there is no failed turn to resume do we
      // fall back to the old truncate-and-restart behavior.
      const idx = ch.messages.findIndex((m) => m.id === userMsg.id);
      const failed = ch.messages
        .slice(idx + 1)
        .find(
          (m) =>
            m.role === "assistant" &&
            (m.retry ||
              m.error ||
              (typeof m.content === "string" &&
                m.content.includes("[Interrupted before finishing"))),
        );
      if (failed) {
        // send() reuses the existing user bubble (no duplicate), clears the
        // retry banner, and keeps the failed assistant message in history so
        // the model sees the partial work + preserved tool list and continues
        // (promptWithResume reinforces the plan continuation).
        setTimeout(
          () =>
            send(
              userMsg.content,
              userMsg.attachments ?? [],
              userMsg.images ?? [],
              false,
              userMsg.id,
            ),
          0,
        );
        return;
      }

      // No failed assistant turn to resume — restart from this user message.
      if (!s.truncateTo(userMsg.id)) return;
      const text = userMsg.content;
      // Give the abort's finally block a tick to reset busy/streaming state
      // before re-sending (send() re-sets busy=true itself, but the abort's
      // finally would otherwise clear it mid-run).
      setTimeout(
        () => send(text, userMsg.attachments ?? [], userMsg.images ?? []),
        0,
      );
    },
    [busy, send, maxHistory],
  );

  // Stable identity for memoized children: ChatMessageView is React.memo'd, so a
  // recreated `onRetry` per render would defeat it. Route through a ref instead.
  const retryMessageRef = useRef(retryMessage);
  retryMessageRef.current = retryMessage;

  // Restart-from-scratch retry for the USER message's retry icon: ALWAYS delete
  // this user message and everything below it, then re-send from scratch. This
  // is deliberately NOT the resume path — the failed assistant turn (partial
  // content + preserved tools + plan) is discarded so the chat continues fresh
  // from this message onward. The error banner's Retry keeps its own resume
  // behavior via retryMessageRef.
  const restartFromMessage = useCallback(
    (id: string) => {
      // Cancel any active stream first — otherwise the `busy` guard in send()
      // would swallow the re-send.
      const active = useStore.getState().chatAborts[chatIdRef.current];
      if (active && !active.signal.aborted) {
        active.abort();
      }
      const s = useStore.getState();
      const ch = s.chats.find((c) => c.id === s.activeChatId);
      if (!ch) return;
      const msg = ch.messages.find((m) => m.id === id);
      if (!msg) return;
      // Resolve the prompt to re-send: if the retry was triggered on a non-user
      // message, fall back to the nearest preceding user message so we still
      // regenerate from the right place.
      const idx = ch.messages.findIndex((m) => m.id === id);
      const userMsg =
        msg.role === "user"
          ? msg
          : [...ch.messages.slice(0, idx)]
            .reverse()
            .find((m) => m.role === "user");
      if (!userMsg || !userMsg.content.trim()) return;
      // ALWAYS truncate-and-restart: remove this message and everything below
      // it, then re-send the prompt from scratch (send() creates a fresh user
      // bubble). When `id` is a user message it is removed too; when it is an
      // assistant message, the user prompt above is kept and only the failed
      // turn + everything below is dropped.
      if (!s.truncateTo(id)) return;
      const text = userMsg.content;
      // Give the abort's finally block a tick to reset busy/streaming state
      // before re-sending (send() re-sets busy=true itself, but the abort's
      // finally would otherwise clear it mid-run).
      setTimeout(
        () => send(text, userMsg.attachments ?? [], userMsg.images ?? []),
        0,
      );
    },
    [send],
  );

  // Stable identity for memoized children: ChatMessageView is React.memo'd, so a
  // recreated `onRetry` per render would defeat it. Route through a ref instead.
  const restartFromMessageRef = useRef(restartFromMessage);
  restartFromMessageRef.current = restartFromMessage;

  // The USER message's retry icon restarts from that message (deletes everything
  // below it and re-sends fresh). The error banner's Retry keeps its own resume
  // path via retryMessageRef.
  const onRetry = useMemo(
    () => (id: string) => restartFromMessageRef.current(id),
    [],
  );

  const submit = () => {
    const v = input.trim();
    if (!v && images.length === 0) return;
    if (v.startsWith("/")) {
      setInput("");
      setCmdOpen(null);
      void handleCommand(v);
      return;
    }
    const ss = useStore.getState();
    const chatObj = ss.chats.find((c) => c.id === chatIdRef.current);
    if (!chatObj) return;
    const rootDir = chatObj.root || ss.root;
    if (!rootDir) {
      setNoRootHint("Open a project folder first — press ⌘O to pick one.");
      setTimeout(() => setNoRootHint(""), 3000);
      return;
    }
    setNoRootHint("");
    const atts = attachments;
    const imgs = images;
    setImages([]);
    // While THIS chat's agent is working, Enter delivers a non-interrupting
    // steer: the message becomes a REAL user message (visible immediately) and
    // is POSTed to /chat/steer (injected at the next tool call). If the turn
    // ends without the backend injecting it, the drain re-sends it as the next
    // turn REUSING this same message. The input is NOT consumed by the stream —
    // no abort.
    if (chatHasStreaming) {
      const userMsg = ss.addMessage(chatObj.id, {
        role: "user",
        content: v,
        attachments: atts,
        images: imgs,
        steerPending: true,
      });
      setInput("");
      setCmdOpen(null);
      forceScrollToBottom();
      void steerChat(chatObj.id, userMsg.id, v);
      return;
    }
    setInput("");
    setCmdOpen(null);
    void send(v, atts, imgs, false, undefined, true);
  };

  const queueForLater = () => {
    const v = input.trim();
    if (!v && images.length === 0) return;
    const ss = useStore.getState();
    const chatObj = ss.chats.find((c) => c.id === chatIdRef.current);
    if (!chatObj) return;
    const atts = attachments;
    const imgs = images;
    ss.queueMessage(chatObj.id, {
      id: uid2(),
      text: v,
      attachments: atts,
      images: imgs,
      kind: "queue",
    });
    forceScrollToBottom();
    setInput("");
    setImages([]);
  };

  const addImage = async (p: string, name: string) => {
    // Normalize first: HEIC / oversized / permission-blocked originals are
    // converted to a readable temp PNG (like screenshots) so the backend can
    // always load the path we send. Falls back to the original path if
    // normalization fails.
    const norm = await api.normalizeImage(p).catch(() => null);
    const path = norm?.path || p;
    const dataUrl =
      norm?.dataUrl || (await api.readImage(p).catch(() => null)) || undefined;
    setImages((imgs) => {
      const hit = imgs.find((i) => i.origPath === p || i.path === p);
      if (hit) {
        if (!dataUrl) return imgs;
        return imgs.map((i) =>
          i.origPath === p || i.path === p ? { ...i, dataUrl } : i,
        );
      }
      return [...imgs, { path, name, dataUrl, origPath: p }];
    });
  };

  const addDroppedFile = (p: string, name: string) => {
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    if (IMAGE_EXTS.has(ext)) {
      addImage(p, name);
      return;
    }
    if (!wroot) return;
    const rel = relFromRoot(wroot, p);
    if (!rel) return;
    setAttachments((a) => (a.includes(rel) ? a : [...a, rel]));
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types?.includes("Files")) setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files ?? []);
    for (const f of dropped) {
      const p =
        window.coder.getPathForFile(f) || (f as File & { path?: string }).path;
      if (p) addDroppedFile(p, f.name);
    }
  };

  const addShot = (shot: { path: string; dataUrl: string }) => {
    setImages((imgs) =>
      imgs.some((i) => i.path === shot.path)
        ? imgs
        : [
          ...imgs,
          { path: shot.path, name: "screenshot.png", dataUrl: shot.dataUrl },
        ],
    );
  };

  const captureRegion = async () => {
    const shot = await api.captureRegion().catch(() => null);
    if (shot) addShot(shot);
  };

  const attachFile = async () => {
    const path = await api.selectFile();
    if (!path) return;
    const name = path.split(/[\\/]/).pop() || path;
    // Same normalization as addImage: the backend should always receive a
    // readable temp PNG path, not the original (possibly HEIC / oversized /
    // permission-blocked) file.
    const norm = await api.normalizeImage(path).catch(() => null);
    const imgPath = norm?.path || path;
    const dataUrl =
      norm?.dataUrl ||
      (await api.readImage(path).catch(() => null)) ||
      undefined;
    setImages((imgs) => {
      const hit = imgs.find((i) => i.origPath === path || i.path === path);
      if (hit) {
        if (!dataUrl) return imgs;
        return imgs.map((i) =>
          i.origPath === path || i.path === path ? { ...i, dataUrl } : i,
        );
      }
      return [...imgs, { path: imgPath, name, dataUrl, origPath: path }];
    });
  };

  const removeImage = (path: string) => {
    setImages((imgs) => imgs.filter((i) => i.path !== path));
  };

  const startRecording = async () => {
    if (recording || transcribing || busy) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Prefer a format the sidecar's `av` can decode; fall back to whatever the
      // browser supports (Whisper handles webm/ogg/opus/wav via decode_audio).
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : MediaRecorder.isTypeSupported("audio/wav")
            ? "audio/wav"
            : "";
      const rec = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 48_000,
      });
      mediaChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) mediaChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recordingRef.current = false;
        setRecording(false);
        const type = mediaChunksRef.current[0]?.type ?? mime;
        const blob = new Blob(mediaChunksRef.current, { type });
        if (blob.size === 0) {
          console.debug("[voice] empty recording (no audio captured)");
          window.alert("No audio was captured — check your microphone.");
          return;
        }
        setTranscribing(true);
        try {
          const lang =
            dir === "rtl" || /[\u0600-\u06FF]/.test(input) ? "fa" : undefined;
          console.debug("[voice] transcribing", {
            mime: blob.type,
            bytes: blob.size,
            lang,
          });
          const text = await transcribeAudio(blob, setTranscribing, lang);
          if (text) {
            setInput((prev) => (prev ? prev.trimEnd() + " " + text : text));
            requestAnimationFrame(() => textareaRef.current?.focus());
          } else {
            console.debug("[voice] empty transcription (silence/unrecognized)");
            window.alert("Nothing was recognized — please try again.");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          window.alert(
            `Voice transcription failed: ${msg}\n` +
            (msg.includes("Failed to fetch")
              ? "The local Python server is likely down — restart the app."
              : "Please try again or check your microphone connection."),
          );
        } finally {
          setTranscribing(false);
        }
      };
      mediaRecorderRef.current = rec;
      rec.start();
      recordingRef.current = true;
      setRecording(true);
      console.debug("[voice] recording started", { mime: rec.mimeType });
    } catch (err) {
      console.debug("[voice] microphone unavailable:", err);
      window.alert(
        `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const stopRecording = () => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      recordingRef.current = false;
      rec.stop();
      mediaRecorderRef.current = null;
    }
  };

  const toggleRecording = () => {
    if (recording) {
      stopRecording();
    } else {
      void startRecording();
    }
  };
  toggleRecordingRef.current = toggleRecording;

  const startCmd = (at?: number) => {
    const el = textareaRef.current;
    if (!el || busy) return;
    const pos = at ?? el.selectionStart;
    const prevChar = pos > 0 ? input[pos - 1] : "";
    if (prevChar && !/\s/.test(prevChar)) return;
    setCmdOpen({ at: pos });
    setSkillMention(null);
    setCmdQuery("");
    setCmdIndex(0);
  };

  const acceptCmd = (name: string) => {
    if (!cmdOpen) return;
    const before = input.slice(0, cmdOpen.at);
    const after = input.slice(cmdOpen.at + 1 + cmdQuery.length);
    const next = `${before}/${name} ${after}`;
    setInput(next);
    setCmdOpen(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const pos = before.length + name.length + 2;
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const ensureSkills = useCallback(async () => {
    const list = await ensureSkillsList();
    setSkillsList(list);
    setSkillsLoading(false);
  }, []);

  // Wire the shared skill cache to the backend fetcher (src/lib/api). Done
  // once at module init so the cache can be invalidated from anywhere
  // (e.g. after a skill is saved in Settings) without re-importing.
  setSkillsFetcher(listSkills);

  // Load the skill list up-front (once) so manual @mentions typed/pasted
  // before the picker ever opens — or sent before the async fetch resolves —
  // are still matched. The cache is module-level (src/lib/skills), so this runs
  // at most once across remounts.
  useEffect(() => {
    if (getSkillsList().length === 0) void ensureSkills();
  }, [ensureSkills]);

  const startSkillMention = (at: number) => {
    setCmdOpen(null);
    setSkillMention({ at });
    setSkillMentionQuery("");
    setSkillMentionIdx(0);
    void ensureSkills();
  };

  const acceptSkillMention = (skill: SkillRow) => {
    if (!skillMention) return;
    const before = input.slice(0, skillMention.at);
    const after = input.slice(skillMention.at + 1);
    // Replace the partial token after "@" (e.g. "ski") with the skill's slug —
    // the canonical, space-free mention token (e.g. "@anthropic-frontend-design").
    const rest = after.replace(/^\S*/, "");
    const token = skill.slug || skill.name;
    const next = `${before}@${token} ${rest}`;
    setInput(next);
    setSkillMention(null);
    setSkillMentionQuery("");
    setSkillMentionIdx(0);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const pos = before.length + token.length + 2;
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const removeAttachment = (rel: string) => {
    setAttachments((a) => a.filter((x) => x !== rel));
  };

  const openSkillPicker = () => {
    setSkillOpen((o) => {
      if (!o) setSkillQuery("");
      return !o;
    });
    setSkillIdx(0);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    const prev = input;
    setInput(v);

    // Trigger popups from the inserted character (works on any keyboard layout
    // / IME, unlike e.key which can differ on Persian etc.).
    if (v.length === prev.length + 1) {
      const ch = v[v.length - 1];
      if (ch === "/" && !cmdOpen) startCmd(v.length - 1);
      // "@" opens the skill mention picker only at a word boundary (start of
      // the line or after whitespace) so emails / @handles don't trigger it.
      if (ch === "@" && !cmdOpen && !skillMention) {
        const prevChar = v.length > 1 ? v[v.length - 2] : "";
        if (!prevChar || /\s/.test(prevChar)) startSkillMention(v.length - 1);
      }
    }

    if (cmdOpen) {
      if (v[cmdOpen.at] !== "/") {
        setCmdOpen(null);
      } else {
        const after = v.slice(cmdOpen.at + 1);
        if (after.search(/\s/) !== -1) {
          setCmdOpen(null);
        } else {
          setCmdQuery(after);
          setCmdIndex(0);
        }
      }
    }

    if (skillMention) {
      if (v[skillMention.at] !== "@") {
        setSkillMention(null);
      } else {
        const after = v.slice(skillMention.at + 1);
        if (after.search(/\s/) !== -1) {
          setSkillMention(null);
        } else {
          setSkillMentionQuery(after);
          setSkillMentionIdx(0);
        }
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Persian/Arabic keyboard layouts often map Shift+2 to a different
    // character (e.g. `"`), so the user can't type `@` for skill mentions.
    // When the physical Shift+Digit2 was pressed but produced something other
    // than `@`, insert `@` manually at the caret (mirrors the insert-at-cursor
    // pattern of startSkillMention/acceptSkillMention).
    if (
      e.code === "Digit2" &&
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      e.key !== "@"
    ) {
      e.preventDefault();
      const el = textareaRef.current;
      if (el) {
        const start = el.selectionStart ?? input.length;
        const end = el.selectionEnd ?? input.length;
        const next = input.slice(0, start) + "@" + input.slice(end);
        setInput(next);
        // Mirror onInputChange's "@ at a word boundary" check so the skill
        // mention picker opens exactly as if the char had been typed normally.
        if (!cmdOpen && !skillMention) {
          const prevChar = start > 0 ? input[start - 1] : "";
          if (!prevChar || /\s/.test(prevChar)) startSkillMention(start);
        }
        requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(start + 1, start + 1);
        });
      }
      return;
    }
    if (cmdOpen && filteredCmds.length > 0) {
      if (
        e.key === "ArrowDown" ||
        ((e.ctrlKey || e.metaKey) && physicalKey(e) === "j")
      ) {
        e.preventDefault();
        setCmdIndex((i) => (i + 1) % filteredCmds.length);
        return;
      }
      if (
        e.key === "ArrowUp" ||
        ((e.ctrlKey || e.metaKey) && physicalKey(e) === "k")
      ) {
        e.preventDefault();
        setCmdIndex((i) => (i - 1 + filteredCmds.length) % filteredCmds.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptCmd(filteredCmds[cmdIndex].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCmdOpen(null);
        return;
      }
    }
    if (cmdOpen && e.key === "Escape") {
      e.preventDefault();
      setCmdOpen(null);
      return;
    }
    if (skillMention && filteredSkills.length > 0) {
      if (
        e.key === "ArrowDown" ||
        ((e.ctrlKey || e.metaKey) &&
          (physicalKey(e) === "j" || physicalKey(e) === "n"))
      ) {
        e.preventDefault();
        setSkillMentionIdx((i) => (i + 1) % filteredSkills.length);
        return;
      }
      if (
        e.key === "ArrowUp" ||
        ((e.ctrlKey || e.metaKey) &&
          (physicalKey(e) === "k" || physicalKey(e) === "p"))
      ) {
        e.preventDefault();
        setSkillMentionIdx(
          (i) => (i - 1 + filteredSkills.length) % filteredSkills.length,
        );
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        acceptSkillMention(filteredSkills[skillMentionIdx]);
        return;
      }
    }
    if (skillMention && e.key === "Escape") {
      e.preventDefault();
      setSkillMention(null);
      return;
    }
    if (skillOpen && e.key === "Escape") {
      e.preventDefault();
      setSkillOpen(false);
      return;
    }

    if (!cmdOpen && !skillMention && e.key === "Tab") {
      e.preventDefault();
      cycleMode(e.shiftKey ? -1 : 1);
      return;
    }

    if (e.key === "/" && !cmdOpen && !(e.metaKey || e.ctrlKey)) {
      startCmd();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (busy) queueForLater();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const stop = () => {
    useStore.getState().setChatPendingAsk(chatIdRef.current, null);
    useStore.getState().setChatPendingPermission(chatIdRef.current, null);
    abortRef.current?.abort();
    useStore.getState().chatAborts[chatIdRef.current]?.abort();
  };

  // Dismiss the retry banner WITHOUT deleting the turn: clear the message's
  // `retry` flag (so the banner unmounts) and then abort the stream. The
  // default `stop` alone leaves the banner up because the stream's `finally`
  // block keeps `retry` for gaveUp/watchdog failures — so we must clear it
  // explicitly here. This is the ✕ button on the error/stalled banner.
  const dismissRetry = useCallback(() => {
    const msgs = chat?.messages ?? [];
    const target =
      retryingMsg ?? [...msgs].reverse().find((m) => m.role === "assistant");
    if (target) {
      useStore.getState().updateMessage(target.id, { retry: null });
    }
    stop();
  }, [retryingMsg, stop, chat?.messages]);

  if (!chat) {
    const noWorkspace = workspaces.length === 0;
    const pickWorkspace = async () => {
      const dirSel = await api.selectFolder();
      if (dirSel) useStore.getState().createWorkspace(dirSel);
    };
    return (
      <div className="chat-panel">
        <div
          className="empty-state"
          style={{ display: "flex", height: "100%", alignItems: "center" }}
        >
          <div>
            <h2>
              {noWorkspace ? "No workspace selected" : "No chat selected"}
            </h2>
            <button
              className="btn"
              onClick={
                noWorkspace
                  ? pickWorkspace
                  : () => useStore.getState().newChat()
              }
            >
              {noWorkspace ? "Select workspace" : "New chat"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-panel">
      {titlebarEl &&
        createPortal(
          <div className="chat-toolbar titlebar-toolbar">
            <button
              className="dir-toggle"
              onClick={toggleDir}
              title={
                dir === "rtl"
                  ? "Right-to-left (فارسی) — click for LTR"
                  : "Left-to-right — click for RTL"
              }
            >
              {dir === "rtl" ? "RTL" : "LTR"}
            </button>
            <span className="badge" title="Active model">
              <span className="badge-provider">
                {provider.name || PROVIDER_LABELS[provider.kind] || provider.id}
              </span>
              {activeModel || "no model"}
            </span>
            <span
              className={`badge context-meter${ctxPct !== null && ctxPct >= 70 ? " warn" : ""}`}
              title={
                ctxWindow != null
                  ? `Context used: real tokens of the last completed reply, or the estimated size while a turn is streaming / right after a compact (of the model's ${formatTokens(ctxWindow)} window).`
                  : "Context used: real tokens of the last completed reply, or the estimated size while a turn is streaming / right after a compact."
              }
              dir="ltr"
            >
              {ctxPct !== null && contextUsed > 0 && (
                <span className="context-meter-track">
                  <span
                    className="context-meter-fill"
                    style={{ width: `${Math.min(100, ctxPct)}%` }}
                  />
                </span>
              )}
              <span className="context-meter-text">
                {contextUsed > 0 ? (
                  <>
                    {formatTokens(contextUsed)}
                    {ctxWindow != null ? ` / ${formatTokens(ctxWindow)}` : ""}
                    {ctxPct !== null ? ` (${ctxPct}%)` : ""}
                  </>
                ) : (
                  "—"
                )}
              </span>
            </span>
            {shownBal && (
              <span
                className="badge titlebar-balance"
                title={`${shownBal.provider.name} balance`}
                dir="ltr"
              >
                <svg
                  className="titlebar-balance-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
                  <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                  <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
                </svg>
                ${shownBal.amount.toFixed(2)}
              </span>
            )}
          </div>,
          titlebarEl,
        )}
      <div className="chat-scroll" ref={scrollRef} onScroll={onChatScroll}>
        <div className="chat-messages" data-dir={dir}>
          {chat.messages.length === 0 && (
            <div className="empty-state">
              <div className="empty-modes">
                {allModes(settings).map((m) => (
                  <div
                    key={m.id}
                    className={`empty-mode${m.id === chat.mode ? " active" : ""}`}
                  >
                    <span className="mode-select-icon">
                      <ModeIcon icon={m.icon} />
                    </span>
                    <span className="empty-mode-body">
                      <span className="empty-mode-label">{m.label}</span>
                      <span className="empty-mode-desc">{m.description}</span>
                    </span>
                  </div>
                ))}
                <p className="empty-hint">
                  Switch modes with <code>Tab</code>, <code>Cmd/Ctrl+M</code>,
                  or the selector above — type <code>/help</code> for all
                  commands and shortcuts.
                </p>
              </div>
            </div>
          )}
          {msgLimit < chat.messages.length && (
            <div className="load-older-row">
              <button
                className="load-older-btn"
                onClick={() => {
                  prependAnchorRef.current =
                    scrollRef.current?.scrollHeight ?? null;
                  setMsgLimit((n) =>
                    Math.min(chat.messages.length, n + MSG_PAGE),
                  );
                }}
              >
                Load {Math.min(MSG_PAGE, chat.messages.length - msgLimit)}{" "}
                earlier message
                {chat.messages.length - msgLimit === 1 ? "" : "s"}…
              </button>
            </div>
          )}
          {chat.messages
            .slice(Math.max(0, chat.messages.length - msgLimit))
            .map((m: ChatMessage) => (
              <Fragment key={m.id}>
                <ChatMessageView message={m} onRetry={onRetry} />
                {/* Newer messages render tool cards inline via `segments`; only
                  older persisted messages without segments keep the stacked
                  timeline below the bubble. */}
                {!m.segments && m.toolActivity && m.toolActivity.length > 0 && (
                  <div className="tool-timeline">
                    {m.toolActivity.map((act, i) => (
                      <ToolCallView
                        key={i}
                        activity={act}
                        onReverted={() =>
                          useStore.getState().markToolReverted(m.id, i)
                        }
                      />
                    ))}
                  </div>
                )}
              </Fragment>
            ))}
          <LiveWorkingStatus />
          {queuedMsgs.length > 0 && (
            <div className="queued-bubbles">
              {queuedMsgs.map((q) => (
                <div
                  className={`queued-bubble${q.kind === "steer" ? " steer" : ""}`}
                  key={q.id}
                  dir={dir}
                  title={
                    q.kind === "steer"
                      ? "Sent to the running agent — will be addressed now or as the next turn"
                      : "Queued — auto-sends after the current turn"
                  }
                >
                  <div className="queued-bubble-head">
                    <span className="queued-bubble-icon">
                      {q.kind === "steer" ? (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M9 14L4 9l5-5" />
                          <path d="M4 9h10a5 5 0 015 5v6" />
                        </svg>
                      ) : (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="9" />
                          <path d="M12 7v5l3 3" />
                        </svg>
                      )}
                    </span>
                    <span className="queued-bubble-label">
                      {q.kind === "steer"
                        ? "Steering the running agent…"
                        : "Queued — auto-sends after the current turn"}
                    </span>
                    <span className="queued-bubble-pulse" />
                    <button
                      className="chip-x queued-bubble-x"
                      onClick={() =>
                        useStore.getState().removeQueuedMessage(chat.id, q.id)
                      }
                      title="Remove from queue"
                    >
                      ×
                    </button>
                  </div>
                  <div className="queued-bubble-text" dir={detectDir(q.text)}>
                    {prepareContent(q.text, dir) || "(empty)"}
                  </div>
                  {q.attachments && q.attachments.length > 0 && (
                    <div className="msg-attachments" dir="ltr">
                      {q.attachments.map((a) => (
                        <span className="attachment-chip" key={a}>
                          @ {a}
                        </span>
                      ))}
                    </div>
                  )}
                  {q.images && q.images.length > 0 && (
                    <div className="msg-images" dir="ltr">
                      {q.images.map((img) => (
                        <div
                          className="msg-image"
                          key={img.path}
                          title={img.name}
                        >
                          {img.dataUrl ? (
                            <img src={img.dataUrl} alt={img.name} />
                          ) : (
                            <span className="msg-image-ph">{img.name}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {(() => {
            // A real retry banner, OR a stalled-but-busy run (no retry event
            // yet) — both render the SAME RetryBanner so the user always has a
            // one-click Retry and the "still waiting" hint, never a dead-end
            // "Still waiting" notice with only a Stop button.
            const effectiveRetry =
              retryingMsg?.retry ??
              (busy && stalled
                ? {
                  attempt: 1,
                  maxAttempts: 10,
                  delay: 30,
                  reason: "Still waiting for the provider…",
                  gaveUp: false,
                }
                : null);
            if (!effectiveRetry) return null;
            return (
              <RetryBanner
                attempt={effectiveRetry.attempt}
                maxAttempts={effectiveRetry.maxAttempts}
                delay={effectiveRetry.delay}
                reason={effectiveRetry.reason}
                gaveUp={effectiveRetry.gaveUp}
                watchdog={effectiveRetry.watchdog}
                model={effectiveRetry.model}
                agent={effectiveRetry.agent}
                fallback={effectiveRetry.fallback}
                stalled={stalled}
                onRetry={() => {
                  // Resume-only: re-send the last user turn WITHOUT deleting
                  // anything. The error banner must never fall through to
                  // retryMessage's truncate-and-restart branch (which wipes the
                  // whole turn) — it only appears when there is no failed
                  // assistant message to resume, so we go straight to the
                  // resume path here.
                  const msgs = chat?.messages ?? [];
                  const idx = retryingMsg
                    ? msgs.findIndex((m) => m.id === retryingMsg.id)
                    : -1;
                  const userMsg = [
                    ...msgs.slice(0, idx === -1 ? msgs.length : idx),
                  ]
                    .reverse()
                    .find((m) => m.role === "user");
                  if (userMsg) {
                    send(
                      userMsg.content,
                      userMsg.attachments ?? [],
                      userMsg.images ?? [],
                      false,
                      userMsg.id,
                    );
                  }
                }}
                onCancel={dismissRetry}
              />
            );
          })()}
          {(cmdError ||
            compactError ||
            compactNotice ||
            prefixNotice ||
            compacting) && (
              <div className="chat-notices">
                {compacting && (
                  <div className="notice-banner notice-loading" dir="ltr">
                    <span className="notice-icon">
                      <span className="spinner" />
                    </span>
                    <span className="notice-text">
                      Compacting context — older messages are being summarized…
                    </span>
                  </div>
                )}
                {cmdError && (
                  <div className="notice-banner notice-error" dir="ltr">
                    <span className="notice-icon">⚠</span>
                    <span className="notice-text">{cmdError}</span>
                    <button
                      type="button"
                      className="notice-dismiss"
                      onClick={() =>
                        useStore.getState().setChatCmdError(chat.id, null)
                      }
                      title="Dismiss"
                    >
                      ✕
                    </button>
                  </div>
                )}
                {compactError && (
                  <div className="notice-banner notice-error" dir="ltr">
                    <span className="notice-icon">⚠</span>
                    <span className="notice-text">
                      Compact failed — {compactError}
                    </span>
                    <button
                      type="button"
                      className="notice-btn"
                      disabled={busy}
                      onClick={() => void compactContext()}
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      className="notice-dismiss"
                      onClick={() =>
                        useStore.getState().setChatCompactError(chat.id, null)
                      }
                      title="Dismiss"
                    >
                      ✕
                    </button>
                  </div>
                )}
                {compactNotice && (
                  <div
                    className={`notice-banner notice-info${noticeLeaving ? " notice-leaving" : ""}`}
                    dir="ltr"
                  >
                    <span className="notice-icon">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </span>
                    <span className="notice-text">{compactNotice}</span>
                    <button
                      type="button"
                      className="notice-dismiss"
                      onClick={() =>
                        useStore.getState().setChatCompactNotice(chat.id, null)
                      }
                      title="Dismiss"
                    >
                      ✕
                    </button>
                  </div>
                )}
                {prefixNotice && (
                  <div className="notice-banner notice-prefix" dir="ltr">
                    <span className="notice-icon">⌨</span>
                    <span className="notice-text">{prefixNotice}</span>
                  </div>
                )}
              </div>
            )}
        </div>
        {showJump && (
          <button
            className="scroll-jump"
            title="Scroll to bottom"
            onClick={() => {
              stickToBottom.current = true;
              setShowJump(false);
              scrollRef.current?.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: "smooth",
              });
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 5.5l6 6 6-6" />
              <path d="M6 12.5l6 6 6-6" />
            </svg>
          </button>
        )}
      </div>

      <div
        ref={composerRef}
        className={`composer${dragOver ? " dragover" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {askReq &&
          (() => {
            const fa = detectDir(askReq.question) === "rtl";
            return (
              <div className="ask-card" dir={fa ? "rtl" : "ltr"}>
                <div className="ask-card-head">
                  <span className="ask-card-icon">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
                    </svg>
                  </span>
                  <span className="ask-card-title">
                    {fa ? "عامل سوالی از شما دارد" : "The agent has a question"}
                  </span>
                </div>
                <div className="ask-card-question" dir={fa ? "rtl" : "ltr"}>
                  {prepareContent(askReq.question, fa ? "rtl" : "ltr")}
                </div>
                {askReq.options.length > 0 && (
                  <div className="ask-options">
                    {askReq.options.map((opt, i) => (
                      <button
                        key={i}
                        type="button"
                        className="ask-option"
                        onClick={() => {
                          void respondAsk(askReq.id, opt);
                          useStore
                            .getState()
                            .setChatPendingAsk(chatIdRef.current, null);
                        }}
                      >
                        <span className="ask-option-mark">
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                        </span>
                        <span className="ask-option-text" dir={detectDir(opt)}>
                          {prepareContent(opt, fa ? "rtl" : "ltr")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="ask-freetext">
                  <textarea
                    className="ask-input"
                    rows={2}
                    autoFocus
                    dir={fa ? "rtl" : "ltr"}
                    value={askFreeText}
                    placeholder={
                      fa ? "پاسخ خود را بنویسید…" : "Type your answer…"
                    }
                    onChange={(e) => setAskFreeText(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        askFreeText.trim()
                      ) {
                        e.preventDefault();
                        void respondAsk(askReq.id, askFreeText.trim());
                        useStore
                          .getState()
                          .setChatPendingAsk(chatIdRef.current, null);
                      }
                    }}
                  />
                  <div className="ask-footer">
                    <button
                      type="button"
                      className="btn ask-send"
                      disabled={!askFreeText.trim()}
                      onClick={() => {
                        void respondAsk(askReq.id, askFreeText.trim());
                        useStore
                          .getState()
                          .setChatPendingAsk(chatIdRef.current, null);
                      }}
                    >
                      {fa ? "ارسال" : "Send"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}
        {permissionReq &&
          (() => {
            const fa = detectDir(permissionReq.action) === "rtl";
            const isConfirm = permissionReq.scope === "confirm";
            const title = isConfirm
              ? fa
                ? "تأیید عملیات"
                : "Confirm action"
              : fa
                ? "دسترسی بیرون از ورکاسپیس"
                : "Outside workspace access";
            const note = isConfirm
              ? fa
                ? "عامل این عملیات را مهم یا غیرقابل بازگشت می‌داند و منتظر شماست."
                : "The agent flagged this as important or hard to undo, and is waiting for you."
              : fa
                ? "این به عامل اجازه می‌دهد بیرون از ورکاسپیس فعلی شما کار کند."
                : "This lets the agent work outside your current workspace.";
            const denyLabel = fa ? "رد کردن" : "Deny";
            return (
              <div className="perm-card" dir={fa ? "rtl" : "ltr"}>
                <div className="ask-card-head">
                  <span className="ask-card-icon">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                  </span>
                  <span className="ask-card-title">{title}</span>
                </div>
                <div className="ask-card-question" dir={fa ? "rtl" : "ltr"}>
                  {prepareContent(permissionReq.action, fa ? "rtl" : "ltr")}
                </div>
                {permissionReq.path ? (
                  <code className="perm-path" dir="ltr">
                    {permissionReq.path}
                  </code>
                ) : null}
                {permissionReq.reason ? (
                  <div
                    className="perm-reason"
                    dir={detectDir(permissionReq.reason)}
                  >
                    {prepareContent(permissionReq.reason, fa ? "rtl" : "ltr")}
                  </div>
                ) : null}
                <div className="perm-note">{note}</div>
                <div className="perm-buttons">
                  <button
                    type="button"
                    className="btn perm-deny"
                    onClick={() => {
                      void respondPermission(permissionReq.id, false);
                      useStore
                        .getState()
                        .setChatPendingPermission(chatIdRef.current, null);
                    }}
                  >
                    {denyLabel}
                  </button>
                  {isConfirm ? (
                    <button
                      type="button"
                      className="btn perm-allow"
                      onClick={() => {
                        void respondPermission(permissionReq.id, true);
                        useStore
                          .getState()
                          .setChatPendingPermission(chatIdRef.current, null);
                      }}
                    >
                      {fa ? "تأیید" : "Confirm"}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn perm-allow"
                        onClick={() => {
                          void respondPermission(permissionReq.id, true);
                          useStore
                            .getState()
                            .setChatPendingPermission(chatIdRef.current, null);
                        }}
                      >
                        {fa ? "اجازه موقت" : "Allow once"}
                      </button>
                      <button
                        type="button"
                        className="btn perm-allow-always"
                        onClick={() => {
                          void respondPermission(permissionReq.id, true);
                          useStore.getState().setOutsideAllowed(true);
                          useStore
                            .getState()
                            .setChatPendingPermission(chatIdRef.current, null);
                        }}
                      >
                        {fa ? "همیشه اجازه بده" : "Always allow"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })()}
        <div className="composer-inner">
          {dragOver && (
            <div className="drop-overlay">Drop files or images to attach</div>
          )}
          <div className="composer-input-wrap">
            {cmdOpen && (
              <div className="mention-popup" dir="ltr">
                {filteredCmds.length === 0 && (
                  <div className="mention-empty">No matching commands</div>
                )}
                {filteredCmds.map((c, i) => (
                  <div
                    key={c.name}
                    className={`mention-item ${i === cmdIndex ? "active" : ""}`}
                    onMouseEnter={() => setCmdIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptCmd(c.name);
                    }}
                  >
                    <span className="mention-icon-badge cmd">/</span>
                    <span className="mention-rel">/{c.name}</span>
                    <span className="mention-hint">{c.hint}</span>
                  </div>
                ))}
              </div>
            )}
            {skillMention && (
              <div className="mention-popup" dir="ltr">
                <div className="mention-head">
                  <span className="mention-head-icon">@</span>
                  <span>Skills</span>
                  <span className="mention-head-count">
                    {filteredSkills.length}
                  </span>
                </div>
                {skillsLoading && skillsList.length === 0 && (
                  <div className="mention-empty">Loading skills…</div>
                )}
                {!skillsLoading && skillsList.length === 0 && (
                  <div className="mention-empty">
                    No skills — create one with /skill or in Settings → Skills
                  </div>
                )}
                {skillsList.length > 0 && filteredSkills.length === 0 && (
                  <div className="mention-empty">No matching skills</div>
                )}
                {filteredSkills.map((s, i) => (
                  <div
                    key={s.name}
                    className={`mention-item skill${i === skillMentionIdx ? " kbd" : ""}`}
                    onMouseEnter={() => setSkillMentionIdx(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptSkillMention(s);
                    }}
                  >
                    <span className="mention-rel">@{s.slug || s.name}</span>
                    <span className="mention-hint">{s.description}</span>
                  </div>
                ))}
              </div>
            )}
            {skillOpen && (
              <div className="mention-popup" ref={skillPopupRef} dir="ltr">
                <div className="mention-head">
                  <span className="mention-head-icon">⚡</span>
                  <span>MCP tools</span>
                  <span className="mention-head-count">
                    {filteredMcp.length}
                  </span>
                </div>
                <input
                  className="mention-search"
                  type="text"
                  placeholder="Search connectors…"
                  value={skillQuery}
                  onChange={(e) => {
                    setSkillQuery(e.target.value);
                    setSkillIdx(0);
                  }}
                  onKeyDown={(e) => {
                    const move = (d: number) => {
                      if (skillOptions.length === 0) return;
                      setSkillIdx(
                        (i) =>
                          (i + d + skillOptions.length) % skillOptions.length,
                      );
                    };
                    if (
                      (e.ctrlKey || e.metaKey) &&
                      (physicalKey(e) === "j" || physicalKey(e) === "n")
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      move(1);
                      return;
                    }
                    if (
                      (e.ctrlKey || e.metaKey) &&
                      (physicalKey(e) === "k" || physicalKey(e) === "p")
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      move(-1);
                      return;
                    }
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      move(1);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      move(-1);
                      return;
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const opt = skillOptions[skillIdx];
                      if (opt)
                        setMcpEnabled(opt.name, !mcpEnabled.includes(opt.name));
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setSkillOpen(false);
                      return;
                    }
                  }}
                  autoFocus
                />
                {Object.keys(mcpConnectors).length === 0 && (
                  <div className="mention-empty">
                    No MCP connectors — add them in Settings → MCP
                  </div>
                )}
                {filteredMcp.map((name, i) => {
                  const on = mcpEnabled.includes(name);
                  return (
                    <div
                      key={name}
                      className={`mention-item mcp-toggle${on ? " on" : ""} ${i === skillIdx ? "kbd" : ""}`}
                      onMouseEnter={() => setSkillIdx(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setMcpEnabled(name, !on);
                      }}
                    >
                      <span className="mention-icon-badge mcp">⚡</span>
                      <span className="mention-rel">{name}</span>
                      <span className="mcp-switch">
                        <span className="mcp-switch-track">
                          <span className="mcp-switch-knob" />
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <textarea
              className="composer-input"
              rows={1}
              // Follows the app-wide dir toggle (same as message bubbles) instead of
              // auto-detecting per keystroke: switching direction mid-sentence as
              // soon as a Persian/Latin char appears was the actual "جابه‌جایی"
              // problem — cursor and text order would jump while typing. A fixed
              // dir means the textarea's own bidi handling of mixed FA/EN input
              // stays stable and consistent with the rest of the UI.
              dir={dir}
              style={{
                direction: dir,
                textAlign: dir === "rtl" ? "right" : "left",
              }}
              placeholder={
                wroot
                  ? "Ask the agent…  (⌘P file · ⚡ skill · / command)"
                  : "Open a project folder first (⌘O)…"
              }
              ref={textareaRef}
              value={input}
              onChange={onInputChange}
              onKeyDown={onKeyDown}
            />
          </div>

          {nvimLabel && (
            <div className="nvim-wrap">
              <button
                type="button"
                className={`nvim-label${nvimMentioned ? " selected" : ""}`}
                dir="ltr"
                title={
                  nvimMentioned
                    ? "Will be mentioned in your next message — click to deselect"
                    : `Open in Neovim: ${nvimFile} — click to mention in your next message`
                }
                onClick={() => setNvimMentioned((m) => !m)}
              >
                <span className="nvim-glyph">nvim</span>
                <span className="nvim-file">{nvimBadge}</span>
                {nvimDiagCounts.error +
                  nvimDiagCounts.warning +
                  nvimDiagCounts.info +
                  nvimDiagCounts.hint >
                  0 && (
                    <span
                      className={`nvim-lsp${lspOpen ? " open" : ""}`}
                      dir="ltr"
                      role="button"
                      tabIndex={0}
                      title="LSP diagnostics — click to view"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLspOpen((v) => !v);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          setLspOpen((v) => !v);
                        }
                      }}
                    >
                      {nvimDiagCounts.error > 0 && (
                        <span className="lsp-count lsp-error" title="LSP errors">
                          {nvimDiagCounts.error}✕
                        </span>
                      )}
                      {nvimDiagCounts.warning > 0 && (
                        <span
                          className="lsp-count lsp-warning"
                          title="LSP warnings"
                        >
                          {nvimDiagCounts.warning}!
                        </span>
                      )}
                      {nvimDiagCounts.info + nvimDiagCounts.hint > 0 && (
                        <span
                          className="lsp-count lsp-info"
                          title="LSP info/hints"
                        >
                          {nvimDiagCounts.info + nvimDiagCounts.hint}·
                        </span>
                      )}
                    </span>
                  )}
                <span className="nvim-check">{nvimMentioned ? "✓" : "+"}</span>
              </button>
              {lspOpen && nvimDiags.length > 0 && (
                <div
                  className="nvim-lsp-pop"
                  dir="ltr"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="nvim-lsp-pop-head">
                    <span className="nvim-lsp-pop-title">
                      LSP diagnostics — {nvimBadge}
                    </span>
                    <button
                      type="button"
                      className="nvim-lsp-pop-close"
                      onClick={() => setLspOpen(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="nvim-lsp-pop-list">
                    {nvimDiags.map((d, i) => {
                      const sev =
                        d.severity === 1 ||
                          d.severity === "Error" ||
                          d.severity === "error"
                          ? "error"
                          : d.severity === 2 ||
                            d.severity === "Warning" ||
                            d.severity === "warning"
                            ? "warning"
                            : d.severity === 3 ||
                              d.severity === "Information" ||
                              d.severity === "information"
                              ? "info"
                              : "hint";
                      const loc = `${(d.lnum ?? 0) + 1}:${(d.col ?? 0) + 1}`;
                      const src = d.source
                        ? `${d.source}${d.code != null ? ` ${d.code}` : ""}`
                        : "";
                      return (
                        <div key={i} className={`nvim-diag nvim-diag-${sev}`}>
                          <span className="nvim-diag-sev">
                            {sev === "error"
                              ? "✕"
                              : sev === "warning"
                                ? "!"
                                : "·"}
                          </span>
                          <span className="nvim-diag-loc">{loc}</span>
                          <span className="nvim-diag-msg">{d.message}</span>
                          {src && <span className="nvim-diag-src">{src}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {(attachments.length > 0 || images.length > 0) && (
            <div className="attachment-chips" dir="ltr">
              {attachments.map((a) => {
                const idx = Math.max(a.lastIndexOf("/"), a.lastIndexOf("\\"));
                const name = idx >= 0 ? a.slice(idx + 1) : a;
                return (
                  <span className="attachment-chip file-chip" key={a} title={a}>
                    <svg
                      className="chip-file-icon"
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <path d="M14 2v6h6" />
                      <path d="M9 13h6" />
                      <path d="M9 17h6" />
                    </svg>
                    <span className="chip-file-name">{name}</span>
                    <button
                      className="chip-x"
                      onClick={() => removeAttachment(a)}
                      title="Remove"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              {images.map((img) => (
                <span className="attachment-chip image-chip" key={img.path}>
                  {img.dataUrl ? (
                    <img className="chip-thumb" src={img.dataUrl} alt="" />
                  ) : (
                    <span className="chip-thumb placeholder" />
                  )}
                  <span className="chip-name">{img.name}</span>
                  <button
                    className="chip-x"
                    onClick={() => removeImage(img.path)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="composer-row">
            <span className="composer-left">
              <ModeSelect
                modes={modes}
                value={chat.mode}
                iconOnly
                onChange={changeMode}
              />
              {provider &&
                (modelReasoning(provider, activeModel) ??
                  supportsReasoning(activeModel, provider.kind)) && (
                  <span
                    className={`thinking-pill${thinkingLevel ? " on" : ""}`}
                    ref={thinkingRef}
                  >
                    <button
                      type="button"
                      className="thinking-pill-btn"
                      onClick={() => setThinkingOpen((o) => !o)}
                      title={`Reasoning effort for this message — now: ${THINKING_LABELS[thinkingLevel] ?? "Medium"}`}
                      aria-label="Reasoning effort for this message"
                      aria-expanded={thinkingOpen}
                    >
                      <svg
                        className="thinking-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
                        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
                        <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
                        <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
                        <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
                        <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
                        <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
                        <path d="M6 18a4 4 0 0 1-1.967-.516" />
                        <path d="M19.967 17.484A4 4 0 0 1 18 18" />
                      </svg>
                      <span className="thinking-label">
                        {THINKING_LABELS[thinkingLevel] ?? "Medium"}
                      </span>
                      <span className="mode-select-caret" aria-hidden="true">
                        {thinkingOpen ? "▲" : "▼"}
                      </span>
                    </button>
                    {thinkingOpen && (
                      <div className="mode-menu thinking-menu">
                        {THINKING_OPTIONS.map(([v, label]) => (
                          <button
                            key={v}
                            type="button"
                            className={`mode-menu-item thinking-item${thinkingLevel === v ? " active" : ""}`}
                            onClick={() => {
                              setThinkingLevel(v);
                              setThinkingOpen(false);
                            }}
                          >
                            <span className="mode-menu-text">
                              <span className="mode-menu-label">{label}</span>
                              <span className="mode-menu-desc">
                                {THINKING_DESCS[v]}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                )}
              <ProviderModelSelect />
            </span>
            <span className="composer-hint" />
            <div className="composer-actions">
              <button
                className={`icon-btn attach-btn mic-btn ${recording ? "recording" : ""} ${transcribing ? "transcribing" : ""}`}
                onClick={toggleRecording}
                disabled={busy}
                title={
                  transcribing
                    ? "Transcribing voice…"
                    : recording
                      ? "Stop recording (Ctrl+X Space)"
                      : "Record voice input (Ctrl+X then Space)"
                }
              >
                {recording ? (
                  <span className="wave animate" aria-hidden="true">
                    <span className="wave-bar" />
                    <span className="wave-bar" />
                    <span className="wave-bar" />
                    <span className="wave-bar" />
                  </span>
                ) : transcribing ? (
                  <span className="wave transcribing" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M8 9l0 6" />
                      <path d="M12 7l0 10" />
                      <path d="M16 9l0 6" />
                    </svg>
                  </span>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                )}
              </button>
              <button
                className="icon-btn attach-btn"
                onClick={captureRegion}
                disabled={busy}
                title="Capture a region of the screen"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>
              <button
                className="icon-btn attach-btn"
                onClick={attachFile}
                disabled={busy}
                title="Attach an image or file"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <button
                className={`icon-btn attach-btn${mcpEnabled.length > 0 ? " has-chips" : ""}`}
                onClick={() => void openSkillPicker()}
                disabled={busy}
                title="Add MCP tools to this message"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                {mcpEnabled.length > 0 && (
                  <span className="attach-count">{mcpEnabled.length}</span>
                )}
              </button>
              {busy ? (
                <>
                  <button
                    className="icon-btn queue-btn"
                    onClick={queueForLater}
                    disabled={!input.trim() && images.length === 0}
                    title="Queue — send after the current turn finishes (won't interrupt)"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
                    </svg>
                  </button>
                  <button
                    className="icon-btn stop-btn"
                    onClick={stop}
                    title="Stop"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  </button>
                </>
              ) : (
                <button
                  className="icon-btn send-btn"
                  disabled={!input.trim() && images.length === 0}
                  onClick={submit}
                  title="Send"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
