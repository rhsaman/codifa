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
import { getActiveProvider, getChatProvider, lspStatusFromEvent, providerApiKeys, sanitizeImageDataUrl, useStore } from "../lib/store";
import { api } from "../lib/fs";
import { AutoRetryScheduler, resetStreamForRetry, isKeepTextRetry, planRetry, resolveRestartUser, shouldIgnoreLateRetryEvent } from "../lib/retry";
import {
  isSlashCommand,
  parseSlashInput,
  prettySlashLabel,
  slashTokenRange,
  loadHistory,
  recordHistory,
  loadPins,
  togglePin,
  historyRows,
  historyTitle,
  historyMeta,
  loadCommandUsage,
  recordCommandUsage,
  bottomAnchoredByUsage,
} from "../lib/slash";
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
  shouldRecoverContentStall,
  shouldShowWaitingForModel,
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
  buildContextBreakdown,
  isContextPopoverOpen,
  formatBreakdownPercent,
  contextBarSegmentPercent,
  CONTEXT_BREAKDOWN_COLORS,
} from "../lib/context";
import {
  steerChat,
  streamChat,
  fetchCredits,
  preloadLocalModel,
  transcribeAudio,
  respondPermission,
  respondAsk,
  listSkills,
  fetchSystemPrompts,
  listMcp,
  triggerCompact,
  gitAutoCommit,
  gitDiscard,
  gitPush,
  type CompactResult,
  type CompactUsage,
  type StreamParams,
} from "../lib/api";
import { playAlarm } from "../lib/alarm";

import type { SkillRow, TranscribeProviderOpts } from "../lib/api";
import { supportsReasoning } from "../lib/thinking";
import { allModes, getMode } from "../lib/modes";
import {
  extractMentionSkills,
  getSkillsList,
  ensureSkillsList,
  invalidateSkillsList,
  setSkillsFetcher,
  loadSkillUsage,
  recordSkillUsage,
} from "../lib/skills";
import { detectDir, prepareContent } from "../lib/bidi";
import {
  registerChatSend,
  sendPendingSteerNext,
  sendQueuedNext,
  uid2,
} from "../lib/chatSends";
import { composerScrollPadding, jumpVisibleThreshold } from "../lib/scrollPadding";
import { combineQuoteAndInput, formatChatQuote, isQuotableSelection } from "../lib/chatQuote";
import {
  compactInputWidth,
  composerHeight,
  shouldExpandComposer,
} from "../lib/composerLayout";
import { fmtClock } from "../lib/time";
import { buildResumeNote } from "../lib/resumeNote";
import {
  isAtBottom,
  distanceFromBottom,
  classifyScrollEvent,
  atBottomScrollPos,
  scrollPosForFlush,
  messageFingerprint,
  shouldLandOnLatest,
  scrollMatchesPin,
  scrollPopupRowIntoView,
} from "../lib/scroll";
import { sliceWindow, MSG_WINDOW_MIN_KEEP, windowBudget } from "../lib/messageWindow";
import { RENDER_CAP, PASTE_MAX, fmtSize } from "../lib/renderCap";
import {
  GLOBAL_SHORTCUTS,
  PREFIX_LABEL,
  PREFIX_SHORTCUTS,
  formatGlobalShortcut,
  formatShortcut,
  navChord,
} from "../lib/shortcuts";
import { shouldHandleForChat } from "../lib/chatWindowMeta";
import type {
  AgentMode,
  ChatMessage,
  McpServerConfig,
  MessageSegment,
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
  editQueuedText,
  isCollapsibleText,
} from "./ChatMessage";
import { MessageImages } from "./MessageImages";
import { FileIcon, openWorkspaceFile } from "./FileIcon";
import { ModeIcon } from "./ModeIcon";
import { ModeSelect } from "./ModeSelect";
import { ProviderModelSelect } from "./ProviderModelSelect";
import { ToolCallView } from "./ToolCallView";
import { BalanceChip } from "./BalanceChip";
import { ComposerDiffBar } from "./ComposerDiffBar";
import { visibleChatMessages } from "../lib/compactDedupe";
import { isFileDrag } from "../lib/fileDrag";
import { useViewerTabs } from "../lib/viewerTabs";

// Sentinels the plan-approval card sends as the ask answer — must match
// graph.py's PLAN_APPROVE_TOKEN / PLAN_DISMISS_TOKEN. The visible option label
// is never sent, so localization can't break the protocol; free text goes
// through verbatim as planner revision feedback.
import { LocalLiveSession, sanitizeLocalTranscript } from "../lib/localLive";
import { isHtmlTranscriptJunk } from "../lib/realtimeLive";
import { playTts, playTtsStream, stopTts, speakableMessageText } from "../lib/tts";
import type { LiveVoiceState } from "../types";
const LIVE_TTS_OWNER = 9007199;
const PLAN_APPROVE_TOKEN = "__plan_approve__";
const PLAN_DISMISS_TOKEN = "__plan_dismiss__";

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
  { name: "plan", hint: "Switch this chat to Plan mode (describe the work after the command to plan it)" },
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
  { name: "goal", hint: "Set a persistent goal (e.g. /goal all tests pass); /goal clear clears it" },
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

/** Drop corrupt image data URLs before send (truncated snapshots, bad base64).
 *  Keeps path-only entries and the text; warns for each dropped image. */
function cleanImagesForSend<T extends { path: string; name?: string; dataUrl?: string }>(imgs: T[]): T[] {
  const out: T[] = [];
  for (const img of imgs ?? []) {
    if (!img) continue;
    if (!img.dataUrl) {
      out.push(img);
      continue;
    }
    const clean = sanitizeImageDataUrl(img.dataUrl);
    if (clean) {
      out.push(clean === img.dataUrl ? img : { ...img, dataUrl: clean });
    } else {
      console.warn("[chat] dropping corrupt image data URL (not sent):", img.path);
    }
  }
  return out;
}

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

/** Fixed width of the context-breakdown popover (also used to clamp its
 *  horizontal anchor so it never overflows the viewport). */
const CTX_POPOVER_WIDTH = 300;

/** Client-side mirror of the server's GOAL_MAX_EXTRA_TURNS (backend/goals.py).
 *  The server is authoritative; this just avoids firing one wasted turn on a
 *  stale [GOAL CONTINUES] marker. Keep in sync with the backend value. */
const MAX_GOAL_TURNS = 15;

/** Reason text after a backend goal marker, e.g. "[GOAL CONTINUES] <reason>".
 *  Fed into the next loop prompt as guidance (Claude-style). Capped so a
 *  verbose judge cannot bloat the prompt. */
function goalReasonAfter(content: string, marker: string): string {
  try {
    const idx = (content ?? "").indexOf(marker);
    if (idx === -1) return "";
    const tail = (content ?? "").slice(idx + marker.length).trim();
    if (!tail) return "";
    const line = tail.split("\n")[0].trim();
    return line.slice(0, 300);
  } catch {
    return "";
  }
}

/** Circular context-usage indicator rendered in the composer next to Send. */
function ContextRing({ pct }: { pct: number | null }) {
  if (pct === null)
    return <span className="ctx-ring-empty" aria-hidden="true" />;
  const rounded = Math.min(100, Math.max(0, Math.round(pct)));
  const clamped = rounded / 100;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="context-meter-ring" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="24" height="24" aria-hidden="true">
        <circle cx="8" cy="8" r={radius} className="context-meter-ring-track" />
        <circle
          cx="8"
          cy="8"
          r={radius}
          className="context-meter-ring-fill"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
        />
      </svg>
      <span
        className={`context-meter-ring-label${rounded >= 100 ? " triple" : ""}`}
      >
        {rounded}
      </span>
    </span>
  );
}

export function ChatPanel(props?: { chatId?: string; dimmed?: boolean }) {
  // Multi-window: each stacked window mounts its own ChatPanel with an
  // explicit chatId. Single-window callers omit it and follow the focused
  // (active) chat. Each instance owns its scroll/draft/msgLimit state, so
  // two visible windows keep independent viewports and composers.
  // Focus subscription without re-render storms: explicit multi-window panels
  // select a constant id plus an isActive boolean, so a focus hop only
  // re-renders the two affected panels instead of every mounted transcript.
  // Single-window callers omit chatId and follow the focused chat as before.
  const activeChatId = useStore((s) => (props?.chatId ? props.chatId : s.activeChatId));
  const isActive = useStore((s) => (props?.chatId ? s.activeChatId === props.chatId : true));
  const dimmed = props?.dimmed ?? false;
  const chat = useStore((s) => {
    const id = props?.chatId ?? s.activeChatId;
    for (const c of s.chats) if (c.id === id) return c;
    return null;
  });
  const provider = useStore((s) => {
    // Per-chat provider override: a chat that picked its own provider/model in
    // the composer runs on that, falling back to the global active provider.
    // Read the override id without subscribing to the whole chats array: only
    // the override + provider list participate in the result.
    const targetId = props?.chatId ?? s.activeChatId;
    let overrideId: string | undefined;
    for (const c of s.chats) {
      if (c.id === targetId) {
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
  const settings = useStore((s) => s.settings);
  const modes = useMemo(() => allModes(settings), [settings]);
  const wroot = chat?.root || root;
  const userSystemPrompt = useStore((s) =>
    chat ? (s.settings.systemPrompts?.[chat.mode] ?? "") : "",
  );
  // The REAL system prompt sent this turn: the user's per-mode override when
  // set, otherwise the backend's built-in prompt for this mode (fetched once).
  // The context popover must show what is actually sent, not just the override.
  const [builtinPrompts, setBuiltinPrompts] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    let alive = true;
    void fetchSystemPrompts().then((p) => {
      if (alive) setBuiltinPrompts(p);
    });
    return () => {
      alive = false;
    };
  }, []);
  const systemPrompt =
    userSystemPrompt || builtinPrompts[chat?.mode ?? ""] || "";

  // The panel now stays mounted across chat switches (no key={activeChatId}),
  // so per-chat UI state must reset explicitly when the active chat changes.
  const [input, setInput] = useState(() => {
    const v = chat?.draft?.input ?? "";
    // Never restore a polluted draft: Next.js/gateway error pages belong in the banner, never in the input.
    // Narrow to error-page signatures so legitimate code pastes are preserved.
    const isErrorPage =
      v.includes('/_next/') ||
      v.includes('&lt;') ||
      /preload|fetchpriority/i.test(v) ||
      /<!doctype/i.test(v) ||
      (/<link/i.test(v) && /href\s*=|src\s*=|rel\s*=/i.test(v));
    return isErrorPage ? "" : v;
  });
  // Safety net: if a Next.js/gateway error page ever reaches the composer
  // (e.g. a stale draft saved before filters existed), strip the junk and
  // keep the clean text. Errors belong in the banner, never in the input.
  // Narrow to error-page signatures so legitimate code pastes are preserved.
  useEffect(() => {
    const isErrorPage =
      input.includes('/_next/') ||
      input.includes('&lt;') ||
      /preload|fetchpriority/i.test(input) ||
      /<!doctype/i.test(input) ||
      (/<link/i.test(input) && /href\s*=|src\s*=|rel\s*=/i.test(input));
    if (input && isErrorPage) {
      const cut = input.search(/<|\/_next\/|&lt;/);
      setInput(cut > 0 ? input.slice(0, cut).trimEnd() : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);
  // Compact while the draft fits on one visual line; expanded (input on its
  // own full-width row) once it wraps to several visual lines.
  const [composerExpanded, setComposerExpanded] = useState(false);
  // Bumped on window resize so the compact-width line measurement below
  // re-runs (the composer width changes with the window).
  const [composerMeasureTick, setComposerMeasureTick] = useState(0);
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
    const incomingInput = chat?.draft?.input ?? "";
    // Never restore a polluted draft: HTML error pages belong in the banner, never in the input.
    setInput(isHtmlTranscriptJunk(incomingInput) || /<\/?[a-z]/i.test(incomingInput) || incomingInput.includes('/_next/') || incomingInput.includes('&lt;') ? "" : incomingInput);
    setAttachments(chat?.draft?.attachments ?? []);
    setImages(chat?.draft?.images ?? []);
    setPastedBlocks(chat?.draft?.pasted ?? []);
    setCmdOpen(null);
    setCmdQuery("");
    setSkillMention(null);
    setSkillMentionQuery("");
    setAskFreeText("");
    setActiveQuote(null);
    // Render enough history so the saved anchor exists on the first paint of
    // the incoming chat (same buffer logic as the mount initializer). Without
    // this, switching back to a scrolled-up chat renders only the last
    // MSG_PAGE messages and the restore lands on a wrong viewport.
    const incomingPos = chat?.scrollPos;
    // Returning to a chat: follow the newest messages when the agent is
    // active in it (streaming, marked busy, or waiting on the user) or when
    // its transcript changed while the user was away (new or grown message)
    // — restoring the old anchor there would hide exactly the reply the user
    // came back to read.
    const switchMsgs = chat?.messages ?? [];
    const agentActive =
      switchMsgs.some((m) => m.streaming || m.retry?.reconnecting === true) ||
      (chat ? (busyMap[chat.id] ?? false) : false) ||
      chat?.pendingAsk != null ||
      chat?.pendingPermission != null;
    const landLatest = shouldLandOnLatest({
      agentActive,
      fingerprint: messageFingerprint(switchMsgs),
      seenFingerprint: lastSeenFpRef.current.get(id),
    });
    const restoredPos = landLatest ? atBottomScrollPos() : incomingPos;
    if (incomingPos && !incomingPos.atBottom && chat && !landLatest) {
      const anchorIdx = chat.messages.findIndex((m) => m.id === incomingPos.id);
      if (anchorIdx >= 0) {
        const start = Math.max(0, anchorIdx - SCROLL_RESTORE_BUFFER);
        setMsgLimit(Math.max(MSG_PAGE, chat.messages.length - start));
      } else {
        setMsgLimit(MSG_PAGE);
      }
    } else {
      setMsgLimit(MSG_PAGE);
    }
    stickToBottom.current =
      landLatest || !chat?.scrollPos || chat.scrollPos.atBottom;
    restoredRef.current = false;
    // The restore layout effect below must re-run for the NEW chat with the
    // NEW chat's saved position (not the mount-time one): refresh the anchor
    // and bump a tick so the effect fires even when every other state setter
    // bails out identical. Without this, switching to a scrolled-up chat can
    // land on a stale anchor — or the oldest-message fallback, i.e. the top.
    initialScrollPosRef.current = restoredPos ?? null;
    setRestoreTick((t) => t + 1);
    restoreTargetRef.current = null;
    // Seed the capture with the position being RESTORED (the bottom when
    // following a live/new turn, otherwise the saved anchor): until the user
    // scrolls this is where they are, and a switch-away flush with a null
    // capture skips the write entirely — resurrecting an older position.
    lastScrollPosRef.current = restoredPos ?? null;
    chatIdRef.current = id;
    // Gated switch-to-paint probe (zero cost unless enabled): set
    // localStorage 'coder:perf' to '1', reload, switch chats, and read the
    // [perf] line in devtools console. Measures effect → second paint frame,
    // i.e. mount + layout of the incoming transcript window.
    if (
      typeof window !== "undefined" &&
      window.localStorage?.getItem("coder:perf") === "1"
    ) {
      const t0 = performance.now();
      const switchedId = id;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          // eslint-disable-next-line no-console
          console.debug(
            `[perf] chat switch → paint: ${(performance.now() - t0).toFixed(0)}ms (${switchedId})`,
          );
        }),
      );
    }
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
  // Separate git-action states so commit/undo/push spinners never lock the
  // composer (the shared `busy` flag disables sending).
  const [isCommitting, setIsCommitting] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [isPushing, setIsPushing] = useState(false);

  const [cmdOpen, setCmdOpen] = useState<{ at: number } | null>(null);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  // Prompt history popup (ArrowUp): previous prompts + up to 3 pinned
  // commands. History/pins persist in localStorage (see src/lib/slash).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIdx, setHistoryIdx] = useState(0);
  const [promptHistory, setPromptHistory] = useState<string[]>(() => loadHistory());
  const [pinnedCmds, setPinnedCmds] = useState<string[]>(() => loadPins());
  // Recently used slash commands (bare names, newest first) — drives the
  // command popup order bottom-anchored so the last used command sits
  // just above the input.
  const [commandUsage, setCommandUsage] = useState<string[]>(() => loadCommandUsage());
  // Keep popup order fresh when usage is recorded from another panel or
  // after a command runs (storage is the source of truth).
  useEffect(() => {
    const refresh = () => setCommandUsage(loadCommandUsage());
    window.addEventListener('coder:command-usage', refresh);
    return () => window.removeEventListener('coder:command-usage', refresh);
  }, []);
  // Persistent goal auto-drive (Codex / Claude parity):
  // - Strictly per-chat: each panel drives ONLY its own chat (never activeChatId),
  //   so a goal in A can never inject turns into B.
  // - Only an explicit backend [GOAL CONTINUES] judgment drives the next turn.
  //   Plain stalls (old messages, steers without judgment, aborts, errors) stay
  //   idle — this is what stops "open window starts working by itself".
  // - Explicit Stop halts the loop via the persistent `goal.stopped` flag (plus
  //   the in-memory stoppedMap for the immediate race). Resume clears it.
  // - First observation per chat per mount is seeded, never sent: historical
  //   transcripts must not auto-fire on open/switch/reload.
  // - The turn cap mirrors the server (GOAL_MAX_EXTRA_TURNS): the client never
  //   fires past it even if a marker is stale, and the judge's reason after
  //   the marker rides into the next prompt as guidance.
  const goalAutoRef = useRef<Map<string, string>>(new Map());
  const goalInitRef = useRef<Set<string>>(new Set());
  const goalSendingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ownId = chat?.id;
    if (!ownId) return;
    const st = useStore.getState();
    const ch = st.chats.find((c) => c.id === ownId);
    const gl = ch?.goal;
    if (!ch || !gl?.active || gl.paused || gl.stopped) return;
    const msgs = ch.messages;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant" || last.streaming) return;
    const content = last.content ?? "";
    const autoKey = `${ownId}:${last.id}`;
    // First observation of this chat in this mount: sync terminal markers so
    // the bar reflects reality, but NEVER send (no autostart on open/switch).
    if (!goalInitRef.current.has(ownId)) {
      goalInitRef.current.add(ownId);
      if (content.includes("[GOAL CLEARED]") || content.includes("[GOAL IMPOSSIBLE]")) {
        if (goalAutoRef.current.get(ownId) !== `cleared:${last.id}`) {
          goalAutoRef.current.set(ownId, `cleared:${last.id}`);
          st.clearGoal(ch.id);
        }
      } else if (content.includes("[GOAL PAUSED]")) {
        if (goalAutoRef.current.get(ownId) !== `paused:${last.id}`) {
          goalAutoRef.current.set(ownId, `paused:${last.id}`);
          st.pauseGoal(ch.id);
        }
      } else {
        goalAutoRef.current.set(ownId, last.id);
      }
      return;
    }
    if (content.includes("[GOAL CLEARED]") || content.includes("[GOAL IMPOSSIBLE]")) {
      if (goalAutoRef.current.get(ownId) !== `cleared:${last.id}`) {
        goalAutoRef.current.set(ownId, `cleared:${last.id}`);
        st.clearGoal(ch.id);
      }
      return;
    }
    if (content.includes("[GOAL PAUSED]")) {
      if (goalAutoRef.current.get(ownId) !== `paused:${last.id}`) {
        goalAutoRef.current.set(ownId, `paused:${last.id}`);
        st.pauseGoal(ch.id);
      }
      return;
    }
    // Codex-style: only [GOAL CONTINUES] continues the loop. Anything else
    // (interrupted turn, error, steer without judgment, historic message) ends
    // idle and waits for explicit user Resume/Send.
    if (!content.includes("[GOAL CONTINUES]")) return;
    // Client-side mirror of the server cap: never fire past MAX_GOAL_TURNS.
    // The server is authoritative; this just avoids one wasted turn on a
    // stale marker. Cap-hit parks the loop as paused (same as [GOAL PAUSED]).
    if ((gl.turns ?? 0) >= MAX_GOAL_TURNS) {
      if (goalAutoRef.current.get(ownId) !== `paused:${last.id}`) {
        goalAutoRef.current.set(ownId, `paused:${last.id}`);
        st.pauseGoal(ch.id);
      }
      return;
    }
    // Explicit Stop (persistent flag or in-memory race flag) blocks the loop.
    let wasStopped = false;
    try {
      wasStopped = Boolean(stoppedMapRef.current?.get(ch.id));
    } catch {
      wasStopped = false;
    }
    if (wasStopped) return;
    const hasRetry = Boolean((last as { retry?: unknown }).retry);
    if (hasRetry) return;
    if (goalAutoRef.current.get(ownId) === last.id) return;
    if (msgs.some((m) => m.streaming)) return;
    if (goalSendingRef.current.has(autoKey)) return;
    goalAutoRef.current.set(ownId, last.id);
    goalSendingRef.current.add(autoKey);
    const judgeNote = goalReasonAfter(content, "[GOAL CONTINUES]");
    const nextPrompt = judgeNote
      ? `Continue working on the persistent goal: "${gl.condition}". Previous assessment: ${judgeNote}`
      : `Continue working on the persistent goal: "${gl.condition}".`;
    void send(nextPrompt, [], [], false, undefined, undefined, false, undefined, ch.id)
      .finally(() => {
        goalSendingRef.current.delete(autoKey);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.messages, chat?.goal, chat?.id]);
  // Codex-style slash highlight: only the leading "/name" token gets the
  // accent color, args and plain text keep the normal color. A backdrop div
  // mirrors the textarea text (same font/padding/wrap) and paints the token
  // span; the textarea itself turns transparent so caret, selection and IME
  // keep working on the real input. Only known commands highlight; unknown
  // "/xxx" stays plain text until submit reports it.
  const composerBackdropRef = useRef<HTMLDivElement>(null);
  const slashParsed = parseSlashInput(input);
  const slashActive =
    !!slashParsed?.name && COMMANDS.some((c) => c.name === slashParsed.name);
  const slashRange = slashActive ? slashTokenRange(input) : null;
  const syncBackdropScroll = useCallback(() => {
    const el = textareaRef.current;
    const bd = composerBackdropRef.current;
    if (el && bd) {
      bd.scrollTop = el.scrollTop;
      bd.scrollLeft = el.scrollLeft;
    }
  }, []);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  // Tauri native drag events are enabled (dragDropEnabled: true) — WKWebView
  // swallows HTML5 drops of OS files, so the shell forwards the native drag
  // phases + cursor position (see main.tsx onDragDropEvent). Each panel
  // hit-tests the cursor against its own bounds, so in multi-window mode
  // ONLY the panel under the cursor shows the overlay and receives the drop.
  useEffect(() => {
    const inBounds = (pos: { x: number; y: number } | null) => {
      if (!pos) return false;
      const r = panelRef.current?.getBoundingClientRect();
      return !!r && pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom;
    };
    const onNativeDrag = (e: Event) => {
      const { phase, pos } = (e as CustomEvent<{ phase: string; pos: { x: number; y: number } | null }>).detail;
      if (phase === "enter" || phase === "over") {
        setDragOver(inBounds(pos));
      } else if (phase === "leave" || (phase === "drop" && !inBounds(pos))) {
        setDragOver(false);
        dragDepth.current = 0;
      }
    };
    const onNativeDrop = (e: Event) => {
      const { pos, paths } = (e as CustomEvent<{ pos: { x: number; y: number } | null; paths?: string[] }>).detail;
      setDragOver(false);
      dragDepth.current = 0;
      if (!inBounds(pos)) return; // dropped on another panel — not ours
      for (const p of paths ?? []) addDroppedFile(p, p.split("/").pop() ?? p);
    };
    window.addEventListener("codifa:file-drag", onNativeDrag);
    window.addEventListener("codifa:file-drop", onNativeDrop);
    return () => {
      window.removeEventListener("codifa:file-drag", onNativeDrag);
      window.removeEventListener("codifa:file-drop", onNativeDrop);
    };
  }, []);
  // "+" action menu (files / screenshot / skills / MCP) — the single entry
  // point that keeps the bottom toolbar minimal.
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);
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
  // Recently used skills (slugs, newest first) — drives the @mention popup
  // order bottom-anchored, like commandUsage for slash.
  const [skillUsage, setSkillUsage] = useState<string[]>(() => loadSkillUsage());
  useEffect(() => {
    const refresh = () => setSkillUsage(loadSkillUsage());
    window.addEventListener('coder:skill-usage', refresh);
    return () => window.removeEventListener('coder:skill-usage', refresh);
  }, []);
  const [titlebarEl, setTitlebarEl] = useState<HTMLElement | null>(null);
  // Second mount point on the app bar's right end — the balance chip portals
  // there so the wallet sits next to the workspace menu, not mid-bar.
  const [titlebarRightEl, setTitlebarRightEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // The titlebar mounts in the same commit as this panel, so resolve the
    // portal target only after the DOM is actually committed.
    setTitlebarEl(document.getElementById("titlebar-toolbar"));
    setTitlebarRightEl(document.getElementById("titlebar-right"));
  }, []);
  const [recording, setRecording] = useState(false);
  const [liveState, setLiveState] = useState<LiveVoiceState>('idle');
  const [liveError, setLiveError] = useState<string | null>(null);
  const liveSessionRef = useRef<LocalLiveSession | null>(null);
  const toggleLiveRef = useRef<() => void>(() => {});
  const [selectedMicId, setSelectedMicId] = useState<string>(() => {
    try {
      return localStorage.getItem("codifa:selectedMicDeviceId") ?? "";
    } catch {
      return "";
    }
  });
  const [micMenuOpen, setMicMenuOpen] = useState(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const micMenuRef = useRef<HTMLDivElement | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  // Composer action visibility: live voice takes over, streaming shows stop
  // + dictate mic, typing shows send only, empty shows mic + live buttons.
  const isLiveVoiceActive = liveState === 'live' || liveState === 'speaking' || liveState === 'connecting';
  const isStreamingActive = busy || chatHasStreaming;
  // Only typed text counts as written text; attached photos/files and
  // collapsed paste cards alone do not: the user attaches first and
  // dictates the prompt afterwards.
  const hasText = input.trim().length > 0;
  const hasAttachment = pastedBlocks.length > 0 || images.length > 0;
  const hasComposerText = hasText || hasAttachment;
  const showLiveActive = isLiveVoiceActive;
  const showStopOnly = !isLiveVoiceActive && isStreamingActive;
  // Dictate mic stays visible during streaming (hidden only when live is active)
  // so the user can dictate the next prompt while the agent works.
  const showDictateDuringStreaming = !isLiveVoiceActive && isStreamingActive;
  // Send appears only once there is typed/pasted text: attaching a photo/file
  // alone keeps the mics visible so the prompt can be dictated afterwards.
  const showSendOnly = !isLiveVoiceActive && !isStreamingActive && hasText;
  // Attachments alone must not hide the mics: user may attach a file/photo
  // and then dictate the prompt. Only typed text hides voice buttons.
  const showVoiceButtons = !isLiveVoiceActive && !isStreamingActive && !hasText;
  // Live voice button shows whenever the composer is idle (empty input,
  // not streaming, live not active) so it comes back after Stop. It stays
  // hidden mid-stream and while typing, unless live is the active session.
  const showLiveIdle = !isLiveVoiceActive && !isStreamingActive && !hasText;
  const sttProviderId = useStore((s) => s.sttProviderId);
  const sttModel = useStore((s) => s.sttModel);
  const sttFallbacks = useStore((s) => s.sttFallbacks ?? []);
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
  const computerUse = useStore((s) => s.computerUse);
  const setComputerUse = useStore((s) => s.setComputerUse);
  const skillQ = skillQuery.trim().toLowerCase();
  // The composer's connector grid = the built-in Computer Use card (same
  // hard on/off switch as an MCP connector: OFF means the `computer` tool is
  // never bound) + every user MCP connector, toggleable per turn.
  const mcpCards: Array<{ name: string; label: string; builtin?: boolean }> = [
    { name: "computer", label: "Computer Use", builtin: true },
    ...Object.keys(mcpConnectors).map((name) => ({ name, label: name })),
  ];
  const filteredMcpCards = mcpCards.filter(
    (c) =>
      !skillQ ||
      c.label.toLowerCase().includes(skillQ) ||
      c.name.toLowerCase().includes(skillQ),
  );
  const skillOptions = filteredMcpCards.map((c) => ({
    kind: (c.builtin ? "builtin" : "mcp") as "builtin" | "mcp",
    name: c.name,
  }));
  const atQuery = skillMentionQuery.trim().toLowerCase();
  const filteredSkills = bottomAnchoredByUsage(
    skillsList.filter(
      (s) =>
        !atQuery ||
        s.name.toLowerCase().includes(atQuery) ||
        (s.slug && s.slug.toLowerCase().includes(atQuery)) ||
        s.description.toLowerCase().includes(atQuery),
    ),
    skillUsage,
    (s) => s.slug || s.name,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // Per-chat scroll restoration: the panel stays mounted across chat
  // switches (no key={activeChatId}), so the restore anchor is refreshed on
  // every switch (see the chat-id effect above). If the user last left this
  // chat scrolled up, don't auto-pin to the bottom on return.
  const initialScrollPosRef = useRef(chat?.scrollPos ?? null);
  const stickToBottom = useRef(!initialScrollPosRef.current || initialScrollPosRef.current.atBottom);
  // Transcript fingerprint per chat as of the last time the user LEFT it
  // (recorded in the scroll-flush cleanup below). On return, a different
  // fingerprint means the agent posted or updated a message while the user
  // was away → land on the newest message instead of the saved anchor
  // (shouldLandOnLatest in the switch effect).
  const lastSeenFpRef = useRef<Map<string, string>>(new Map());
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
  // Per-chat auto-retry schedulers (epoch-guarded): every automatic resend
  // (watchdog stall retry, post-turn drain) is armed through these, so an
  // explicit Stop bumps the epoch and a timer firing afterwards is dropped
  // instead of restarting the turn and bringing the retry banner back.
  const autoRetryMapRef = useRef<Map<string, AutoRetryScheduler>>(new Map());
  const autoRetryFor = (chatId: string): AutoRetryScheduler => {
    let sched = autoRetryMapRef.current.get(chatId);
    if (!sched) {
      sched = new AutoRetryScheduler();
      autoRetryMapRef.current.set(chatId, sched);
    }
    return sched;
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Reply-to-selection: floating reply button over selected transcript text.
  // activeQuote is the pinned quote shown above the composer until sent.
  const [quoteSel, setQuoteSel] = useState<{ text: string; x: number; y: number } | null>(null);
  const [activeQuote, setActiveQuote] = useState<string | null>(null);
  const quoteSelRef = useRef<{ text: string; x: number; y: number } | null>(null);
  quoteSelRef.current = quoteSel;
  const refreshQuoteSel = useCallback(() => {
    const rootEl = scrollRef.current;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (quoteSelRef.current) setQuoteSel(null);
      return;
    }
    const text = sel.toString();
    if (!isQuotableSelection(text)) {
      if (quoteSelRef.current) setQuoteSel(null);
      return;
    }
    const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement ?? null;
    const focusEl = sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode?.parentElement ?? null;
    const inTranscript = (el: Element | null) => !!el && !!rootEl && rootEl.contains(el) && !composerRef.current?.contains(el);
    if (!inTranscript(anchor) && !inTranscript(focusEl)) return;
    try {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      const x = Math.min(Math.max(rect.left + rect.width / 2, 48), window.innerWidth - 48);
      const y = Math.max(rect.top - 8, 8);
      setQuoteSel({ text, x, y });
    } catch {
      // ignore invalid ranges
    }
  }, []);
  useEffect(() => {
    document.addEventListener("selectionchange", refreshQuoteSel);
    const onScroll = () => {
      if (quoteSelRef.current) setQuoteSel(null);
    };
    document.addEventListener("scroll", onScroll, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && quoteSelRef.current) setQuoteSel(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("selectionchange", refreshQuoteSel);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [refreshQuoteSel]);
  const applyQuoteSel = useCallback(() => {
    const cur = quoteSelRef.current;
    if (!cur) return;
    const block = formatChatQuote(cur.text);
    if (block) setActiveQuote(block);
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      // ignore
    }
    setQuoteSel(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    });
  }, []);
  // Hidden mirror + row/action widths used to count visual lines at the
  // compact input width (layout-independent, so no compact/expanded flip
  // loop). The single-line mirror height is cached (font never changes).
  const composerRowRef = useRef<HTMLDivElement>(null);
  const composerMeasureRef = useRef<HTMLDivElement>(null);
  const composerRightRef = useRef<HTMLDivElement>(null);
  // Action widths are fixed-size buttons: cache the first non-zero read so
  // the mirror width never depends on the live mode (expanded vs compact).
  const composerLeftWRef = useRef<number | null>(null);
  const composerRightWRef = useRef<number | null>(null);
  const composerSingleLineHRef = useRef<number | null>(null);
  const skillPopupRef = useRef<HTMLDivElement>(null);
  // Container for the @skill mention popup, so the highlighted row can be
  // scrolled into view on Ctrl+J/K / arrow navigation (the list scrolls
  // internally and the highlight can move outside the visible 300px area).
  const skillMentionPopupRef = useRef<HTMLDivElement>(null);
  // Same containers for the slash-command and history popups: keyboard
  // navigation moves the highlight while the list scrolls independently.
  const cmdPopupRef = useRef<HTMLDivElement>(null);
  const historyPopupRef = useRef<HTMLDivElement>(null);
  // Bottom-anchored history: keep the active row visible inside the popup
  // only (never the window) when navigating from the bottom upward.
  useEffect(() => {
    if (!historyOpen) return;
    scrollPopupRowIntoView(historyPopupRef.current, ".hist-card.kbd");
  }, [historyOpen, historyIdx]);
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
   *  the store root — it survives chat switches too. Rendered only in the
   *  focused panel so one Ctrl+X does not banner every visible window. */
  const rawPrefixNotice = useStore((s) => s.prefixNotice ?? null);
  const prefixNotice = rawPrefixNotice && isActive ? rawPrefixNotice : null;
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
      if (!recordingRef.current) return;
      // Per-chat isolation: every mounted ChatPanel listens on document, so
      // without this guard a Space pressed in ANY chat would stop ALL
      // recording chats (and swallow the space keystroke).
      if (!shouldHandleForChat(useStore.getState().activeChatId, chatIdRef.current)) return;
      if (
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

  // Cycle Ask <-> Coder in the current chat (Tab / ⌘M). Plan is entered
  // via `/plan` (Codex-style) and never appears in the cycle or the mode
  // menu; when the chat is already in Plan mode, Tab lands on Ask.
  const cycleMode = (dir: 1 | -1) => {
    if (!chat) return;
    const ids = allModes(useStore.getState().settings)
      .map((m) => m.id)
      .filter((id) => id !== "plan");
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
      // Prefix slash commands target the focused chat only — otherwise one
      // Ctrl+X chord would run the same command in every visible window.
      if (!shouldHandleForChat(useStore.getState().activeChatId, chatIdRef.current)) return;
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

  // Cross-window command-usage sync: another ChatPanel recording a slash
  // command broadcasts `coder:command-usage`, so this panel's popup order
  // (filteredCmds via sortCommandsByUsage) stays recent-first everywhere.
  useEffect(() => {
    const onUsage = () => setCommandUsage(loadCommandUsage());
    window.addEventListener("coder:command-usage", onUsage);
    return () => window.removeEventListener("coder:command-usage", onUsage);
  }, []);

  // Cross-window skill-usage sync: same pattern for the @mention popup order.
  useEffect(() => {
    const onSkillUsage = () => setSkillUsage(loadSkillUsage());
    window.addEventListener("coder:skill-usage", onSkillUsage);
    return () => window.removeEventListener("coder:skill-usage", onSkillUsage);
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
  /** Last programmatic scrollTop set: the CLAMPED value read back right after
   *  the set, plus a timestamp. A scroll event arriving at exactly this
   *  position is the pin's own (possibly late-dispatched) event or content
   *  growth under a pinned viewport — never a manual scroll-up — so it must
   *  not unpin auto-scroll. Cleared on the first genuine user scroll. */
  const pinTopRef = useRef<{ top: number; at: number } | null>(null);
  /** Frame that lowers the programmatic-scroll flag; cancelled and re-armed
   *  by every pin so overlapping pins during fast streaming keep the flag up
   *  until a full frame after the LAST pin. */
  const pinRafRef = useRef<number | null>(null);
  const setProgrammaticScroll = (el: HTMLDivElement, top: number) => {
    programmaticScrollRef.current = true;
    el.scrollTop = top;
    // Record the clamped position (read back: the browser may clamp the
    // requested value to the scroll range) so a late-dispatched event from
    // this pin still compares equal (see scrollMatchesPin).
    pinTopRef.current = { top: el.scrollTop, at: Date.now() };
    if (pinRafRef.current != null) cancelAnimationFrame(pinRafRef.current);
    pinRafRef.current = requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
      pinRafRef.current = null;
    });
  };

  /** Pin the viewport to the newest messages AND record that as the saved
   *  scroll position. Every path that sticks to the bottom must go through
   *  this: the chat-switch flush only persists what's in `lastScrollPosRef`
   *  (plus the pin flag), so a pin that skips the record leaves a stale anchor
   *  behind — and the chat then reopens NOT at the bottom after a switch. At
   *  the bottom the anchor id/offset are unused, so no DOM scan is needed. */
  const recordAtBottom = () => {
    stickToBottom.current = true;
    setShowJump(false);
    lastScrollPosRef.current = atBottomScrollPos();
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
    // Late-dispatched pin event or content growth under a pinned viewport:
    // scrollTop still sits exactly where the last programmatic pin put it, so
    // this is not the user scrolling up — ignore it instead of unpinning
    // auto-scroll mid-stream (the ChatGPT-style follow would otherwise die on
    // the first fast streaming chunk after every pin).
    if (fromReanchor || scrollMatchesPin(el.scrollTop, pinTopRef.current)) return;
    // Jump flight in progress: intermediate ticks of the smooth animation are
    // not user scrolls — keep the pin and the hidden button until arrival.
    if (jumpScrollingRef.current) {
      if (isAtBottom(el)) {
        jumpScrollingRef.current = false;
        // Arrival at the bottom: record it — this branch returns early, so the
        // capture below never runs, and without a record the leave-flush would
        // save the pre-jump anchor (chat reopens off the bottom after a switch).
        recordAtBottom();
      }
      return;
    }
    // A genuine user scroll reached this point (programmatic pins returned
    // above): the recorded pin is stale, drop it so later events compare
    // against fresh pins only.
    pinTopRef.current = null;
    const atBottom = isAtBottom(el);
    if (atBottom) {
      // Record synchronously: at the bottom there is nothing to scan, and the
      // rAF capture below can be cancelled by a chat switch — losing the
      // atBottom flag is what made a chat reopen off the bottom.
      recordAtBottom();
    } else {
      stickToBottom.current = false;
    }
    // Bail out when unchanged so scrolling doesn't re-render the whole panel on
    // every tick — the jump button only flips once per boundary crossing.
    // آستانهٔ نمایش: محتوا باید واقعاً پشت کامپوزر پنهان شده باشد، نه فقط
    // چند پیکسل از انتهای محتوا فاصله داشته باشیم (اگر نه، فلش «داخل اینپوت»
    // به نظر می‌رسد چون کامپوزر روی فضای رزروشدهٔ انتهای چت شناور است).
    const jumpVisible = distanceFromBottom(el) > jumpThresholdRef.current;
    setShowJump((prev) => (prev === jumpVisible ? prev : jumpVisible));
    // Reached the top with older messages still unrendered → load the previous
    // page. Anchored via prependAnchorRef so the viewport doesn't jump.
    // NOTE: the trigger is the actually-rendered window (count page AND char
    // budget), never `messages.length > msgLimit`: msgLimit is intentionally
    // uncapped (it also scales the char budget), so that comparison goes
    // permanently false on giant chats and scroll-loading silently dies.
    if (el.scrollTop < 200 && chat) {
      const visible = visibleChatMessages(chat.messages);
      const budget = windowBudget(msgLimit, MSG_PAGE);
      const rendered = sliceWindow(
        visible,
        msgLimit,
        budget,
        MSG_WINDOW_MIN_KEEP,
        (m) => Math.min(m.content?.length ?? 0, RENDER_CAP),
      ).length;
      if (rendered < visible.length) {
        prependAnchorRef.current = el.scrollHeight;
        setMsgLimit((n) => n + MSG_PAGE);
      }
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
    recordAtBottom();
    setScrollTick((t) => t + 1);
    // Persist immediately: send/queue is an explicit user action and the app
    // may close before any flush picks the position up from the ref.
    if (chat?.id && lastScrollPosRef.current) {
      useStore.getState().setChatScrollPos(chat.id, lastScrollPosRef.current);
    }
  };

  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = scrollRef.current;
    if (!el) return;
    // Keep the saved position pinned too: this scroll may fire no scroll
    // event (already at max), and a chat switch flushes the ref as-is.
    recordAtBottom();
    // Flagged pin: an unflagged scrollTo here fires a scroll event that looks
    // exactly like a manual scroll-up when the next streaming chunk grows
    // scrollHeight mid-flight — permanently unpinning auto-scroll mid-stream.
    // Flagged events are ignored regardless of position (narrow same-frame
    // window, so a real user scroll-up right after still disables follow).
    setProgrammaticScroll(el, el.scrollHeight);
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
        if (atBottom) recordAtBottom();
        else stickToBottom.current = false;
        const jumpVisible = distanceFromBottom(el) > jumpThresholdRef.current;
        setShowJump((prev) => (prev === jumpVisible ? prev : jumpVisible));
        return;
      }
      const atBottom = isAtBottom(el);
      if (stickToBottom.current) {
        // Flagged pin for the same reason as the auto-scroll effect above:
        // async content growth (images, fonts, highlighting) between an
        // unflagged set and its scroll event mimics a manual scroll-up.
        setProgrammaticScroll(el, el.scrollHeight);
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
    const prevHeight = prependAnchorRef.current;
    prependAnchorRef.current = null;
    // Flagged re-anchor, not a raw set: same fake-scroll-up hazard as above.
    setProgrammaticScroll(el, el.scrollTop + (el.scrollHeight - prevHeight));
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
      recordAtBottom();
      // Flagged pin (not a raw set): a raw set fires an unflagged scroll event
      // that a streaming chunk rendered just after it turns into a fake
      // "manual scroll-up", permanently unpinning auto-scroll on return.
      setProgrammaticScroll(el, el.scrollHeight);
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
        // The anchor still exists but is paged out (not rendered) → expand the
        // rendered window to include it (plus a buffer above for exact
        // positioning) and retry after render, instead of landing on a nearby
        // message or the bottom (wrong viewport after a chat switch).
        if (!rendered.has(pos.id)) {
          const start = Math.max(0, idx - SCROLL_RESTORE_BUFFER);
          const needed = Math.max(MSG_PAGE, msgs.length - start);
          if (needed > msgLimit) {
            setMsgLimit(needed);
            return;
          }
        }
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
      recordAtBottom();
      // Flagged pin, same reason as the atBottom branch above.
      setProgrammaticScroll(el, el.scrollHeight);
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
    const pushToStore = (isChatSwitch = false) => {
      if (!cid) return;
      if (isChatSwitch) {
        // Chat switch: the DOM already shows the INCOMING chat, so a synchronous
        // recompute would capture the new transcript and save it under the OLD
        // chat id (wrong viewport on return). Keep the last position captured
        // while the old chat was mounted; just drop the pending frame.
        if (scrollRafRef.current != null) {
          cancelAnimationFrame(scrollRafRef.current);
          scrollRafRef.current = null;
        }
      } else {
        // If a scroll happened in the last frame, its rAF capture may not have
        // fired yet — compute synchronously so the position saved is exactly the
        // viewport at flush time (cheap: no-op unless a capture is pending).
        syncScrollPos();
      }
      // A pin to the bottom outranks the raw capture: the capture can be stale
      // (its rAF was just cancelled above) or never have happened (entering a
      // chat and the jump-button arrival don't schedule one), so persisting it
      // as-is would resurrect an old scrolled-up anchor and the chat would not
      // reopen at the bottom after a switch.
      const pos = scrollPosForFlush(lastScrollPosRef.current, stickToBottom.current);
      if (pos) {
        lastScrollPosRef.current = pos;
        useStore.getState().setChatScrollPosMem(cid, pos);
      }
    };
    const onFlushUi = () => pushToStore(false);
    // Unmount (chat switch / minimize): push the position into the store
    // in-memory only — never flushNow here. A full flush runs sanitizeChats
    // over every message plus settings encryption on the commit path and
    // blocks the minimize paint (the reported minimize lag). The debounced
    // persist after the window action covers disk; the quit path flushes.
    const flush = () => {
      pushToStore(true);
      // Record a fingerprint of this chat's transcript as the user leaves it:
      // on the next return, a different fingerprint means the agent posted or
      // updated a message while they were away → land on the newest message
      // instead of the saved anchor (shouldLandOnLatest). Read fresh from the
      // store — the closure's `chat` is from the render that last changed
      // chat?.id, so it can be stale.
      if (cid) {
        const cur = useStore.getState().chats.find((c) => c.id === cid);
        if (cur) lastSeenFpRef.current.set(cid, messageFingerprint(cur.messages));
      }
    };
    // App close: push the position into the store AND force an immediate write,
    // so it survives even if the store's own beforeunload flush already ran.
    const flushOnClose = () => {
      pushToStore(false);
      useStore.getState().flushNow();
    };
    window.addEventListener("coder:flush-ui", onFlushUi);
    window.addEventListener("pagehide", flushOnClose);
    window.addEventListener("beforeunload", flushOnClose);
    return () => {
      window.removeEventListener("coder:flush-ui", onFlushUi);
      window.removeEventListener("pagehide", flushOnClose);
      window.removeEventListener("beforeunload", flushOnClose);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id]);

  // Expanded when the draft needs more than one visual line at the COMPACT
  // input width (explicit newline or wrapping). Measured with a hidden mirror
  // sized to the compact width, so the result does not depend on the current
  // layout: no expand/collapse oscillation for borderline lengths.
  useLayoutEffect(() => {
    const row = composerRowRef.current;
    const mirror = composerMeasureRef.current;
    const el = textareaRef.current;
    if (!row || !mirror || !el) return;
    const leftLive = plusMenuRef.current?.offsetWidth ?? 0;
    const rightLive = composerRightRef.current?.offsetWidth ?? 0;
    if (leftLive > 0) composerLeftWRef.current = leftLive;
    if (rightLive > 0) composerRightWRef.current = rightLive;
    const leftW = composerLeftWRef.current ?? leftLive;
    const rightW = composerRightWRef.current ?? rightLive;
    // Widths not laid out yet: keep the current mode instead of deciding on
    // zeros (a zero-width mirror would wrongly collapse a multi-line draft).
    if (!row.clientWidth || (leftW <= 0 && rightW <= 0)) return;
    // Layout-independent: always measure at the compact input width using
    // fixed compact metrics. Reading live padding/gap here would oscillate
    // because they change with the expanded class.
    mirror.style.width = `${compactInputWidth(row.clientWidth, leftW, rightW)}px`;
    if (composerSingleLineHRef.current == null) {
      mirror.textContent = "x";
      composerSingleLineHRef.current = mirror.scrollHeight;
    }
    const singleH = composerSingleLineHRef.current || mirror.scrollHeight;
    mirror.textContent = `${input}\u200b`;
    const expanded = shouldExpandComposer(input, mirror.scrollHeight, singleH, composerExpanded);
    setComposerExpanded(expanded);
    if (expanded) {
      el.style.height = "auto";
      const fit = composerHeight(el.scrollHeight);
      el.style.height = `${fit.height}px`;
      el.style.overflowY = fit.overflowY;
    } else {
      el.style.height = "";
      el.style.overflowY = "hidden";
    }
    syncBackdropScroll();
  }, [input, composerExpanded, composerMeasureTick, syncBackdropScroll]);

  // The compact/expanded class flip changes the textarea width, so re-fit
  // its height once under the new width.
  useLayoutEffect(() => {
    if (!composerExpanded) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const fit = composerHeight(el.scrollHeight);
    el.style.height = `${fit.height}px`;
    el.style.overflowY = fit.overflowY;
  }, [composerExpanded]);

  useEffect(() => {
    const onResize = () => setComposerMeasureTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
      // Only the focused chat cycles mode — otherwise one Tab/⌘M chord
      // would flip every visible window.
      if (!shouldHandleForChat(useStore.getState().activeChatId, chatIdRef.current)) return;
      cycleMode(1);
    };
    const onAttachFile = (e: Event) => {
      // File picker attaches to the focused chat only — without this guard
      // Ctrl+P in one window appends the file to ALL visible composers.
      if (!shouldHandleForChat(useStore.getState().activeChatId, chatIdRef.current)) return;
      const rel = (e as CustomEvent<{ rel: string }>).detail?.rel;
      if (!rel || !wroot) return;
      setAttachments((a) => (a.includes(rel) ? a : [...a, rel]));
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    const onToggleVoice = () => {
      // Voice dictation toggles only in the focused chat — otherwise Space
      // during transcription inserts into every visible composer.
      if (!shouldHandleForChat(useStore.getState().activeChatId, chatIdRef.current)) return;
      toggleRecordingRef.current();
    };
    const onToggleLive = () => {
      // Live session has its own shortcut (Ctrl+X then L), separate from
      // dictation, so the two modes never mix.
      if (!shouldHandleForChat(useStore.getState().activeChatId, chatIdRef.current)) return;
      toggleLiveRef.current();
    };
    window.addEventListener("coder:toggle-mode", onToggleMode);
    window.addEventListener("coder:toggle-voice", onToggleVoice);
    window.addEventListener("coder:toggle-live", onToggleLive);
    window.addEventListener("coder:attach-file", onAttachFile as EventListener);
    return () => {
      window.removeEventListener("coder:toggle-mode", onToggleMode);
      window.removeEventListener("coder:toggle-voice", onToggleVoice);
      window.removeEventListener("coder:toggle-live", onToggleLive);
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
    const matched = COMMANDS.filter(
      (c) => c.name.includes(q) || c.hint.toLowerCase().includes(q),
    );
    // Bottom-anchored like the recent-prompt popup: oldest on top, newest
    // just above the bottom (closest to the input). Shows all matches.
    return bottomAnchoredByUsage(matched, commandUsage, (c) => c.name);
  }, [cmdOpen, cmdQuery, commandUsage]);

  const ctxWindow = modelContextWindow(provider, activeModel);

  // Context count for the titlebar meter — see `computeContextUsed`: the latest
  // assistant turn's token total (input + output + reasoning + cache), matching
  // opencode's `overflow.ts` accounting. opencode shows 0% until the first real
  // usage event arrives — no estimate fallback — so a brand-new chat reads empty.
  const contextUsed = useMemo(
    () => computeContextUsed(chat, systemPrompt, ctxWindow ?? undefined),
    [chat, systemPrompt, ctxWindow],
  );

  // Warn (yellow) when used context reaches the auto-compaction threshold
  // (compactAtPercent% of the raw window) — the same point where backend
  // auto-compaction fires.
  const compactAtPercent = settings.compactAtPercent ?? 80;
  const usable =
    ctxWindow != null ? Math.round(ctxWindow * (compactAtPercent / 100)) : null;

  // Ring progress is measured against the usable window (auto-compaction
  // threshold), not the raw window: 100% means compaction fires. E.g. with a
  // 50% threshold, half the raw window fills the ring and shows 100.
  const ctxPct =
    usable != null && usable > 0
      ? contextPercent(contextUsed, usable)
      : contextPercent(contextUsed, ctxWindow);

  // ---- Context-breakdown popover (hover the ring next to Send) ----
  const [ctxPopoverChatId, setCtxPopoverChatId] = useState<string | null>(null);
  const [ctxPopoverPos, setCtxPopoverPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const ctxRingWrapRef = useRef<HTMLDivElement | null>(null);
  // Real per-turn part sizes reported by the backend's ctx_parts event
  // (system prompt tail, skills section, bound MCP schemas) — keyed by chat.
  type CtxParts = {
    chat_id?: string;
    mode?: string;
    systemChars?: number;
    skillsChars?: number;
    mcpChars?: number;
    systemToolsChars?: number;
  };
  const [ctxPartsByChat, setCtxPartsByChat] = useState<Record<string, CtxParts>>({});
  const ctxPopoverCloseTimer = useRef<number | null>(null);
  const cancelCtxPopoverClose = () => {
    if (ctxPopoverCloseTimer.current != null) {
      window.clearTimeout(ctxPopoverCloseTimer.current);
      ctxPopoverCloseTimer.current = null;
    }
  };
  const scheduleCtxPopoverClose = () => {
    cancelCtxPopoverClose();
    // Grace period so the pointer can cross the gap into the popover itself.
    ctxPopoverCloseTimer.current = window.setTimeout(
      () => setCtxPopoverChatId(null),
      180,
    );
  };
  const openCtxPopover = () => {
    // The ring lives inside the "+" menu's ref container now, so its own
    // pointer-down no longer counts as "outside" — close that menu here.
    setPlusMenuOpen(false);
    cancelCtxPopoverClose();
    // The mount-time fetch can race the sidecar (empty result) or the backend
    // can restart with new prompts — retry whenever this mode's built-in
    // prompt is still missing so the popover's System prompt row isn't stuck
    // at zero.
    if (!builtinPrompts[chat?.mode ?? ""]) {
      void fetchSystemPrompts().then((p) => {
        if (Object.keys(p).length > 0)
          setBuiltinPrompts((prev) => ({ ...prev, ...p }));
      });
    }
    const el = ctxRingWrapRef.current;
    if (el && typeof window !== "undefined") {
      const r = el.getBoundingClientRect();
      setCtxPopoverPos({
        top: r.top - 6,
        left: Math.max(
          8,
          Math.min(
            r.right - CTX_POPOVER_WIDTH,
            window.innerWidth - CTX_POPOVER_WIDTH - 8,
          ),
        ),
      });
    }
    setCtxPopoverChatId(activeChatId);
  };
  useEffect(() => cancelCtxPopoverClose, []);
  // Keep file-viewer comment popups on screen and keep the commented text
  // visibly marked while the popup is open. The viewer anchors the popup at
  // the highlight position, which can sit close to the right/bottom edge, and
  // focusing the textarea collapses window.getSelection(). Clamp the inline
  // left/top after mount and wrap the last non-collapsed range in a persist
  // span so the highlight survives the focus steal; unwrap on close.
  useEffect(() => {
    let lastGoodRange: Range | null = null;
    let lastGoodText = "";
    let lastGoodRoot: Element | null = null;
    let lastGoodDoc: Document | null = null;
    let persistEls: HTMLElement[] = [];
    const POPUP_SEL = ".fv-comment-pop, .fv-comment-float, .fv-comment-box, .fv-comment-input";
    function isInsidePopup(node: Node | null) {
      if (!node) return false;
      const el = node instanceof Element ? node : node.parentElement;
      return !!el?.closest?.(POPUP_SEL);
    }
    function popupOpen() {
      return !!document.querySelector(".fv-comment-pop, .fv-comment-float, .fv-comment-box");
    }
    function isEditableTarget(t: Element | null) {
      // Text entry inside the popup must receive focus normally.
      return !!t?.closest?.("textarea, input, [contenteditable=\"true\"], [contenteditable=\"\"]");
    }
    function onPopupMouseDown(e: MouseEvent) {
      // Keep the document selection alive while the popup is open. Pressing
      // on popup chrome (quote, margins) must not steal focus and collapse
      // the native highlight; typing areas are excluded so focus still works.
      const t = e.target as Element | null;
      const box = t?.closest?.(".fv-comment-pop, .fv-comment-float, .fv-comment-box");
      if (!box) return;
      if (isEditableTarget(t)) {
        // Focus is about to move into the textarea: paint the persist
        // highlight synchronously before getSelection() collapses.
        persistHighlight();
        return;
      }
      e.preventDefault();
    }
    function onDocMouseUp() {
      // Save the live Range before the viewer mounts and focuses the popup.
      onSelectionChange();
      scanIframeSelections();
      ensureIframeListeners();
      if (popupOpen()) persistHighlight();
    }
    function onPopupFocusIn(e: FocusEvent) {
      // Textarea autofocus collapses the native selection; the saved clone
      // from selectionchange/mouseup is the source of truth, so re-apply
      // the visible highlight immediately instead of waiting for observer.
      const t = e.target as Element | null;
      if (!t?.closest?.(".fv-comment-pop, .fv-comment-float, .fv-comment-box")) return;
      persistHighlight();
    }
    const wiredFrames = new WeakSet<HTMLIFrameElement>();
    function ensureIframeListeners() {
      // Iframe selections never fire the main document selectionchange, so
      // watch each same-origin viewer frame directly and mirror its range.
      try {
        const frames = Array.from(document.querySelectorAll("iframe"));
        for (const frame of frames) {
          if (wiredFrames.has(frame)) continue;
          let fdoc: Document | null = null;
          try {
            fdoc = frame.contentDocument ?? null;
          } catch {
            continue;
          }
          if (!fdoc) continue;
          try {
            const onFrameSel = () => scanIframeSelections();
            fdoc.addEventListener("selectionchange", onFrameSel);
            fdoc.addEventListener("mouseup", onFrameSel);
            wiredFrames.add(frame);
          } catch {
            continue;
          }
        }
      } catch {
        // Ignore iframe access failures (cross-origin).
      }
    }
    // Active document holding the selection: main doc or same-origin viewer iframe.
    // All range/walker ops must use this doc, otherwise iframe ranges look detached.
    function activeDoc(): Document {
      return lastGoodDoc ?? document;
    }
    function docHas(doc: Document | null, node: Node | null): boolean {
      if (!doc || !node) return false;
      try {
        return doc.contains(node);
      } catch {
        return false;
      }
    }
    // Inline style fallback so the persist mark stays visible even inside a
    // viewer iframe that does not inherit global.css.
    function stylePersistSpan(span: HTMLElement) {
      span.style.background = "rgba(137, 180, 250, 0.38)";
      span.style.borderRadius = "2px";
      span.style.outline = "1px solid rgba(137, 180, 250, 0.55)";
      try {
        (span.style as CSSStyleDeclaration & { boxDecorationBreak?: string }).boxDecorationBreak = "clone";
      } catch {
        // Ignore styling failures.
      }
    }
    function saveRange(range: Range, text: string, doc: Document | null) {
      try {
        lastGoodRange = range.cloneRange();
        lastGoodText = text;
        lastGoodDoc = doc;
        const container = range.commonAncestorContainer;
        const el = container instanceof Element ? container : container.parentElement;
        lastGoodRoot =
          el?.closest?.(".file-viewer-doc, .fv-sheet-wrap, .fv-grid-doc, [data-file-viewer]") ??
          el ??
          null;
      } catch {
        lastGoodRange = null;
        lastGoodText = "";
        lastGoodRoot = null;
        lastGoodDoc = null;
      }
    }
    function scanIframeSelections(): boolean {
      // Docx viewer may render inside a same-origin iframe: the main
      // document selection stays empty while the real selection lives
      // inside the iframe. Capture it so the highlight survives.
      let found = false;
      try {
        const frames = Array.from(document.querySelectorAll("iframe"));
        for (const frame of frames) {
          let fdoc: Document | null = null;
          try {
            fdoc = frame.contentDocument ?? null;
          } catch {
            continue;
          }
          if (!fdoc) continue;
          let fsel: Selection | null = null;
          try {
            fsel = fdoc.getSelection ? fdoc.getSelection() : null;
          } catch {
            continue;
          }
          if (!fsel || fsel.rangeCount === 0 || fsel.isCollapsed) continue;
          let frange: Range | null = null;
          try {
            frange = fsel.getRangeAt(0);
          } catch {
            continue;
          }
          if (!frange || isInsidePopup(frange.commonAncestorContainer)) continue;
          saveRange(frange, fsel.toString(), fdoc);
          found = true;
        }
      } catch {
        // Ignore iframe access failures (cross-origin).
      }
      return found;
    }
    function onSelectionChange() {
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest?.(POPUP_SEL)) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        scanIframeSelections();
        return;
      }
      const range = sel.getRangeAt(0);
      if (isInsidePopup(range.commonAncestorContainer)) return;
      saveRange(range, sel.toString(), document);
    }
    // Wrap a substring inside a single text node with the persist class.
    function wrapSubstring(node: Text, substr: string): boolean {
      const val = node.nodeValue || "";
      const idx = val.indexOf(substr);
      if (idx < 0) return false;
      if (substr.length === 0) return false;
      try {
        const owner = node.ownerDocument ?? activeDoc();
        const r = owner.createRange();
        r.setStart(node, idx);
        r.setEnd(node, idx + substr.length);
        if (r.collapsed) return false;
        const span = owner.createElement("span");
        span.className = "fv-comment-highlight-persist";
        stylePersistSpan(span);
        r.surroundContents(span);
        persistEls.push(span);
        return true;
      } catch {
        return false;
      }
    }
    // Find a text node inside root containing the key (forward or backward).
    function findKeyNode(root: Element | Document, key: string, fromEnd: boolean): Text | null {
      if (!key || key.trim().length < 3) return null;
      try {
        const rootDoc = root instanceof Document ? root : (root.ownerDocument ?? activeDoc());
        const walker = rootDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        let n = walker.nextNode() as Text | null;
        while (n) {
          const parentEl = n.parentElement;
          if (n.nodeValue && n.nodeValue.trim() !== "" && !parentEl?.closest?.(POPUP_SEL)) {
            nodes.push(n);
          }
          n = walker.nextNode() as Text | null;
        }
        const ordered = fromEnd ? [...nodes].reverse() : nodes;
        for (const node of ordered) {
          if (!docHas(rootDoc, node)) continue;
          if (node.parentElement?.closest?.(".fv-comment-highlight-persist")) continue;
          if ((node.nodeValue || "").includes(key)) return node;
        }
      } catch {
        // Ignore lookup failures.
      }
      return null;
    }
    // Rebuild an attached range from saved text when the original range
    // detached (viewer re-render). Uses start/end anchors so fragmented
    // docx runs (one word per span) still resolve to the selected block.
    function reconstructRange(root: Element, text: string): Range | null {
      const norm = text.replace(/\s+/g, " ").trim();
      if (norm.length < 4) return null;
      const words = norm.split(" ").filter((w) => w.length >= 3);
      const startKeys = [norm.slice(0, 12), words[0] || ""].filter((k) => k.trim().length >= 3);
      const endKeys = [norm.slice(-12), words[words.length - 1] || ""].filter((k) => k.trim().length >= 3);
              const rdoc = root.ownerDocument ?? activeDoc();
        for (const sk of startKeys) {
        const startNode = findKeyNode(root, sk, false);
        if (!startNode) continue;
        for (const ek of endKeys) {
          const endNode = findKeyNode(root, ek, true);
          if (!endNode) continue;
          try {
            const r = rdoc.createRange();
            const sVal = startNode.nodeValue || "";
            const eVal = endNode.nodeValue || "";
            const sIdx = Math.max(0, sVal.indexOf(sk));
            const eIdx = eVal.lastIndexOf(ek);
            r.setStart(startNode, sIdx);
            r.setEnd(endNode, eIdx < 0 ? eVal.length : eIdx + ek.length);
            if (!r.collapsed) return r;
          } catch {
            continue;
          }
        }
        // Start found but end not: single-node selection.
        try {
          const r = rdoc.createRange();
          const sVal = startNode.nodeValue || "";
          const sIdx = Math.max(0, sVal.indexOf(sk));
          r.setStart(startNode, sIdx);
          r.setEnd(startNode, Math.min(sVal.length, sIdx + norm.length));
          if (!r.collapsed) return r;
        } catch {
          continue;
        }
      }
      return null;
    }
    // Text fallback when React re-rendered the viewer and detached the saved
    // Range: find distinctive slices of the saved text in the live DOM.
    function wrapByText(text: string): boolean {
      const norm = text.replace(/\s+/g, " ").trim();
      if (norm.length < 4) return false;
      let slices: string[] = [];
      if (norm.length <= 30) slices = [norm];
      else {
        slices = [
          norm.slice(0, 20),
          norm.slice(Math.floor(norm.length / 2) - 10, Math.floor(norm.length / 2) + 10),
          norm.slice(-20),
        ].filter((s) => s.trim().length >= 6);
      }
      let wrapped = false;
      let count = 0;
      try {
        const adoc = activeDoc();
        const walker = adoc.createTreeWalker(adoc.body ?? document.body, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        let n = walker.nextNode() as Text | null;
        while (n) {
          const parentEl = n.parentElement;
          if (n.nodeValue && n.nodeValue.trim() !== "" && !parentEl?.closest?.(POPUP_SEL)) {
            nodes.push(n);
          }
          n = walker.nextNode() as Text | null;
        }
        for (const slice of slices) {
          for (const node of nodes) {
            if (count >= 20) break;
            const v = node.nodeValue || "";
            if (!v.includes(slice)) continue;
            // Skip nodes already wrapped.
            if (node.parentElement?.closest?.(".fv-comment-highlight-persist")) continue;
            if (!adoc.contains(node) && !document.contains(node)) continue;
            if (wrapSubstring(node, slice)) {
              wrapped = true;
              count++;
              break;
            }
          }
          if (count >= 20) break;
        }
      } catch {
        // Ignore lookup failures; quote still flows into the popup.
      }
      return wrapped;
    }
    // Fragmentation-proof fallback: docx viewers often render one word per
    // span, so no single text node contains a multi-word slice. Walk the
    // viewer root in order and find the contiguous word sequence matching
    // the saved selection, then wrap those whole word nodes.
    function wrapByWordSequence(root: Element, text: string): boolean {
      const norm = text.replace(/\s+/g, " ").trim();
      if (norm.length < 2) return false;
      const selWords = norm.split(" ").filter((w) => w.length > 0);
      // Single words repeat everywhere; a first-occurrence highlight would
      // mark the wrong place, so only handle multi-word sequences here.
      if (selWords.length < 2) return false;
      try {
        const wdoc = root.ownerDocument ?? activeDoc();
        const walker = wdoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        let n = walker.nextNode() as Text | null;
        while (n) {
          const parentEl = n.parentElement;
          if (
            n.nodeValue &&
            n.nodeValue.trim() !== "" &&
            !parentEl?.closest?.(POPUP_SEL) &&
            !parentEl?.closest?.(".fv-comment-highlight-persist") &&
            wdoc.contains(n)
          ) {
            nodes.push(n);
          }
          n = walker.nextNode() as Text | null;
        }
        const flat: { w: string; ni: number }[] = [];
        nodes.forEach((node, ni) => {
          const ws = (node.nodeValue || "").replace(/\s+/g, " ").trim().split(" ").filter((w) => w.length > 0);
          for (const w of ws) flat.push({ w, ni });
        });
        if (flat.length === 0) return false;
        let best = -1;
        outer: for (let i = 0; i + selWords.length <= flat.length; i++) {
          for (let j = 0; j < selWords.length; j++) {
            const fw = flat[i + j];
            const sw = selWords[j];
            if (!fw || fw.w !== sw) continue outer;
          }
          best = i;
          break;
        }
        if (best < 0) return false;
        const first = flat[best];
        const last = flat[best + selWords.length - 1];
        if (!first || !last) return false;
        const startNi = first.ni;
        const endNi = last.ni;
        if (endNi - startNi + 1 > 200) return false;
        let wrapped = false;
        // Wrap back-to-front so earlier node references stay valid.
        for (let ni = endNi; ni >= startNi; ni--) {
          try {
            const node = nodes[ni];
            if (!node || !wdoc.contains(node)) continue;
            if (node.parentElement?.closest?.(".fv-comment-highlight-persist")) continue;
            const r = wdoc.createRange();
            r.selectNodeContents(node);
            if (r.collapsed) continue;
            const span = wdoc.createElement("span");
            span.className = "fv-comment-highlight-persist";
            stylePersistSpan(span);
            r.surroundContents(span);
            persistEls.push(span);
            wrapped = true;
          } catch {
            continue;
          }
        }
        return wrapped;
      } catch {
        return false;
      }
    }
    function unwrapPersist(restoreSelection: boolean) {
      for (const el of persistEls) {
        const parent = el.parentNode;
        if (!parent) continue;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        parent.normalize?.();
      }
      persistEls = [];
      if (restoreSelection && lastGoodRange) {
        try {
          const sel = lastGoodDoc?.getSelection?.() ?? window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(lastGoodRange);
        } catch {
          // Stale range after DOM moves; highlight already unwrapped.
        }
      }
    }
    function persistHighlight() {
      // Drop spans wiped by React re-renders so highlight can be re-applied
      // while the popup stays open.
      if (persistEls.length > 0) {
        persistEls = persistEls.filter((el) => document.contains(el) || docHas(activeDoc(), el));
        if (persistEls.length > 0) return;
      }
      // Refresh from the live selection when it is still valid: the popup
      // focuses its textarea on mount, which collapses getSelection() before
      // the observer fires, so the saved clone from selectionchange is the
      // source of truth once focus is stolen.
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const live = sel.getRangeAt(0);
          if (!isInsidePopup(live.commonAncestorContainer)) {
            saveRange(live, sel.toString(), document);
          }
        } else {
          scanIframeSelections();
        }
      } catch {
        // Keep the previously saved range.
      }
      // If the saved range detached (viewer re-rendered), rebuild it from
      // saved text using start/end anchors so fragmented docx runs still
      // resolve, then fall through to range wrapping below.
      if (!lastGoodRange || !docHas(activeDoc(), lastGoodRange.commonAncestorContainer)) {
        const adoc = activeDoc();
        const rootEl =
          lastGoodRoot && docHas(adoc, lastGoodRoot)
            ? lastGoodRoot
            : (adoc.body ?? document.body);
        let rebuilt = false;
        if (lastGoodText && rootEl instanceof Element) {
          try {
            const r = reconstructRange(rootEl, lastGoodText);
            if (r && !r.collapsed) {
              lastGoodRange = r;
              rebuilt = true;
            }
          } catch {
            // Keep text fallback below.
          }
        }
        if (!rebuilt) {
          const adoc2 = activeDoc();
          const viewerRoot =
            (lastGoodRoot && docHas(adoc2, lastGoodRoot) ? lastGoodRoot : null) ??
            adoc2.querySelector(".file-viewer-doc, .fv-sheet-wrap, .fv-grid-doc, [data-file-viewer]") ??
            document.querySelector(".file-viewer-doc, .fv-sheet-wrap, .fv-grid-doc, [data-file-viewer]") ??
            adoc2.body ??
            document.body;
          // Word-sequence first: it matches fragmented single-word runs
          // precisely; anchor/text-slice search follows as backup.
          if (lastGoodText && viewerRoot instanceof Element && wrapByWordSequence(viewerRoot, lastGoodText)) return;
          if (lastGoodText && wrapByText(lastGoodText)) return;
          if (!lastGoodRange) return;
          try {
            if (!docHas(activeDoc(), lastGoodRange.commonAncestorContainer)) return;
          } catch {
            return;
          }
        }
      }
      const range = lastGoodRange;
      if (!range) return;
      // Prefer the saved viewer root: the narrow commonAncestor is often a
      // single word span in fragmented docx runs, which would hide the rest
      // of the selection from the candidate scan below.
      let root: Element | null = null;
      if (lastGoodRoot && document.contains(lastGoodRoot)) {
        root = lastGoodRoot;
      } else {
        const ancestor = range.commonAncestorContainer;
        root = ancestor instanceof Element ? ancestor : ancestor.parentElement;
      }
      if (!root || (!document.contains(root) && !docHas(activeDoc(), root))) return;
      let candidates: Text[] = [];
      try {
        const cdoc = root.ownerDocument ?? activeDoc();
        const walker = cdoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;
        while (node) {
          try {
            if (
              node.nodeValue &&
              node.nodeValue.trim() !== "" &&
              range.intersectsNode(node)
            ) {
              const parentEl = node.parentElement;
              if (
                !parentEl?.closest?.(
                  ".fv-comment-pop, .fv-comment-float, .fv-comment-input",
                )
              ) {
                candidates.push(node);
              }
            }
          } catch {
            // Skip nodes that cannot be tested.
          }
          node = walker.nextNode() as Text | null;
        }
      } catch {
        candidates = [];
      }
      // Single text node fast path: surroundContents works when the range
      // sits inside one node.
      if (candidates.length === 0) {
        if (lastGoodText && root instanceof Element && wrapByWordSequence(root, lastGoodText)) return;
        try {
          const span = (range.startContainer.ownerDocument ?? activeDoc()).createElement("span");
          span.className = "fv-comment-highlight-persist";
          stylePersistSpan(span);
          range.surroundContents(span);
          persistEls.push(span);
        } catch {
          // Partially-selected non-text nodes cannot be surrounded; the saved
          // text still flows into the popup quote instead of throwing.
        }
        return;
      }
      for (const textNode of candidates) {
        try {
          const sub = (textNode.ownerDocument ?? activeDoc()).createRange();
          sub.selectNodeContents(textNode);
          if (
            textNode === range.startContainer &&
            textNode === range.endContainer
          ) {
            sub.setStart(textNode, range.startOffset);
            sub.setEnd(textNode, range.endOffset);
          } else if (textNode === range.startContainer) {
            sub.setStart(textNode, range.startOffset);
            sub.setEnd(textNode, textNode.length);
          } else if (textNode === range.endContainer) {
            sub.setStart(textNode, 0);
            sub.setEnd(textNode, range.endOffset);
          } else if (
            range.compareBoundaryPoints(Range.END_TO_START, sub) <= 0 ||
            range.compareBoundaryPoints(Range.START_TO_END, sub) >= 0
          ) {
            continue;
          }
          if (sub.collapsed) continue;
          const span = (textNode.ownerDocument ?? activeDoc()).createElement("span");
          span.className = "fv-comment-highlight-persist";
          stylePersistSpan(span);
          sub.surroundContents(span);
          persistEls.push(span);
        } catch {
          continue;
        }
      }
    }
    function clampCommentPopup(popup: HTMLElement) {
      // Measure after layout so offsetWidth/offsetHeight are valid.
      requestAnimationFrame(() => {
        const rect = popup.getBoundingClientRect();
        const rawLeft = popup.style.left ? Number.parseFloat(popup.style.left) : rect.left;
        const rawTop = popup.style.top ? Number.parseFloat(popup.style.top) : rect.top;
        const x = Number.isFinite(rawLeft) ? rawLeft : rect.left;
        const y = Number.isFinite(rawTop) ? rawTop : rect.top;
        const clampedLeft = Math.max(8, Math.min(x, window.innerWidth - popup.offsetWidth - 8));
        const clampedTop = Math.max(8, Math.min(y, window.innerHeight - popup.offsetHeight - 8));
        popup.style.left = `${clampedLeft}px`;
        popup.style.top = `${clampedTop}px`;
      });
      persistHighlight();
    }
    function scan(root: ParentNode) {
      const popups = root.querySelectorAll?.(".fv-comment-pop, .fv-comment-float, .fv-comment-box");
      popups?.forEach((el) => clampCommentPopup(el as HTMLElement));
    }
    function scanRemoved(node: Node) {
      if (!(node instanceof HTMLElement)) return false;
      if (node.matches?.(".fv-comment-pop, .fv-comment-float, .fv-comment-box")) return true;
      return !!node.querySelector?.(".fv-comment-pop, .fv-comment-float, .fv-comment-box");
    }
    scan(document.body);
    const observer = new MutationObserver((mutations) => {
      let sawAdd = false;
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches?.(".fv-comment-pop, .fv-comment-float, .fv-comment-box")) {
            sawAdd = true;
            clampCommentPopup(node);
          } else scan(node);
        });
        let popupClosed = false;
        mutation.removedNodes.forEach((node) => {
          if (scanRemoved(node)) popupClosed = true;
        });
        if (popupClosed) unwrapPersist(true);
      }
      // Viewer re-render wiped our spans while popup stays open: re-apply.
      if (!sawAdd && popupOpen()) {
        const live = persistEls.filter((el) => document.contains(el) || docHas(activeDoc(), el));
        if (live.length === 0) persistHighlight();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    function onResize() {
      scan(document.body);
    }
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onPopupMouseDown, true);
    document.addEventListener("mouseup", onDocMouseUp);
    document.addEventListener("focusin", onPopupFocusIn);
    window.addEventListener("resize", onResize);
    ensureIframeListeners();
    return () => {
      observer.disconnect();
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onPopupMouseDown, true);
      document.removeEventListener("mouseup", onDocMouseUp);
      document.removeEventListener("focusin", onPopupFocusIn);
      window.removeEventListener("resize", onResize);
      unwrapPersist(false);
    };
  }, []);
  const ctxPopoverOpen = isContextPopoverOpen(
    ctxPopoverChatId,
    activeChatId,
    contextUsed,
  );
  const ctxBreakdown = useMemo(() => {
    if (!ctxPopoverOpen) return null;
    // Real per-turn sizes from the backend's ctx_parts event win: they cover
    // the system prompt TAIL (workspace note / saved plan / …), the full
    // skills section (catalog + @mentioned + auto-picked) and the bound MCP
    // tool schemas — none of which the frontend can measure on its own.
    const real = ctxPartsByChat[chat?.id ?? ""];
    if (real && chat) {
      return buildContextBreakdown(chat, systemPrompt, usable ?? ctxWindow, {
        systemPromptChars: real.systemChars,
        skillsChars: real.skillsChars,
        mcpChars: real.mcpChars,
        systemToolsChars: real.systemToolsChars,
      });
    }
    // Fallback estimate (before the first turn reports): the AVAILABLE
    // SKILLS catalog is always sent (- name: desc per line) plus the bodies
    // of the skills @mentioned in the draft; MCP counts its connector config.
    const mentioned = extractMentionSkills(input, skillsList).skills;
    let skillsChars = 0;
    for (const s of skillsList) {
      skillsChars += s.description
        ? 5 + s.name.length + s.description.length
        : 3 + s.name.length;
    }
    for (const name of mentioned) {
      const row = skillsList.find((s) => s.name === name || s.slug === name);
      if (row) skillsChars += row.content.length;
    }
    const mcpCfg = settings.mcpServers ?? {};
    let mcpChars = 0;
    for (const name of mcpEnabled) {
      const cfg = mcpCfg[name];
      if (cfg) mcpChars += JSON.stringify(cfg).length;
    }
    return buildContextBreakdown(chat, systemPrompt, usable ?? ctxWindow, {
      skillsChars,
      mcpChars,
    });
  }, [
    ctxPopoverOpen,
    ctxPartsByChat,
    chat,
    systemPrompt,
    usable,
    input,
    skillsList,
    mcpEnabled,
    settings.mcpServers,
  ]);

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
    // Persistent goal: when active and not paused, the condition rides along
    // with every model prompt (the visible bubble stays clean). `stopped`
    // does NOT detach the goal — a manual send after Stop still pursues it.
    const activeGoalForSend = chat.goal?.active && !chat.goal.paused ? chat.goal : null;
    // Codex-style re-arm: an explicit user turn (anything except the loop's
    // own "Continue working on the persistent goal" ping) clears the Stop
    // halt so the loop can drive again after this turn judges CONTINUES.
    const isGoalLoopPing =
      typeof text === "string" && text.startsWith("Continue working on the persistent goal:");
    if (!isGoalLoopPing && chat.goal?.active && !chat.goal.paused && chat.goal.stopped) {
      try {
        s.rearmGoal(chat.id);
      } catch {
        /* ignore */
      }
    }
    if (activeGoalForSend) {
      try {
        s.incrementGoalTurn(chat.id);
      } catch {
        /* ignore */
      }
    }
    const sendImgs = cleanImagesForSend(imgs);
    stoppedMapRef.current.set(chatId, false);
    // Fresh turn: invalidate any retry armed by the previous turn and allow
    // auto-retry again (an explicit Stop bumps the epoch via stop() below).
    autoRetryFor(chatId).beginTurn();
    // Per-turn local state (was shared refs — now locals so concurrent chats
    // don't race). stop() coordinates via stoppedMapRef + chatAborts store.
    let mcpChanged = false;
    // Messages that ask to create/install skills or MCP connectors also grant
    // the create_skill/create_mcp tools — in EVERY mode (ask, plan, build).
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
    // Plan mode gets NO note (buildResumeNote): its checklist IS the draft
    // plan, so "PRESERVE, do not create a new one" contradicted the mode's
    // revise contract — the planner then never emitted a revised plan_card
    // and the todos never updated.
    const resumeNote = buildResumeNote(chat.messages, chat.mode);
    const promptWithResume = resumeNote
      ? `${finalPrompt}\n\n${resumeNote}`
      : finalPrompt;
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
        images: sendImgs,
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
        // Re-send images carried by earlier user messages so the backend can
        // re-analyze them (vision-cached by content) — without this the model
        // "forgets" an attached image on the very next turn.
        ...(m.images?.length
          ? {
              images: m.images.flatMap(
                (i): Array<string | { path: string; dataUrl: string }> => {
                  if (!i.dataUrl) return [i.path];
                  const clean = sanitizeImageDataUrl(i.dataUrl);
                  return clean ? [{ path: i.path, dataUrl: clean }] : [];
                },
              ),
            }
          : {}),
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
    let lastContentAtMs = Date.now();
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

    // Batched stream rendering: text tokens can arrive many times per second
    // and each updateMessage triggers a zustand set + transcript render.
    // Buffer text chunks and flush at most every 75ms (~13 renders/sec)
    // instead of once per token. Non-text events flush first so tool and
    // status updates never wait behind the batch window. The final flush runs
    // in handleEvent (non-text branch) and in the `finally` block below, so
    // no buffered text is ever lost on abort.
    let pendingText = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPendingText = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pendingText) return;
      const chunk = pendingText;
      pendingText = "";
      const cur = useStore
        .getState()
        .chats.find((c) => c.id === chat.id)
        ?.messages.find((m) => m.id === assistantMsg.id);
      const prev = cur?.content ?? "";
      const clean = stripLeadingModeTag(chunk, prev);
      if (!clean) return;
      useStore.getState().updateMessage(assistantMsg.id, {
        content: prev + clean,
        segments: appendTextSegment(cur?.segments, clean),
        ...(cur?.retry?.fallback === true ? {} : { retry: null }),
        thinkingActive: false,
        statusText: undefined,
        lspStatus: undefined,
      });
    };
    const queueTextChunk = (chunk: string) => {
      if (!chunk) return;
      pendingText += chunk;
      if (!flushTimer) {
        flushTimer = setTimeout(flushPendingText, 75);
      }
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
      const turnStart = prev?.workingStartedAt ?? Date.now();
      assistantMsg = s.addMessage(chat.id, {
        role: "assistant",
        content: "",
        mode: mode ?? chat.mode,
        toolActivity: [],
        segments: [],
        streaming: true,
        workingStartedAt: turnStart,
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
      // An explicit Stop cancels all auto-retry: never re-arm the retry banner
      // or schedule a resend after the user stopped this chat. Without this, a
      // tick queued before the abort fires afterwards and the banner comes back.
      if (autoRetryFor(chat.id).isStopped) return;
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
      // Content stall while the socket stays alive via keepalives: a wedged
      // provider stream would otherwise show "waiting for model" forever.
      // Thinking models are exempt — reasoning silence is legitimate no matter
      // how long it runs. Permission/ask pauses return early above.
      const thinkingNowEarly =
        useStore
          .getState()
          .chats.find((c) => c.id === chat.id)
          ?.messages.find((m) => m.id === assistantMsg.id)
          ?.thinkingActive === true;
      const contentLimit = isToolRunning(toolRunning)
        ? 900_000
        : 300_000;
      const elapsed = Date.now() - lastEventAtMs;
      const contentElapsed = Date.now() - lastContentAtMs;
      // Content-stall recovery: keepalives keep the socket clock fresh, so a
      // wedged stream (model silent, socket alive) never reaches the dead-
      // socket path below. Once content has been stale past the limit while the
      // socket is still "alive", treat it as stalled and fall through to the
      // auto-retry path instead of showing the pill forever.
      const contentStalled = thinkingNowEarly
        ? false
        : shouldRecoverContentStall(
            contentElapsed,
            elapsed,
            contentLimit,
          );
      // Active thinking is legitimate silence, however long the reasoning
      // pass runs: while the thinking window is open the per-message thinking
      // indicator already explains the wait, so the watchdog must not consider
      // it at all — no pill, no content-stall recovery. Only a truly dead
      // socket (no keepalives either, i.e. the backend itself is gone) still
      // falls through to the stall path below; thinking does not keep a dead
      // connection alive.
      const thinkingNow =
        chatState?.messages.find((m) => m.id === assistantMsg.id)
          ?.thinkingActive === true;
      // Early feedback (not a retry): after 25s without REAL content the Working
      // pill explains the wait instead of looking frozen. Keepalives refresh
      // only the socket clock, so a long silent non-thinking wait still shows
      // the pill. Cleared by any real event via statusText: undefined in
      // handlers. Include elapsed seconds and refresh it so a multi-minute
      // model wait visibly ticks instead of looking stuck.
      if (
        shouldShowWaitingForModel(contentElapsed, elapsed, limit) &&
        !contentStalled &&
        !thinkingNow
      ) {
        const cur = useStore
          .getState()
          .chats.find((c) => c.id === chat.id)
          ?.messages.find((m) => m.id === assistantMsg.id);
        if (cur && !cur.retry) {
          const secs = Math.floor(contentElapsed / 1000);
          const label = isToolRunning(toolRunning)
            ? `tool running (${secs}s)`
            : `waiting for model (${secs}s)`;
          if (cur.statusText !== label) {
            useStore.getState().updateMessage(assistantMsg.id, {
              statusText: label,
            });
          }
        }
        return;
      }
      if (elapsed <= limit && !contentStalled) {
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
          // Epoch-guarded: dropped when Stop bumps the epoch before it fires.
          autoRetryFor(originId).schedule(0, () =>
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
      // Token saver: keep this block tiny — it is re-sent on every later
      // request. Tool outputs already live in history as ToolMessages, so only
      // fold a short per-tool summary here (no item rows, no file bodies).
      const MAX_ITEMS = 5;
      const MAX_SUMMARY_CHARS = 200;
      const MAX_BLOCK_CHARS = 2000;
      const blocks: string[] = [];
      for (const a of doneActs.slice(0, MAX_ITEMS)) {
        const raw = a.summary ? `: ${a.summary}` : "";
        const clipped =
          raw.length > MAX_SUMMARY_CHARS
            ? `${raw.slice(0, MAX_SUMMARY_CHARS)}…`
            : raw;
        blocks.push(`- ${a.tool}${clipped}`);
      }
      if (doneActs.length > MAX_ITEMS) {
        blocks.push(`- …and ${doneActs.length - MAX_ITEMS} more (see history)`);
      }
      // Written to a non-visible field so the model still sees what was done
      // (avoids re-executing completed tools) but the visible transcript stays
      // clean — small/free models on opencode misread the inlined warning as
      // a new instruction, which looked like an instant disconnect.
      let summary = `[Interrupted before finishing. Already done this turn — do NOT repeat these:\n${blocks.join("\n")}]`;
      if (summary.length > MAX_BLOCK_CHARS) {
        summary = `${summary.slice(0, MAX_BLOCK_CHARS)}…]`;
      }
      useStore.getState().updateMessage(assistantMsg.id, {
        preservedToolSummary: summary,
      });
    };

    const handleEvent = (event: SidecarEvent) => {
      // Heartbeat from the backend: it arrives every ~15s while the agent is
      // legitimately silent (running a tool / thinking). Refresh only the socket
      // clock so a long-running tool is NOT mistaken for a dead connection —
      // only a socket that stops emitting keepalives (a genuinely dead one)
      // should trip the stall watchdog. The content clock is untouched so the
      // "waiting for model" pill still appears during long silent thinking.
      if (event.kind === "keepalive") {
        lastEventAtMs = Date.now();
        return;
      }
      lastEventAtMs = Date.now();
      lastContentAtMs = Date.now();
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
      // Batched text must land before any tool/status/retry update, so cards
      // never render ahead of the prose that preceded them.
      if (event.kind !== "text") flushPendingText();
      if (event.kind === "text") {
        // Keep the current "isThinking" flag untouched — a text chunk must not
        // cancel the composer glow while the model is still reasoning.
        useStore.getState().setStreaming(true, useStore.getState().isThinking);
        // Flush text buffered for the previous bubble before rotating, so it
        // lands on the sealed bubble instead of the fresh one.
        if (bubbleSealed) flushPendingText();
        ensureLiveBubble();
        // Buffer raw chunks and flush at most every 75ms (see queueTextChunk
        // above) instead of one store update per token.
        queueTextChunk(event.content ?? "");
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
          // Sub-agent fallback notice survives: it explains which model to fix.
          ...(findMsg()?.retry?.fallback === true ? {} : { retry: null }),
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
        // AUTO-matched skills (manual:false) are different: the user wants to
        // see which skills the decision router picked, so they are stamped on
        // the assistant message and rendered as chips under its bubble.
        if (!event.manual && event.skills && event.skills.length > 0) {
          store.updateMessage(assistantMsg.id, { autoSkills: event.skills });
        }
        if (event.note) {
          useStore.getState().setChatSkillNotice(chat.id, event.note);
        }
      } else if (event.kind === "mcp") {
        // Deliberately NOT rendered into the chat (same reason as "skill"
        // above): the active MCP servers are already listed in the prompt's
        // USER-SELECTED SKILLS/TOOLS section, so the note is redundant UI.
      } else if (event.kind === "ctx_parts") {
        // Real part sizes for the context popover. Route by the backend's
        // chat_id (never the viewed chat): a sub-agent building its context
        // must not overwrite the parent's row, and a background drain must
        // not land on the chat the user happens to be viewing. No mode guard:
        // the latest reported sizes win even if the mode switched mid-turn,
        // otherwise the popover sticks at System tools 0.
        const p = event as unknown as CtxParts;
        const targetId = p.chat_id || chat?.id || "";
        if (!targetId) return;
        setCtxPartsByChat((prev) => ({ ...prev, [targetId]: p }));
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
        // Codex-style: the first browser tool call of a turn docks the Browser
        // viewer tab on the right so the user watches the shared session live.
        if ((event.tool ?? "").startsWith("browser_")) {
          const browserVt = useViewerTabs.getState();
          if (!browserVt.tabs.some((t) => t.kind === "browser" && t.chatId === chat.id))
            browserVt.openBrowser(chat.id);
        }
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
              ...(findMsg()?.retry?.fallback === true ? {} : { retry: null }),
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
        // Live document preview: a finished write_document bumps the file's
        // revision so an open right-panel viewer re-fetches immediately.
        if (event.tool === "write_document") {
          const p = (event as { path?: unknown }).path;
          if (typeof p === "string" && p) {
            const abs = p.startsWith("/")
              ? p
              : `${chat.root || useStore.getState().root}/${p.replace(/^\/+/, "")}`;
            store.bumpDocRev(abs);
          }
        }
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
        // Match a diff event to its tool card: when two edit_file/write_file
        // calls run concurrently, matching on tool name alone attaches the
        // diff to both cards. The backend sends path, so match on path first
        // and fall back to the legacy tool+running match when no card matches
        // (e.g. mid-turn reconnected stream).
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
        // Live viewer refresh for plain text writes too (the diff carries the
        // path; an open right-panel viewer re-fetches if it shows this file).
        if (typeof event.path === "string" && event.path) {
          const abs = event.path.startsWith("/")
            ? event.path
            : `${chat.root || useStore.getState().root}/${event.path.replace(/^\/+/, "")}`;
          store.bumpDocRev(abs);
        }
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
          // Queued messages during compact are delivered only after compact ends.
          // Epoch-guarded so an explicit Stop drops the drain.
          autoRetryFor(chat.id).schedule(0, () => {
            if (!sendPendingSteerNext(chat.id)) sendQueuedNext(chat.id);
          });
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
        // Drain the queue even on compact failure so no user message is lost.
        // Epoch-guarded so an explicit Stop drops the drain.
        autoRetryFor(chat.id).schedule(0, () => {
          if (!sendPendingSteerNext(chat.id)) sendQueuedNext(chat.id);
        });
      } else if (event.kind === "plan") {
        // Backend emits the authoritative merged checklist (preserves completed,
        // handles steer edits/removals). Replace — never merge stale extras back.
        const incoming = event.items ?? [];
        store.updateMessage(assistantMsg.id, {
          plan: incoming,
          retry: null,
        });
        // The right panel never opens automatically, even with a fresh todo;
        // only the user opens it via button/shortcut.
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
          // Auto-open the docked Plan viewer tab on create and on every
          // revision so the newest plan replaces the previous one on the right.
          // Focus the chat that produced the plan: viewer tabs are chat-scoped,
          // so without focusing the plan tab stays invisible (and the panel
          // looks empty) while another chat is active.
          try {
            useViewerTabs.getState().openPlan(chat.id);
            const st = useStore.getState();
            if (st.activeChatId !== chat.id) st.focusWindow(chat.id);
          } catch {
            // Viewer open must never break the stream.
          }
        }
      } else if (event.kind === "mode_changed") {
        // Backend switched the workflow mode mid-run (plan approval → build).
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
        // Backend options may be non-strings (object/array/null). Coerce all
        // to string so prepareContent never crashes.
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
        playAlarm("alert");
      } else if (event.kind === "error") {
        // A late backend error arriving after an explicit Stop must not re-arm
        // the retry banner — the user already cancelled this turn.
        if (shouldIgnoreLateRetryEvent(stoppedMapRef.current.get(chat.id) === true)) return;
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
        // model, retrying, LSP install/update). Shown in the Working pill so
        // a slow turn does not look frozen. Cleared on first real
        // text/tool/thinking content or turn done.
        lastEventAtMs = Date.now();
        lastContentAtMs = Date.now();
        ensureLiveBubble();
        const label =
          typeof event.content === "string" && event.content.trim()
            ? event.content.trim().slice(0, 120)
            : typeof (event as { stage?: unknown }).stage === "string"
              ? String((event as { stage?: unknown }).stage).slice(0, 120)
              : "Working";
        const lsp = lspStatusFromEvent(event as { stage?: string; tool?: string; status?: string; summary?: string; content?: string; language?: string });
        if (lsp) {
          if (lsp.phase === "done" || lsp.phase === "error") {
            useStore.getState().updateMessage(assistantMsg.id, { statusText: undefined, lspStatus: undefined });
          } else {
            useStore.getState().updateMessage(assistantMsg.id, { statusText: label, lspStatus: lsp });
          }
        } else {
          useStore.getState().updateMessage(assistantMsg.id, { statusText: label });
        }
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
        store.accrueChatUsage(chat.id, providerId, model, {
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
        lastContentAtMs = Date.now();
        // Flush any buffered text before resolving cards, so the final
        // content is complete before the turn closes.
        flushPendingText();
        resolveStuckCards();
        useStore.getState().updateMessage(assistantMsg.id, { statusText: undefined, lspStatus: undefined });
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
          const isTerminal = r.gaveUp === true || r.watchdog === true || r.fallback === true;
          const isFailedTurn = curMsg.error === true;
          if (!isTerminal && !isFailedTurn) {
            useStore.getState().updateMessage(assistantMsg.id, { retry: null });
          }
        }
        // Turn-finished alarm: the error sound when the turn ended in a backend
        // failure (an inline `error` event always precedes this `done`
        // sentinel), the alert sound on a successful completion.
        playAlarm(curMsg?.error === true ? "error" : "alert");
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
          prompt: activeGoalForSend ? `[Active goal: ${activeGoalForSend.condition}] ${promptWithResume}` : promptWithResume,
          history,
          attachments: atts.map((a) =>
            // Imported (outside-workspace) files arrive as absolute paths and
            // are sent as-is; workspace-relative ones get the root prefix.
            /^(\/|[a-zA-Z]:[\\/])/.test(a)
              ? a
              : `${rootDir}/${a.replace(/^\/+/, "")}`,
          ),
          images: sendImgs.map((i) =>
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
          allowComputer: s.computerUse,
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
          restart: overrides?.restart ?? false,
          goal: activeGoalForSend?.condition ?? null,
          goalTurns: typeof activeGoalForSend?.turns === "number" ? activeGoalForSend.turns : 0,
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
        playAlarm("error");
      } else if ((err as Error).name !== "AbortError") {
        handleEvent({ kind: "error", content: (err as Error).message });
        preserveToolActivity();
        playAlarm("error");
      } else {
        // User-initiated Stop: the request was simply cancelled (no
        // retry/resume loop). Folding the completed tool calls into content is
        // handled by preserveToolActivity() above so the next turn knows what
        // was already done.
        preserveToolActivity();
      }
    } finally {
      clearInterval(stallTimer);
      // Final flush: buffered text must land even on abort/error, otherwise
      // the last ~75ms of tokens would be lost when the stream throws.
      flushPendingText();
      // Neutralize any stall-timer callback already queued: with a fresh clock
      // its 180s check can't fire and re-show "Still waiting" after the stream
      // has actually ended.
      lastEventAtMs = Date.now();
      lastContentAtMs = Date.now();
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
          // Epoch-guarded: an explicit Stop drops this drain instead of
          // restarting the turn the user just cancelled.
          autoRetryFor(chat.id).schedule(0, () => sendPendingSteerNext(chat.id));
        } else {
          const remaining = cNow.queued?.filter((q) => !q.sent);
          if (remaining && remaining.length > 0) {
            autoRetryFor(chat.id).schedule(0, () => sendQueuedNext(chat.id));
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
      // Drain the queue even on manual compact failure so no user message is lost.
      // Epoch-guarded so an explicit Stop drops the drain.
      autoRetryFor(ch.id).schedule(0, () => {
        if (!sendPendingSteerNext(ch.id)) sendQueuedNext(ch.id);
      });
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
    // Queued messages during manual compact are delivered only after compact ends.
    // Epoch-guarded so an explicit Stop drops the drain.
    autoRetryFor(ch.id).schedule(0, () => {
      if (!sendPendingSteerNext(ch.id)) sendQueuedNext(ch.id);
    });
    // Stay where the user is (normally the bottom, where the live conversation
    // continues). The messages-change effect below keeps the view pinned to
    // the bottom; do NOT yank the view up to the summary — that reads as the
    // chat "suddenly scrolling to top" after every compact.
  };

  const handleCommand = async (v: string) => {
    const s = useStore.getState();
    const ch = s.chats.find((c) => c.id === s.activeChatId);
    // Slash commands stay out of the prompt history (they have their own
    // recent-use popup); pins are managed separately.
    const parsed = parseSlashInput(v);
    const word = parsed && parsed.name ? `/${parsed.name}` : v.split(/\s+/)[0].toLowerCase();
    // Track usage only for known commands so typos never pollute the popup order.
    // Compute from localStorage (the source of truth) instead of inside a
    // state updater, so the write + cross-window broadcast run exactly once.
    if (COMMANDS.some((c) => `/${c.name}` === word)) {
      setCommandUsage(recordCommandUsage(v));
    }
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
      case "/plan": {
        // Codex-style entry to Plan mode: switch the chat, then either wait
        // for the request (`/plan` alone) or plan the given text right away.
        if (ch) s.setChatMode(ch.id, "plan");
        const rest = v.slice("/plan".length).trim();
        if (!rest) {
          s.addMessage(ch?.id ?? "", {
            role: "assistant",
            content:
              "Plan mode selected — describe what to plan. I will scout the code and lay out the steps without changing anything.",
          });
          break;
        }
        const created = s.addMessage(ch?.id ?? "", {
          role: "user",
          content: rest,
          ...(ch ? { mode: "plan" as AgentMode } : {}),
        });
        void send(rest, [], [], false, created.id);
        break;
      }
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
        // Store the pretty label (no leading slash) as the visible bubble;
        // send() reuses this bubble but posts the full prompt to the model.
        const created = s.addMessage(ch?.id ?? "", {
          role: "user",
          content: prettySlashLabel(v),
          ...(ch?.mode ? { mode: ch.mode } : {}),
        });
        void send(
          target === "skill"
            ? `Create a new skill or edit an existing one from this description: "${rest}". If it names or describes an existing skill, first call load_skill to read its current instructions, then call create_skill with the SAME name to overwrite it with the updated instructions. Otherwise use the create_skill tool to set it up with a good name/slug and the instructions. Ask me only for anything essential that is genuinely missing; otherwise just create or update it. Do not modify files outside creating/editing this skill.`
            : `Create a new MCP connector from this description: "${rest}". Use the create_mcp tool to add it, choosing a good name and command/URL/config that fits the description. Ask me only for anything essential that is genuinely missing; otherwise just create it. Do not modify files for this.`,
          [],
          [],
          true,
          created.id,
        );
        break;
      }
      case "/goal": {
        const rest = v.slice("/goal".length).trim();
        if (!ch) break;
        if (!rest) {
          const g = ch.goal;
          s.addMessage(ch.id, {
            role: "assistant",
            content:
              g?.active
                ? `Current goal: "${g.condition}"${g.paused ? " (paused)" : " (active)"}${typeof g.turns === "number" ? ` — ${g.turns} turn(s)` : ""}. Use \`/goal clear\` to clear it, \`/goal <condition>\` to replace it.`
                : "No active goal. Set one with `/goal <condition>` — e.g. `/goal all tests pass`.",
          });
          break;
        }
        if (rest === "clear") {
          s.clearGoal(ch.id);
          s.addMessage(ch.id, { role: "assistant", content: "Goal cleared." });
          break;
        }
        s.setGoal(ch.id, rest);
        // A persistent goal needs write access to make progress, so move
        // an ask/plan chat to build automatically when a goal starts.
        if (ch.mode !== "build") {
          s.setChatMode(ch.id, "build");
        }
        const created = s.addMessage(ch.id, {
          role: "user",
          content: prettySlashLabel(v),
          mode: "build",
        });
        void send(
          `Follow this persistent goal until it is done or cleared: "${rest}". Treat it as a standing directive for every turn.`,
          [],
          [],
          false,
          created.id,
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
      // Epoch-guarded: dropped when Stop bumps the epoch before it fires.
      autoRetryFor(targetId).schedule(0, () =>
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
      // Epoch-guarded: dropped when Stop bumps the epoch before it fires.
      autoRetryFor(targetId).schedule(0, () =>
        send(text, atts, imgs, false, undefined, undefined, false, undefined, targetId),
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
      // Resolve the prompt to re-send via the shared helper (same rule as
      // resolveRestartUser tests): a user id restarts its own turn, an
      // assistant id restarts the user turn above it.
      const userMsg = resolveRestartUser(ch.messages, id);
      if (!userMsg) return;
      // ALWAYS truncate-and-restart from the OWNING user message (not `id`):
      // truncating to an assistant `id` would keep the user prompt above AND
      // send() would append a second identical user bubble — the duplicate
      // user message reported. Truncating to userMsg.id removes the turn and
      // send() recreates exactly one user bubble from scratch.
      if (!s.truncateTo(userMsg.id)) return;
      const text = userMsg.content;
      // Give the abort's finally block a tick to reset busy/streaming state
      // before re-sending (send() re-sets busy=true itself, but the abort's
      // finally would otherwise clear it mid-run). Pin origin chat.
      // restart=true clears the backend checkpoint so old tool work is NOT replayed.
      {
        const targetId = ch.id;
        const atts = userMsg.attachments ?? [];
        const imgs = userMsg.images ?? [];
        // Epoch-guarded: dropped when Stop bumps the epoch before it fires.
        autoRetryFor(targetId).schedule(0, () =>
          send(text, atts, imgs, false, undefined, undefined, false, { restart: true }, targetId),
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

  // Edit-and-resubmit: replace a user message's text and regenerate from there.
  // Cancels any active stream, truncates history up to the edited user message,
  // then resends the new text with the same attachments (restart=true clears
  // the backend checkpoint so the turn runs fresh, like regenerate).
  const handleEditMessage = useCallback(
    (id: string, newText: string) => {
      const text = newText.trim();
      if (!text) return;
      const originId = chatIdRef.current;
      const active = useStore.getState().chatAborts[originId];
      if (active && !active.signal.aborted) {
        active.abort();
      }
      const s = useStore.getState();
      const ch = s.chats.find((c) => c.id === originId);
      if (!ch) return;
      const userMsg = resolveRestartUser(ch.messages, id);
      if (!userMsg) return;
      if (!s.truncateTo(userMsg.id)) return;
      const targetId = ch.id;
      const atts = userMsg.attachments ?? [];
      const imgs = userMsg.images ?? [];
      // Epoch-guarded: dropped when Stop bumps the epoch before it fires.
      autoRetryFor(targetId).schedule(0, () =>
        send(text, atts, imgs, false, undefined, undefined, false, { restart: true }, targetId),
      );
    },
    [send],
  );

  // Stable identity for memoized children, same pattern as onRetry above.
  const handleEditMessageRef = useRef(handleEditMessage);
  handleEditMessageRef.current = handleEditMessage;

  const onEdit = useMemo(
    () => (id: string, newText: string) => handleEditMessageRef.current(id, newText),
    [],
  );

  // Queue edit (not yet sent): update the queued text in place — no
  // truncate/resend. Order-preserving: queueMessage appends, so a plain
  // remove + add would move the edited item to the end; instead remove all
  // unsent items and re-queue them in the same order with the edited text
  // swapped in (editQueuedText is the pure, unit-tested swap).
  const handleEditQueued = useCallback((id: string, newText: string) => {
    const originId = chatIdRef.current;
    const s = useStore.getState();
    const ch = s.chats.find((c) => c.id === originId);
    if (!ch) return;
    const items = (ch.queued ?? []).filter((q) => !q.sent);
    const next = editQueuedText(items, id, newText);
    if (!next) return;
    for (const q of items) s.removeQueuedMessage(originId, q.id);
    for (const q of next) s.queueMessage(originId, { ...q });
  }, []);

  // Stable identity for memoized children, same pattern as onEdit above.
  const handleEditQueuedRef = useRef(handleEditQueued);
  handleEditQueuedRef.current = handleEditQueued;

  const onEditQueued = useMemo(
    () => (id: string, newText: string) => handleEditQueuedRef.current(id, newText),
    [],
  );

  const submit = (overrideText?: string) => {
    const typed = (overrideText ?? input).trim();
    if (!typed && pastedBlocks.length === 0 && images.length === 0 && !activeQuote) return;
    // Record plain prompts so ArrowUp recalls them; slash commands and
    // skill mentions stay out (they have their own recent-use popups).
    if (typed && !typed.startsWith("/")) {
      const hasSkill = extractMentionSkills(typed, getSkillsList()).skills.length > 0;
      if (!hasSkill) {
        setPromptHistory((prev) => recordHistory(typed, prev));
      }
    }
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
    // Record skill uses so the @mention popup sorts recent-first.
    if (selectedSkills.length > 0) {
      const list = getSkillsList();
      let usage = loadSkillUsage();
      for (const nm of selectedSkills) {
        const hit = list.find((s) => s.name === nm);
        usage = recordSkillUsage(hit ? hit.slug || hit.name : nm, usage);
      }
      setSkillUsage(usage);
    }
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
      setActiveQuote(null);
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
    // NOTE: read streaming state fresh from the store (not the render closure)
    // so dictate auto-send during streaming still steers even when the closure
    // is stale (e.g. recording started before the turn began).
    const freshChatForSteer = ss.chats.find((c) => c.id === chatObj.id);
    const freshStreaming = freshChatForSteer?.messages.some((m) => m.streaming) ?? chatHasStreaming;
    if (freshStreaming) {
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
      setActiveQuote(null);
      setCmdOpen(null);
      forceScrollToBottom();
      // Mid-run steer must carry the active goal so the agent keeps working
      // toward it instead of dropping it after the steer turn. The visible
      // bubble keeps the raw text; only the steer prompt is prefixed.
      const steerPrompt = chatObj.goal?.active && !chatObj.goal.paused && v.trim().length > 0 && !v.trim().startsWith("/goal")
        ? `[Active goal: ${chatObj.goal.condition}] ${v}`
        : v;
      void steerChat(chatObj.id, userMsg.id, steerPrompt, atts, cleanImagesForSend(imgs), {
        mcpServers: selectedMcpServers,
        skills: selectedSkills,
      });
      return;
    }
    setInput("");
    setPastedBlocks([]);
    setActiveQuote(null);
    setCmdOpen(null);
    void send(v, atts, imgs, false, undefined, undefined, true);
  };

  const queueForLater = () => {
    const typed = input.trim();
    if (!typed && pastedBlocks.length === 0 && images.length === 0 && !activeQuote) return;
    // Slash commands run immediately and never enter the chat transcript as
    // raw "/..." text, even when queued via the queue button.
    if (typed.startsWith("/")) {
      setInput("");
      setCmdOpen(null);
      setHistoryOpen(false);
      void handleCommand(typed);
      return;
    }
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
    const queuedSkills: string[] = Array.from(
      extractMentionSkills(v, getSkillsList()).skills,
    );
    if (queuedSkills.length > 0) {
      const list = getSkillsList();
      let usage = loadSkillUsage();
      for (const nm of queuedSkills) {
        const hit = list.find((s) => s.name === nm);
        usage = recordSkillUsage(hit ? hit.slug || hit.name : nm, usage);
      }
      setSkillUsage(usage);
    }
    ss.queueMessage(chatObj.id, {
      id: uid2(),
      text: v,
      attachments: atts,
      images: imgs,
      mcpServers: sel,
      skills: queuedSkills,
      kind: "queue",
    });
    forceScrollToBottom();
    setInput("");
    setPastedBlocks([]);
    setActiveQuote(null);
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
    const rel = relFromRoot(wroot, p);
    if (rel) {
      setAttachments((a) => (a.includes(rel) ? a : [...a, rel]));
      return;
    }
    // Outside-workspace file: import it into the data dir's uploads folder so
    // the agent can read it (the backend allows reads under the data root
    // without a permission prompt) instead of silently dropping the file.
    void api
      .importFile(p)
      .then((imported) => {
        if (!imported) {
          useStore
            .getState()
            .setChatCmdError(
              chatIdRef.current,
              `Could not attach "${name}" — restart the app (⌘R or relaunch) to finish updating, then try again.`,
            );
          return;
        }
        setAttachments((a) => (a.includes(imported) ? a : [...a, imported]));
      })
      .catch(() => {});
  };

  const hasFileDrag = (e: React.DragEvent) => isFileDrag(e.dataTransfer.types);
  const onPanelDragEnter = (e: React.DragEvent) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onPanelDragOver = (e: React.DragEvent) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  };
  const onPanelDragLeave = (e: React.DragEvent) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onPanelDrop = (e: React.DragEvent) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files ?? []);
    for (const f of dropped) {
      const p =
        window.coder.getPathForFile(f) || (f as File & { path?: string }).path;
      if (p) {
        addDroppedFile(p, f.name);
        continue;
      }
      // WKWebView gives no path for OS drags (Tauri native drag events are
      // disabled so the HTML5 DnD handlers work). Images don't need a path —
      // attach them by content as a data URL, like screenshots.
      if (f.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => {
          setImages((imgs) =>
            imgs.some((i) => i.path === f.name)
              ? imgs
              : [
                  ...imgs,
                  { path: f.name, name: f.name, dataUrl: String(reader.result) },
                ],
          );
        };
        reader.readAsDataURL(f);
      }
    }
    // WKWebView sometimes exposes OS drags ONLY as file URLs (dataTransfer
    // files is empty). Parse text/uri-list / public.file-url and attach by
    // path so Finder drags still work.
    if (dropped.length === 0) {
      const raw =
        e.dataTransfer.getData("text/uri-list") ||
        e.dataTransfer.getData("public.file-url") ||
        "";
      for (const line of raw.split(/\r?\n/)) {
        const url = line.trim();
        if (!url.startsWith("file://")) continue;
        let p = decodeURIComponent(url.replace(/^file:\/\/(?:localhost)?/, ""));
        // Windows file:///C:/... yields "/C:/..." — strip the leading slash.
        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
        addDroppedFile(p, p.split("/").pop() ?? p);
      }
    }
  };

  // Long pastes never enter the textarea: they become a collapsed card above
  // the input and are joined back into the prompt on send. Short pastes keep
  // the native inline behavior; clipboard files fall through to the default
  // handler.
  const onComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if ((e.clipboardData.files?.length ?? 0) > 0) return;
    const raw = e.clipboardData.getData("text/plain");
    if (!raw || !isCollapsibleText(raw)) return;
    e.preventDefault();
    // Pasted dumps reach megabytes (log/trace output) and would then be
    // re-sent to the model EVERY turn plus parsed on every chat switch.
    // Truncate at entry with a visible marker (attach the file with @ for the
    // full content instead). The marker travels into the prompt so the model
    // knows the text is incomplete instead of silently reasoning on a cut.
    const text =
      raw.length > PASTE_MAX
        ? `${raw.slice(0, PASTE_MAX)}\n\n[…pasted text truncated: ${fmtSize(raw.length - PASTE_MAX)} omitted — attach the file with @ instead of pasting dumps]`
        : raw;
    setPastedBlocks((blocks) => [
      ...blocks,
      { id: uid2(), text: text.replace(/^\n+|\n+$/g, ""), createdAt: Date.now() },
    ]);
  };

  /** Pasted cards + typed input become one prompt: cards first (they sit above
   *  the input in the composer), then what the user typed. */
  const composePrompt = (typed: string): string => {
    const pasted = pastedBlocks.map((b) => b.text).join("\n\n");
    const base = pasted && typed ? `${pasted}\n\n${typed}` : typed || pasted;
    if (!activeQuote) return base;
    return combineQuoteAndInput(activeQuote, base);
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

  /** Attach one picked path: images go through the image pipeline, workspace
   *  files attach by relative path, and files from outside the workspace are
   *  imported into the data dir's uploads folder so the agent can read them. */
  const attachPickedPath = async (p: string) => {
    const name = p.split(/[\\/]/).pop() || p;
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (IMAGE_EXTS.has(ext)) {
      await addImage(p, name);
      return;
    }
    const rel = relFromRoot(wroot, p);
    if (rel) {
      setAttachments((a) => (a.includes(rel) ? a : [...a, rel]));
      return;
    }
    const imported = await api.importFile(p).catch(() => null);
    if (!imported) {
      // importFile is missing on app bundles started before this feature
      // shipped (no `file:import` IPC handler). Never fail silently — the
      // user must know a restart is needed.
      useStore
        .getState()
        .setChatCmdError(
          chatIdRef.current,
          `Could not attach "${name}" — restart the app (⌘R or relaunch) to finish updating, then try again.`,
        );
      return;
    }
    setAttachments((a) => (a.includes(imported) ? a : [...a, imported]));
  };

  const attachFile = async () => {
    // Older Electron main processes still return a single path string —
    // accept both shapes so the picker never degrades into a no-op.
    const picked = await api.selectFile().catch(() => null);
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    for (const p of paths) {
      await attachPickedPath(p);
    }
  };

  const removeImage = (path: string) => {
    setImages((imgs) => imgs.filter((i) => i.path !== path));
  };

  // Build the STT chain: primary first, then ordered fallbacks.
  // 'local' means on-device Whisper (undefined opts).
  const resolveSttChain = (): {
    lang: string | undefined;
    chains: (TranscribeProviderOpts | undefined)[];
  } => {
    const lang =
      dir === "rtl" || /[\u0600-\u06FF]/.test(input) ? "fa" : undefined;
    const toTranscribeOpts = (
      cfg: (typeof settings.providers)[number],
      model: string | undefined,
    ): TranscribeProviderOpts => ({
      kind: cfg.kind,
      baseUrl: cfg.baseUrl ?? "",
      apiKeys: [...(cfg.apiKeys ?? (cfg.apiKey ? [cfg.apiKey] : []))],
      model,
    });
    const chains: (TranscribeProviderOpts | undefined)[] = [];
    if (sttProviderId === "local") {
      chains.push(undefined);
    } else {
      const sttCfg = settings.providers.find((p) => p.id === sttProviderId);
      chains.push(sttCfg ? toTranscribeOpts(sttCfg, sttModel) : undefined);
    }
    // Local STT ON means fully offline: never contact a remote STT
    // provider via fallbacks in the same turn.
    if (sttProviderId !== "local") {
      for (const fb of sttFallbacks ?? []) {
        if (fb.providerId === "local") {
          chains.push(undefined);
          continue;
        }
        const cfg = settings.providers.find((p) => p.id === fb.providerId);
        if (!cfg) continue;
        chains.push(toTranscribeOpts(cfg, fb.model));
      }
    }
    return { lang, chains };
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
          try {
            const bannerId = chatIdRef.current;
            if (bannerId) useStore.getState().setChatCmdError(bannerId, "No audio was captured — check your microphone.");
          } catch {
            // Banner is best-effort.
          }
          return;
        }
        setTranscribing(true);
        try {
          const { lang, chains } = resolveSttChain();
          console.debug("[voice] transcribing", {
            mime: blob.type,
            bytes: blob.size,
            lang,
          });
          // Try each STT target in order; first success wins.
          let text = "";
          let lastError: unknown = null;
          for (const opts of chains) {
            try {
              text = await transcribeAudio(blob, setTranscribing, lang, opts);
              lastError = null;
              break;
            } catch (e) {
              lastError = e;
            }
          }
          if (lastError) throw lastError;
          const finalText = (text ?? "").trim();
          // A gateway HTML error page must never land in the composer.
          // Errors surface in the banner under messages, never in the input.
          if (finalText && (isHtmlTranscriptJunk(finalText) || /<\/?[a-z]/i.test(finalText) || finalText.includes('&lt;') || finalText.includes('/_next/') || /preload|fetchpriority/i.test(finalText) || /<[a-z][^<>]*$/i.test(finalText))) {
            console.debug("[voice] ignoring HTML junk transcription");
            try {
              const bannerId = chatIdRef.current;
              if (bannerId) useStore.getState().setChatCmdError(bannerId, "Transcription returned an error page — please try again.");
            } catch {
              // Banner is best-effort.
            }
          } else if (finalText) {
            // Noise gate: single-char Whisper hallucinations from background
            // noise must never reach the agent as a real turn.
            if (finalText.length < 2) {
              console.debug("[voice] ignoring noise fragment");
              try {
                const bannerId = chatIdRef.current;
                if (bannerId) useStore.getState().setChatCmdError(bannerId, "Nothing was recognized — please try again.");
              } catch {
                // Banner is best-effort.
              }
            } else {
              // Dictate auto-sends: no extra Enter needed.
              submit(finalText);
            }
          } else {
            console.debug("[voice] empty transcription (silence/unrecognized)");
            try {
              const bannerId = chatIdRef.current;
              if (bannerId) useStore.getState().setChatCmdError(bannerId, "Nothing was recognized — please try again.");
            } catch {
              // Banner is best-effort.
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const friendly =
            `Voice transcription failed: ${msg}\n` +
            (msg.includes("Failed to fetch")
              ? "The local Python server is likely down — restart the app."
              : "Please try again or check your microphone connection.");
          try {
            const bannerId = chatIdRef.current;
            if (bannerId) useStore.getState().setChatCmdError(bannerId, friendly);
          } catch {
            // Banner is best-effort.
          }
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
      try {
        const bannerId = chatIdRef.current;
        if (bannerId) useStore.getState().setChatCmdError(bannerId, `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // Banner is best-effort.
      }
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

  // Live voice session (separate from dictate): persistent WebSocket,
  // auto mic streaming, model playback, server VAD barge-in.
  const refreshMicDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(devices.filter((d) => d.kind === 'audioinput'));
    } catch {
      setMicDevices([]);
    }
  };
  const reportLiveError = (msg: string) => {
    setLiveError(msg);
    const id = chatIdRef.current || chat?.id;
    if (id) {
      try {
        useStore.getState().setChatLiveError(id, msg);
      } catch {
        // Banner mirror is best-effort.
      }
    }
  };
  const clearLiveError = () => {
    setLiveError(null);
    const id = chatIdRef.current || chat?.id;
    if (id) {
      try {
        useStore.getState().setChatLiveError(id, null);
      } catch {
        // Banner mirror is best-effort.
      }
    }
  };
  const selectMicDevice = async (deviceId: string) => {
    setSelectedMicId(deviceId);
    try {
      localStorage.setItem('codifa:selectedMicDeviceId', deviceId);
    } catch {
      // Storage unavailable; keep in-memory selection only.
    }
    setMicMenuOpen(false);
    const live = liveSessionRef.current;
    if (live && isLiveVoiceActive) {
      try {
        await live.setMicrophoneDeviceId(deviceId);
      } catch (err) {
        reportLiveError(err instanceof Error ? err.message : String(err));
      }
    }
  };
  // Offline live voice (no OpenAI): chunked mic VAD -> local/remote STT ->
  // existing chat pipeline (send) -> local TTS answer. Barge-in stops TTS.
  const startLive = async () => {
    if (liveState === 'connecting' || isLiveVoiceActive) return;
    if (recording) stopRecording();
    stopTts(LIVE_TTS_OWNER);
    clearLiveError();
    setLiveState('connecting');
    // Warm local weights in parallel with the user speaking: the sidecar
    // loads Whisper/G2P/pocket in the background while the mic opens, so
    // the first turn never pays the cold-load cost inside its timeout.
    // No RAM is pinned at boot — this only runs on explicit live start,
    // and idle-eviction still frees the weights after the idle window.
    preloadLocalModel('whisper');
    preloadLocalModel('tts');
    try {
      const transcribeChunk = async (blob: Blob, lang?: string): Promise<string> => {
        const { lang: chainLang, chains } = resolveSttChain();
        // Live has no typed input to sniff, so default to Persian when the
        // UI is RTL: otherwise short Persian turns go without the fa hint
        // and Whisper mistranscribes them unlike dictate mode.
        const effectiveLang = lang ?? chainLang ?? (dir === 'rtl' ? 'fa' : 'fa');
        let lastError: unknown = null;
        for (const opts of chains) {
          try {
            const text = await transcribeAudio(blob, undefined, effectiveLang, opts);
            lastError = null;
            return text;
          } catch (e) {
            lastError = e;
          }
        }
        throw lastError ?? new Error('Transcription failed');
      };
      // Provider chain + local voice config for live speech (shared by
      // progressive streaming speech and the full-text fallback).
      const buildLiveTtsChain = () => {
        const st = useStore.getState();
        const providers = st.settings.providers ?? [];
        const chain: Array<{ kind: string; baseUrl: string; apiKeys?: string[]; model?: string; voice?: string }> = [];
        const isLocalTts = st.ttsProviderId === 'local';
        if (!isLocalTts) {
          const primary = providers.find((p) => p.id === st.ttsProviderId);
          if (primary) {
            chain.push({ kind: primary.kind, baseUrl: primary.baseUrl ?? '', apiKeys: [...(primary.apiKeys ?? (primary.apiKey ? [primary.apiKey] : []))], model: st.ttsModel, voice: st.ttsVoice });
          }
          for (const fb of st.ttsFallbacks ?? []) {
            const p = providers.find((x) => x.id === fb.providerId);
            if (!p) continue;
            chain.push({ kind: p.kind, baseUrl: p.baseUrl ?? '', apiKeys: [...(p.apiKeys ?? (p.apiKey ? [p.apiKey] : []))], model: fb.model, voice: fb.voice });
          }
        }
        const localCfg = { ttsProviderId: st.ttsProviderId, ttsModel: st.ttsModel, ttsBaseUrl: (st.settings as { ttsBaseUrl?: string }).ttsBaseUrl, ttsVoice: st.ttsVoice };
        const args = chain.length > 0 ? chain : [{ kind: 'local', baseUrl: localCfg.ttsBaseUrl ?? '', model: localCfg.ttsModel }];
        return { args, localCfg };
      };
      // Live text source for progressive speech: follows the currently
      // streaming assistant bubble and reports done when it settles, so
      // speech starts on the first completed sentence instead of waiting
      // for the full answer. Never replays an older answer: before the new
      // bubble exists the snapshot is empty and not done.
      const makeLiveStreamSource = (chatId: string) => {
        let trackedId: string | null = null;
        let finalText = '';
        return {
          snapshot: () => {
            try {
              const st = useStore.getState();
              const chat = st.chats.find((c) => c.id === chatId);
              const streaming = chat?.messages.find((m) => m.role === 'assistant' && m.streaming);
              if (streaming) {
                trackedId = streaming.id;
                finalText = streaming.content ?? '';
                return { text: finalText, done: false };
              }
              if (trackedId) {
                const msg = chat?.messages.find((m) => m.id === trackedId);
                if (msg) finalText = msg.content ?? finalText;
                return { text: finalText, done: true };
              }
              return { text: '', done: false };
            } catch {
              return { text: '', done: false };
            }
          },
        };
      };
      const speakAnswer = async (chatId: string): Promise<void> => {
        const st = useStore.getState();
        const target = st.chats.find((c) => c.id === chatId);
        const lastAssistant = target ? [...target.messages].reverse().find((m) => m.role === 'assistant') : undefined;
        if (!lastAssistant) return;
        let speakable = '';
        try {
          speakable = speakableMessageText(lastAssistant).trim();
        } catch {
          speakable = (lastAssistant.content ?? '').trim();
        }
        if (!speakable) return;
        const { args, localCfg } = buildLiveTtsChain();
        const live = liveSessionRef.current;
        try {
          live?.notifySpeaking(true);
          setLiveState('speaking');
          await playTts(speakable, args, LIVE_TTS_OWNER, localCfg);
        } catch (err) {
          reportLiveError(err instanceof Error ? err.message : String(err));
        } finally {
          live?.notifySpeaking(false);
          if (liveSessionRef.current) setLiveState('live');
        }
      };
      const live = new LocalLiveSession({
        deviceId: selectedMicId || undefined,
        lang: dir === 'rtl' ? 'fa' : undefined,
        transcribe: transcribeChunk,
        onSpeechStart: () => {
          // Barge-in: user started talking while the agent answers — stop
          // TTS playback immediately so the user hears themselves. The
          // agent stream is aborted only once real transcribed text arrives
          // (onUserText below), never on mere VAD onset, so a false
          // positive never kills a good answer for nothing.
          try {
            stopTts(LIVE_TTS_OWNER);
          } catch {
            // Best-effort.
          }
          liveSessionRef.current?.notifySpeaking(false);
        },
        onStateChange: (s) => setLiveState(s),
        onUserText: async (raw) => {
          const text = sanitizeLocalTranscript(raw).trim();
          if (!text) return;
          // Noise gate: never interrupt the agent for a 1-char hallucination.
          if (text.length < 2) return;
          if (isHtmlTranscriptJunk(text) || /<\/?[a-z]/i.test(text) || text.includes('&lt;') || text.includes('/_next/') || /preload|fetchpriority/i.test(text) || /<[a-z][^<>]*$/i.test(text)) {
            reportLiveError('Live transcript returned an error page — please try again.');
            return;
          }
          const targetChatId = chatIdRef.current;
          try {
            const st0 = useStore.getState();
            const liveChat = st0.chats.find((c) => c.id === targetChatId);
            const liveStreaming = liveChat?.messages.some((m) => m.streaming) ?? false;
            if (liveStreaming) {
              const userMsg = st0.addMessage(targetChatId, {
                role: "user",
                content: text,
                steerPending: true,
              });
              forceScrollToBottom();
              await steerChat(targetChatId, userMsg.id, text, [], [], {});
              return;
            }
          } catch {
            // Fall through to normal send.
          }
          // Ensure a still-streaming answer is cancelled before the new
          // live turn starts (barge-in must not wait for the agent).
          try {
            const id = chatIdRef.current;
            if (id) {
              try {
                abortMapRef.current.get(id)?.abort();
              } catch {
                // Already aborted.
              }
              try {
                const ctrl = useStore.getState().chatAborts?.[id];
                if (ctrl && !ctrl.signal.aborted) ctrl.abort();
              } catch {
                // Already aborted.
              }
            }
          } catch {
            // Best-effort.
          }
          // Let the aborted stream settle so the backend releases the turn
          // before the new live message is sent (otherwise the new turn
          // races the old finally block and never reaches the agent).
          // Short budget: abort usually settles in 1-2 ticks, so barge-in
          // feels instant instead of making the user wait out a full answer.
          try {
            // Settle budget: the aborted turn must release the backend slot
            // before the new turn is sent, otherwise the new turn races the
            // old finally block and never reaches the agent.
            for (let i = 0; i < 30; i++) {
              const cur = useStore.getState().chats.find((c) => c.id === targetChatId);
              const stillStreaming = cur?.messages.some((m) => m.streaming);
              if (!stillStreaming) break;
              await new Promise((r) => setTimeout(r, 100));
            }
          } catch {
            // Wait is best-effort.
          }
          // Progressive speech: speak the streaming answer from the first
          // completed sentence instead of waiting for the full text, so the
          // first audio arrives fast. Falls back to full-text speech only
          // when streaming speech failed outright.
          const liveTts = buildLiveTtsChain();
          const streamFailedP = playTtsStream(
            makeLiveStreamSource(targetChatId),
            liveTts.args,
            LIVE_TTS_OWNER,
            liveTts.localCfg,
          ).then(
            () => false,
            () => true,
          );
          liveSessionRef.current?.notifySpeaking(true);
          setLiveState('speaking');
          try {
            await send(text);
          } catch (err) {
            // The aborted turn may still hold the backend slot: settle
            // briefly and retry once instead of dropping the live turn.
            try {
              await new Promise((r) => setTimeout(r, 1500));
              await send(text);
            } catch (err2) {
              stopTts(LIVE_TTS_OWNER);
              liveSessionRef.current?.notifySpeaking(false);
              if (liveSessionRef.current) setLiveState('live');
              reportLiveError(err2 instanceof Error ? err2.message : String(err2));
              return;
            }
          }
          if (!liveSessionRef.current) {
            stopTts(LIVE_TTS_OWNER);
            return;
          }
          try {
            if (await streamFailedP) await speakAnswer(targetChatId);
          } catch (err) {
            reportLiveError(err instanceof Error ? err.message : String(err));
          } finally {
            liveSessionRef.current?.notifySpeaking(false);
            if (liveSessionRef.current) setLiveState('live');
          }
        },
        onError: (e) => reportLiveError(e instanceof Error ? e.message : String(e)),
      });
      liveSessionRef.current = live;
      await live.connect();
    } catch (err) {
      liveSessionRef.current = null;
      setLiveState('error');
      reportLiveError(err instanceof Error ? err.message : String(err));
    }
  };
  const stopLive = () => {
    try {
      liveSessionRef.current?.disconnect();
    } catch {
      // Disconnect is best-effort; state reset below is what matters.
    }
    try {
      stopTts(LIVE_TTS_OWNER);
    } catch {
      // TTS stop is best-effort.
    }
    liveSessionRef.current = null;
    setLiveState('idle');
  };
  const toggleLive = () => {
    if (liveState === 'connecting' || isLiveVoiceActive) stopLive();
    else void startLive();
  };
  toggleLiveRef.current = toggleLive;
  // Close the mic menu on outside click / Escape.
  useEffect(() => {
    if (!micMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (micMenuRef.current && !micMenuRef.current.contains(e.target as Node)) {
        setMicMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMicMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [micMenuOpen]);

  const startCmd = (at?: number) => {
    const el = textareaRef.current;
    // Slash picker stays available while streaming: picking only inserts
    // text, Enter follows the existing submit/steer/queue path.
    if (!el) return;
    const pos = at ?? el.selectionStart;
    const prevChar = pos > 0 ? input[pos - 1] : "";
    if (prevChar && !/\s/.test(prevChar)) return;
    // Fresh usage on every open so the order is always recent-first.
    setCommandUsage(loadCommandUsage());
    setCmdOpen({ at: pos });
    setSkillMention(null);
    setCmdQuery("");
    // Bottom-anchored like history: newest sits just above the bottom.
    setCmdIndex(Math.max(0, COMMANDS.length - 1));
  };

  const acceptCmd = (name: string) => {
    if (!cmdOpen) return;
    // Record usage on pick (like skills) so the next open sorts recent-last
    // at the bottom even before the command runs via handleCommand.
    setCommandUsage(recordCommandUsage(`/${name}`));
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
  // Only the popup's own scrollTop is adjusted, so the page never jumps.
  useEffect(() => {
    if (!skillMention) return;
    scrollPopupRowIntoView(skillMentionPopupRef.current, ".hist-card.kbd");
  }, [skillMention, skillMentionIdx, skillMentionQuery, filteredSkills.length]);

  // Keep the keyboard-highlighted slash-command row visible while
  // navigating with arrows / Ctrl+J/K (same container-only scrolling).
  useEffect(() => {
    if (!cmdOpen) return;
    scrollPopupRowIntoView(cmdPopupRef.current, ".hist-card.kbd");
  }, [cmdOpen, cmdIndex, cmdQuery]);

  // Keep the keyboard-highlighted history row visible while navigating.
  useEffect(() => {
    if (!historyOpen) return;
    scrollPopupRowIntoView(historyPopupRef.current, ".hist-card.kbd");
  }, [historyOpen, historyIdx, promptHistory.length, pinnedCmds.length]);

  const startSkillMention = (at: number) => {
    setCmdOpen(null);
    // Fresh usage on every open so the order is always recent-first.
    setSkillUsage(loadSkillUsage());
    setSkillMention({ at });
    setSkillMentionQuery("");
    // Bottom-anchored like history: newest sits just above the bottom.
    setSkillMentionIdx(Math.max(0, skillsList.length - 1));
    void ensureSkills();
  };

  const acceptSkillMention = (skill: SkillRow) => {
    if (!skillMention) return;
    // Track usage so the next open sorts recent-first (like slash commands).
    setSkillUsage(recordSkillUsage(skill.slug || skill.name));
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

  // Close the "+" menu on outside pointer-down or on Escape. The listeners are
  // bound lazily (only while the menu is open) so they never fight other
  // popups' own key handling.
  useEffect(() => {
    if (!plusMenuOpen) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (ev.target instanceof Node && plusMenuRef.current?.contains(ev.target))
        return;
      setPlusMenuOpen(false);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setPlusMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [plusMenuOpen]);

  // "Skills" row of the "+" menu: mirrors what typing "@" does, so the existing
  // skill mention popup opens (and the list starts loading) without a separate
  // toolbar button.
  const openSkillsFromPlusMenu = () => {
    setPlusMenuOpen(false);
    const at = input ? input.length + 1 : 0;
    setInput((prev) => (prev ? `${prev} @` : "@"));
    startSkillMention(at);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    const prev = input;
    setInput(v);
    // Typing diverges from the history preview: dismiss the popup but keep
    // the edited text so the user can refine the previewed row.
    if (historyOpen) setHistoryOpen(false);

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
          const q = after.toLowerCase();
          const count = COMMANDS.filter(
            (c) => c.name.includes(q) || c.hint.toLowerCase().includes(q),
          ).length;
          setCmdIndex(Math.max(0, count - 1));
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
          const q = after.trim().toLowerCase();
          const count = skillsList.filter(
            (s) =>
              !q ||
              s.name.toLowerCase().includes(q) ||
              (s.slug && s.slug.toLowerCase().includes(q)) ||
              s.description.toLowerCase().includes(q),
          ).length;
          setSkillMentionIdx(Math.max(0, count - 1));
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
    // Prompt history popup: ArrowUp on an empty composer opens the history
    // (pins first, then recents); ArrowUp/Down navigate, Enter sends the
    // row directly, Escape closes. ArrowDown past the bottom-most row
    // closes the popup and clears the composer. Only when no other popup
    // owns the chord and the caret is at the very start (no partial text
    // to lose).
    if (!cmdOpen && !skillMention && !skillOpen && !historyOpen && e.key === "ArrowUp") {
      const el = textareaRef.current;
      const atStart = !el || ((el.selectionStart ?? 0) === 0 && (el.selectionEnd ?? 0) === 0);
      if (input === "" && atStart && (promptHistory.length > 0 || pinnedCmds.length > 0)) {
        e.preventDefault();
        e.stopPropagation();
        setHistoryOpen(true);
        // Bottom-anchored: newest sits just above the bottom, selection starts there.
        // Live preview: the highlighted row appears in the input without Enter.
        const openRows = historyRows(promptHistory, pinnedCmds);
        const openIdx = Math.max(0, openRows.length - 1);
        setHistoryIdx(openIdx);
        if (openRows[openIdx] !== undefined) {
          const openPreview = openRows[openIdx];
          setInput(openPreview);
          requestAnimationFrame(() => {
            const previewEl = textareaRef.current;
            if (previewEl) {
              previewEl.focus();
              previewEl.setSelectionRange(openPreview.length, openPreview.length);
            }
          });
        }
        return;
      }
    }
    if (historyOpen) {
      if (e.key === "Backspace" || e.key === "Delete") {
        // Delete/Backspace closes the popup (like Esc) but still deletes.
        setHistoryOpen(false);
        return;
      }
      const rows = historyRows(promptHistory, pinnedCmds);
      const d = navChord(e);
      if (d !== 0) {
        e.preventDefault();
        e.stopPropagation();
        if (rows.length > 0) {
          // Past the bottom-most row, ArrowDown exits history: close the
          // popup and clear the composer instead of wrapping around.
          if (d > 0 && historyIdx >= rows.length - 1) {
            setHistoryOpen(false);
            setInput("");
            return;
          }
          // Live preview: every highlight appears in the input without Enter.
          const next = (historyIdx + d + rows.length) % rows.length;
          setHistoryIdx(next);
          const preview = rows[next];
          if (preview !== undefined) {
            setInput(preview);
            requestAnimationFrame(() => {
              const previewEl = textareaRef.current;
              if (previewEl) {
                previewEl.focus();
                previewEl.setSelectionRange(preview.length, preview.length);
              }
            });
          }
        }
        return;
      }
      if (rows.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
        e.preventDefault();
        e.stopPropagation();
        const picked = rows[historyIdx] ?? rows[0];
        setHistoryOpen(false);
        submit(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setHistoryOpen(false);
        return;
      }
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
    // Codex-style: an explicit Stop also halts this chat's goal loop. The goal
    // stays attached (paused=false) for manual sends, but auto-continue stays
    // idle until the user presses Resume in the goal bar.
    try {
      useStore.getState().stopGoal(originId);
    } catch {
      /* ignore */
    }
    // Single cancellation path: drop pending auto-retry timers and bump the
    // epoch so any armed retry firing afterwards is ignored — it never
    // restarts the turn or brings the retry banner back.
    autoRetryFor(originId).stop();
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
      <div className="chat-panel" ref={panelRef}>
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

  // The direction switch moved to the window-strip cluster (App.tsx /
  // Sidebar.tsx) so it never moves when the sidebar toggles; the toolbar
  // portal stays for future chat-scoped controls.
  const toolbar = null;

  // The wallet chip lives on the app bar's right end (see #titlebar-right in
  // App.tsx), right of the static model-usage chip, not mid-bar.
  const balanceChip = (
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
  );

  const isFocused = !dimmed;
  return (
    <div
      className={"chat-panel" + (dimmed ? " chat-window-dimmed" : "") + (dragOver ? " file-dragover" : "")}
      data-chat-id={chat?.id ?? activeChatId}
      data-focused={isFocused ? "true" : "false"}
      onPointerDown={() => {
        const id = chat?.id ?? (props?.chatId ?? null);
        if (id && useStore.getState().activeChatId !== id) useStore.getState().focusWindow(id);
      }}
      onDragEnter={onPanelDragEnter}
      onDragOver={onPanelDragOver}
      onDragLeave={onPanelDragLeave}
      onDrop={onPanelDrop}
    >
      {titlebarEl && toolbar ? (isFocused ? createPortal(toolbar, titlebarEl) : toolbar) : toolbar}
      {titlebarRightEl && isFocused && createPortal(balanceChip, titlebarRightEl)}
      {chat?.goal?.active && (() => {
        // Goal strip pinned above the transcript so the active goal stays
        // visible while scrolling. Quiet icon buttons; Pause/Clear also abort
        // the live stream so they take effect immediately, and Resume
        // continues the goal with a follow-up turn. The play icon shows
        // whenever the goal is paused/stopped or the stream is idle (e.g.
        // after the composer stop button), so there is always a visible way
        // to resume. Codex-style: Stop halts the loop (stopped flag) without
        // detaching the goal; only Pause/Clear change attachment.
        const g = chat.goal!;
        const goalChatId = chat.id;
        const elapsedMs = Math.max(0, Date.now() - g.startedAt);
        const mins = Math.floor(elapsedMs / 60000);
        const elapsed = mins < 1 ? "<1m" : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
        const goalIdle = Boolean(g.paused || g.stopped);
        const onGoalPause = () => {
          useStore.getState().pauseGoal(goalChatId);
          stop();
        };
        const onGoalResume = () => {
          goalAutoRef.current.delete(goalChatId);
                    try {
                      stoppedMapRef.current?.delete(goalChatId);
                    } catch {
                      /* ignore */
                    }
          try {
            goalSendingRef.current.forEach((k) => {
              if (k.startsWith(`${goalChatId}:`)) goalSendingRef.current.delete(k);
            });
          } catch {
            /* ignore */
          }
          // Cap-hit resume grants a fresh turn budget (explicit user action):
          // without resetting turns the server would instantly re-pause on
          // the stale counter. setGoal resets turns/flags for the same condition.
          if ((g.turns ?? 0) >= MAX_GOAL_TURNS) {
            useStore.getState().setGoal(goalChatId, g.condition);
          } else {
            useStore.getState().resumeGoal(goalChatId);
          }
          if (!busy) {
            void send(`Continue working on the persistent goal: "${g.condition}".`, [], [], false, undefined, undefined, false, undefined, goalChatId);
          }
        };
        const onGoalClear = () => {
          useStore.getState().clearGoal(goalChatId);
          stop();
        };
        const onGoalEdit = () => {
          setInput(`/goal ${g.condition}`);
          requestAnimationFrame(() => textareaRef.current?.focus());
        };
        const ghostBtn = {
          background: "transparent",
          border: "1px solid var(--border, #2a2a35)",
          borderRadius: 6,
          padding: "4px",
          fontSize: 12,
          lineHeight: 1,
          cursor: "pointer",
          color: "inherit",
          opacity: 0.85,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        };
        return (
          <div
            className="goal-bar"
            dir="ltr"
            role="status"
            aria-label={goalIdle ? "Goal paused" : "Active goal"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              margin: "8px 12px 0",
              borderRadius: 10,
              border: "1px solid var(--border, #2a2a35)",
              background: "var(--panel, rgba(120, 120, 160, 0.08))",
              fontSize: 12,
              minWidth: 0,
            }}
          >
            <span
              className="goal-dot"
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flexShrink: 0,
                background: goalIdle ? "var(--warning, #d9a13b)" : "var(--success, #3fb950)",
              }}
            />
            <span className="goal-label" style={{ fontFamily: "monospace", opacity: 0.8, flexShrink: 0 }}>/goal</span>
            <span
              className="goal-cond"
              dir="auto"
              title={g.condition}
              style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {g.condition}
            </span>
            <span className="goal-meta" style={{ opacity: 0.6, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
              {elapsed}{typeof g.turns === "number" ? ` · ${g.turns} turn${g.turns === 1 ? "" : "s"}` : ""}{g.paused ? " · paused" : g.stopped ? " · stopped" : ""}
            </span>
            <span className="goal-actions" style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              {goalIdle || !busy ? (
                <button type="button" className="goal-btn" style={ghostBtn} onClick={onGoalResume} title="Resume goal" aria-label="Resume goal">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                </button>
              ) : (
                <button type="button" className="goal-btn" style={ghostBtn} onClick={onGoalPause} title="Pause goal" aria-label="Pause goal">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                </button>
              )}
              <button type="button" className="goal-btn" style={ghostBtn} onClick={onGoalEdit} title="Edit goal" aria-label="Edit goal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" /></svg>
              </button>
              <button type="button" className="goal-btn" style={ghostBtn} onClick={onGoalClear} title="Clear goal" aria-label="Clear goal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" /></svg>
              </button>
            </span>
          </div>
        );
      })()}
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
                  Switch between Ask and Coder with <code>Tab</code>,{" "}
                  <code>Cmd/Ctrl+M</code>, or the selector above — type{" "}
                  <code>/plan</code> for Plan mode, <code>/help</code> for all
                  commands and shortcuts.
                </p>
              </div>
            </div>
          )}
          {(() => {
            const visible = visibleChatMessages(chat.messages);
            // Char budget scales with the count limit so "load older" (which
            // raises msgLimit) always reveals more — the button never stalls.
            // Lengths are render-capped: a 1.5MB paste renders ≤100KB, so the
            // budget measures actual parse work, not stored size.
            const budget = windowBudget(msgLimit, MSG_PAGE);
            const windowed = sliceWindow(
              visible,
              msgLimit,
              budget,
              MSG_WINDOW_MIN_KEEP,
              (m) => Math.min(m.content?.length ?? 0, RENDER_CAP),
            );
            const hidden = visible.length - windowed.length;
            return (
              <>
                {hidden > 0 && (
                  <div className="load-older-row">
                    <button
                      className="load-older-btn"
                      onClick={() => {
                        prependAnchorRef.current =
                          scrollRef.current?.scrollHeight ?? null;
                        // Deliberately NOT capped at visible.length: the char
                        // budget scales with msgLimit, so capping would freeze
                        // the budget on giant chats (each message over budget)
                        // and make further clicks reveal nothing. An oversized
                        // msgLimit is harmless — countStart floors at 0 and the
                        // restore/auto-load comparisons still behave.
                        setMsgLimit((n) => n + MSG_PAGE);
                      }}
                    >
                      Load {Math.min(MSG_PAGE, hidden)}{" "}
                      earlier message
                      {hidden === 1 ? "" : "s"}…
                    </button>
                  </div>
                )}
                {windowed
                  .map((m: ChatMessage) => (
                    <Fragment key={m.id}>
                      <ChatMessageView message={m} onRetry={onRetry} onEdit={onEdit} />
                      {/* Newer messages render tool cards inline via `segments`; only
                        older persisted messages without segments keep the stacked
                        timeline below the bubble. */}
                      {!m.segments &&
                        m.toolActivity &&
                        m.toolActivity.length > 0 && (
                          <div className="tool-timeline">
                            {/* Explore parent cards are hidden in chat (the
                              sub-agent tool group represents them); keep the
                              original index for markToolReverted. */}
                            {m.toolActivity
                              .map((act, i) => ({ act, i }))
                              .filter(({ act }) => act.tool !== "explore")
                              .map(({ act, i }) => (
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
                  <QueuedCollapsibleText id={q.id} text={q.text} onEdit={onEditQueued} />
                  {q.attachments && q.attachments.length > 0 && (
                    <div className="msg-attachments" dir="ltr">
                      {q.attachments.map((a) => (
                        <span
                          className="attachment-chip attachment-chip-open"
                          key={a}
                          role="button"
                          tabIndex={0}
                          title={`${a} — open in the side panel`}
                          onClick={() => openWorkspaceFile(a)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openWorkspaceFile(a);
                            }
                          }}
                        >
                          <FileIcon path={a} size={20} />
                          {a}
                        </span>
                      ))}
                    </div>
                  )}
                  {q.images && q.images.length > 0 && (
                    <MessageImages images={q.images} />
                  )}
                  {q.skills && q.skills.length > 0 && (
                    <div className="msg-attachments" dir="ltr">
                      {(q.skills ?? []).map((sk) => (
                        <span className="attachment-chip" key={`skill-${sk}`}>
                          @{sk}
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
            liveError ||
            chat?.liveError ||
            chat?.ttsError ||
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
                {(liveError || chat?.liveError) && (
                  <div className="notice-banner notice-error" dir="ltr">
                    <span className="notice-icon">⚠</span>
                    <span className="notice-text">{liveError ?? chat?.liveError}</span>
                    <button
                      type="button"
                      className="notice-dismiss"
                      onClick={() => {
                        setLiveError(null);
                        if (chat) useStore.getState().setChatLiveError(chat.id, null);
                      }}
                      title="Dismiss"
                    >
                      ✕
                    </button>
                  </div>
                )}
                {chat?.ttsError && (
                  <div className="notice-banner notice-error" dir="ltr">
                    <span className="notice-icon">⚠</span>
                    <span className="notice-text">{chat.ttsError}</span>
                    <button
                      type="button"
                      className="notice-dismiss"
                      onClick={() =>
                        useStore.getState().setChatTtsError(chat.id, null)
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

      <div ref={composerRef} className="composer">
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
              recordAtBottom();
              jumpScrollingRef.current = true;
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
                role="dialog"
                aria-label="Implementation plan approval"
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
                  <span className="ask-card-icon plan-approval-icon" aria-hidden="true">
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
                        aria-pressed={i === sel}
                        className={`plan-approval-option${i === sel ? " selected" : ""}`}
                        onClick={() => answerOption(i)}
                      >
                        <span className="plan-approval-num" dir="ltr" aria-hidden="true">{i + 1}</span>
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
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Plan feedback"
                    value={askFreeText}
                    placeholder="Suggest changes or type feedback…"
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
                    <kbd>Tab</kbd> / <kbd>↑↓</kbd> to choose · <kbd>Enter</kbd> to select
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
                            useStore.getState().setComputerUse(true);
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
        <ComposerDiffBar
          root={wroot}
          disabled={busy}
          onCommit={() => {
            if (!wroot || busy || !chat || isCommitting) return;
            const chatId = chat.id;
            void (async () => {
              setIsCommitting(true);
              try {
                // Commit messages run on the "compact" tool model
                // (Settings → Tools → Compact model): a one-line message needs
                // a small fast model, not the main chat model. Empty or the
                // "main model" sentinel falls back to the active provider.
                // Mirrors the compact-path resolution above (provider id first,
                // then kind for legacy "custom/…" values).
                const st = useStore.getState();
                const compactEntry = (st.subagentModels?.compact || "").trim();
                let commitProvider = provider;
                let commitModel = activeModel;
                if (
                  compactEntry &&
                  compactEntry !== "main model" &&
                  compactEntry !== "main_model" &&
                  compactEntry !== "main"
                ) {
                  const slash = compactEntry.indexOf("/");
                  const prefix = slash > 0 ? compactEntry.slice(0, slash) : "";
                  const modelName =
                    slash > 0 ? compactEntry.slice(slash + 1) : compactEntry;
                  const explicitProvider = prefix
                    ? st.settings.providers.find(
                        (p) => p.id === prefix || p.kind === prefix,
                      )
                    : undefined;
                  if (explicitProvider) {
                    commitProvider = explicitProvider;
                    commitModel = modelName;
                  } else if (!prefix && modelName) {
                    commitModel = modelName;
                  }
                }
                const res = await gitAutoCommit(wroot, {
                  kind: commitProvider.kind,
                  model: commitModel,
                  baseUrl: commitProvider.baseUrl,
                  apiKeys: providerApiKeys(commitProvider),
                  id: commitProvider.id,
                });
                if ("error" in res) {
                  useStore.getState().setChatCmdError(chatId, res.error);
                } else if (res.usage) {
                  // Accrue the commit-message call into the chat's cumulative
                  // usage so the sidebar's Model usage panel bills it —
                  // grouped under the provider that ACTUALLY ran it
                  // (provider_id > kind > commit provider), mirroring the
                  // compact path. No usage on the heuristic fallback path
                  // (there was no model call to bill).
                  const cu: CompactUsage = res.usage;
                  const pid =
                    cu.provider_id ||
                    cu.provider ||
                    commitProvider.id ||
                    provider.id;
                  useStore.getState().accrueChatUsage(
                    chatId,
                    pid,
                    cu.model || commitModel,
                    {
                      input: cu.input_tokens ?? 0,
                      output: cu.output_tokens ?? 0,
                      cacheRead: cu.cache_read_tokens ?? 0,
                      cacheWrite: cu.cache_write_tokens ?? 0,
                    },
                  );
                }
              } finally {
                setIsCommitting(false);
              }
            })();
          }}
          isCommitting={isCommitting}
          isUndoing={isUndoing}
          isPushing={isPushing}
          onUndo={() => {
            if (!wroot || busy || isUndoing) return;
            if (
              !window.confirm(
                "Discard all uncommitted changes? This cannot be undone.",
              )
            )
              return;
            const chatId = chat?.id;
            void (async () => {
              setIsUndoing(true);
              try {
                const res = await gitDiscard(wroot);
                if ("error" in res && chatId) {
                  useStore.getState().setChatCmdError(chatId, res.error);
                }
              } finally {
                setIsUndoing(false);
              }
            })();
          }}
          onPush={() => {
            if (!wroot || busy || isPushing) return;
            const chatId = chat?.id;
            void (async () => {
              setIsPushing(true);
              try {
                const res = await gitPush(wroot);
                if ("error" in res && chatId) {
                  useStore.getState().setChatCmdError(chatId, res.error);
                }
              } finally {
                setIsPushing(false);
              }
            })();
          }}
        />
        <div className="composer-inner">
          <div className="composer-input-wrap">
            {historyOpen && (
              // Terminal-style history: oldest on top, newest just above the
              // bottom, pins (max 3) last at the very bottom. Click / Enter
              // sends the row directly via submit.
              <div className="mention-popup history-popup" dir="ltr" ref={historyPopupRef}>
                {(() => {
                  const rows = historyRows(promptHistory, pinnedCmds);
                  const pinnedRows = rows.filter((r) => pinnedCmds.includes(r));
                  const recentRows = rows.filter((r) => !pinnedCmds.includes(r));
                  const insert = (row: string) => {
                    setHistoryOpen(false);
                    submit(row);
                  };
                  const renderCard = (row: string) => {
                    const i = rows.indexOf(row);
                    const pinned = pinnedCmds.includes(row);
                    const slash = isSlashCommand(row);
                    // Terminal-style row lines shared with unit tests.
                    const title = historyTitle(row);
                    const meta = historyMeta(row);
                    const sub = meta && meta !== title ? meta : null;
                    return (
                      <div
                        key={row}
                        className={`hist-card${i === historyIdx ? " kbd" : ""}`}
                        onMouseEnter={() => {
                          setHistoryIdx(i);
                          setInput(row);
                        }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          insert(row);
                        }}
                      >
                        <div className="hist-card-head">
                          <span
                            className={`hist-card-icon${slash ? " cmd" : ""}`}
                            aria-hidden="true"
                          >
                            {slash ? "✦" : "$"}
                          </span>
                          <span className="hist-card-title">{title}</span>
                          <button
                            type="button"
                            className={`history-pin${pinned ? " on" : ""}`}
                            title={pinned ? "Unpin" : "Pin (max 3)"}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setPinnedCmds((prev) => togglePin(row, prev));
                            }}
                          >
                            {pinned ? "★" : "☆"}
                          </button>
                        </div>
                        {sub && <div className="hist-card-sub">{sub}</div>}
                      </div>
                    );
                  };
                  return (
                    <>
                      {rows.length === 0 && (
                        <div className="mention-empty">No history yet</div>
                      )}
                      {recentRows.length > 0 && (
                        <div className="hist-section">
                          <div className="hist-section-label">$ recent</div>
                          {recentRows.map(renderCard)}
                        </div>
                      )}
                      {pinnedRows.length > 0 && (
                        <div className="hist-section">
                          <div className="hist-section-label">$ pinned</div>
                          {pinnedRows.map(renderCard)}
                        </div>
                      )}
                      {rows.length > 0 && (
                        <div className="hist-hint">
                          ↑↓ navigate · Enter send · Esc close
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
            {cmdOpen && (
              <div className="mention-popup history-popup" dir="ltr" ref={cmdPopupRef}>
                {filteredCmds.length === 0 && (
                  <div className="mention-empty">No matching commands</div>
                )}
                {filteredCmds.map((c, i) => (
                  <div
                    key={c.name}
                    className={`hist-card${i === cmdIndex ? " kbd" : ""}`}
                    onMouseEnter={() => setCmdIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptCmd(c.name);
                    }}
                  >
                    <div className="hist-card-head">
                      <span
                        className="hist-card-icon cmd"
                        aria-hidden="true"
                      >
                        ✦
                      </span>
                      <span className="hist-card-title">/{c.name}</span>
                    </div>
                    <div className="hist-card-sub">{c.hint}</div>
                  </div>
                ))}
                {filteredCmds.length > 0 && (
                  <div className="hist-hint">
                    ↑↓ navigate · Enter insert · Esc close
                  </div>
                )}
              </div>
            )}
            {skillMention && (
              <div className="mention-popup history-popup" dir="ltr" ref={skillMentionPopupRef}>
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
                {filteredSkills.map((s, i) => {
                  const title = `@${s.slug || s.name}`;
                  const sub = (s.description || "").trim() ? s.description.trim() : null;
                  return (
                    <div
                      key={s.name}
                      className={`hist-card${i === skillMentionIdx ? " kbd" : ""}`}
                      onMouseEnter={() => setSkillMentionIdx(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptSkillMention(s);
                      }}
                    >
                      <div className="hist-card-head">
                        <span
                          className="hist-card-icon skill"
                          aria-hidden="true"
                        >
                          @
                        </span>
                        <span className="hist-card-title">{title}</span>
                      </div>
                      {sub && <div className="hist-card-sub">{sub}</div>}
                    </div>
                  );
                })}
                {filteredSkills.length > 0 && (
                  <div className="hist-hint">
                    ↑↓ navigate · Enter insert · Esc close
                  </div>
                )}
              </div>
            )}
            {skillOpen && (
              <div className="mention-popup" ref={skillPopupRef} dir="ltr">
                <div className="mention-head">
                  <span>MCP tools</span>
                  <span className="mention-head-count">
                    {filteredMcpCards.length}
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
                      if (opt?.kind === "builtin")
                        setComputerUse(!computerUse);
                      else if (opt)
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
                  filteredMcpCards.length === 0 && (
                    <div className="mention-empty">
                      No connectors match “{skillQuery.trim()}”
                    </div>
                  )}
                {filteredMcpCards.length > 0 && (
                  <div className="mcp-grid">
                    {filteredMcpCards.map((c, i) => {
                      const on = c.builtin
                        ? computerUse
                        : mcpEnabled.includes(c.name);
                      const toggle = () => {
                        if (c.builtin) setComputerUse(!on);
                        else setMcpEnabled(c.name, !on);
                      };
                      return (
                        <div
                          key={c.name}
                          className={`mention-item mcp-toggle${on ? " on" : ""} ${i === skillIdx ? "kbd" : ""}`}
                          title={
                            c.builtin
                              ? "Desktop control — when off, the agent never gets the computer tool"
                              : undefined
                          }
                          onMouseEnter={() => setSkillIdx(i)}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            toggle();
                          }}
                        >
                          <span className="mention-rel">{c.label}</span>
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
            {activeQuote && (
              <div className="paste-cards">
                <div className="paste-card" dir="ltr">
                  <button
                    className="chip-x paste-card-x"
                    onClick={() => setActiveQuote(null)}
                    title="Remove reply quote"
                  >
                    ×
                  </button>
                  <div className="paste-card-preview">
                    {activeQuote}
                  </div>
                  <div className="paste-card-foot">
                    <span className="paste-card-badge">Replying to</span>
                  </div>
                </div>
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
                      <FileIcon path={a} size={20} />
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
            <div
              ref={composerRowRef}
              className={`composer-input-row${composerExpanded ? " expanded" : " compact"}`}
            >
              <div
                ref={composerMeasureRef}
                className="composer-measure"
                aria-hidden="true"
                dir={dir}
              />
              <div
                className={`composer-input-stack${slashRange ? " slash-rich" : ""}`}
              >
                <div
                  className="composer-backdrop"
                  aria-hidden="true"
                  dir={dir}
                  style={{
                    direction: dir,
                    textAlign: dir === "rtl" ? "right" : "left",
                  }}
                  ref={composerBackdropRef}
                >
                  {slashRange ? (
                    <>
                      <span className="backdrop-plain">
                        {input.slice(0, slashRange.start)}
                      </span>
                      <span className="slash-hidden" aria-hidden="true">
                        /
                      </span>
                      <span className="slash-token">
                        {input.slice(slashRange.start + 1, slashRange.end)}
                      </span>
                      <span className="backdrop-plain">
                        {input.slice(slashRange.end) || "\u200b"}
                      </span>
                    </>
                  ) : null}
                </div>
                <textarea
                  className={`composer-input${slashActive ? " slash-active" : ""}`}
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
                  onScroll={syncBackdropScroll}
                />
              </div>
              <div className="composer-bottom-row">
                <div className="composer-left-actions" ref={plusMenuRef}>
                  <button
                    className="icon-btn plus-btn"
                    onClick={() => setPlusMenuOpen((o) => !o)}
                    title="Add files, screenshot, skills or MCP tools"
                    aria-label="Add"
                    aria-haspopup="menu"
                    aria-expanded={plusMenuOpen}
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
                  {plusMenuOpen && (
                    <div className="plus-menu" role="menu" dir="ltr">
                      <button
                        type="button"
                        className="plus-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setPlusMenuOpen(false);
                          void attachFile();
                        }}
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
                          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                        </svg>
                        <span>Add files or photos</span>
                      </button>
                      <button
                        type="button"
                        className="plus-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setPlusMenuOpen(false);
                          void captureRegion();
                        }}
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
                          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                          <circle cx="12" cy="13" r="4" />
                        </svg>
                        <span>Screenshot</span>
                      </button>
                      <button
                        type="button"
                        className="plus-menu-item"
                        role="menuitem"
                        onClick={openSkillsFromPlusMenu}
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
                          <path d="M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3z" />
                        </svg>
                        <span>Skills</span>
                      </button>
                      <button
                        type="button"
                        className="plus-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setPlusMenuOpen(false);
                          if (!skillOpen) openSkillPicker();
                        }}
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
                          <path d="M9 2v6" />
                          <path d="M15 2v6" />
                          <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
                          <path d="M12 17v5" />
                        </svg>
                        <span>MCP connectors</span>
                        {mcpEnabled.length > 0 && (
                          <span className="plus-menu-badge">
                            {mcpEnabled.length}
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                  <div
                    className="ctx-ring-wrap"
                    ref={ctxRingWrapRef}
                    onMouseEnter={openCtxPopover}
                    onMouseLeave={scheduleCtxPopoverClose}
                  >
                    <button
                      type="button"
                      className={`ctx-ring-btn${contextWarn(contextUsed, usable) ? " warn" : ""}`}
                      aria-label="Context windows"
                      aria-haspopup="dialog"
                      aria-expanded={ctxPopoverOpen}
                      onClick={() =>
                        ctxPopoverOpen
                          ? setCtxPopoverChatId(null)
                          : openCtxPopover()
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setCtxPopoverChatId(null);
                      }}
                    >
                      <ContextRing pct={ctxPct} />
                    </button>
                  </div>
                </div>
                <div className="composer-right-actions" ref={composerRightRef}>
                  {showLiveActive && (
                    <button
                      type="button"
                      className="live-stop-pill"
                      onClick={toggleLive}
                      title="Stop live voice"
                    >
                      <span className="live-dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span>Stop</span>
                    </button>
                  )}
                  {(showVoiceButtons || showLiveActive) && (
                  <>
                  {showVoiceButtons && (
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
                  )}
                    {(showLiveIdle || showLiveActive) && (
                    <div className="live-btn-wrap" ref={micMenuRef}>
                      <button
                        type="button"
                        className={`icon-btn attach-btn live-btn${showLiveActive ? " live-active" : ""}`}
                        onClick={toggleLive}
                        title={showLiveActive ? "Stop live voice" : "Live voice conversation (Ctrl+X then L)"}
                      >
                        {showLiveActive ? (
                          <span className="wave animate" aria-hidden="true">
                            <span className="wave-bar" />
                            <span className="wave-bar" />
                            <span className="wave-bar" />
                            <span className="wave-bar" />
                          </span>
                        ) : (
                          <span className="wave" aria-hidden="true">
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M4.5 10v4" />
                              <path d="M8.5 7v10" />
                              <path d="M12 4v16" />
                              <path d="M15.5 7v10" />
                              <path d="M19.5 10v4" />
                            </svg>
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="live-chev-btn"
                        aria-label="Choose microphone"
                        aria-expanded={micMenuOpen}
                        onClick={() => {
                          if (!micMenuOpen) void refreshMicDevices();
                          setMicMenuOpen((v) => !v);
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      {micMenuOpen && (
                        <div className="mic-menu" role="menu" aria-label="Microphone" dir="ltr">
                          <div className="mic-menu-head">
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                              <line x1="12" y1="19" x2="12" y2="22" />
                            </svg>
                            <span className="mic-level"><span className="mic-level-dot" /></span>
                          </div>
                          {(() => {
                            const normalizeMicLabel = (raw: string) => {
                              let label = (raw || "").trim() || "Microphone";
                              // Strip trailing USB ids like " (1235:800e)" and leading
                              // "Default -" prefixes (any dash variant) repeatedly so
                              // "Default - Default - X (1235:800e)" collapses to "X".
                              for (let i = 0; i < 5; i++) {
                                const noUsb = label.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)\s*$/g, "").trim();
                                if (noUsb !== label) {
                                  label = noUsb || label;
                                  continue;
                                }
                                const noDef = label.replace(/^default\s*[-\u2013\u2014:]\s*/i, "").trim();
                                if (noDef !== label) {
                                  label = noDef || label;
                                  continue;
                                }
                                break;
                              }
                              label = label.replace(/\s+/g, " ").trim() || "Microphone";
                              // Guard against a missed prefix leaving "Default - X".
                              const guard = label.replace(/^default\s*[-\u2013\u2014:]\s*/i, "").trim();
                              if (guard) label = guard;
                              label = label.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)\s*$/g, "").trim() || label;
                              return label;
                            };
                            const stripDefaultPrefix = normalizeMicLabel;
                            const seenLabels = new Set<string>();
                            const uniqueDevices = micDevices.filter((d) => {
                              const norm = stripDefaultPrefix(d.label || "Microphone").toLowerCase();
                              if (seenLabels.has(norm)) return false;
                              seenLabels.add(norm);
                              return true;
                            });
                            const rawFirst = uniqueDevices.length > 0 ? stripDefaultPrefix(uniqueDevices[0].label || "Microphone") : "";
                            const firstName = rawFirst.replace(/^default\s*[-\u2013\u2014:]\s*/i, "").trim() || rawFirst;
                            const rows = [
                              { id: "", label: firstName ? `Default - ${firstName}` : "Default" },
                              ...uniqueDevices
                                .filter((d) => {
                                  const id = (d.deviceId ?? "").trim();
                                  // The "default" pseudo-device duplicates the synthetic row.
                                  if (!id || id.toLowerCase() === "default") return false;
                                  return true;
                                })
                                .map((d, i) => ({
                                  id: d.deviceId ?? "",
                                  label: stripDefaultPrefix(d.label || `Microphone ${i + 1}`),
                                })),
                            ];
                            return rows.map((r, i) => {
                              const active = (selectedMicId || "") === r.id;
                              return (
                                <button
                                  key={`${r.id || "default"}-${i}`}
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={active}
                                  className={`mic-item${active ? " active" : ""}`}
                                  onClick={() => void selectMicDevice(r.id)}
                                >
                                  <span className="mic-item-label">{r.label}</span>
                                  {active && <span className="mic-check" aria-hidden="true">✓</span>}
                                </button>
                              );
                            });
                          })()}
                        </div>
                      )}
                    </div>
                    )}
                  </>
                  )}
                  {ctxPopoverOpen &&
                    ctxBreakdown &&
                    ctxPopoverPos &&
                    typeof document !== "undefined" &&
                    createPortal(
                      <div
                        className="context-popover"
                        dir="ltr"
                        role="dialog"
                        aria-label="Context windows"
                        style={{
                          position: "fixed",
                          top: ctxPopoverPos.top,
                          left: ctxPopoverPos.left,
                          width: CTX_POPOVER_WIDTH,
                          transform: "translateY(-100%)",
                        }}
                        onMouseEnter={cancelCtxPopoverClose}
                        onMouseLeave={scheduleCtxPopoverClose}
                      >
                        <div className="ctx-pop-title">Context windows</div>
                        <div className="ctx-pop-total">
                          {formatTokens(ctxBreakdown.total)}
                          {ctxBreakdown.window
                            ? `/${formatTokensK(ctxBreakdown.window)} (${(
                                (ctxBreakdown.total / ctxBreakdown.window) *
                                100
                              ).toFixed(1)}%)`
                            : ""}
                        </div>
                        <div className="ctx-pop-bar">
                          {ctxBreakdown.rows.map((row) => (
                            <span
                              key={row.key}
                              style={{
                                width: `${contextBarSegmentPercent(
                                  row.tokens,
                                  ctxBreakdown.total,
                                  ctxBreakdown.window,
                                )}%`,
                                backgroundColor:
                                  CONTEXT_BREAKDOWN_COLORS[row.key],
                              }}
                            />
                          ))}
                        </div>
                        <div className="ctx-pop-rows">
                          {ctxBreakdown.rows.map((row) => (
                            <div className="ctx-pop-row" key={row.key}>
                              <span
                                className="ctx-pop-dot"
                                style={{
                                  backgroundColor:
                                    CONTEXT_BREAKDOWN_COLORS[row.key],
                                }}
                              />
                              <span className="ctx-pop-label">{row.label}</span>
                              <span className="ctx-pop-tok">
                                {formatTokens(row.tokens)}
                              </span>
                              <span className="ctx-pop-pct">
                                {formatBreakdownPercent(row.percent)}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="ctx-pop-foot">
                          <span>Average cache hit rate</span>
                          <span>
                            {ctxBreakdown.cacheHitRate != null
                              ? formatBreakdownPercent(
                                  ctxBreakdown.cacheHitRate,
                                )
                              : "—"}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="ctx-pop-compact"
                          disabled={compacting || busy}
                          onClick={() => {
                            setCtxPopoverChatId(null);
                            void compactContext();
                          }}
                        >
                          {compacting ? "Compacting…" : "Compact context"}
                        </button>
                      </div>,
                      document.body,
                    )}
                  {showLiveActive ? null : showStopOnly ? (
                    <>
                      <button
                        className="send-circle-btn stop-btn"
                        onClick={stop}
                        title="Stop"
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                      </button>
                      {showDictateDuringStreaming && (
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
                      )}
                    </>
                  ) : showSendOnly ? (
                    <button
                      className="send-circle-btn"
                      onClick={() => submit()}
                      title="Send"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M19 7v4a2 2 0 01-2 2H5" />
                        <polyline points="9 17 5 13 9 9" />
                        <line x1="5" y1="13" x2="14" y2="13" />
                      </svg>
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="composer-footer">
          <span className="composer-footer-right">
            <span className="composer-mode">
              <ModeSelect
                modes={modes}
                menuModes={modes.filter((m) => m.id !== "plan")}
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
            <ProviderModelSelect chatId={chat?.id ?? activeChatId} />
          </span>
        </div>
      </div>
      {quoteSel && (
        <button
          type="button"
          className="chat-quote-reply"
          title="Reply to selection"
          aria-label="Reply to selected text"
          onMouseDown={(e) => e.preventDefault()}
          onClick={applyQuoteSel}
          style={{
            position: "fixed",
            left: quoteSel.x,
            top: quoteSel.y,
            transform: "translate(-50%, -100%)",
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            borderRadius: 10,
            border: "1px solid var(--border, #2a2a35)",
            background: "var(--bg-panel, #313244)",
            color: "var(--text, #cdd6f4)",
            boxShadow: "var(--shadow, 0 4px 20px rgba(0,0,0,0.35))",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 14L4 9l5-5" />
            <path d="M4 9h10a5 5 0 015 5v6" />
          </svg>
          <span>Reply</span>
        </button>
      )}
      {dragOver && (
        <div className="chat-file-drop-overlay" aria-hidden="true">
          <div className="chat-file-drop-icons">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
          </div>
          <span>Drop files here</span>
        </div>
      )}
    </div>
  );
}
