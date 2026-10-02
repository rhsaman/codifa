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
import { getActiveProvider, getChatProvider, useStore } from "../lib/store";
import { api } from "../lib/fs";
import { resetStreamForRetry, isKeepTextRetry, planRetry } from "../lib/retry";
import {
  applyToolEvent,
  diffStatsFromUnified,
  makeToolActivity,
  resolveStuckActivities,
  resolveToolResult,
} from "../lib/toolActivity";
import {
  bumpToolRunning,
  dropToolRunning,
  isToolRunning,
} from "../lib/watchdog";
import { PROVIDER_META } from "../lib/provider-meta";
import { bareModelId } from "../lib/provider-fetch";
import { normalizeUsageModel } from "../lib/usage";
import { stripLeadingModeTag } from "../lib/modeTag";
import {
  contextPercent,
  computeContextUsed,
  formatCost,
  formatTokens,
  formatTokensK,
  modelContextWindow,
  contextWarn,
  modelReasoning,
  priceForModel,
  computeUsageCost,
} from "../lib/context";
import {
  steerChat,
  streamChat,
  fetchCredits,
  transcribeAudio,
  respondPermission,
  respondAsk,
  listSkills,
  listMcp,
  triggerCompact,
  type CompactResult,
  type StreamParams,
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
import { composerScrollPadding, jumpVisibleThreshold } from "../lib/scrollPadding";
import { fmtClock } from "../lib/time";
import { isAtBottom, distanceFromBottom, classifyScrollEvent } from "../lib/scroll";
import {
  GLOBAL_SHORTCUTS,
  PREFIX_LABEL,
  PREFIX_SHORTCUTS,
  formatGlobalShortcut,
  formatShortcut,
  navChord,
} from "../lib/shortcuts";
import type {
  AgentMode,
  ChatMessage,
  McpServerConfig,
  MessageSegment,
  NvimDiagnostic,
  PastedText,
  SidecarEvent,
  ThinkingLevel,
  ToolActivity,
  SearchResultItem,
} from "../types";
import {
  ChatMessageView,
  QueuedCollapsibleText,
  RetryBanner,
  isCollapsibleText,
} from "./ChatMessage";
import { MessageImages } from "./MessageImages";
import { ModeIcon } from "./ModeIcon";
import { ModeSelect } from "./ModeSelect";
import { ProviderModelSelect } from "./ProviderModelSelect";
import { ToolCallView } from "./ToolCallView";
import { BalanceChip } from "./BalanceChip";
import { ComposerDiffBar } from "./ComposerDiffBar";
import { visibleChatMessages } from "../lib/compactDedupe";

// Sentinels the plan-approval card sends as the ask answer — must match
// graph.py's PLAN_APPROVE_TOKEN / PLAN_DISMISS_TOKEN. The visible option label
// is never sent, so localization can't break the protocol; free text goes
// through verbatim as planner revision feedback.
const PLAN_APPROVE_TOKEN = "__plan_approve__";
const PLAN_DISMISS_TOKEN = "__plan_dismiss__";

const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDER_META).map((m) => [m.kind, m.label]),
);

const THINKING_OPTIONS: Array<[ThinkingLevel, string]> = [
  ["none", "None"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "XHigh"],
];
const THINKING_LABELS = Object.fromEntries(THINKING_OPTIONS) as Record<
  ThinkingLevel,
  string
>;
const THINKING_DESCS: Record<ThinkingLevel, string> = {
  "": "Default reasoning",
  none: "No reasoning — fastest replies",
  low: "Light reasoning — faster replies",
  medium: "Balanced reasoning — default",
  high: "Deep reasoning — better answers",
  xhigh: "Extra-deep reasoning — strongest answers",
  max: "Maximum reasoning — strongest answers",
};

const COMMANDS: Array<{ name: string; hint: string }> = [
  { name: "help", hint: "List all commands" },
  { name: "compact", hint: "Summarize & compact the chat context" },
  { name: "clear", hint: "Clear all messages in this chat" },
  { name: "new", hint: "Start a new chat" },
  { name: "undo", hint: "Undo the last user/assistant exchange" },
  { name: "redo", hint: "Redo the last undone exchange" },
  {
    name: "create-skill",
    hint: "Create or edit a skill (describe what you want after the command)",
  },
  {
    name: "create-mcp",
    hint: "Create an MCP connector (describe what you want after the command)",
  },
];

/** True when a message asks to create/edit/install/import skills or MCP connectors,
 *  so the agent gets the `create_skill` / `create_mcp` tools for the turn.
 *  Matches English AND Persian intent words (نصب/ساخت/بساز/ایجاد/ذخیره/اضافه/ویرایش/ادیت/اصلاح/تغییر/حذف/آپدیت/بروز →
 *  action; اسکیل/مهارت → skill target) so Persian-only prompts work too.
 *  `create_skill` overwrites an existing skill with the same name, so the same
 *  grant covers both creating AND editing a skill. */
function wantsSkillOrMcp(text: string): boolean {
  const low = text.toLowerCase();
  const action =
    /\b(install|add|create|import|save|set up|setup|copy|edit|update|modify|change|fix|delete|remove)\b|(نصب|ساخت|بساز|ایجاد|ذخیره|اضافه|ویرایش|ادیت|اصلاح|تغییر|حذف|آپدیت|بروز)/.test(
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

export function ChatPanel() {
  // Subscribe by id first: the active chat object identity only changes when
  // THAT chat's own record changes (message/stream/draft), so typing a draft
  // in another chat or streaming elsewhere never re-renders this panel.
  const activeChatId = useStore((s) => s.activeChatId);
  const chat = useStore((s) => {
    const id = s.activeChatId;
    for (const c of s.chats) if (c.id === id) return c;
    return null;
  });
  const provider = useStore((s) => {
    // Per-chat provider override: a chat that picked its own provider/model in
    // the composer runs on that, falling back to the global active provider.
    // Read the override id without subscribing to the whole chats array: only
    // the override + provider list participate in the result.
    let overrideId: string | undefined;
    for (const c of s.chats) {
      if (c.id === s.activeChatId) {
        overrideId = c.providerId;
        break;
      }
    }
    return (
      s.settings.providers.find(
        (x) => x.id === (overrideId ?? s.settings.activeProviderId),
      ) ?? s.settings.providers[0]
    );
  });
  void activeChatId;
  const activeModel = chat?.model ?? provider.model;
  const allProviders = useStore((s) => s.settings.providers);

  // Live provider balance (OpenRouter). STRICTLY click-to-refresh — NO
  // automatic polling, no mount seed, no post-turn refresh, no post-compact
  // refresh. Every automatic /credits request competes for the same local
  // sidecar the open /chat/stream is using, and the user has reported that
  // ANY background /credits firing near a live stream correlates with the
  // stream dropping (the fetch is independent but the render churn /
  // promise scheduling can interact with the SSE read loop on the renderer
  // side). The chip below calls `refreshCredits` only on click; everything
  // else is explicit. Trade-off: a stale balance until the user clicks —
  // acceptable because the chip is informational, not load-bearing.
  const [creditMap, setCreditMap] = useState<
    Record<
      string,
      Partial<{ balance: number; total_credits: number; total_usage: number }>
    >
  >({});
  // The "refreshing" indicator uses a ref + DOM class so the click handler
  // does NOT trigger a React re-render at all. The chip's <button> reads
  // `refreshingRef.current` via a className callback ref that touches the
  // DOM directly, bypassing the React tree. This keeps the click truly
  // fire-and-forget from React's perspective — a re-render during an open
  // /chat/stream SSE is the surest way to make the renderer event loop
  // stutter enough to drop a streaming chunk.
  // Spinner state — a tiny React state so the chip class is correct without
  // the old DOM-trick (`refreshButtonsRef` + `refreshingRef.current`).
  // Re-renders are cheap: the chip is a single button and the change is one
  // class flip. The previous ref-only design was needed when click handlers
  // were forbidden to schedule renders, but that constraint is gone now.
  const [creditBusy, setCreditBusy] = useState(false);
  // Hold the in-flight promise in a ref so a second click while the first
  // is still pending dedupes to the same request (and so a fast double-click
  // can't queue two parallel fetches racing for the same sidecar slot).
  const inFlightRef = useRef<Promise<void> | null>(null);
  const refreshCredits = useCallback(() => {
    if (!provider) return;
    if (inFlightRef.current) return inFlightRef.current;
    const target = provider;
    setCreditBusy(true);
    const p = (async () => {
      try {
        const result = await fetchCredits(target);
        if (result && target) {
          setCreditMap((m) => ({ ...m, [target.id]: result }));
        }
      } catch {
        /* swallow — balance is non-critical UI */
      } finally {
        setCreditBusy(false);
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = p;
    return p;
  }, [provider]);

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

  // The panel now stays mounted across chat switches (no key={activeChatId}),
  // so per-chat UI state must reset explicitly when the active chat changes.
  const [input, setInput] = useState(chat?.draft?.input ?? "");
  const [attachments, setAttachments] = useState<string[]>(
    chat?.draft?.attachments ?? [],
  );
  const [images, setImages] = useState<
    Array<{
      path: string;
      name: string;
      dataUrl?: string;
      origPath?: string;
    }>
  >(chat?.draft?.images ?? []);
  // Long pastes captured as collapsed cards above the input (joined back into
  // the prompt on send). Scoped to the chat like input/attachments/images.
  const [pastedBlocks, setPastedBlocks] = useState<PastedText[]>(
    chat?.draft?.pasted ?? [],
  );
  const [attLen, setAttLen] = useState(0);
  const prevChatIdRef = useRef(chat?.id ?? "");
  useEffect(() => {
    const id = chat?.id ?? "";
    if (prevChatIdRef.current === id) return;
    prevChatIdRef.current = id;
    // Flush the outgoing draft synchronously so no keystroke is lost, then
    // load the incoming chat's draft. Cancel the pending debounce first.
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    const prevId = useStore.getState().activeChatId;
    void prevId;
    setInput(chat?.draft?.input ?? "");
    setAttachments(chat?.draft?.attachments ?? []);
    setImages(chat?.draft?.images ?? []);
    setPastedBlocks(chat?.draft?.pasted ?? []);
    setCmdOpen(null);
    setCmdQuery("");
    setSkillMention(null);
    setSkillMentionQuery("");
    setAskFreeText("");
    setNvimMentioned(false);
    setMsgLimit(MSG_PAGE);
    stickToBottom.current = !chat?.scrollPos || chat.scrollPos.atBottom;
    restoredRef.current = false;
    // The restore layout effect below must re-run for the NEW chat with the
    // NEW chat's saved position (not the mount-time one): refresh the anchor
    // and bump a tick so the effect fires even when every other state setter
    // bails out identical. Without this, switching to a scrolled-up chat can
    // land on a stale anchor — or the oldest-message fallback, i.e. the top.
    initialScrollPosRef.current = chat?.scrollPos ?? null;
    setRestoreTick((t) => t + 1);
    restoreTargetRef.current = null;
    lastScrollPosRef.current = null;
    chatIdRef.current = id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id]);
  // Per-chat isolation: the panel stays mounted across switches (no
  // key={activeChatId}), so ALL per-turn mutable state must be keyed by chatId.
  // A single boolean/ref would leak the Stop button, aborts, watchdog timers
  // and error banners across chats. Each chat tracks its own local busy flag;
  // the message-level `streaming` flag stays the source of truth for activity.
  const chatIdRef = useRef(chat?.id ?? "");
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
  const setBusyFor = useCallback((chatId: string, v: boolean) => {
    setBusyMap((m) => {
      if (v) {
        if (m[chatId]) return m;
        return { ...m, [chatId]: true };
      }
      if (!m[chatId]) return m;
      const n = { ...m };
      delete n[chatId];
      return n;
    });
  }, []);
  const setBusy = useCallback(
    (v: boolean) => {
      const id = chatIdRef.current || chat?.id;
      if (!id) return;
      setBusyFor(id, v);
    },
    [chat?.id, setBusyFor],
  );
  const busyLocal = chat?.id ? (busyMap[chat.id] ?? false) : false;
  // This chat is busy when THIS chat has a streaming assistant message (so
  // another chat streaming in the background doesn't lock this composer). The
  // message-level streaming flag is the source of truth — the global
  // isStreaming flag stays in the store only as the persist gate.
  const chatHasStreaming = chat?.messages.some((m) => m.streaming) ?? false;
  // While the client is self-healing a dropped stream (reconnecting from the
  // on-disk checkpoint), the backend keeps producing tokens but the `streaming`
  // flag may already be false (it is cleared the moment the SSE socket drops,
  // before the `retry`/`reconnecting` event arrives). Treat a live reconnect as
  // busy too, so the Stop button stays up and the user can see the turn is
  // still running instead of the Send button appearing mid-reconnect.
  const chatReconnecting =
    chat?.messages.some((m) => m.retry?.reconnecting === true) ?? false;
  const queuedMsgs = chat?.queued?.filter((q) => !q.sent) ?? [];
  const busy = busyLocal || chatHasStreaming || chatReconnecting;
  /** The assistant message currently being rate-limited/retried by the provider,
   *  if any. Its RetryBanner is rendered once, at the END of the message list
   *  (not inline inside the message) so it never sits "above the agent's reply"
   *  between the user's message and the incoming content. */
  const retryingMsg = chat?.messages.find((m) => m.retry) ?? null;
  const [sidecarStatus, setSidecarStatus] = useState<"ok" | "fail">("ok");

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
  const sttProviderId = useStore((s) => s.sttProviderId);
  const sttModel = useStore((s) => s.sttModel);
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
  // Selected row on the plan-approval card (index into its options; 0 = the
  // pre-highlighted "Approve" option). Reset whenever a new ask lands.
  const [planApprovalSel, setPlanApprovalSel] = useState(0);
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
  // Per-chat scroll restoration: the panel stays mounted across chat
  // switches (no key={activeChatId}), so the restore anchor is refreshed on
  // every switch (see the chat-id effect above). If the user last left this
  // chat scrolled up, don't auto-pin to the bottom on return.
  const initialScrollPosRef = useRef(chat?.scrollPos ?? null);
  const stickToBottom = useRef(!initialScrollPosRef.current || initialScrollPosRef.current.atBottom);
  // A jump-to-bottom smooth scroll started by the scroll-jump button is still
  // in flight: while set, onChatScroll ignores the animation's intermediate
  // scroll events so they can't unpin the view or pop the button back.
  // Cleared on arrival at the bottom, or immediately on user wheel/touch.
  const jumpScrollingRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  /** آستانهٔ نمایش فلش «پرش به پایین»: صفر یعنی محتوای چت هنوز پشت UI شناور
   *  پنهان نشده (کامپوزر روی فضای رزروشدهٔ انتهای چت شناور است)؛ تا وقتی
   *  فاصلهٔ اسکرول از پایین از این مقدار نگذرد فلش نمایش داده نمی‌شود. با
   *  رشد/کوچک شدن کامپوزر یا باز/بسته شدن کارت ask/perm در افکت padding به‌روز
   *  می‌شود. */
  const jumpThresholdRef = useRef(0);
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
  /** Bumped on every chat switch so the restore layout effect below re-runs
   *  for the incoming chat even when all other state setters bail out. */
  const [restoreTick, setRestoreTick] = useState(0);
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
  /** True while a programmatic scrollTop set (restore / re-anchor) is "in
   *  flight": the scroll events it fires must be ignored (they are not user
   *  scrolls). Raised right before setting scrollTop and lowered on the next
   *  animation frame — per spec, the scroll events of one set fire in the same
   *  frame, before the rAF callback, so the flag window exactly covers them.
   *  Unlike comparing the set value against the event's scrollTop, this is
   *  immune to the browser clamping the requested value to the scroll range
   *  (content-visibility placeholders make the requested restore position
   *  exceed scrollHeight - clientHeight on a fresh mount). */
  const programmaticScrollRef = useRef(false);
  /** Bumped to force the transcript to the bottom even when the user scrolled
   *  up (send / queue / steer). The auto-scroll effect depends on it. */
  const [scrollTick, setScrollTick] = useState(0);
  // Per-chat abort controllers: single ref would abort the WRONG chat after a
  // switch (stop in B would kill A's stream). The store's `chatAborts` map is
  // authoritative; this mirror lets stop() abort instantly without a store read
  // race. Keyed by chatId.
  const abortMapRef = useRef<Map<string, AbortController>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  /** Per-chat stop flags: prevents trailing retry events from re-activating
   *  another chat's banner after the user stopped THIS chat. */
  const stoppedMapRef = useRef<Map<string, boolean>>(new Map());
  const stoppedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skillPopupRef = useRef<HTMLDivElement>(null);
  // Container for the @skill mention popup, so the highlighted row can be
  // scrolled into view on Ctrl+J/K / arrow navigation (the list scrolls
  // internally and the highlight can move outside the visible 300px area).
  const skillMentionPopupRef = useRef<HTMLDivElement>(null);
  const lastEventAt = useRef(0);
  const toolRunningRef = useRef(0);
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
  /** True when a create_mcp tool was called this turn — triggers MCP list refresh on done. */
  const mcpChangedRef = useRef(false);
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
  const skillNotice = chat?.skillNotice ?? null;
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
    let cancelled = false;
    window.coder
      .getSidecarUrl()
      .then((url) => {
        if (cancelled) return;
        setSidecarStatus(url ? "ok" : "fail");
      })
      .catch(() => {
        if (cancelled) return;
        setSidecarStatus("fail");
      });
    return () => {
      cancelled = true;
    };
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
  // Debounced (~250ms): typing must never write the store per keystroke — each
  // write rebuilds the chat object and re-renders every subscriber of that chat
  // (transcript, sidebar row). The local `input` state stays the typing source
  // of truth; the store only receives the settled value.
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!chat) return;
    const id = chat.id;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      useStore.getState().setChatDraft(id, {
        input,
        attachments,
        images,
        pasted: pastedBlocks,
      });
    }, 250);
    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id, input, attachments, images, pastedBlocks]);
  // NOTE: نقشه‌های context/pricing/reasoning هر پروایدر فقط در استارت‌آپ
  // (App.tsx → fetchAndPersist) و هنگام افزودن/ویرایش پروایدر (SettingsModal)
  // فچ می‌شوند — تعویض پروایدر در چت دیگر فچ اضافه‌ای انجام نمی‌دهد.

  useEffect(() => {
    if (!wroot || attachments.length === 0) {
      setAttLen(0);
      return;
    }
    let total = 0;
    let cancelled = false;
    attachments.forEach((a) => {
      void api
        .fsRead(wroot, a)
        .then((r) => {
          if (cancelled) return;
          total += r.content.length;
          setAttLen(total);
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [wroot, attachments]);

  /** Snapshot the current viewport as a message-anchored scroll position. */
  const computeScrollPos = (
    el: HTMLDivElement,
  ): { id: string; offset: number; atBottom: boolean } | null => {
    const atBottom = isAtBottom(el);
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

  /** Set scrollTop programmatically (restore / re-anchor) while marking the
   *  resulting scroll events as non-user: raise the flag, set, and lower it on
   *  the next animation frame — per spec the scroll events of one set fire in
   *  the same frame, before the rAF callback, so the window exactly covers
   *  them. Immune to the browser clamping the requested value (which broke the
   *  old value-comparison approach). */
  const setProgrammaticScroll = (el: HTMLDivElement, top: number) => {
    programmaticScrollRef.current = true;
    el.scrollTop = top;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  };

  const onChatScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // If the user scrolls away from the position the restore set, stop
    // re-anchoring (the restore is only for the initial viewport).
    // A programmatic re-anchor (the restore itself re-setting scrollTop as
    // content-visibility placeholders settle) must NOT be treated as a user
    // scroll: it fires a scroll event at the clamped position, where
    // isAtBottom can wrongly report "at bottom" and flip stickToBottom on —
    // the first message update would then yank the viewport to the end and
    // overwrite the saved position with atBottom (the "returned to the chat
    // at the bottom of the page" regression).
    const { cancelRestore, fromReanchor } = classifyScrollEvent(
      restoreTargetRef.current,
      programmaticScrollRef.current,
    );
    if (cancelRestore) {
      restoreTargetRef.current = null;
    }
    if (fromReanchor) return;
    // Jump flight in progress: intermediate ticks of the smooth animation are
    // not user scrolls — keep the pin and the hidden button until arrival.
    if (jumpScrollingRef.current) {
      if (isAtBottom(el)) {
        jumpScrollingRef.current = false;
        stickToBottom.current = true;
        setShowJump(false);
      }
      return;
    }
    const atBottom = isAtBottom(el);
    stickToBottom.current = atBottom;
    // Bail out when unchanged so scrolling doesn't re-render the whole panel on
    // every tick — the jump button only flips once per boundary crossing.
    // آستانهٔ نمایش: محتوا باید واقعاً پشت کامپوزر پنهان شده باشد، نه فقط
    // چند پیکسل از انتهای محتوا فاصله داشته باشیم (اگر نه، فلش «داخل اینپوت»
    // به نظر می‌رسد چون کامپوزر روی فضای رزروشدهٔ انتهای چت شناور است).
    const jumpVisible = distanceFromBottom(el) > jumpThresholdRef.current;
    setShowJump((prev) => (prev === jumpVisible ? prev : jumpVisible));
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
            setProgrammaticScroll(el, desired);
            return;
          }
        }
        // بازیابی تثبیت شد (لنگر پایدار شد یا حذف شد): هم‌زمان با پاک کردن
        // هدف، وضعیت pin و فلشِ پرش‌به‌پایین را با ویوپورتِ بازیابی‌شده
        // همگام کن — onChatScroll رویدادهای برنامه‌ای را نادیده می‌گیرد، پس
        // بدون این همگام‌سازی فلش تا اولین اسکرولِ کاربر مخفی می‌ماند.
        restoreTargetRef.current = null;
        const atBottom = isAtBottom(el);
        stickToBottom.current = atBottom;
        const jumpVisible = distanceFromBottom(el) > jumpThresholdRef.current;
        setShowJump((prev) => (prev === jumpVisible ? prev : jumpVisible));
        return;
      }
      const atBottom = isAtBottom(el);
      if (stickToBottom.current) {
        el.scrollTop = el.scrollHeight;
        setShowJump(false);
      } else if (atBottom) {
        setShowJump(false);
      } else {
        const jumpVisible = distanceFromBottom(el) > jumpThresholdRef.current;
        setShowJump((prev) => (prev === jumpVisible ? prev : jumpVisible));
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
      const diffBar = composer.querySelector<HTMLElement>(".composer-diff-bar");
      const composerH = composer.getBoundingClientRect().height;
      const cardH = card ? card.getBoundingClientRect().height : null;
      const diffBarH = diffBar ? diffBar.getBoundingClientRect().height : null;
      const padding = composerScrollPadding(composerH, cardH, diffBarH);
      el.style.paddingBottom = `${padding}px`;
      // فلش فقط وقتی معنا دارد که متن‌های چت واقعاً پشت کامپوزر پنهان شده
      // باشند؛ آستانه = فضای رزروشدهٔ انتهای محتوا منهای ارتفاع UI شناور
      // (کامپوزر + کارت + نوار گیت که داخل composerH اندازه‌گیری می‌شود).
      jumpThresholdRef.current = jumpVisibleThreshold(padding, composerH + (cardH ?? 0));
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
  // visible jump. Fires on mount and on every chat switch (restoreTick).
  useLayoutEffect(() => {
    if (restoredRef.current) return;
    const pos = initialScrollPosRef.current;
    const el = scrollRef.current;
    if (!el) return;
    if (!pos || pos.atBottom) {
      // کاربر در پایین بود (یا موقعیتی ذخیره نشده) → مستقیماً به پایین اسکرول کن.
      // حین استریم محتوا رشد می‌کند و reconcile/auto-scroll پین را حفظ می‌کنند.
      restoredRef.current = true;
      stickToBottom.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
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
    setProgrammaticScroll(el, el.scrollTop + (anchorRect.top - containerRect.top - pos.offset));
    setShowJump(false);
    // content-visibility: auto skips off-screen messages on a fresh mount, so
    // the first pass lands near the anchor using 140px placeholders — the
    // restored viewport can be off by the difference between placeholder and
    // real heights. Keep re-anchoring (via the ResizeObserver reconcile above)
    // as the browser actually renders the content around the anchor, until the
    // position stabilizes or the user scrolls away.
    restoreTargetRef.current = { id: anchorId, offset: pos.offset };
  }, [restoreTick, msgLimit, chat]);

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
    // Unmount (chat switch): push + flushNow so the position survives even
    // mid-stream (persist() is deferred while streaming, so it could be lost).
    const flush = () => {
      pushToStore();
      if (cid && lastScrollPosRef.current) {
        useStore.getState().flushNow();
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
  // assistant turn's token total (input + output + reasoning + cache), matching
  // opencode's `overflow.ts` accounting. opencode shows 0% until the first real
  // usage event arrives — no estimate fallback — so a brand-new chat reads empty.
  const contextUsed = useMemo(
    () => computeContextUsed(chat, systemPrompt, ctxWindow ?? undefined),
    [chat, systemPrompt, ctxWindow],
  );

  // opencode's meter compares the latest turn's total against the RAW window
  // (`limit.context`). The backend auto-compaction threshold is a percentage of
  // this same raw window (compactAtPercent), so the meter and the trigger agree:
  // the bar hits the threshold exactly when compaction fires.
  const ctxPct = contextPercent(contextUsed, ctxWindow);

  // Warn (yellow) when used context reaches the auto-compaction threshold
  // (compactAtPercent% of the raw window) — the same point where backend
  // auto-compaction fires.
  const compactAtPercent = settings.compactAtPercent ?? 80;
  const usable =
    ctxWindow != null ? Math.round(ctxWindow * (compactAtPercent / 100)) : null;

  // This chat's CUMULATIVE token usage & cost per model (main + explore /
  // compact / vision sub-agents). Tracked in the chat record itself so it
  // survives compacts and chat switches — session totals only ever grow. Each
  // model is priced with its OWN advertised rate when the provider publishes
  // one — never the parent model's rate (would silently misprice old models).
  const sessionUsage = useMemo(() => {
    const usage = chat?.usage;
    const out: Array<{
      providerId: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost: number | null;
    }> = [];
    for (const u of usage?.entries ?? []) {
      if (u.input + u.output <= 0) continue;
      const price = priceForModel(provider.pricingMap, u.model);
      // input_tokens already includes the cache-read/write portion; bill the
      // cache lines at their own cheaper rate when advertised, else full input.
      const cacheRead = u.cacheRead ?? 0;
      const cacheWrite = u.cacheWrite ?? 0;
      const cost = computeUsageCost(price, {
        input: u.input,
        output: u.output,
        cacheRead,
        cacheWrite,
      });
      out.push({
        providerId: u.providerId,
        model: u.model,
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

  // ============================================================================
  // INVARIANT: the send path MUST NOT await /credits (or any other sidecar
  // call besides /chat/stream). Polling for the active provider's balance is
  // fire-and-forget in ChatPanel's credits effect above; the header chip
  // tolerates a missing balance until the next poll resolves. If you need
  // credits data on send, read it from `creditMap` (updated by the polling
  // effect), never from a fresh `fetchCredits` call.
  // ============================================================================
  const send = async (
    text: string,
    atts: string[] = [],
    imgs: Array<{ path: string; name: string; dataUrl?: string }> = [],
    allowCreate = false,
    reuseMsgId?: string,
    continueAssistantId?: string,
    forceScroll = false,
    overrides?: { mcpServers?: Record<string, McpServerConfig>; skills?: string[]; restart?: boolean },
    forChatId?: string,
  ) => {
    // Per-chat isolation: resolve the ORIGIN chat first (background drains via
    // registry must target their own chat, not the currently viewed one), then
    // keep ALL turn-local mutable state in locals/maps keyed by that origin so
    // two chats streaming concurrently never share watchdog clocks, abort
    // controllers, stop flags or busy flags.
    const s = useStore.getState();
    // Use THIS panel's chat (captured at render), never s.activeChatId: a
    // queued turn drained while the user is viewing ANOTHER chat must still
    // target this chat's messages/usage.
    // `forChatId` pins the ORIGIN chat for background drains / watchdog
    // retries (which fire while another chat is active). Without it, `send`
    // would read `chatIdRef.current` (the viewed chat) and inject A's turn
    // into B — the cross-chat contamination reported by users.
    const chatId = forChatId ?? chatIdRef.current;
    const chat = s.chats.find((c) => c.id === chatId) ?? null;
    if (!chat) return;
    stoppedMapRef.current.set(chatId, false);
    // Per-turn local state (was shared refs — now locals so concurrent chats
    // don't race). stop() coordinates via stoppedMapRef + chatAborts store.
    let mcpChanged = false;
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
    if (!rootDir) {
      // Every chat belongs to a workspace (see store.ts newChat/newChatInRoot).
      // A silent return here used to look like an "instant disconnect" — the
      // composer cleared but nothing happened. Surface a visible /cmd error so
      // the user knows exactly why the send did nothing.
      useStore
        .getState()
        .setChatCmdError(
          chat.id,
          "Open or create a workspace to start a chat — every chat belongs to a workspace.",
        );
      return;
    }
    let activeProvider = getChatProvider(chat.id);
    if (!activeProvider.model) {
      s.setSettingsOpen(true);
      return;
    }
    // Self-heal a stale per-chat model override: when the chat's model is not
    // in the provider's REAL catalog (p.models, populated from /models) and the
    // provider is a built-in gateway (authoritative catalog), fall the chat
    // back to the provider's own (self-healed) default instead of sending a
    // request the gateway will 401 ("Model ... is not supported").
    const catalog = activeProvider.models ?? [];
    if (
      catalog.length > 0 &&
      PROVIDER_META[activeProvider.kind]?.builtin === true &&
      !catalog.some(
        (m) =>
          bareModelId(activeProvider, m) ===
          bareModelId(activeProvider, activeProvider.model),
      )
    ) {
      s.setChatProvider(chat.id, activeProvider.id, activeProvider.model);
      activeProvider = getChatProvider(chat.id);
    }
    s.addRecentModel(activeProvider.model, activeProvider.id);

    // NOTE: MCP connectors are no longer injected as a text instruction. The
    // backend now opens a real connection to each enabled server and registers
    // its tools directly with the model, so a textual "use the MCP tools" note
    // is both redundant and misleading (it used to be the ONLY thing wired up,
    // which is why MCP tools silently never worked).
    const skillNotes: string[] = [];
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
    const effectiveSkills = overrides?.skills ?? Array.from(mentionSkills);
    const effectiveMcpServers: Record<string, McpServerConfig> =
      overrides?.mcpServers ??
      (() => {
        const all = s.settings.mcpServers ?? {};
        const enabled = s.settings.mcpEnabled ?? [];
        const sel: Record<string, McpServerConfig> = {};
        for (const n of enabled) if (all[n]) sel[n] = all[n];
        return sel;
      })();
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
        mcpServers: effectiveMcpServers,
        skills: effectiveSkills,
        // Capture the CURRENT chat mode on the user bubble so the transcript
        // stays consistent: every user message records which mode it ran in.
        // This also guarantees a retry (which re-sends via send()) inherits the
        // mode the user is IN now, never the mode of the old message it replaces.
        mode: chat.mode,
      });
    }
    let assistantMsg: ChatMessage;
    if (continueAssistantId) {
      // Auto-retry / watchdog continuation: keep the SAME assistant bubble and
      // resume streaming into it instead of spawning a second, half-finished one.
      const existing = chat.messages.find((m) => m.id === continueAssistantId);
      if (existing) {
        assistantMsg = existing;
        s.updateMessage(existing.id, {
          streaming: true,
          retry: null,
          // Base for the "Working" elapsed timer — stored on the message so
          // switching chats (unmount/remount) doesn't reset it to zero. Kept
          // from the original turn start on continuations so the finished
          // turn's persisted duration covers the whole turn, not just the
          // resumed segment.
          ...(existing.workingStartedAt
            ? {}
            : { workingStartedAt: Date.now() }),
        });
      } else {
        assistantMsg = s.addMessage(chat.id, {
          role: "assistant",
          content: "",
          mode: chat.mode,
          toolActivity: [],
          segments: [],
          streaming: true,
          // Base for the "Working" elapsed timer (see workingStartedAt in types).
          workingStartedAt: Date.now(),
        });
      }
    } else {
      assistantMsg = s.addMessage(chat.id, {
        role: "assistant",
        content: "",
        mode: chat.mode,
        toolActivity: [],
        segments: [],
        streaming: true,
        workingStartedAt: Date.now(),
      });
    }
    // User-initiated sends jump to the bottom even if they scrolled up (the
    // auto-drain path passes forceScroll=false so it never yanks the user away
    // from history they are reading).
    if (forceScroll) forceScrollToBottom();

    // Clear any lingering retry banner and stale streaming flag from a previous
    // message before sending. A prior turn that was aborted/interrupted may have
    // left an assistant message with streaming:true; without this cleanup the new
    // turn would add a second streaming message and show two "Thinking" indicators.
    for (const m of chat.messages) {
      if (m.id === assistantMsg.id) continue;
      if (m.retry) s.updateMessage(m.id, { retry: null });
      // A stale streaming flag from a previous turn: close it AND stamp its
      // duration so the finished turn keeps its working time in the footer.
      if (m.streaming) {
        const staleStart = m.workingStartedAt ?? m.thinkingStartedAt;
        s.updateMessage(m.id, {
          streaming: false,
          workingStartedAt: undefined,
          ...(staleStart != null
            ? { turnElapsedMs: Math.max(0, Date.now() - staleStart) }
            : {}),
        });
      }
    }
    // A skill warning from the previous turn (e.g. an @mention that resolved to
    // nothing) is stale by now — the new turn re-resolves its own mentions.
    if (chat.skillNotice) s.setChatSkillNotice(chat.id, null);

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
        // Sent to the model only — UI never renders this field. The backend
        // folds it into the AIMessage's content so a retry knows what was
        // already done without re-executing completed tools.
        preservedToolSummary: m.preservedToolSummary,
      }));
    // Cast: SearchResultItem fields (title, url, snippet) are valid JSON-
    // serializable keys; the narrower StreamParams type omits them but they
    // survive the round-trip fine.  The pre-existing sliceToBudget wrapper
    // masked this mismatch with an implicit any.
    const history = allHistory as StreamParams["history"];

    const abort = new AbortController();
    abortMapRef.current.set(chat.id, abort);
    useStore.getState().setChatAbort(chat.id, abort);
    setBusyFor(chat.id, true);
    // Turn-local watchdog clock/counters: locals (not shared refs) so two
    // chats streaming at once never overwrite each other's timers.
    let lastEventAtMs = Date.now();
    let stalledSinceMs: number | null = null;
    let watchdogAborted = false;
    let watchdogAutoRetried = 0;
    const toolRunning = { current: 0 };
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

    // Plan-card seal: when a plan_card lands on this bubble the reply is
    // finished (the plan collapsed into a card). Whatever streams next belongs
    // to a NEW logical reply — a planner revision after an edit request, or
    // the approved Coder implementation — so the next streamed event rotates
    // to a fresh assistant bubble. The sealed bubble keeps its FULL content
    // (the model still sees the whole plan in later history); the chat renders
    // only its preamble + the collapsed Plan card.
    let bubbleSealed = false;
    const rotateAssistantBubble = (mode?: string) => {
      const s = useStore.getState();
      const prev = s.chats
        .find((c) => c.id === chat.id)
        ?.messages.find((m) => m.id === assistantMsg.id);
      if (prev) {
        s.updateMessage(prev.id, {
          streaming: false,
          statusText: undefined,
          thinkingActive: false,
          ...(prev.workingStartedAt
            ? { turnElapsedMs: Math.max(0, Date.now() - prev.workingStartedAt) }
            : {}),
        });
      }
      assistantMsg = s.addMessage(chat.id, {
        role: "assistant",
        content: "",
        mode: mode ?? chat.mode,
        toolActivity: [],
        segments: [],
        streaming: true,
        workingStartedAt: Date.now(),
      });
      bubbleSealed = false;
    };
    const ensureLiveBubble = () => {
      if (bubbleSealed) rotateAssistantBubble();
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
    const STALL_CHECK_INTERVAL_MS = 10_000;
    const stallTimer = setInterval(() => {
      // While the agent is waiting for the user to answer a permission /
      // confirm / ask request, it is legitimately paused — never treat that
      // as a stall and never force-abort, no matter how long the user takes.
      const chatState = useStore.getState().chats.find((c) => c.id === chat.id);
      if (chatState?.pendingPermission || chatState?.pendingAsk) {
        stalledSinceMs = null;
        return;
      }
      // A tool that's still running gets a much longer leash — it's doing real
      // work, not stalled on the provider.
      const limit = isToolRunning(toolRunning) ? 900_000 : 300_000;
      const elapsed = Date.now() - lastEventAtMs;
      // Early feedback (not a retry): after 25s of total silence the Working
      // pill explains the wait instead of looking frozen. Cleared by any real
      // event via statusText: undefined in text/tool/thinking handlers.
      if (elapsed > 25_000 && elapsed <= limit) {
        const cur = useStore
          .getState()
          .chats.find((c) => c.id === chat.id)
          ?.messages.find((m) => m.id === assistantMsg.id);
        if (cur && !cur.statusText && !cur.retry) {
          useStore.getState().updateMessage(assistantMsg.id, {
            statusText: isToolRunning(toolRunning)
              ? "tool running"
              : "waiting for model",
          });
        }
        return;
      }
      if (elapsed <= limit) {
        stalledSinceMs = null;
        return;
      }
      if (stalledSinceMs == null) stalledSinceMs = Date.now();
      // Auto-retry on a loop with exponential backoff. Each retry re-sends the
      // last user turn; the backend's own retry loop handles transient failures.
      // Only force-abort if we've exhausted the retries AND the silence drags on
      // far past the last one (a genuinely dead connection).
      if (watchdogAutoRetried < WATCHDOG_MAX_RETRIES) {
        watchdogAutoRetried += 1;
        // Read the latest messages from the store, not the closure. The stall
        // watchdog fires 10s apart on a stable `setInterval`; reading
        // `chat.messages` from the closure would let it see a stale chat object
        // during a long stream and pick an outdated `lastUser` to retry.
        const liveChat = useStore
          .getState()
          .chats.find((c) => c.id === chat.id);
        const msgs = liveChat?.messages ?? [];
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        if (lastUser) {
          // Show a visible "stalled — retrying" pill instead of a silent
          // interrupt, so the user understands the pause (the backend resumes
          // from its checkpoint rather than starting over).
          useStore.getState().updateMessage(assistantMsg.id, {
            retry: {
              attempt: watchdogAutoRetried,
              maxAttempts: WATCHDOG_MAX_RETRIES,
              delay: 0,
              reason:
                "Connection stalled — the model is taking a while; auto-retrying…",
              reconnecting: true,
            },
          });
          // RESUME the same user turn WITHOUT truncating: retryMessage() would
          // call truncateTo() here because the stalled assistant turn isn't
          // flagged failed/error yet (the stream is still alive, just silent),
          // which deletes every message after the user turn. Abort the stalled
          // stream first, then re-send the same user message so the backend
          // continues from where it was cut off — no messages are lost.
          // Pin the ORIGIN chat: the watchdog can fire while the user views
          // another chat; without forChatId the retry would land in the wrong chat.
          if (!abort.signal.aborted) abort.abort();
          const originId = chat.id;
          setTimeout(
            () =>
              send(
                lastUser.content,
                lastUser.attachments ?? [],
                lastUser.images ?? [],
                false,
                lastUser.id,
                assistantMsg.id,
                false,
                undefined,
                originId,
              ),
            0,
          );
        }
        return;
      }
      if (Date.now() - (stalledSinceMs ?? Date.now()) > HARD_STALL_GRACE_MS) {
        watchdogAborted = true;
        abort.abort();
      }
    }, 10_000);

    // Preserve tool-call context on a FAILED turn so the next one doesn't redo
    // it. The recap is written to a NON-visible `preservedToolSummary` field on
    // the message (NOT appended to `content` — that polluted the visible
    // transcript and tripped small models on the next send). The model still
    // sees the recap on the next turn (the history map below carries the
    // field), but the UI never renders it. Fire it on EVERY failure path: the
    // streamChat catch below AND inline SSE "error" events (a backend fatal
    // arrives as a normal event, not a throw).
    // A turn's stream can end without a tool_result for every started card
    // (backend crash, stop, error, lost SSE). Force any still-"running" card to
    // "done" so the spinner/tick never hangs forever. Recursively resolves
    // children too — without this, orphaned sub-agent children (grep/read
    // inside explore task cards) stay "running" forever with a growing timer.
    const resolveStuckCards = () => {
      const msg = useStore
        .getState()
        .chats.find((c) => c.id === chat.id)
        ?.messages.find((m) => m.id === assistantMsg.id);
      // Guard: check recursively — a child can be orphaned at "running" even
      // when the parent task card is already "done" (FIFO race edge case).
      const hasRunning = (acts: ToolActivity[]): boolean =>
        acts.some(
          (a) =>
            a.status === "running" ||
            (a.children != null && hasRunning(a.children)),
        );
      if (!msg || !hasRunning(msg.toolActivity ?? [])) return;
      useStore.getState().updateMessage(assistantMsg.id, {
        toolActivity: resolveStuckActivities(msg.toolActivity ?? []),
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
      const blocks: string[] = [];
      for (const a of doneActs.slice(0, 20)) {
        const head = `- ${a.tool}${a.summary ? `: ${a.summary}` : ""}`;
        // Fold the REAL tool output (not just the summary) so a reconnect does
        // not re-execute the call and waste context. `items`/`results` carry the
        // actual rows (grep hits, glob paths, web_search links, …); fall back to
        // the summary only when there is no structured result.
        const rows = (a.items ?? a.results ?? []) as unknown as Array<
          Record<string, unknown>
        >;
        const body = rows.length
          ? rows
            .slice(0, 50)
            .map((r) => {
              const line =
                (r.snippet as string) ||
                (r.content as string) ||
                (r.text as string) ||
                (r.title as string) ||
                (r.url as string) ||
                (r.path as string) ||
                (r.file as string) ||
                JSON.stringify(r);
              return `    ${line}`;
            })
            .join("\n")
          : "";
        blocks.push(body ? `${head}\n${body}` : head);
      }
      // Written to a non-visible field so the model still sees what was done
      // (avoids re-executing completed tools) but the visible transcript stays
      // clean — small/free models on opencode misread the inlined warning as
      // a new instruction, which looked like an instant disconnect.
      const summary = `[Interrupted before finishing. Already done this turn — do NOT repeat these:\n${blocks.join("\n")}]`;
      useStore.getState().updateMessage(assistantMsg.id, {
        preservedToolSummary: summary,
      });
    };

    const handleEvent = (event: SidecarEvent) => {
      // Heartbeat from the backend: it arrives every ~15s while the agent is
      // legitimately silent (running a tool / thinking). Refresh the watchdog
      // clock so a long-running tool is NOT mistaken for a dead connection —
      // only a socket that stops emitting keepalives (a genuinely dead one)
      // should trip the stall watchdog. No UI work needed.
      if (event.kind === "keepalive") {
        lastEventAtMs = Date.now();
        return;
      }
      lastEventAtMs = Date.now();
      // Live reads: `useStore.getState()` on every event. A snapshot captured
      // once per turn goes stale after the first updateMessage, and the second
      // event then overwrites the first one's segments (steer segment lost when
      // a tool card lands right after steer_applied — the vanish bug).
      const findMsg = () =>
        useStore
          .getState()
          .chats.find((c) => c.id === chat.id)
          ?.messages.find((m) => m.id === assistantMsg.id);
      const store = useStore.getState();
      // A transient retry banner ("Provider hiccup — retrying…") must retire
      // as soon as the turn shows ANY activity — not only text. After a
      // successful retry the model often resumes straight into a tool loop
      // (deduped tool cards, sub-agent events, tool_result / diff updates)
      // and may not emit text for minutes; without this the banner stayed
      // frozen at "retrying…" the whole time while cards kept streaming.
      // Terminal banners (gaveUp / watchdog) and the sub-agent fallback
      // notice survive: they carry the Retry button / the "which model to
      // fix" hint.
      const clearTransientRetry = () => {
        const r = findMsg()?.retry;
        if (
          !r ||
          r.gaveUp === true ||
          r.watchdog === true ||
          r.fallback === true
        )
          return;
        store.updateMessage(assistantMsg.id, { retry: null });
      };
      if (event.kind === "text") {
        // Keep the current "isThinking" flag untouched — a text chunk must not
        // cancel the composer glow while the model is still reasoning.
        useStore.getState().setStreaming(true, useStore.getState().isThinking);
        ensureLiveBubble();
        const prev = findMsg()?.content ?? "";
        const chunk = stripLeadingModeTag(event.content ?? "", prev);
        store.updateMessage(assistantMsg.id, {
          content: prev + chunk,
          segments: appendTextSegment(findMsg()?.segments, chunk),
          retry: null,
          thinkingActive: false,
          statusText: undefined,
        });
      } else if (event.kind === "thinking") {
        // Lightweight signal: the backend now emits active:True ONLY when the
        // model actually produces reasoning content. Drive the per-message
        // thinking indicator from it (not from mere streaming).
        useStore.getState().setStreaming(true, !!event.active);
        ensureLiveBubble();
        store.updateMessage(assistantMsg.id, {
          thinkingActive: !!event.active,
          ...(event.active ? { thinkingStartedAt: Date.now() } : {}),
          // Safety net: if a retry banner is somehow still attached (e.g. a
          // retry resumed into a long thinking pass before the first text/tool
          // chunk arrives), clear it now — the model is clearly working again.
          retry: null,
          ...(event.active ? { statusText: undefined } : {}),
        });
      } else if (event.kind === "skill") {
        // Successful @mention attachments are deliberately NOT rendered into
        // the chat — the user asked for the "Attached skills" notes to stay out
        // of the transcript. The attached skills are still inlined in the
        // system prompt, so the model follows them; only the visible note is
        // dropped. The `note` field is different: it warns that an attached
        // skill was NOT found (deleted/renamed) — without it the user never
        // learns why the skill silently didn't apply. Stored per-chat (like
        // compactNotice) so it survives a chat switch mid-turn.
        if (event.note) {
          useStore.getState().setChatSkillNotice(chat.id, event.note);
        }
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
        bumpToolRunning(toolRunning);
        clearTransientRetry();
        ensureLiveBubble();
        // A create_mcp call this turn means the connector list in the store is
        // stale — flag it so the `done` handler re-fetches from the sidecar.
        if (event.tool === "create_mcp") mcpChanged = true;
        // Sub-agent tool calls (task/explore's internal read/grep/glob, or a
        // general sub-agent reusing the parent's tools) render NESTED inside
        // the running task card, not as top-level cards — so a task turn shows
        // one collapsible parent with its details, never a stack of collapsed
        // fragments. `applyToolEvent` nests sub-events by branch even when the
        // parent card is already "done".
        if (event.sub) {
          const currentSub = findMsg()?.toolActivity ?? [];
          const next = applyToolEvent(currentSub, event);
          // Orphan sub-events promoted to top-level cards (no matching task
          // card) grow the list — they need their own segment, otherwise
          // renderSegments never shows them (visible in trace, missing in chat).
          if (next.length > currentSub.length) {
            const toolIndex = currentSub.length;
            store.updateMessage(assistantMsg.id, { toolActivity: next });
            // Atomic segment append so a concurrent steer_applied cannot be
            // overwritten by this wholesale segments replace (the vanish bug).
            useStore.getState().appendMessageSegments(assistantMsg.id, [
              { kind: "tool", index: toolIndex } as MessageSegment,
            ]);
          } else {
            store.updateMessage(assistantMsg.id, { toolActivity: next });
          }
        } else {
          // Top-level tool event. De-dupes against an existing card with the
          // same callId (provider-native id or LangChain numeric): the
          // Anthropic / Gemini stream can emit a `tool_use` part AND the
          // tool's own callback can both surface a `kind: "tool"` event for
          // the same call, and we want ONE card per call, not two stacked.
          const current = findMsg()?.toolActivity ?? [];
          const next = applyToolEvent(current, event);
          // Only mint a new render-segment when the activity list actually
          // grew. applyToolEvent returns the same list (by reference) when
          // it dedupes — checking `next.length` against `current.length` is
          // the cheapest way to tell "new card" from "merged into existing".
          if (next.length > current.length) {
            const toolIndex = current.length;
            store.updateMessage(assistantMsg.id, {
              toolActivity: next,
              retry: null,
              statusText: undefined,
            });
            // Atomic segment append so a concurrent steer_applied cannot be
            // overwritten by this wholesale segments replace (the vanish bug).
            useStore.getState().appendMessageSegments(assistantMsg.id, [
              { kind: "tool", index: toolIndex } as MessageSegment,
            ]);
          } else {
            store.updateMessage(assistantMsg.id, { toolActivity: next });
          }
        }
      } else if (event.kind === "retry") {
        // If the user already clicked Stop, ignore any trailing retry events
        // that the backend may still be emitting during its asyncio.sleep delay.
        // Per-chat: only THIS origin chat's stop flag matters, not another chat's.
        if (stoppedMapRef.current.get(chat.id) === true) return;
        const info = {
          attempt: event.attempt ?? 1,
          maxAttempts: event.max_attempts ?? 3,
          delay: event.delay ?? 0,
          reason: event.reason ?? "",
          model: event.model ?? "",
          agent: event.agent ?? "",
          fallback: event.fallback,
          reconnecting: event.reconnecting,
          startedAt: Date.now(),
        };
        if (isKeepTextRetry(event.reconnecting, event.fallback)) {
          // Backend automatic retry, client self-heal reconnect, OR a
          // sub-agent fallback notice: keep the already-streamed text and
          // segments — do NOT reset the message. The banner is informational
          // (the turn is still alive); once the model resumes (thinking /
          // text / tool events), the banner is cleared automatically via
          // retry:null in those handlers.
          resolveStuckCards();
          store.updateMessage(assistantMsg.id, { retry: info });
        } else {
          const cur = findMsg();
          // Banner retry without `reconnecting` is a user-triggered RESTART
          // (e.g. a transient retry failed and the user hit the banner
          // button). Wipe the streamed text AND the tool segments — the new
          // attempt is going to re-stream its own answer AND re-issue tool
          // calls, so keeping the old timeline would duplicate everything.
          const reset = resetStreamForRetry(
            cur?.content ?? "",
            cur?.segments,
            "restart",
          );
          store.updateMessage(assistantMsg.id, {
            retry: info,
            content: reset.content,
            segments: reset.segments,
            toolActivity: [],
          });
        }
      } else if (event.kind === "retry_giveup") {
        if (stoppedMapRef.current.get(chat.id) === true) return;
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
        dropToolRunning(toolRunning);
        clearTransientRetry();
        // `resolveToolResult` resolves sub-agent results by branch/call_id even
        // when the parent branch card (or its nested child) is already "done",
        // so late sub-results are never dropped.
        const next = resolveToolResult(findMsg()?.toolActivity ?? [], event);
        store.updateMessage(assistantMsg.id, { toolActivity: next });
        // When the AI creates a skill via the create_skill tool, invalidate
        // the frontend skills cache so the @mention picker picks it up.
        // Must also refresh the component's skillsList state — clearing the
        // module-level cache alone doesn't trigger a re-render.
        if (event.tool === "create_skill") {
          invalidateSkillsList();
          void ensureSkills();
        }
      } else if (event.kind === "diff") {
        clearTransientRetry();
        const current = findMsg()?.toolActivity ?? [];
        // تطبیق ایونت diff با کارت ابزار: وقتی دو edit_file/write_file همزمان
        // running هستند، تطبیقِ فقط بر اساس نام ابزار، دیف را به هر دو کارت
        // می‌چسباند. بک‌اند path را می‌فرستد؛ پس اول بر اساس path مچ می‌کنیم و
        // اگر هیچ کارتی مچ نشد (مثلاً استریم mid-turn ریکانکت شده)، به تطبیق
        // قدیمیِ tool+running برمی‌گردیم.
        const pathOf = (a: ToolActivity) =>
          String(a.args?.path ?? a.args?.filePath ?? "");
        const hasPath = typeof event.path === "string" && event.path !== "";
        const isTarget = (a: ToolActivity) =>
          a.tool === event.tool &&
          a.status === "running" &&
          (!hasPath || pathOf(a) === event.path);
        const anyPathMatch = current.some(isTarget);
        const next = current.map((a) => {
          if (isTarget(a) || (hasPath && !anyPathMatch && a.tool === event.tool && a.status === "running")) {
            const diff = event.diff ?? "";
            return {
              ...a,
              diff,
              diffStats: diffStatsFromUnified(diff),
              summary: event.summary,
              checkpoint: event.checkpoint,
            };
          }
          return a;
        });
        store.updateMessage(assistantMsg.id, { toolActivity: next });
      } else if (event.kind === "compact_start") {
        // Backend is auto-compacting (summarizer running) — show the loading
        // banner under the messages until the compact/compact_failed event lands.
        // Stored per-chat so it survives a chat switch mid-compact; clear any
        // stale notice/error so the loading banner replaces them.
        // Treat the compaction like a running tool so the watchdog grants the
        // 900s leash (not the 300s non-tool limit) — a slow mid-turn compact
        // must not be mistaken for a stalled stream and force-aborted.
        bumpToolRunning(toolRunning);
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
        dropToolRunning(toolRunning);
        useStore.getState().setChatCompacting(chat.id, false);
        const chatId = chat.id;
        if (chatId) {
          // Auto-compact: the backend tells us exactly how many recent turns it
          // preserved verbatim (`keep`), so we fold the SAME older turns and keep
          // the SAME recent ones — the summary never contradicts the tail it
          // renders next. Fall back to 1 (opencode-style: only the last message
          // survives verbatim) on older backends that don't report `keep`.
          const backendKeep =
            Number.isFinite(event.keep) && (event.keep ?? -1) >= 0
              ? event.keep
              : undefined;
          store.compactChat(chatId, event.content ?? "", backendKeep ?? 1);
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
          // پیام‌های صف‌شده حین کامپکت فقط بعد از اتمام کامپکت تحویل داده می‌شوند
          setTimeout(() => {
            if (!sendPendingSteerNext(chat.id)) sendQueuedNext(chat.id);
          }, 0);
        }
      } else if (event.kind === "compact_failed") {
        // Auto-compact failed — the backend did NOT drop any messages. Surface
        // the retry banner so the user can compact manually (the manual path
        // runs the summarizer as a read-only ask request with the parent model,
        // which succeeds even when the compact subagent model is invalid).
        dropToolRunning(toolRunning);
        useStore.getState().setChatCompacting(chat.id, false);
        useStore
          .getState()
          .setChatCompactError(
            chat.id,
            event.reason ||
            "Automatic compaction failed — nothing was deleted.",
          );
        // حتی در شکست کامپکت هم صف تخلیه شود تا پیام کاربر گم نشود
        setTimeout(() => {
          if (!sendPendingSteerNext(chat.id)) sendQueuedNext(chat.id);
        }, 0);
      } else if (event.kind === "plan") {
        // Backend emits the authoritative merged checklist (preserves completed,
        // handles steer edits/removals). Replace — never merge stale extras back.
        const incoming = event.items ?? [];
        store.updateMessage(assistantMsg.id, {
          plan: incoming,
          retry: null,
        });
        // پنل راست هرگز خودکار باز نمی‌شود — حتی با ساخت تودوی تازه؛
        // فقط کاربر با دکمه/میان‌بر آن را باز می‌کند.
      } else if (event.kind === "plan_card") {
        // Plan mode finished: collapse the streamed plan into a Plan card.
        // The bubble is sealed — the next streamed text (planner revision or
        // the approved Coder run) opens a fresh reply bubble. The message keeps
        // its full content for model history; ChatMessage renders only the
        // preamble + card.
        const body = typeof event.body === "string" ? event.body : "";
        if (body) {
          bubbleSealed = true;
          store.updateMessage(assistantMsg.id, {
            planDoc: {
              title: typeof event.title === "string" ? event.title : "",
              body,
              preamble:
                typeof event.preamble === "string" && event.preamble
                  ? event.preamble
                  : undefined,
            },
            statusText: undefined,
          });
        }
      } else if (event.kind === "mode_changed") {
        // Backend switched the workflow mode mid-run (plan approval → coder).
        // Sync chat.mode silently (no "[Mode switched]" marker — the backend
        // narrates through the stream) and rotate so the implementation gets
        // its own reply bubble.
        const mode = typeof event.mode === "string" ? event.mode : "";
        if (mode) {
          useStore.getState().setChatModeQuiet(chat.id, mode);
          rotateAssistantBubble(mode);
        }
      } else if (event.kind === "permission") {
        useStore.getState().setChatPendingPermission(chat.id, {
          id: event.id ?? "",
          action: event.action ?? "",
          path: event.path,
          reason: event.reason,
          scope: event.scope,
          folder: event.folder,
        });
      } else if (event.kind === "ask") {
        setAskFreeText("");
        setPlanApprovalSel(0);
        // آیتم‌های options ممکنه از سمت backend غیررشته باشن (object/array/null).
        // همه رو به string coerce می‌کنیم تا prepareContent کرش نکنه.
        const rawOpts: unknown[] = Array.isArray(event.options)
          ? event.options
          : [];
        const options: string[] = rawOpts
          .map((o: unknown) =>
            typeof o === "string"
              ? o
              : o == null
                ? ""
                : typeof o === "object"
                  ? JSON.stringify(o)
                  : String(o),
          )
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
        useStore.getState().setChatPendingAsk(chat.id, {
          id: event.id ?? "",
          question: typeof event.question === "string" ? event.question : "",
          options,
          style: typeof event.style === "string" ? event.style : undefined,
        });
      } else if (event.kind === "error") {
        // A backend error while the summarizer was supposedly running means the
        // compact can't complete either — never leave the "Compacting context"
        // banner stuck next to the error. Clear it defensively (the backend's
        // own compact_failed event already does this on its normal path).
        useStore.getState().setChatCompacting(chat.id, false);
        // Do NOT append the error text to the message content — errors are
        // shown only in the notification banner (RetryBanner), not as inline
        // chat bubbles. The `retry` object below is what triggers the banner;
        // `error: true` keeps the failed-turn styling without rendering text.
        store.updateMessage(assistantMsg.id, {
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
        // render BELOW the steer, in real order. Also clear the steerPending flag
        // so the turn's finally block does NOT re-send it as a new turn.
        // Atomic append (no wholesale segments replace) so a tool/text event
        // landing right after cannot drop the steer segment. Only messages
        // actually anchored as a segment are hidden — otherwise the bubble
        // stays visible instead of vanishing.
        const ids = Array.isArray(event.ids) ? event.ids : [];
        const live = useStore.getState();
        const toAnchor: Array<{ kind: "user"; id: string }> = [];
        for (const id of ids) {
          const userMsg = live.chats
            .find((c) => c.id === chat.id)
            ?.messages.find((m) => m.id === id);
          if (!userMsg || userMsg.role !== "user") continue;
          toAnchor.push({ kind: "user", id });
        }
        if (toAnchor.length > 0) {
          live.appendMessageSegments(assistantMsg.id, toAnchor);
        }
        // Re-read: appendMessageSegments dedupes, so verify each id actually
        // has a segment before hiding its bubble.
        const anchoredIds = new Set(
          (useStore.getState().chats
            .find((c) => c.id === chat.id)
            ?.messages.find((m) => m.id === assistantMsg.id)?.segments ?? [])
            .filter((s) => s.kind === "user")
            .map((s) => (s as { id: string }).id),
        );
        for (const seg of toAnchor) {
          if (!anchoredIds.has(seg.id)) continue;
          useStore.getState().updateMessage(seg.id, {
            steerPending: false,
            steerInterleaved: true,
          });
        }
      } else if (event.kind === "steer_dropped") {
        // Backend discarded these steers without injecting (turn ended with no
        // tool call to carry them). Keep them visible/pending so the auto-drain
        // re-sends them as the next turn instead of losing them.
        const ids = Array.isArray(event.ids) ? event.ids : [];
        for (const id of ids) {
          useStore.getState().updateMessage(id, {
            steerPending: true,
            steerInterleaved: false,
          });
        }
      } else if (event.kind === "status") {
        // Staged progress before first token (preparing context, contacting
        // model, retrying). Shown in the Working pill so a slow turn does not
        // look frozen. Cleared on first real text/tool/thinking content.
        lastEventAtMs = Date.now();
        ensureLiveBubble();
        const label =
          typeof event.content === "string" && event.content.trim()
            ? event.content.trim().slice(0, 120)
            : typeof (event as { stage?: unknown }).stage === "string"
              ? String((event as { stage?: unknown }).stage).slice(0, 120)
              : "Working";
        useStore.getState().updateMessage(assistantMsg.id, { statusText: label });
      } else if (event.kind === "laya") {
        // فعالیت زنده تصمیم سریع laya — جدا از رویداد usage (مصرف دست‌نخورده
        // می‌ماند)؛ در تاریخچه همان چت مبدأ استریم ثبت می‌شود (نه چت فعال لحظه‌ای)
        // تا با سوییچ چت، تاریخچه قاطی نشود. لاگ کامل در trace_store بک‌اند است
        // و از پنل Trace (آیکون اپ‌بار) دیده می‌شود — دیگر پنل راست باز نمی‌شود.
        const originChatId = chat.id;
        store.appendLayaRun(originChatId, {
          route: typeof event.route === "string" ? event.route : "normal",
          confidence: typeof event.confidence === "number" ? event.confidence : 0,
          abstained: event.abstained === true,
          reason: typeof event.reason === "string" ? event.reason : "",
          handled: event.handled === true,
          providerId:
            (event.provider_id as string | undefined) ||
            (event.provider as string | undefined) ||
            "local",
          model: typeof event.model === "string" ? event.model : "",
          elapsedMs: typeof event.elapsed_ms === "number" ? event.elapsed_ms : 0,
        });
      } else if (event.kind === "usage") {
        // `unbilled` events report a REJECTED (window-overflow) request — the
        // provider never charged those tokens, so they must not count toward
        // the message badge or the chat's billed totals.
        if (event.unbilled) return;
        const inputTokens = event.input_tokens ?? 0;
        const outputTokens = event.output_tokens ?? 0;
        const total = event.total_tokens ?? inputTokens + outputTokens;
        // Prefer the provider the backend actually used (from the usage event);
        // `provider_id` is the user-configured id, which the sidebar groups by
        // (several providers can share the same kind). Fall back to the kind
        // field for legacy events, then to the chat's own provider.
        const providerId =
          (event.provider_id as string | undefined) ||
          (event.provider as string | undefined) ||
          getChatProvider(chat.id).id ||
          "unknown";
        const model = normalizeUsageModel(
          providerId,
          (event.model || "").trim() || activeModel || "main",
        );
        // Store the provider + model EXPLICITLY (no key string, no guessing) so
        // the sidebar shows the exact provider/model that ran this chat.
        // رویداد laya (لوکال صفرتوکنی یا پروایدر خارجی) با پرچم laya ثبت می‌شود
        // تا ردیف صفرتوکنی لوکال هم در model usage بماند — مثل مدل‌های tools.
        store.accrueChatUsage(chat.id, providerId, model, {
          input: inputTokens,
          output: outputTokens,
          cacheRead: event.cache_read_tokens ?? 0,
          cacheWrite: event.cache_write_tokens ?? 0,
          ...(event.laya ? { laya: true } : {}),
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
              contextTokens: event.context_tokens ?? undefined,
              reasoningTokens: event.reasoning_tokens ?? 0,
              cacheReadTokens: event.cache_read_tokens ?? 0,
              cacheWriteTokens: event.cache_write_tokens ?? 0,
            },
          });
        }
      } else if (event.kind === "done") {
        // The backend signals the end of the stream with a "done" event.
        // Refresh the watchdog clock so a queued stall-timer callback can't
        // re-set it after the stream closes.
        lastEventAtMs = Date.now();
        resolveStuckCards();
        useStore.getState().updateMessage(assistantMsg.id, { statusText: undefined });
        // Backend reports steers it discarded without injecting
        // (dropped_steer_ids). Keep them pending/visible so the auto-drain
        // below re-sends them as the next turn instead of losing them.
        const dropped = (event as { dropped_steer_ids?: unknown }).dropped_steer_ids;
        if (Array.isArray(dropped)) {
          for (const id of dropped) {
            if (typeof id !== "string" || !id) continue;
            useStore.getState().updateMessage(id, {
              steerPending: true,
              steerInterleaved: false,
            });
          }
        }
        // A create_mcp ran this turn: the connector was saved to the app's user
        // data folder by the backend, but the store's mcpServers snapshot is only hydrated
        // once at app startup — re-fetch so Settings → MCP shows it without a
        // restart. Fire-and-forget: a failure here must not break the turn.
        if (mcpChanged) {
          mcpChanged = false;
          void listMcp().then((db) => {
            useStore.getState().setMcpServers(db.mcpServers ?? {});
          }).catch(() => { });
        }
        // A successful completion clears ANY retry banner (not just
        // reconnecting). This ensures the attempt counter resets to 1 on the
        // next turn's first error.
        //
        // BUT: a `done` arriving AFTER an `error` is just the server's
        // stream-close sentinel — it is NOT a success. The previous version
        // unconditionally set `retry: null` here, which wiped the error
        // banner the user needs to see. Only clear the banner when the
        // turn actually succeeded (`error: false`), or when the retry
        // object is a transient (in-progress) one that should naturally
        // retire on turn completion. A terminal `retry.gaveUp` /
        // `retry.watchdog` MUST survive the `done` so the user has a
        // Retry button to click.
        const curMsg = findMsg();
        if (curMsg?.retry) {
          const r = curMsg.retry;
          const isTerminal = r.gaveUp === true || r.watchdog === true;
          const isFailedTurn = curMsg.error === true;
          if (!isTerminal && !isFailedTurn) {
            useStore.getState().updateMessage(assistantMsg.id, { retry: null });
          }
        }
      }
    };

    try {
      // Fresh per-origin reads: background drains (watchdog/queue) fire while
      // another chat is active, so closure-captured thinkingLevel/nvim would be
      // the VIEWED chat's values. Read the origin chat's own level; only attach
      // nvim context for foreground sends from the active chat.
      const originThinking =
        (useStore.getState().chats.find((c) => c.id === chat.id)
          ?.thinkingLevel ?? thinkingLevel) as typeof thinkingLevel;
      const isForeground =
        useStore.getState().activeChatId === chat.id;
      await streamChat(
        {
          provider: activeProvider,
          root: rootDir,
          mode: chat.mode,
          chatId: chat.id,
          prompt: promptWithResume,
          history,
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
            ? originThinking
            : "",
          modelReasoning:
            modelReasoning(activeProvider, activeProvider.model) ??
            supportsReasoning(
              activeProvider.model,
              activeProvider.kind,
              modelReasoning(activeProvider, activeProvider.model),
            ),
          mcpServers: effectiveMcpServers,
          skills: effectiveSkills,
          allowCreate,
          cap: getMode(s.settings, chat.mode).capabilities,
          allowOutside: s.outsideAllowed,
          allowOutsideFolders: s.outsideFolders,
          allowComputer: s.computerAllowed,
          nvimFile:
            isForeground && nvimMentioned ? nvimRel || undefined : undefined,
          nvimDiagnostics: isForeground && nvimMentioned ? nvimDiags : undefined,
          vectorDbPath: s.vectorDbPath,
          vectorConfig: {
            ttl_days: s.ragWebTtlDays,
            max_docs: 500,
            max_chunks: 4000,
          },
          subagentModels: s.subagentModels,
          providers: Object.fromEntries(
            (s.settings.providers ?? []).map((p) => [p.id, p]),
          ),
          compactAtPercent: s.settings.compactAtPercent ?? 80,
        maxSteps: s.maxSteps ?? 0,
          restart: overrides?.restart ?? false,
          signal: abort.signal,
        },
        handleEvent,
      );
    } catch (err) {
      // Preserve tool-call context on ANY abort — the user pressing Stop, the
      // stall watchdog, or a backend/stream error that THROWS. `preserveToolActivity`
      // is defined above and folded tool calls into `content`, so a manual retry
      // knows what this turn already did instead of redoing it from scratch.
      if (watchdogAborted) {
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
      lastEventAtMs = Date.now();
      stalledSinceMs = null;
      toolRunning.current = 0;
      setBusyFor(chat.id, false);
      useStore.getState().setChatCompacting(chat.id, false);
      useStore.getState().setChatPendingAsk(chat.id, null);
      useStore.getState().setChatPendingPermission(chat.id, null);
      resolveStuckCards();
      abortMapRef.current.delete(chat.id);
      useStore.getState().setChatAbort(chat.id, null);
      // Global streaming flag is only a persist gate — clear it only when NO
      // OTHER chat is still streaming. Note: this chat's own assistant message
      // still has streaming:true here (cleared below), so exclude it from the
      // check, otherwise the gate would never clear.
      {
        const st = useStore.getState();
        const otherStreaming = st.chats.some((c) =>
          c.messages.some((m) => m.streaming && m.id !== assistantMsg.id),
        );
        if (!otherStreaming) {
          st.setStreaming(false, false);
        }
      }
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
      // Persist the turn's working time on the message so it stays visible in
      // the chat footer after the live "Working" indicator unmounts.
      const turnStart = curMsg?.workingStartedAt ?? curMsg?.thinkingStartedAt;
      const turnElapsedMs =
        turnStart != null ? Math.max(0, Date.now() - turnStart) : undefined;
      useStore.getState().updateMessage(assistantMsg.id, {
        streaming: false,
        thinkingActive: false,
        workingStartedAt: undefined,
        ...(turnElapsedMs != null ? { turnElapsedMs } : {}),
        ...(keepRetry ? {} : { retry: null }),
      });
      // No auto-refresh of the credit chip here — strictly click-to-refresh
      // (see the credits block above). A turn-end fetch can land right when
      // the SSE connection is closing, and the user has seen it correlate
      // with the stream dropping.
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
  // this panel shows another chat. The wrapper PINs the chatId VALUE at
  // registration time — never read chatIdRef inside the drain, otherwise A's
  // queued turn would inject into the currently-viewed B (cross-chat leak).
  // Registered every render; NEVER deregistered on unmount.
  {
    const boundId = chatIdRef.current;
    if (boundId) {
      registerChatSend(boundId, (text, atts, imgs, allowCreate, reuseMsgId, continueAssistantId, forceScroll, overrides) =>
        void send(text, atts, imgs, allowCreate, reuseMsgId, continueAssistantId, forceScroll, overrides, boundId),
      );
    }
  }

  const compactContext = async () => {
    let s = useStore.getState();
    // Per-chat: compact the panel's own chat, not "active" at await-resume time
    // (the user may have switched while streaming). chatIdRef tracks the viewed
    // chat and is updated synchronously on switch.
    let ch = s.chats.find((c) => c.id === chatIdRef.current) ?? null;
    if (!ch) return;

    // How long the manual /compact call may run before we give up. Slow/free
    // models can take minutes to summarize a large history, so this is generous
    // — the backend streams no progress for this JSON call, and aborting early
    // just discards a compaction that would otherwise succeed (the backend keeps
    // running and logs "[compact] success"). 600s gives even a heavy summarizer
    // room; raising it further only delays the failure banner.
    const COMPACT_TIMEOUT_MS = 600_000;

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
      setBusyFor(chatId, true);
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
    ch = s.chats.find((c) => c.id === chatId) ?? null;
    if (!ch) return;
    const msgs = ch.messages.filter(
      (m) => !m.compacted && (m.role === "user" || m.role === "assistant"),
    );
    if (msgs.length === 0) {
      setBusyFor(chatId, false);
      useStore.getState().setChatCompacting(chatId, false);
      return;
    }
    const rootDir = ch.root || s.root;
    setBusyFor(ch.id, true);
    useStore.getState().setChatCompactError(ch.id, null);
    useStore.getState().setChatCompactNotice(ch.id, null);
    useStore.getState().setChatCompacting(ch.id, true);

    // Serialize the live conversation — including any prior compact summary —
    // so the backend can MERGE it into the new one (opencode keeps a running
    // summary across repeated compactions instead of starting from scratch).
    // Full fidelity: toolActivity/plan/mode/preservedToolSummary travel too,
    // so the summarizer sees WHAT tools ran (not just prose) and the next
    // turn does not re-issue them.
    const history = ch.messages
      .filter((m) => !m.compacted)
      .map((m) => ({
        role: m.role,
        content: m.content ?? "",
        thinking: m.thinking,
        plan: m.plan,
        mode: m.mode,
        toolActivity: (m.toolActivity ?? []).filter(
          (a) => a.status !== "running",
        ),
        preservedToolSummary: m.preservedToolSummary,
      }));

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
    const timeout = setTimeout(() => ctr.abort(), COMPACT_TIMEOUT_MS);
    let result: CompactResult | null = null;
    let errMsg = "";
    try {
      result = await triggerCompact({
        provider: compactProvider,
        fallback: activeProvider,
        history,
        contextWindow:
          modelContextWindow(activeProvider, activeProvider.model) ?? 0,
        compactAtPercent: useStore.getState().settings.compactAtPercent ?? 80,
        signal: ctr.signal,
      });
    } catch (err) {
      errMsg =
        (err as Error).name === "AbortError"
          ? `timed out after ${Math.round(COMPACT_TIMEOUT_MS / 1000)}s`
          : (err as Error).message;
    } finally {
      clearTimeout(timeout);
    }

    setBusyFor(ch.id, false);
    useStore.getState().setChatCompacting(ch.id, false);
    // No auto-refresh of the credit chip after compact either — see the
    // credits block above. Strictly click-to-refresh.

    // A summarizer that errored, timed out, or returned nothing is a failed
    // compact — do NOT collapse the real messages behind a fake summary. Leave
    // the chat untouched and let the user retry manually.
    if (!result || !result.summary || result.error) {
      useStore
        .getState()
        .setChatCompactError(ch.id, result?.error || errMsg || "empty summary");
      // حتی در شکست کامپکت دستی هم صف تخلیه شود تا پیام کاربر گم نشود
      setTimeout(() => {
        if (!sendPendingSteerNext(ch.id)) sendQueuedNext(ch.id);
      }, 0);
      return;
    }
    // The backend already returns opencode's "[Compacted earlier context]"
    // summary and the token-budgeted tail (`keep`) to preserve verbatim — no
    // extra wrapper, and no hardcoded keep=1.
    s.compactChat(ch.id, result.summary, result.keep);
    // Accrue the summarizer's own token usage (the backend returns it in
    // `usage`) so the session total counts the compaction too — grouped under
    // the provider that ACTUALLY ran it (provider_id > kind > chat provider).
    const cu = result.usage;
    if (cu) {
      const pid =
        cu.provider_id ||
        cu.provider ||
        compactProvider.id ||
        activeProvider.id;
      s.accrueChatUsage(ch.id, pid, cu.model || compactProvider.model, {
        input: cu.input_tokens ?? 0,
        output: cu.output_tokens ?? 0,
        cacheRead: cu.cache_read_tokens ?? 0,
        cacheWrite: cu.cache_write_tokens ?? 0,
      });
    }
    useStore
      .getState()
      .setChatCompactNotice(
        ch.id,
        "Context compacted — older messages are summarized below (after the conversation).",
      );
    // پیام‌های صف‌شده حین کامپکت دستی فقط بعد از اتمام کامپکت تحویل داده می‌شوند
    setTimeout(() => {
      if (!sendPendingSteerNext(ch.id)) sendQueuedNext(ch.id);
    }, 0);
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
      case "/create-skill":
      case "/create-mcp": {
        const target =
          word === "/create-skill" ? "skill" : "MCP connector";
        const rest = v.slice(word.length).trim();
        if (!rest) {
          s.addMessage(ch?.id ?? "", {
            role: "assistant",
            content:
              word === "/create-skill"
                ? `Usage: \`/create-skill <description>\` — describe the skill you want after the command, e.g. \`/create-skill summarize a project's git log into release notes\`.`
                : `Usage: \`/create-mcp <description>\` — describe the tool/connector you want after the command, e.g. \`/create-mcp a way to search YouTube\`.`,
          });
          return;
        }
        s.addMessage(ch?.id ?? "", {
          role: "user",
          content: v,
        });
        void send(
          target === "skill"
            ? `Create a new skill or edit an existing one from this description: "${rest}". If it names or describes an existing skill, first call load_skill to read its current instructions, then call create_skill with the SAME name to overwrite it with the updated instructions. Otherwise use the create_skill tool to set it up with a good name/slug and the instructions. Ask me only for anything essential that is genuinely missing; otherwise just create or update it. Do not modify files outside creating/editing this skill.`
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

  const retryMessage = useCallback((id: string) => {
    // If a previous turn is still mid-stream (auto-retry waiting on a provider
    // throttle, streaming reply, etc.), pressing Retry must cancel that run
    // FIRST — otherwise the "Retry" click is silently swallowed by the `busy`
    // guard below and nothing happens, even after the user changed the model.
    // Per-chat: abort THIS panel's chat only, never another chat's stream.
    const originId = chatIdRef.current;
    const active = useStore.getState().chatAborts[originId];
    if (active && !active.signal.aborted) {
      active.abort();
    }
    const s = useStore.getState();
    const ch = s.chats.find((c) => c.id === originId);
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
      // RESUME via planRetry (banner semantics): reuse the existing user bubble
      // (no duplicate) AND continue the SAME assistant bubble so toolActivity,
      // plan and preservedToolSummary stay on one message. Backend resumes from
      // its checkpoint (restart=false) instead of redoing completed tools.
      const plan = planRetry(ch.messages, userMsg.id, 'banner');
      const continueId = plan?.target.continueAssistantId ?? failed.id;
      const targetId = ch.id;
      setTimeout(
        () =>
          send(
            userMsg.content,
            userMsg.attachments ?? [],
            userMsg.images ?? [],
            false,
            userMsg.id,
            continueId,
            false,
            undefined,
            targetId,
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
    {
      const targetId = ch.id;
      const atts = userMsg.attachments ?? [];
      const imgs = userMsg.images ?? [];
      setTimeout(
        () => send(text, atts, imgs, false, undefined, undefined, false, undefined, targetId),
        0,
      );
    }
  }, [send]);

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
      // would swallow the re-send. Per-chat: only this panel's chat.
      const originId = chatIdRef.current;
      const active = useStore.getState().chatAborts[originId];
      if (active && !active.signal.aborted) {
        active.abort();
      }
      const s = useStore.getState();
      const ch = s.chats.find((c) => c.id === originId);
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
      // finally would otherwise clear it mid-run). Pin origin chat.
      // restart=true clears the backend checkpoint so old tool work is NOT replayed.
      {
        const targetId = ch.id;
        const atts = userMsg.attachments ?? [];
        const imgs = userMsg.images ?? [];
        setTimeout(
          () => send(text, atts, imgs, false, undefined, undefined, false, { restart: true }, targetId),
          0,
        );
      }
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
    const typed = input.trim();
    if (!typed && pastedBlocks.length === 0 && images.length === 0) return;
    if (typed.startsWith("/")) {
      // Slash commands act on the typed text only; pasted cards stay pinned to
      // the composer for the next real message.
      setInput("");
      setCmdOpen(null);
      void handleCommand(typed);
      return;
    }
    const v = composePrompt(typed).trim();
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
    setAttachments([]);
    setImages([]);
    const selectedMcpServers: Record<string, McpServerConfig> = (() => {
      const all = ss.settings.mcpServers ?? {};
      const enabled = ss.settings.mcpEnabled ?? [];
      const sel: Record<string, McpServerConfig> = {};
      for (const n of enabled) if (all[n]) sel[n] = all[n];
      return sel;
    })();
    const selectedSkills: string[] = Array.from(
      extractMentionSkills(v, getSkillsList()).skills,
    );
    // اگر کامپکت در جریان است پیام باید صف شود نه steer مستقیم
    if (chatObj.compacting) {
      ss.queueMessage(chatObj.id, {
        id: uid2(),
        text: v,
        attachments: atts,
        images: imgs,
        mcpServers: selectedMcpServers,
        skills: selectedSkills,
        kind: "queue",
      });
      setInput("");
      setPastedBlocks([]);
      setCmdOpen(null);
      forceScrollToBottom();
      return;
    }
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
        mcpServers: selectedMcpServers,
        skills: selectedSkills,
        steerPending: true,
      });
      setInput("");
      setPastedBlocks([]);
      setCmdOpen(null);
      forceScrollToBottom();
      void steerChat(chatObj.id, userMsg.id, v, atts, imgs, {
        mcpServers: selectedMcpServers,
        skills: selectedSkills,
      });
      return;
    }
    setInput("");
    setPastedBlocks([]);
    setCmdOpen(null);
    void send(v, atts, imgs, false, undefined, undefined, true);
  };

  const queueForLater = () => {
    const typed = input.trim();
    if (!typed && pastedBlocks.length === 0 && images.length === 0) return;
    const v = composePrompt(typed).trim();
    const ss = useStore.getState();
    const chatObj = ss.chats.find((c) => c.id === chatIdRef.current);
    if (!chatObj) return;
    const atts = attachments;
    const imgs = images;
    const all = ss.settings.mcpServers ?? {};
    const enabled = ss.settings.mcpEnabled ?? [];
    const sel: Record<string, McpServerConfig> = {};
    for (const n of enabled) if (all[n]) sel[n] = all[n];
    ss.queueMessage(chatObj.id, {
      id: uid2(),
      text: v,
      attachments: atts,
      images: imgs,
      mcpServers: sel,
      skills: Array.from(extractMentionSkills(v, getSkillsList()).skills),
      kind: "queue",
    });
    forceScrollToBottom();
    setInput("");
    setPastedBlocks([]);
    setAttachments([]);
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

  // Long pastes never enter the textarea: they become a collapsed card above
  // the input and are joined back into the prompt on send. Short pastes keep
  // the native inline behavior; clipboard files fall through to the default
  // handler.
  const onComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if ((e.clipboardData.files?.length ?? 0) > 0) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text || !isCollapsibleText(text)) return;
    e.preventDefault();
    setPastedBlocks((blocks) => [
      ...blocks,
      { id: uid2(), text: text.replace(/^\n+|\n+$/g, ""), createdAt: Date.now() },
    ]);
  };

  /** Pasted cards + typed input become one prompt: cards first (they sit above
   *  the input in the composer), then what the user typed. */
  const composePrompt = (typed: string): string => {
    const pasted = pastedBlocks.map((b) => b.text).join("\n\n");
    if (pasted && typed) return `${pasted}\n\n${typed}`;
    return typed || pasted;
  };

  // "Edit" on a paste card: fold the text back into the textarea (append after
  // what's already typed) and drop the card.
  const editPastedBlock = (id: string) => {
    const block = pastedBlocks.find((b) => b.id === id);
    if (!block) return;
    setPastedBlocks((blocks) => blocks.filter((b) => b.id !== id));
    setInput((prev) => (prev ? `${prev}\n${block.text}` : block.text));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    });
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

  // Resolve STT provider config + language for the current input.
  const resolveStt = () => {
    const lang =
      dir === "rtl" || /[\u0600-\u06FF]/.test(input) ? "fa" : undefined;
    const sttCfg =
      sttProviderId === "local"
        ? undefined
        : settings.providers.find((p) => p.id === sttProviderId);
    const opts = sttCfg
      ? {
          kind: sttCfg.kind,
          baseUrl: sttCfg.baseUrl ?? "",
          apiKeys: [...(sttCfg.apiKeys ?? (sttCfg.apiKey ? [sttCfg.apiKey] : []))],
          model: sttModel,
        }
      : undefined;
    return { lang, opts };
  };

  const startRecording = async () => {
    if (recording || transcribing) return;
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
        if (e.data.size > 0) {
          mediaChunksRef.current.push(e.data);
        }
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
          const { lang, opts } = resolveStt();
          console.debug("[voice] transcribing", {
            mime: blob.type,
            bytes: blob.size,
            lang,
          });
          const text = await transcribeAudio(blob, setTranscribing, lang, opts);
          const finalText = (text ?? "").trim();
          if (finalText) {
            setInput((prev) => (prev ? prev.trimEnd() + " " + finalText : finalText));
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
  useEffect(() => {
    setSkillsFetcher(listSkills);
  }, []);

  // Load the skill list up-front (once) so manual @mentions typed/pasted
  // before the picker ever opens — or sent before the async fetch resolves —
  // are still matched. The cache is module-level (src/lib/skills), so this runs
  // at most once across remounts.
  useEffect(() => {
    if (getSkillsList().length === 0) void ensureSkills();
  }, [ensureSkills]);

  // Keep the keyboard-highlighted skill row visible: Ctrl+J/K (and arrow
  // keys) move `skillMentionIdx` but the popup scrolls independently
  // (max-height + overflow-y: auto), so without this the highlight can
  // move past the visible 300px and look like nothing is happening.
  useEffect(() => {
    if (!skillMention) return;
    const row = skillMentionPopupRef.current?.querySelector<HTMLElement>(
      ".mention-item.kbd",
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [skillMention, skillMentionIdx]);

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
    // پالت فرمان (/): کوردهای ناوبری حتی وقتی هیچ موردی match نشده بلعیده
    // می‌شوند تا رویداد به شورتکات‌های سراسری (Ctrl+K سرچ سایدبار و…) نریزد.
    if (cmdOpen) {
      const d = navChord(e);
      if (d !== 0) {
        e.preventDefault();
        e.stopPropagation();
        if (filteredCmds.length > 0)
          setCmdIndex(
            (i) => (i + d + filteredCmds.length) % filteredCmds.length,
          );
        return;
      }
      if (filteredCmds.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
        e.preventDefault();
        e.stopPropagation();
        acceptCmd(filteredCmds[cmdIndex].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setCmdOpen(null);
        return;
      }
    }
    // پیکر @mention اسکیل: همان بلعیدن — رگرسیون Ctrl+K که رویدادش تا window
    // حباب می‌کرد و هندلر سایدبار فوکوس را به سرچ چت می‌دزدید.
    if (skillMention) {
      const d = navChord(e);
      if (d !== 0) {
        e.preventDefault();
        e.stopPropagation();
        if (filteredSkills.length > 0)
          setSkillMentionIdx(
            (i) => (i + d + filteredSkills.length) % filteredSkills.length,
          );
        return;
      }
      if (filteredSkills.length > 0 && (e.key === "Tab" || e.key === "Enter")) {
        e.preventDefault();
        e.stopPropagation();
        acceptSkillMention(filteredSkills[skillMentionIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSkillMention(null);
        return;
      }
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
      if (busy || compacting) queueForLater();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const stop = () => {
    // Per-chat stop: only THIS viewed chat is affected. Aborting another chat's
    // controller here was the cross-chat kill (Stop in B ended A's stream).
    const originId = chatIdRef.current;
    stoppedMapRef.current.set(originId, true);
    useStore.getState().setChatPendingAsk(originId, null);
    useStore.getState().setChatPendingPermission(originId, null);
    // Clear any retry banner immediately. The banner's visibility
    // (`effectiveRetry = retryingMsg?.retry ?? ...`) depends ONLY on
    // `message.retry`, not on `busy` — so without this, a live "Provider
    // hiccup / retry in Xs" banner keeps showing (frozen once its local
    // countdown hits 0 → "retrying…") after Stop, even though busy already
    // flipped false and the Stop button itself reverted to Send. The async
    // finally in send() will eventually clear it once streamChat's promise
    // rejects, but that's not instant — clear it eagerly here so the banner
    // disappears the moment Stop is clicked, same as dismissRetry does.
    const msgs = chat?.messages ?? [];
    const target =
      retryingMsg ?? [...msgs].reverse().find((m) => m.role === "assistant");
    if (target?.retry) {
      useStore.getState().updateMessage(target.id, { retry: null });
    }
    // Abort ONLY this chat's controller (per-chat mirror + store-level
    // authoritative one). Never touch the legacy shared ref — it points at
    // whichever chat sent last, so aborting it kills the WRONG chat.
    try {
      abortMapRef.current.get(originId)?.abort();
    } catch {
      /* already aborted */
    }
    try {
      const ctrl = useStore.getState().chatAborts?.[originId];
      if (ctrl && !ctrl.signal.aborted) ctrl.abort();
    } catch {
      /* already aborted */
    }
    // Force-clear THIS chat's busy so its Stop button vanishes immediately.
    // Normally the send() finally block handles this, but if abort was
    // already null (e.g. reconnect race) the finally block never ran, leaving
    // busy stuck as true and the Stop button permanently visible. Do NOT touch
    // other chats' busy flags, and only clear the global streaming gate when
    // no chat is still streaming.
    setBusyFor(originId, false);
    // Only clear the global gate when no OTHER chat is still streaming —
    // this chat's own streaming flag is still true here (cleared by send's
    // finally after abort propagates), so exclude this chat from the check.
    {
      const st = useStore.getState();
      const otherStreaming = st.chats.some(
        (c) => c.id !== originId && c.messages.some((m) => m.streaming),
      );
      if (!otherStreaming) {
        st.setStreaming(false, false);
      }
    }
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

  const toolbar = (
    <div className="chat-toolbar titlebar-toolbar">
      <button
        className="titlebar-icon-btn dir-text-btn"
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
        className={`badge context-meter${contextWarn(contextUsed, usable) ? " warn" : ""}`}
        title={
          ctxWindow != null
            ? `Context used: real tokens of the last completed reply, relative to the model's raw ${formatTokens(ctxWindow)} window (like opencode — no headroom subtracted). The meter turns yellow exactly when usage reaches the auto-compaction threshold (${formatTokens(usable ?? 0)} tokens = ${compactAtPercent}% of the window) — the same point where auto-compaction fires.`
            : "Context used: real tokens of the last completed reply, relative to the raw model window (like opencode — no headroom subtracted)."
        }
        dir="ltr"
      >
        {ctxPct !== null && contextUsed > 0 && (() => {
          const clamped = Math.min(100, Math.max(0, ctxPct)) / 100;
          const radius = 6;
          const circumference = 2 * Math.PI * radius;
          return (
            <span className="context-meter-ring" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="16" height="16">
                <circle
                  cx="8"
                  cy="8"
                  r={radius}
                  className="context-meter-ring-track"
                />
                <circle
                  cx="8"
                  cy="8"
                  r={radius}
                  className="context-meter-ring-fill"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - clamped)}
                />
              </svg>
            </span>
          );
        })()}
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
      <BalanceChip
        providerName={
          shownBal
            ? shownBal.provider.name || shownBal.provider.id
            : provider
              ? provider.name || provider.id
              : null
        }
        amount={shownBal ? shownBal.amount : null}
        busy={creditBusy}
        disabled={!provider || creditBusy}
        onRefresh={refreshCredits}
      />
    </div>
  );

  return (
    <div className="chat-panel">
      {titlebarEl ? createPortal(toolbar, titlebarEl) : toolbar}
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={onChatScroll}
        onWheel={() => {
          jumpScrollingRef.current = false;
        }}
        onTouchStart={() => {
          jumpScrollingRef.current = false;
        }}
      >
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
          {(() => {
            const visible = visibleChatMessages(chat.messages);
            return (
              <>
                {msgLimit < visible.length && (
                  <div className="load-older-row">
                    <button
                      className="load-older-btn"
                      onClick={() => {
                        prependAnchorRef.current =
                          scrollRef.current?.scrollHeight ?? null;
                        setMsgLimit((n) =>
                          Math.min(visible.length, n + MSG_PAGE),
                        );
                      }}
                    >
                      Load {Math.min(MSG_PAGE, visible.length - msgLimit)}{" "}
                      earlier message
                      {visible.length - msgLimit === 1 ? "" : "s"}…
                    </button>
                  </div>
                )}
                {visible
                  .slice(Math.max(0, visible.length - msgLimit))
                  .map((m: ChatMessage) => (
                    <Fragment key={m.id}>
                      <ChatMessageView message={m} onRetry={onRetry} />
                      {/* Newer messages render tool cards inline via `segments`; only
                        older persisted messages without segments keep the stacked
                        timeline below the bubble. */}
                      {!m.segments &&
                        m.toolActivity &&
                        m.toolActivity.length > 0 && (
                          <div className="tool-timeline">
                            {m.toolActivity.map((act, i) => (
                              <ToolCallView
                                key={i}
                                activity={act}
                                chatId={chat.id}
                                onReverted={() =>
                                  useStore.getState().markToolReverted(m.id, i)
                                }
                              />
                            ))}
                          </div>
                        )}
                    </Fragment>
                  ))}
              </>
            );
          })()}
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
                  <QueuedCollapsibleText id={q.id} text={q.text} />
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
                    <MessageImages images={q.images} />
                  )}
                  {((q.skills && q.skills.length > 0) ||
                    (q.mcpServers && Object.keys(q.mcpServers).length > 0)) && (
                    <div className="msg-attachments" dir="ltr">
                      {(q.skills ?? []).map((sk) => (
                        <span className="attachment-chip" key={`skill-${sk}`}>
                          @{sk}
                        </span>
                      ))}
                      {Object.keys(q.mcpServers ?? {}).map((n) => (
                        <span className="attachment-chip" key={`mcp-${n}`}>
                          MCP {n}
                        </span>
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
                startedAt={effectiveRetry.startedAt}
                onRetry={() => {
                  // Resume-only (banner semantics via planRetry): re-send the last
                  // user turn WITHOUT deleting anything, reusing the user bubble
                  // and continuing the failed assistant bubble so completed tools,
                  // plan and preservedToolSummary are kept. Never falls through
                  // to truncate-and-restart.
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
                    const plan = planRetry(msgs, userMsg.id, 'banner');
                    send(
                      userMsg.content,
                      userMsg.attachments ?? [],
                      userMsg.images ?? [],
                      false,
                      userMsg.id,
                      plan?.target.continueAssistantId ?? retryingMsg?.id,
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
            skillNotice ||
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
                {skillNotice && (
                  <div className="notice-banner notice-error" dir="ltr">
                    <span className="notice-icon">⚠</span>
                    <span className="notice-text">{skillNotice}</span>
                    <button
                      type="button"
                      className="notice-dismiss"
                      onClick={() =>
                        useStore.getState().setChatSkillNotice(chat.id, null)
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
        </div>

      <div
        ref={composerRef}
        className={`composer${dragOver ? " dragover" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {showJump && (
          <button
            type="button"
            className="scroll-jump"
            title="Scroll to bottom"
            onClick={() => {
              const el = scrollRef.current;
              if (!el) return;
              // The user explicitly asked for the bottom: drop any in-progress
              // viewport restore so it can't fight the jump, then smooth-scroll.
              restoreTargetRef.current = null;
              stickToBottom.current = true;
              jumpScrollingRef.current = true;
              setShowJump(false);
              programmaticScrollRef.current = true;
              el.scrollTo({
                top: el.scrollHeight,
                behavior: "smooth",
              });
              requestAnimationFrame(() => {
                programmaticScrollRef.current = false;
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
        {askReq &&
          askReq.style === "plan_approval" &&
          (() => {
            const options = askReq.options;
            const sel = Math.min(planApprovalSel, Math.max(0, options.length - 1));
            const clearReq = () =>
              useStore.getState().setChatPendingAsk(chatIdRef.current, null);
            // Option 0 is the Approve option (backend guarantees the order);
            // its answer is the sentinel, never the visible label.
            const answerOption = (i: number) => {
              void respondAsk(
                askReq.id,
                i === 0 ? PLAN_APPROVE_TOKEN : (options[i] ?? ""),
              );
              clearReq();
            };
            const submitFreeText = () => {
              if (!askFreeText.trim()) return;
              void respondAsk(askReq.id, askFreeText.trim());
              clearReq();
            };
            const splitOption = (opt: string) => {
              const dash = opt.indexOf("—");
              if (dash === -1) return [opt, ""];
              return [opt.slice(0, dash).trim(), opt.slice(dash + 1).trim()];
            };
            return (
              <div
                className="ask-card plan-approval"
                dir="ltr"
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setPlanApprovalSel((cur) => {
                      const n = options.length;
                      if (n <= 1) return 0;
                      return e.key === "ArrowDown" ? (cur + 1) % n : (cur - 1 + n) % n;
                    });
                  } else if (e.key === "Enter" || e.key === " ") {
                    const t = e.target as HTMLElement;
                    if (t.tagName === "TEXTAREA" || t.tagName === "BUTTON") return;
                    if (options[sel]) {
                      e.preventDefault();
                      answerOption(sel);
                    }
                  }
                }}
              >
                <div className="ask-card-head plan-approval-head">
                  <span className="ask-card-icon plan-approval-icon">
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
                  <span className="ask-card-title">Implementation plan</span>
                  <span className="plan-approval-chip">Permission required</span>
                </div>
                <div className="plan-approval-options">
                  {options.map((opt, i) => {
                    const [head, desc] = splitOption(opt);
                    return (
                      <button
                        key={i}
                        type="button"
                        autoFocus={i === 0}
                        className={`plan-approval-option${i === sel ? " selected" : ""}`}
                        onClick={() => answerOption(i)}
                      >
                        <span className="plan-approval-num" dir="ltr">{i + 1}</span>
                        <span className="plan-approval-opt-text" dir="auto">
                          <span className="plan-approval-opt-head">{head}</span>
                          {desc ? (
                            <span className="plan-approval-opt-desc">
                              {desc.charAt(0).toUpperCase() + desc.slice(1)}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="plan-approval-freetext">
                  <textarea
                    className="ask-input"
                    rows={2}
                    dir="auto"
                    value={askFreeText}
                    placeholder="Enter your answer…"
                    onChange={(e) => setAskFreeText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && askFreeText.trim()) {
                        e.preventDefault();
                        submitFreeText();
                      }
                    }}
                  />
                </div>
                <div className="plan-approval-footer">
                  <span className="plan-approval-hint">
                    Tab / ↑↓ to choose · Enter to select
                  </span>
                  <span className="plan-approval-actions">
                  <button
                    type="button"
                    className="btn plan-approval-dismiss"
                    onClick={() => {
                      void respondAsk(askReq.id, PLAN_DISMISS_TOKEN);
                      clearReq();
                    }}
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    className="btn ask-send plan-approval-submit"
                    disabled={!askFreeText.trim() && !options[sel]}
                    onClick={() => {
                      if (askFreeText.trim()) submitFreeText();
                      else if (options[sel]) answerOption(sel);
                    }}
                  >
                    Submit
                  </button>
                  </span>
                </div>
              </div>
            );
          })()}
        {askReq &&
          askReq.style !== "plan_approval" &&
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
            const isComputer = permissionReq.scope === "computer";
            const title = isConfirm
              ? fa
                ? "تأیید عملیات"
                : "Confirm action"
              : isComputer
                ? fa
                  ? "کنترل اپ‌های دسکتاپ"
                  : "Desktop app control"
                : fa
                  ? "دسترسی بیرون از ورکاسپیس"
                  : "Outside workspace access";
            const note = isConfirm
              ? fa
                ? "عامل این عملیات را مهم یا غیرقابل بازگشت می‌داند و منتظر شماست."
                : "The agent flagged this as important or hard to undo, and is waiting for you."
              : isComputer
                ? fa
                  ? "این به عامل اجازه می‌دهد اپ‌های دیگر را از طریق Accessibility Tree ببیند و کنترل کند."
                  : "This lets the agent see and control other apps via the Accessibility Tree."
                : fa
                  ? "این به عامل اجازه می‌دهد بیرون از ورکاسپیس فعلی شما کار کند."
                  : "This lets the agent work outside your current workspace.";
            const folderNote =
              !isConfirm && !isComputer && permissionReq.folder
                ? fa
                  ? "اجازه فقط برای همین پوشه و زیرپوشه‌هایش ثبت می‌شود؛ سایر مسیرهای بیرون از ورک‌اسپیس همچنان مجوز جداگانه می‌خواهند."
                  : "The grant applies only to this folder and its subfolders; other outside-workspace paths still need a fresh permission."
                : null;
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
                {folderNote ? <div className="perm-note">{folderNote}</div> : null}
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
                          // scope-aware: "Always allow" persists the grant matching
                          // the dialog's scope — computer vs outside-workspace.
                          if (permissionReq.scope === "computer") {
                            useStore.getState().setComputerAllowed(true);
                          } else if (permissionReq.folder) {
                            // Per-folder grant: only the requested folder's
                            // subtree stays approved for the session — NOT the
                            // whole outside-workspace space. The folder is
                            // backend-normalized (nearest existing parent).
                            useStore
                              .getState()
                              .addOutsideFolder(permissionReq.folder);
                          } else {
                            useStore.getState().setOutsideAllowed(true);
                          }
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
        <ComposerDiffBar root={wroot} />
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
              <div className="mention-popup" dir="ltr" ref={skillMentionPopupRef}>
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
                    No skills — create one with /create-skill or in Settings → Skills
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
                    const d = navChord(e);
                    if (d !== 0) {
                      e.preventDefault();
                      e.stopPropagation();
                      move(d);
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
                {Object.keys(mcpConnectors).length > 0 &&
                  filteredMcp.length === 0 && (
                    <div className="mention-empty">
                      No connectors match “{skillQuery.trim()}”
                    </div>
                  )}
                {filteredMcp.length > 0 && (
                  <div className="mcp-grid">
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
              </div>
            )}
            {pastedBlocks.length > 0 && (
              <div className="paste-cards">
                {pastedBlocks.map((b) => {
                  const fa = detectDir(b.text) === "rtl";
                  return (
                    <div
                      className="paste-card"
                      key={b.id}
                      dir={fa ? "rtl" : "ltr"}
                    >
                      <button
                        className="chip-x paste-card-x"
                        onClick={() =>
                          setPastedBlocks((blocks) =>
                            blocks.filter((x) => x.id !== b.id),
                          )
                        }
                        title="Remove pasted text"
                      >
                        ×
                      </button>
                      <div className="paste-card-preview">
                        <span className="paste-card-time">
                          [{fmtClock(b.createdAt)}]
                        </span>{" "}
                        {b.text}
                      </div>
                      <div className="paste-card-foot">
                        <span className="paste-card-badge">Pasted</span>
                        <button
                          className="paste-card-edit"
                          onClick={() => editPastedBlock(b.id)}
                          title="Edit pasted text"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  );
                })}
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
            <div className="composer-input-row">
              <textarea
                className="composer-input"
                rows={1}
                dir={dir}
                style={{
                  direction: dir,
                  textAlign: dir === "rtl" ? "right" : "left",
                }}
                placeholder={
                  wroot ? "Write a message…" : "Open a project folder first (⌘O)…"
                }
                ref={textareaRef}
                value={input}
                onChange={onInputChange}
                onKeyDown={onKeyDown}
                onPaste={onComposerPaste}
              />
              <div className="composer-bottom-row">
                <div className="composer-left-actions">
                  <button
                    className="icon-btn plus-btn"
                    onClick={attachFile}
                    title="Attach files or images"
                    aria-label="Attach"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 8v8M8 12h8" />
                    </svg>
                  </button>
                  <button
                    className="icon-btn attach-btn"
                    onClick={captureRegion}
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
                    className={`icon-btn attach-btn mic-btn ${recording ? "recording" : ""} ${transcribing ? "transcribing" : ""}`}
                    onClick={toggleRecording}
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
                    className={`icon-btn attach-btn${mcpEnabled.length > 0 ? " has-chips" : ""}`}
                    onClick={() => void openSkillPicker()}
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
                      <path d="M9 2v6" />
                      <path d="M15 2v6" />
                      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
                      <path d="M12 17v5" />
                    </svg>
                    {mcpEnabled.length > 0 && (
                      <span className="attach-count">{mcpEnabled.length}</span>
                    )}
                  </button>
                </div>
                {busy ? (
                  <button
                    className="send-circle-btn stop-btn"
                    onClick={stop}
                    title="Stop"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  </button>
                ) : (
                  <button
                    className="send-circle-btn"
                    disabled={
                      !input.trim() &&
                      pastedBlocks.length === 0 &&
                      images.length === 0
                    }
                    onClick={submit}
                    title="Send"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M19 7v4a2 2 0 01-2 2H5" />
                      <polyline points="9 17 5 13 9 9" />
                      <line x1="5" y1="13" x2="14" y2="13" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="composer-footer">
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
          <span className="composer-footer-right">
            <span className="composer-mode">
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
                      title={`Reasoning effort for this message — now: ${THINKING_LABELS[thinkingLevel] ?? (thinkingLevel ? thinkingLevel.toUpperCase() : "Medium")}`}
                      aria-label="Reasoning effort for this message"
                      aria-expanded={thinkingOpen}
                    >
                      <span className="thinking-label">
                        {THINKING_LABELS[thinkingLevel] ?? (thinkingLevel ? thinkingLevel.toUpperCase() : "Medium")}
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
            </span>
            <ProviderModelSelect />
          </span>
        </div>
      </div>
    </div>
  );
}
