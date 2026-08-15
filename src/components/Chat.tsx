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
import { getActiveProvider, useStore, defaultMaxHistoryFor } from "../lib/store";
import { api } from "../lib/fs";
import { PROVIDER_META } from "../lib/provider-meta";
import {
  contextPercent,
  estimateContextTokens,
  formatCost,
  formatTokens,
  formatTokensK,
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
} from "../lib/api";
import { supportsReasoning } from "../lib/thinking";
import { allModes, getMode } from "../lib/modes";
import { prepareContent } from "../lib/bidi";
import { registerChatSend, sendPendingSteerNext, sendQueuedNext, uid2 } from "../lib/chatSends";
import {
  GLOBAL_SHORTCUTS,
  PREFIX_LABEL,
  PREFIX_SHORTCUTS,
  formatGlobalShortcut,
  formatShortcut,
} from "../lib/shortcuts";
import type {
  AgentMode,
  ChatMessage,
  MessageSegment,
  NvimDiagnostic,
  SidecarEvent,
  ToolActivity,
} from "../types";
import { ChatMessageView, RetryBanner, ThinkingBlock } from "./ChatMessage";
import { ModeIcon } from "./ModeIcon";
import { ModeSelect } from "./ModeSelect";
import { ProviderModelSelect } from "./ProviderModelSelect";
import { ToolCallView } from "./ToolCallView";

const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDER_META).map((m) => [m.kind, m.label]),
);

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
  const action = /(install|add|create|import|save|set up|setup|copy|نصب|ساخت|بساز|ایجاد|ذخیره|اضافه)\b/.test(
    low,
  );
  const target = /\b(skill|mcp|connector)s?\b|(اسکیل|مهارت|سورس)/.test(low);
  return action && target;
}

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
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
  // Model-scale the history char budget so small-context models (8k) get a tiny
  // slice, mirroring the backend's own trimmer.
  const ctx = contextWindow && contextWindow > 0 ? contextWindow : 32000;
  const budget = Math.floor(ctx * 1.5); // chars (~37% of window at 4 chars/token); mirrors the backend's conservative history share
  // Absolute per-mode ceilings: ask replies are guidance (not a scrollback to
  // re-read verbatim), and coder/plan turn history is mostly tool-call records
  // that stay relevant longer, but on very large windows the raw ctx*1.5 share
  // would balloon past what the context window can really hold — so cap each
  // mode. Mirrors the backend's per-mode caps.
  const MODE_HISTORY_CAPS: Record<string, number> = {
    ask: 60000,
    plan: 120000,
    coder: 140000,
  };
  const capped = Math.min(budget, MODE_HISTORY_CAPS[mode ?? "ask"] ?? budget);
  const recent = history.slice(-maxHistory);
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
  const provider = useStore(
    (s) =>
      s.settings.providers.find((p) => p.id === s.settings.activeProviderId) ??
      s.settings.providers[0],
  );
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

  // Which provider's balance the header chip displays: the active provider if it
  // returns a number, otherwise the first configured provider with a balance
  // (OpenRouter) so the chip always shows a real remaining amount.
  let shownBal: {
    provider: (typeof allProviders)[number];
    amount: number;
  } | null = null;
  const activeBal = provider ? creditMap[provider.id] : undefined;
  if (activeBal && activeBal.balance !== undefined) {
    shownBal = { provider, amount: activeBal.balance };
  } else {
    for (const p of allProviders) {
      const b = creditMap[p.id];
      if (b && b.balance !== undefined) {
        shownBal = { provider: p, amount: b.balance };
        break;
      }
    }
  }
  const root = useStore((s) => s.root);
  const dir = useStore((s) => s.dir);
  const workspaces = useStore((s) => s.workspaces);
  const toggleDir = useStore((s) => s.toggleDir);
  const settings = useStore((s) => s.settings);
  const autoSkills = useStore((s) => s.settings.autoSkills === true);
  const setAutoSkills = useStore((s) => s.setAutoSkills);
  const modes = useStore((s) => allModes(s.settings));
  const maxHistory = provider.maxHistory ?? defaultMaxHistoryFor(provider.kind);
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
  // Live thinking pinned to the top while the streaming message carries any
  // thinking text. Deliberately independent of `isThinking`: text chunks toggle
  // that flag on/off mid-turn, which used to flicker the pin on and off as the
  // model alternated between emitting text and reasoning.
  const liveThinking = chat?.messages.find((m) => m.streaming)?.thinking ?? "";
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
    Array<{ path: string; name: string; dataUrl?: string }>
  >(chat?.draft?.images ?? []);
  const [cmdOpen, setCmdOpen] = useState<{ at: number } | null>(null);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [noRootHint, setNoRootHint] = useState("");
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillIdx, setSkillIdx] = useState(0);
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
  const [skillChips, setSkillChips] = useState<
    Array<{ kind: "skill" | "mcp"; name: string; path?: string }>
  >(chat?.draft?.skillChips ?? []);
  const [permissionReq, setPermissionReq] = useState<{
    id: string;
    action: string;
    path?: string;
    reason?: string;
    scope?: string;
  } | null>(null);
  const [askReq, setAskReq] = useState<{
    id: string;
    question: string;
    options: string[];
  } | null>(null);
  const [askFreeText, setAskFreeText] = useState("");
  const mcpConnectors = useStore((s) => s.settings.mcpServers ?? {});
  const mcpEnabled = useStore((s) => s.settings.mcpEnabled ?? []);
  const setMcpEnabled = useStore((s) => s.setMcpEnabled);
  const skillQ = skillQuery.trim().toLowerCase();
  const filteredMcp = Object.keys(mcpConnectors).filter(
    (name) => !skillQ || name.toLowerCase().includes(skillQ),
  );
  const skillOptions: Array<{
    kind: "skill" | "mcp";
    name: string;
    path?: string;
  }> = [...filteredMcp.map((name) => ({ kind: "mcp" as const, name }))];
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
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
  const toggleRecordingRef = useRef<() => void>(() => { });
  /** Whether the open Neovim file is selected to be mentioned on the next send. */
  const [nvimMentioned, setNvimMentioned] = useState(false);
  /** Transient confirmation shown when the user switches the chat's mode. */
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  /** Transient confirmation shown after a manual /compact. */
  const [compactNotice, setCompactNotice] = useState<string | null>(null);
  /** Set when a compact attempt fails, so the composer can show a retry banner
   *  instead of silently collapsing messages behind a broken summary. Cleared
   *  on the next compact attempt (success or failure). */
  const [compactError, setCompactError] = useState<string | null>(null);
  /** Shown while the tmux-style Ctrl+X prefix is armed (waiting for the next key). */
  const [prefixNotice, setPrefixNotice] = useState<string | null>(null);

  // Switch the CURRENT chat's mode and confirm it visibly (so it's obvious the
  // change applies to this chat's next message, not a new chat).
  const changeMode = (mode: AgentMode) => {
    if (!chat) return;
    useStore.getState().setChatMode(chat.id, mode);
    const def = getMode(settings, mode);
    setModeNotice(
      `Mode changed to ${def.label} — your next message runs in this mode.`,
    );
  };

  // Cycle to the next/previous mode in the current chat (Tab / ⌘M).
  const cycleMode = (dir: 1 | -1) => {
    if (!chat) return;
    const ids = allModes(useStore.getState().settings).map((m) => m.id);
    const idx = ids.indexOf(chat.mode);
    const next = ids[(idx + dir + ids.length) % ids.length] ?? "ask";
    changeMode(next);
  };

  useEffect(() => {
    if (!modeNotice) return;
    const t = setTimeout(() => setModeNotice(null), 3500);
    return () => clearTimeout(t);
  }, [modeNotice]);

  useEffect(() => {
    if (!compactNotice) return;
    const t = setTimeout(() => setCompactNotice(null), 4000);
    return () => clearTimeout(t);
  }, [compactNotice]);

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
      setPrefixNotice(
        active
          ? `Prefix ${PREFIX_LABEL} active — press ${Object.keys(PREFIX_SHORTCUTS)
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
      skillChips,
    });
  }, [chat?.id, input, attachments, images, skillChips]);
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

  const onChatScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottom.current = atBottom;
    setShowJump(!atBottom);
  };

  useEffect(() => {
    if (!stickToBottom.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat?.messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

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

  const ctxWindow =
    (provider.contextMap?.[provider.model] &&
      provider.contextMap[provider.model] > 0 &&
      provider.contextMap[provider.model]) ||
    (provider.contextWindow && provider.contextWindow > 0
      ? provider.contextWindow
      : null);

  const contextUsed = useMemo(() => {
    // Source of truth: the REAL input+output tokens the provider reported for
    // the last completed exchange (message.usage), which already reflects
    // whatever the backend actually sent — base system prompt, auto-scout
    // dossier, RAG block and injected memory notes included. None of that is
    // knowable from the frontend, so a blind character estimate of `history`
    // alone was structurally unable to match it (it could only ever see the
    // conversation text, not the backend-only additions). Because compacted
    // messages are excluded and their `usage` is cleared, this naturally
    // resets to a small number right after a compact, then reflects real
    // usage again once the first post-compact reply completes. Falls back to
    // the character-based estimate only when no real usage exists yet (a
    // brand new chat, or the brief window between a compact and the next
    // completed reply).
    const msgs = chat?.messages ?? [];
    const active = msgs.filter((m) => !m.compacted);
    for (let i = active.length - 1; i >= 0; i--) {
      const u = active[i].usage;
      if (u) return u.totalTokens;
    }
    return estimateContextTokens(
      chat,
      systemPrompt,
      maxHistory,
      ctxWindow ?? undefined,
      chat?.mode,
    );
  }, [chat, systemPrompt, maxHistory, ctxWindow]);

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
    imgs: Array<{ path: string; name: string }> = [],
    allowCreate = false,
    reuseMsgId?: string,
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
    const activeProvider = getActiveProvider();
    if (!activeProvider.model) {
      s.setSettingsOpen(true);
      return;
    }
    s.addRecentModel(activeProvider.model, activeProvider.id);

    // Selected skills (chips) and enabled MCP connectors (persistent switches)
    // become an explicit instruction on this turn.
    const skillNotes: string[] = [];
    // Read from the live chat's draft (not the component closure) so a turn
    // drained while this panel is unmounted still carries the picked chips.
    const activeChips = chat.draft?.skillChips ?? skillChips;
    for (const chip of activeChips) {
      if (chip.kind === "skill") {
        skillNotes.push(
          `Read ${chip.path} and follow its instructions exactly.`,
        );
      }
    }
    for (const name of s.settings.mcpEnabled ?? []) {
      if (s.settings.mcpServers?.[name]) {
        skillNotes.push(
          `Use the MCP tools from server "${name}" where relevant.`,
        );
      }
    }
    const finalPrompt =
      skillNotes.length > 0
        ? `${text}\n\n=== USER-SELECTED SKILLS/TOOLS FOR THIS TURN ===\n${skillNotes.join(
          "\n",
        )}`
        : text;

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
        toolActivity: (m.toolActivity ?? []).filter((a) => a.status !== "running"),
      }));
    const history = sliceToBudget(
      allHistory,
      maxHistory,
      ctxWindow ?? undefined,
      chat.mode,
    );

    const abort = new AbortController();
    abortRef.current = abort;
    useStore.getState().setChatAbort(chat.id, abort);
    setBusy(true);
    setStalled(false);
    lastEventAt.current = Date.now();
    stalledSinceRef.current = null;
    watchdogAbortedRef.current = false;
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

    // Watchdog: if the provider stalls (no SSE event at all), surface a hint so
    // the run doesn't silently hang at a "retrying" banner. 180s because the
    // backend read timeout is 300s and slow free-tier thinking models can pause
    // well past 60s between streamed chunks — a 60s threshold false-alarmed
    // during legitimate long thinking.
    // If the silence continues for a further HARD_STALL_GRACE_MS past that
    // hint, force-abort: a truly dead connection (backend process crashed, a
    // socket that never signals close, ...) produces NO event ever, so
    // handleEvent's own "error" path can never fire on its own — without this,
    // `busy` stays true and the composer's Send button stays stuck on the stop
    // icon forever, with no visible error at all.
    const HARD_STALL_GRACE_MS = 120_000;
    const stallTimer = setInterval(() => {
      const limit = toolRunningRef.current ? 900_000 : 180_000;
      const elapsed = Date.now() - lastEventAt.current;
      if (elapsed <= limit) {
        stalledSinceRef.current = null;
        return;
      }
      setStalled(true);
      if (stalledSinceRef.current == null) stalledSinceRef.current = Date.now();
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
      if (!msg || !msg.toolActivity?.some((a) => a.status === "running")) return;
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
      lastEventAt.current = Date.now();
      setStalled(false);
      const store = useStore.getState();
      const findMsg = () =>
        store.chats
          .find((c) => c.id === chat.id)
          ?.messages.find((m) => m.id === assistantMsg.id);
      if (event.kind === "text") {
        useStore.getState().setStreaming(true, false);
        store.updateMessage(assistantMsg.id, {
          content: (findMsg()?.content ?? "") + (event.content ?? ""),
          segments: appendTextSegment(findMsg()?.segments, event.content ?? ""),
          retry: null,
        });
      } else if (event.kind === "thinking") {
        useStore.getState().setStreaming(true, true);
        store.updateMessage(assistantMsg.id, {
          thinking: (findMsg()?.thinking ?? "") + (event.content ?? ""),
          retry: null,
        });
      } else if (event.kind === "skill") {
        const names = Array.isArray(event.skills) ? event.skills : [];
        if (names.length > 0) {
          const note = `> ✦ **Auto-selected skills:** ${names.join(", ")}\n\n`;
          store.updateMessage(assistantMsg.id, {
            content: note + (findMsg()?.content ?? ""),
          });
        } else if (event.note) {
          store.updateMessage(assistantMsg.id, {
            content: `> ${event.note}\n\n` + (findMsg()?.content ?? ""),
          });
        }
      } else if (event.kind === "subagent_models") {
        // Debug-only routing info. Deliberately NOT rendered into the chat —
        // the user asked for subagent model lists to stay out of the message.
      } else if (event.kind === "tool") {
        toolRunningRef.current = true;
        const act: ToolActivity = {
          tool: event.tool ?? "tool",
          args: event.args,
          status: "running",
          startedAt: Date.now(),
          callId: typeof event.call_id === "number" ? event.call_id : undefined,
          sub: event.sub,
        };
        // Sub-agent tool calls (explore's internal read/grep/glob) render
        // NESTED inside the running explore card, not as top-level cards —
        // so an explore turn shows one collapsible parent with its details,
        // never a stack of collapsed fragments.
        if (event.sub) {
          const prev = findMsg()?.toolActivity ?? [];
          const next = prev.map((a): ToolActivity => {
            if (a.tool === "explore" && a.status === "running") {
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
          },
        });
      } else if (event.kind === "tool_result") {
        toolRunningRef.current = false;
        const current = findMsg()?.toolActivity ?? [];
        const now = Date.now();
        const gotId = typeof event.call_id === "number";
        const resolved = (act: ToolActivity): ToolActivity => {
          // Match by per-call correlation id first (precise — the same tool
          // can run many times, and explore sub-agent events share tool names);
          // fall back to tool-name+status matching when the result has no id.
          const target =
            gotId && act.status === "running" && act.callId === event.call_id;
          const fallback =
            !gotId && act.tool === event.tool && act.status === "running";
          if (target || fallback) {
            return {
              ...act,
              status: event.status === "error" ? "error" : event.status === "denied" ? "denied" : "done",
              summary: event.summary,
              engine: event.engine,
              items: event.results,
              elapsedMs: now - (act.startedAt ?? now),
            };
          }
          // Sub-agent results resolve a child INSIDE the running explore card,
          // never a top-level card (sub calls are nested, not standalone).
          if (event.sub && act.children && act.children.length > 0) {
            const children = act.children.map(resolved);
            if (children.some((c, i) => c !== act.children![i])) {
              return { ...act, children };
            }
          }
          return act;
        };
        const next = current.map(resolved);
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
      } else if (event.kind === "compact") {
        // Auto-compact: fold the older messages into the summary. The summary
        // is persisted as a system message so the next request still sends it
        // to the backend — the agent doesn't forget the compacted context.
        // Deliberately does NOT touch scroll position: this can fire on almost
        // every turn once the window is near full, and yanking the view up to
        // the summary mid-stream (previously via scrollIntoView) is exactly
        // what caused the chat to suddenly jump away from the live reply. The
        // summary is still fully visible by scrolling up whenever the user wants.
        const chatId = chat.id;
        if (chatId) {
          store.compactChat(chatId, event.content ?? "", maxHistory);
        }
      } else if (event.kind === "compact_failed") {
        // Auto-compact failed — the backend did NOT drop any messages. Surface
        // the retry banner so the user can compact manually (the manual path
        // runs the summarizer as a read-only ask request with the parent model,
        // which succeeds even when the compact subagent model is invalid).
        setCompactError(
          event.reason || "Automatic compaction failed — nothing was deleted.",
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
        setPermissionReq({
          id: event.id ?? "",
          action: event.action ?? "",
          path: event.path,
          reason: event.reason,
          scope: event.scope,
        });
      } else if (event.kind === "ask") {
        setAskFreeText("");
        setAskReq({
          id: event.id ?? "",
          question: event.question ?? "",
          options: Array.isArray(event.options) ? event.options : [],
        });
      } else if (event.kind === "error") {
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
          store.updateMessage(id, { steerPending: false, steerInterleaved: true });
        }
      } else if (event.kind === "usage") {
        // `unbilled` events report a REJECTED (window-overflow) request — the
        // provider never charged those tokens, so they must not count toward
        // the message badge or the chat's billed totals.
        if (event.unbilled) return;
        const inputTokens = event.input_tokens ?? 0;
        const outputTokens = event.output_tokens ?? 0;
        const total = event.total_tokens ?? inputTokens + outputTokens;
        const model = (event.model || "").trim() || provider.model || "main";
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
        store.updateMessage(assistantMsg.id, {
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: total,
            cacheReadTokens: event.cache_read_tokens ?? 0,
            cacheWriteTokens: event.cache_write_tokens ?? 0,
          },
        });
      } else if (event.kind === "done") {
        // The backend signals the end of the stream with a "done" event.
        // Clear the stall hint immediately and refresh the watchdog clock so a
        // queued stall-timer callback can't re-set it after the stream closes.
        setStalled(false);
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
          images: imgs.map((i) => i.path),
          systemPrompt: s.settings.systemPrompts?.[chat.mode] ?? "",
          thinkingLevel: supportsReasoning(
            activeProvider.model,
            activeProvider.kind,
          )
            ? (activeProvider.thinkingLevel ?? "")
            : "",
          mcpServers: (() => {
            const all = s.settings.mcpServers ?? {};
            const sel: Record<string, (typeof all)[string]> = {};
            for (const n of s.settings.mcpEnabled ?? [])
              if (all[n]) sel[n] = all[n];
            return sel;
          })(),
          skills: activeChips
            .filter((c) => c.kind === "skill")
            .map((c) => c.name),
          autoSkills: s.settings.autoSkills === true,
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
        // connection was silent for minutes straight, so surface a real,
        // visible error instead of the normal silent AbortError handling below.
        handleEvent({
          kind: "error",
          content:
            "The connection went silent for too long and was closed automatically — the backend may have crashed or lost connectivity. Please try again.",
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
      setStalled(false);
      setBusy(false);
      setAskReq(null);
      setPermissionReq(null);
      resolveStuckCards();
      abortRef.current = null;
      useStore.getState().setChatAbort(chat.id, null);
      useStore.getState().setStreaming(false, false);
      useStore
        .getState()
        .updateMessage(assistantMsg.id, { streaming: false, retry: null });
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
    const s = useStore.getState();
    const ch = s.chats.find((c) => c.id === s.activeChatId);
    if (!ch) return;
    const msgs = ch.messages.filter(
      (m) => !m.compacted && (m.role === "user" || m.role === "assistant"),
    );
    if (msgs.length === 0) return;
    const transcript = msgs
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n")
      .slice(-120000);
    const rootDir = ch.root || s.root;
    setBusy(true);
    setCompactError(null);
    const prompt =
      "Summarize the following conversation into concise notes for continued work. " +
      "Keep key decisions, files touched, and open questions. Answer in ENGLISH even if the " +
      "conversation is in another language (e.g. Persian/Farsi), under 150 words, no preamble.\n\n" +
      transcript;
    let summary = "";
    let failed = false;
    let failReason = "";
    // Run the summarizer as a minimal READ-ONLY request: no tools (every cap
    // false), no MCP servers, no skills, and the "ask" base prompt. This stops
    // the summarizer from being hijacked into tool loops or plan output, which
    // made /compact hang or return non-summary text in coder/plan mode.
    const ctr = new AbortController();
    const timeout = setTimeout(() => ctr.abort(), 60_000);
    try {
      await streamChat(
        {
          provider: getActiveProvider(),
          root: rootDir,
          mode: "ask",
          prompt,
          history: [],
          maxHistory: 0,
          systemPrompt: "",
          cap: {
            readFiles: false,
            writeFiles: false,
            runTerminal: false,
            web: false,
          },
          mcpServers: {},
          skills: [],
          autoSkills: false,
          signal: ctr.signal,
        },
        (ev) => {
          if (ev.kind === "text") summary += ev.content ?? "";
          else if (ev.kind === "error") {
            failed = true;
            failReason = ev.content ?? "unknown error";
          }
        },
      );
    } catch (err) {
      failed = true;
      failReason =
        (err as Error).name === "AbortError"
          ? "timed out after 60s"
          : (err as Error).message;
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
    // A summarizer that errored or returned nothing at all is a failed compact
    // — do NOT collapse the real messages behind a fake "(compact failed)"
    // summary. Leave the chat untouched and let the user retry manually.
    if (failed || !summary.trim()) {
      setCompactError(failReason || "empty summary");
      return;
    }
    s.compactChat(
      ch.id,
      `[Compacted conversation]\n${summary.trim()}`,
      maxHistory,
    );
    // Best-effort: stash the summary in short-term RAG (~24h) so the compressed
    // history stays recallable via memory later. Never blocks or throws.
    addMemoryNote(rootDir, `[Compacted conversation]\n${summary.trim()}`).catch(
      () => { },
    );
    setCompactNotice(
      "Context compacted — older messages are collapsed above the summary.",
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
          s.addMessage(ch?.id ?? "", { role: "assistant", content: "Nothing to undo." });
        }
        break;
      case "/redo":
        if (ch && s.redoMessage()) {
          s.addMessage(ch.id, { role: "assistant", content: "↪ Redone." });
        } else {
          s.addMessage(ch?.id ?? "", { role: "assistant", content: "Nothing to redo." });
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
        s.addMessage(ch?.id ?? "", {
          role: "assistant",
          content: `Unknown command \`${word}\`. Type \`/help\` to see available commands.`,
        });
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
      if (!msg || msg.role !== "user" || !msg.content.trim()) return;
      if (!s.truncateTo(id)) return;
      const text = msg.content;
      // Give the abort's finally block a tick to reset busy/streaming state
      // before re-sending (send() re-sets busy=true itself, but the abort's
      // finally would otherwise clear it mid-run).
      setTimeout(() => send(text, msg.attachments ?? [], msg.images ?? []), 0);
    },
    [busy, send, maxHistory],
  );

  // Stable identity for memoized children: ChatMessageView is React.memo'd, so a
  // recreated `onRetry` per render would defeat it. Route through a ref instead.
  const retryMessageRef = useRef(retryMessage);
  retryMessageRef.current = retryMessage;
  const onRetry = useMemo(
    () => (id: string) => retryMessageRef.current(id),
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
      void steerChat(chatObj.id, userMsg.id, v);
      return;
    }
    setInput("");
    setCmdOpen(null);
    void send(v, atts, imgs);
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
    setInput("");
    setImages([]);
  };

  const addImage = (p: string, name: string) => {
    setImages((imgs) =>
      imgs.some((i) => i.path === p) ? imgs : [...imgs, { path: p, name }],
    );
    void api
      .readImage(p)
      .then((dataUrl) => {
        if (dataUrl)
          setImages((imgs) =>
            imgs.map((i) => (i.path === p ? { ...i, dataUrl } : i)),
          );
      })
      .catch(() => undefined);
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
    setImages((imgs) =>
      imgs.some((i) => i.path === path) ? imgs : [...imgs, { path, name }],
    );
    const dataUrl = await api.readImage(path).catch(() => null);
    if (dataUrl) {
      setImages((imgs) =>
        imgs.map((i) => (i.path === path ? { ...i, dataUrl } : i)),
      );
    }
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
          const lang = dir === "rtl" || /[\u0600-\u06FF]/.test(input) ? "fa" : undefined;
          console.debug("[voice] transcribing", { mime: blob.type, bytes: blob.size, lang });
          const text = await transcribeAudio(blob, setTranscribing, lang);
          if (text) {
            setInput((prev) => (prev ? prev.trimEnd() + " " + text : text));
            textareaRef.current?.focus();
          } else {
            console.debug("[voice] empty transcription (silence/unrecognized)");
            window.alert("Nothing was recognized — please try again.");
          }
        } catch (err) {
          window.alert(
            `Voice transcription failed: ${err instanceof Error ? err.message : String(err)
            }`,
          );
        } finally {
          setTranscribing(false);
        }
      };
      mediaRecorderRef.current = rec;
      rec.start();
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

  const toggleSkillChip = (item: {
    kind: "skill" | "mcp";
    name: string;
    path?: string;
  }) => {
    setSkillChips((chips) => {
      const exists = chips.some(
        (c) => c.kind === item.kind && c.name === item.name,
      );
      return exists
        ? chips.filter((c) => !(c.kind === item.kind && c.name === item.name))
        : [...chips, item];
    });
    setSkillOpen(false);
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
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (cmdOpen && filteredCmds.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCmdIndex((i) => (i + 1) % filteredCmds.length);
        return;
      }
      if (e.key === "ArrowUp") {
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
    if (skillOpen && e.key === "Escape") {
      e.preventDefault();
      setSkillOpen(false);
      return;
    }

    if (!cmdOpen && e.key === "Tab") {
      e.preventDefault();
      cycleMode(e.shiftKey ? -1 : 1);
      return;
    }

    if (e.key === "/" && !cmdOpen && !(e.metaKey || e.ctrlKey)) {
      startCmd();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const stop = () => {
    setAskReq(null);
    setPermissionReq(null);
    abortRef.current?.abort();
    useStore.getState().chatAborts[chatIdRef.current]?.abort();
  };

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
              {provider.model || "no model"}
            </span>
            <span
              className={`badge context-meter${ctxPct !== null && ctxPct >= 70 ? " warn" : ""}`}
              title={
                ctxWindow != null
                  ? `Context used: estimate of the current window (of the model's ${formatTokens(ctxWindow)} window) — resets on compact.`
                  : "Context used: estimate of the current window — resets on compact."
              }
              dir="ltr"
            >
              {ctxPct !== null && (
                <span className="context-meter-track">
                  <span
                    className="context-meter-fill"
                    style={{ width: `${ctxPct}%` }}
                  />
                </span>
              )}
              <span className="context-meter-text">
                {formatTokens(contextUsed)}
                {ctxWindow != null ? ` / ${formatTokens(ctxWindow)}` : ""}
                {ctxPct !== null ? ` (${ctxPct}%)` : ""}
              </span>
            </span>
            {shownBal && (
              <span
                className="badge titlebar-balance"
                title={`${shownBal.provider.name} balance`}
                dir="ltr"
              >
                💳 ${shownBal.amount.toFixed(2)}
              </span>
            )}
          </div>,
          titlebarEl,
        )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onChatScroll}>
        {liveThinking && (
          <div className="thinking-pin">
            <ThinkingBlock text={liveThinking} />
          </div>
        )}
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
          {chat.messages.map((m: ChatMessage) => (
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
          {retryingMsg?.retry && (
            <RetryBanner
              attempt={retryingMsg.retry.attempt}
              maxAttempts={retryingMsg.retry.maxAttempts}
              delay={retryingMsg.retry.delay}
              reason={retryingMsg.retry.reason}
              gaveUp={retryingMsg.retry.gaveUp}
              model={retryingMsg.retry.model}
              agent={retryingMsg.retry.agent}
              onRetry={() => {
                const msgs = chat?.messages ?? [];
                const idx = msgs.findIndex((m) => m.id === retryingMsg.id);
                const userMsg = [...msgs.slice(0, idx)]
                  .reverse()
                  .find((m) => m.role === "user");
                if (userMsg) retryMessageRef.current(userMsg.id);
              }}
              onCancel={stop}
            />
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
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
        )}
      </div>

      <div
        className={`composer${dragOver ? " dragover" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {askReq &&
          (() => {
            const fa = /[\u0600-\u06FF]/.test(askReq.question);
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
                <div className="ask-card-question">
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
                          setAskReq(null);
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
                        <span className="ask-option-text">
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
                        setAskReq(null);
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
                        setAskReq(null);
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
            const fa = /[\u0600-\u06FF]/.test(permissionReq.action);
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
                <div className="ask-card-question">
                  {prepareContent(permissionReq.action, fa ? "rtl" : "ltr")}
                </div>
                {permissionReq.path ? (
                  <code className="perm-path" dir="ltr">
                    {permissionReq.path}
                  </code>
                ) : null}
                {permissionReq.reason ? (
                  <div className="perm-reason">
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
                      setPermissionReq(null);
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
                        setPermissionReq(null);
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
                          setPermissionReq(null);
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
                          setPermissionReq(null);
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
          {modeNotice && (
            <div className="mode-notice" dir="ltr">
              {modeNotice}
            </div>
          )}
          {prefixNotice && (
            <div className="mode-notice prefix-notice" dir="ltr">
              {prefixNotice}
            </div>
          )}
          {compactNotice && (
            <div className="mode-notice compact-notice" dir="ltr">
              {compactNotice}
            </div>
          )}
          {compactError && (
            <div className="mode-notice compact-notice compact-error" dir="ltr">
              <span>Compact failed — {compactError}</span>
              <button
                type="button"
                className="compact-retry-btn"
                disabled={busy}
                onClick={() => void compactContext()}
              >
                Retry
              </button>
              <button
                type="button"
                className="compact-dismiss-btn"
                onClick={() => setCompactError(null)}
                title="Dismiss"
              >
                ×
              </button>
            </div>
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
            {skillOpen && (
              <div className="mention-popup" ref={skillPopupRef} dir="ltr">
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
                      e.key.toLowerCase() === "n"
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      move(1);
                      return;
                    }
                    if (
                      (e.ctrlKey || e.metaKey) &&
                      e.key.toLowerCase() === "p"
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
              ref={textareaRef}
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
              value={input}
              onChange={onInputChange}
              onKeyDown={onKeyDown}
            />
          </div>

          {nvimLabel && (
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
                  <span className="nvim-lsp" dir="ltr">
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
                      <span className="lsp-count lsp-info" title="LSP info/hints">
                        {nvimDiagCounts.info + nvimDiagCounts.hint}·
                      </span>
                    )}
                  </span>
                )}
              <span className="nvim-check">{nvimMentioned ? "✓" : "+"}</span>
            </button>
          )}

          {(attachments.length > 0 ||
            images.length > 0 ||
            skillChips.some((c) => c.kind === "skill")) && (
              <div className="attachment-chips" dir="ltr">
                {skillChips
                  .filter((c) => c.kind === "skill")
                  .map((c) => (
                    <span
                      className="attachment-chip skill-chip"
                      key={`${c.kind}-${c.name}`}
                    >
                      <span className="chip-icon-badge">✦</span>
                      {c.name}
                      <button
                        className="chip-x"
                        onClick={() => toggleSkillChip(c)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                {attachments.map((a) => (
                  <span className="attachment-chip" key={a}>
                    {a}
                    <button
                      className="chip-x"
                      onClick={() => removeAttachment(a)}
                    >
                      ×
                    </button>
                  </span>
                ))}
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

          {queuedMsgs.length > 0 && (
            <div className="attachment-chips queued-chips" dir="ltr">
              {queuedMsgs.map((q) => (
                <span
                  className={`attachment-chip queued-chip${q.kind === "steer" ? " steer-chip" : ""}`}
                  key={q.id}
                  title={
                    q.kind === "steer"
                      ? "Sent to the running agent — will be addressed now or as the next turn"
                      : "Queued — auto-sends after the current turn"
                  }
                >
                  {q.kind === "steer" ? "↝" : "⏳"} {q.text.slice(0, 40)}
                  <button
                    className="chip-x"
                    onClick={() => useStore.getState().removeQueuedMessage(chat.id, q.id)}
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
              <ProviderModelSelect />
              <button
                type="button"
                className={`skills-toggle${autoSkills ? " on" : ""}`}
                onClick={() => setAutoSkills(!autoSkills)}
                title="Auto-use skills — pick the most relevant skills for each message (Coder mode)"
                aria-pressed={autoSkills}
              >
                <span className="skills-toggle-track">
                  <span className="skills-toggle-knob" />
                </span>
                <span className="skills-toggle-label">Skills</span>
              </button>
            </span>
            <span className="composer-hint">
              {busy && stalled && (
                <span className="composer-working warn">
                  {toolRunningRef.current
                    ? "Tool is still running… (Stop to cancel)"
                    : "Still waiting for the provider… (Stop to cancel)"}
                </span>
              )}
            </span>
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
