import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ToolActivity } from "../types";
import {
  detectDir,
  fixZwsp,
  isMostlyRtlText,
  prepareContent,
  stripBidiMarks,
} from "../lib/bidi";
import { fixArrowDirections, rehypeArrows } from "../lib/arrowDir";
import { rehypeLtrIslands, isolateLtrRuns, dirByText } from "../lib/ltrIslands";
import { copyToClipboard } from "../lib/clipboard";
import { dedupDocPaths, extractInlinePathParts, filePathFromHref, isDocPath, looksLikeFilePath, splitPathLine } from "../lib/fileTypes";
import { editTargetOf } from "../lib/toolActivity";
import { FileChip, FileIcon, openWorkspaceFile } from "./FileIcon";
import { RENDER_CAP, fmtSize } from "../lib/renderCap";
import { fmtClock, fmtClockFull, fmtClockTime, fmtMonthDay, fmtElapsed, isToday } from "../lib/time";
import { cancelSteer, ensureSidecar, peekSidecarUrl } from "../lib/api";
import { resolveLocalMedia } from "../lib/mediaUrl";
import { fallbackReason, humanizeError } from "../lib/errorText";
import { chatMessageViewPropsEqual } from "../lib/messageViewEqual";
import { friendlyTtsError, speakableMessageText, useTtsPlayback } from "../lib/tts";
import type { SpeakProviderOpts } from "../lib/api";
import { providerDisplayName } from "../lib/provider-meta";
import { lspStatusLabel, useStore } from "../lib/store";
import { getMode } from "../lib/modes";
import { splitSections } from "../lib/sections";
import { handleLinkClick, splitTextByUrls } from "../lib/link";
import { ArtifactCard } from "./ArtifactCard";
import { getHighlightedLines } from "../lib/highlight";
import {
  ToolCallView,
  ToolEditGroupView,
  ToolGroupView,
  ToolSingleRow,
  TraceNarration,
  isEditActivity,
  isSubagentCard,
} from "./ToolCallView";
import { AskUserCard } from "./AskUserCard";
import { MessageImages } from "./MessageImages";
import "highlight.js/styles/github-dark.min.css";
import { useViewerTabs } from "../lib/viewerTabs";
import { planDisplay } from "../lib/planDoc";

// ── Heavy, rarely-mounted children are code-split ────────────────────────────
// Reading mode is a two-pane document viewer that only mounts after the user
// clicks "مطالعه"; Mermaid drags in the whole diagram engine (~500 KB). Both
// used to sit in the startup chunk, so every session paid for them even when
// neither was ever shown.
const ReadingMode = lazy(() =>
  import("./ReadingMode").then((m) => ({ default: m.ReadingMode })),
);
// Mermaid: the module itself is light (it only imports the ENGINE dynamically,
// so the engine lands in its own chunk) and the block paints a static
// placeholder until the user scrolls it into view.
import { Mermaid } from "./Mermaid";
import { ChartBlock } from "./ChartBlock";
import { MessageActionsBar, MsgClocks } from "./MessageActionsBar";

/** Basename for attachment chips: message bubbles must show "report.pdf",
 *  never the full absolute path (imported uploads live in the app data root
 *  and rendering it verbatim is noise). The full path stays in the tooltip. */
/** Show a TTS error in the chat footer. It does not fade on a timer: the next
 *  status (new turn, compaction, notice — see Chat.tsx) replaces it. */
function postTtsError(chatId: string, msg: string): void {
  useStore.getState().setChatTtsError(chatId, msg);
}

export function forkChatWithConfirm(messageId: string): void {
  const s = useStore.getState();
  const src = s.chats.find((c) => c.messages.some((m) => m.id === messageId));
  if (!src) return;
  const label = (src.title || "").trim() || "این چت";
  if (
    !window.confirm(
      `از «${label}» یک چت جدید (فورک) ساخته شود؟\n\n` +
        "فورک فقط تا همین نقطه را به‌صورت خلاصه به همراه می‌برد و چت فعلی دست‌نخورده می‌ماند.",
    )
  ) {
    return;
  }
  s.forkChatFromMessage(messageId);
}

/** Render prepared user text as one block per line, each with its own
 *  direction (detectDir). A line keeps pre-wrap wrapping; an empty line
 *  becomes a spacer. */
// Original surface, re-exported verbatim:
export { cachedPrepare } from './message/shared'
export { cachedPrepareText } from './message/shared'
export { perLineDir } from './message/shared'
export { PREPARED_CACHE_MAX } from './message/shared'

export { CodeBlock } from './message/doccard'
export { EDIT_ICON } from './message/doccard'
export { MarkdownImage } from './message/doccard'
export { PlanDocCard } from './message/doccard'
export { VideoThumbnailCard } from './message/doccard'
export { _vimeoId } from './message/doccard'
export { _ytId } from './message/doccard'
export { codeFilePath } from './message/doccard'
export { codeLang } from './message/doccard'
export { codeStartLine } from './message/doccard'
export { extractVideoEmbed } from './message/doccard'
export { openExternalPreferred } from './message/doccard'
export { textFromChildren } from './message/doccard'
export { MarkdownProse } from './message/markdown'
export { PROSE_REHYPE_PLUGINS } from './message/markdown'
export { PROSE_REMARK_PLUGINS } from './message/markdown'
export { keepFileUrls } from './message/markdown'
export { mdComponents } from './message/markdown'
export { ALWAYS_VISIBLE_TOOLS } from './message/thinking'
export { EditIcon } from './message/thinking'
export { InlineRetryLine } from './message/thinking'
export { THINKING_DEFAULT_H } from './message/thinking'
export { THINKING_MAX_H } from './message/thinking'
export { THINKING_MIN_H } from './message/thinking'
export { ThinkingBlock } from './message/thinking'
export { ThinkingIndicator } from './message/thinking'
export { USER_COLLAPSE_CHARS } from './message/thinking'
export { USER_COLLAPSE_LINES } from './message/thinking'
export { computeLeft } from './message/thinking'
export { fmtTokens } from './message/thinking'
export { isCollapsibleText } from './message/thinking'
export { localWords } from './message/thinking'
export { subRetryInfo } from './message/thinking'
export { textTabTitle } from './message/thinking'
export { CAPTION_MAX_CHARS } from './message/bubbles'
export { CAPTION_MAX_LINES } from './message/bubbles'
export { QueuedCollapsibleText } from './message/bubbles'
export { SegSteerBubble } from './message/bubbles'
export { SummaryBlock } from './message/bubbles'
export { UserMessageBubble } from './message/bubbles'
export { editQueuedText } from './message/bubbles'
export { isCaptionCandidate } from './message/bubbles'
export { summaryPreviewText } from './message/bubbles'

import { QueuedCollapsibleText, SegSteerBubble, SummaryBlock, UserMessageBubble, isCaptionCandidate } from './message/bubbles'
import { PlanDocCard } from './message/doccard'
import { MarkdownProse } from './message/markdown'
import { ALWAYS_VISIBLE_TOOLS, InlineRetryLine, ThinkingIndicator, subRetryInfo, textTabTitle } from './message/thinking'

import { DocFileChips } from './message/shared'
import { PREPARED_CACHE_MAX } from './message/shared'
import { PREPARED_CACHE_MAX_CHARS } from './message/shared'
import { PREPARED_CACHE_SKIP_CHARS } from './message/shared'
import { attachmentBasename } from './message/shared'
import { cachedPrepare } from './message/shared'
import { cachedPrepareText } from './message/shared'
import { computePrepared } from './message/shared'
import { docPathsFromActivities } from './message/shared'
import { dropPrepared } from './message/shared'
import { perLineDir } from './message/shared'
import { preparedCache } from './message/shared'
import { preparedCacheChars } from './message/shared'
import { useCapped } from './message/shared'

export function renderSegments(
  message: ChatMessage,
  onRetry?: (id: string) => void,
  onEdit?: (messageId: string, newText: string) => void,
  editingDisabled?: boolean,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let pending: { activity: ToolActivity; index: number }[] = [];
  // A run of consecutive tool rows / groups (no real prose between them)
  // accumulates here instead of going straight into `nodes`, so the whole run
  // wraps in ONE card (see wrapTrace) instead of each item floating as its own
  // bordered box with a gap around it.
  let trace: ReactNode[] = [];
  // The narration line held back to attach to the NEXT tool call (see
  // isCaptionCandidate). Stored per-call so a narration BETWEEN two calls
  // (caption, tool, caption, tool) attaches to its own call without breaking
  // the run into separate groups — the whole run stays ONE group.
  let pendingCaption: string | null = null;
  // Per-call captions collected while the run accumulates: caption[i] is the
  // narration that preceded pending[i]. The LAST one also becomes the group
  // head's summary title (Claude.ai style).
  const captions: (string | null)[] = [];
  // Monotonic counter for orphan-caption prose fallbacks (a held-back caption
  // with no groupable call after it) — guarantees unique React keys even when
  // several such captions appear in one message.
  let orphanCap = 0;
  // هویت پایدار کارت trace (والد گروه‌ها): ایندکس اولین فعالیتِ رانِ جاری —
  // نه نقطه‌ای که ران بسته می‌شود. کلید پوزیشنال («trace-{i}» / «trace-end»)
  // همان باگ کلید گروه را برای والدِ آن هم زنده نگه می‌داشت: حین استریم،
  // narration نیمه‌تایپ‌شده هنوز فراخوانیِ بعدی را ندارد و موقتاً prose
  // حساب می‌شود؛ ران زیر یک کلید flush می‌شود. لحظه‌ای بعد فراخوانی می‌رسد،
  // همان متن caption می‌شود و ران زیر کلید دیگری دوباره flush می‌شود —
  // تغییر کلید والد یعنی unmount کل زیردرخت و از دست رفتن state باز/بسته
  // بودن گروهی که کاربر باز کرده بود. لنگر به اولین فعالیتِ ران (مثل
  // grp-… فقط یک‌بار ثبت می‌شود) کلید را در همهٔ رندرها ثابت نگه می‌دارد؛
  // گروهِ باز فقط با کلیک خود کاربر بسته می‌شود.
  let traceAnchor: number | null = null;
  // ران ویرایشی جدا: edit_file/write_fileهای پشت‌سرهم این‌جا انباشته می‌شوند
  // تا در یک گروه ویرایش واحد (ToolEditGroupView) فلاش شوند — هرگز با ران
  // فقط‌خواندنی (pending) قاطی نمی‌شوند.
  let pendingEdit: { activity: ToolActivity; index: number }[] = [];
  const flushEdits = () => {
    if (pendingEdit.length === 0) return;
    if (pendingEdit.length === 1) {
      const entry = pendingEdit[0];
      const { activity } = entry;
      const entryIndex = entry.index;
      nodes.push(
        <ToolCallView
          key={`edit-${entryIndex}`}
          activity={activity}
          messageId={message.id}
          onReverted={() =>
            useStore.getState().markToolReverted(message.id, entryIndex)
          }
        />,
      );
    } else {
      const key = `edit-grp-${pendingEdit[0].index}`;
      nodes.push(
        <ToolEditGroupView
          key={key}
          activities={pendingEdit}
          messageId={message.id}
          onReverted={(idx) =>
            useStore.getState().markToolReverted(message.id, idx)
          }
        />,
      );
    }
    pendingEdit = [];
  };
  const wrapTrace = () => {
    if (trace.length === 0) return;
    nodes.push(
      <div key={`trace-${traceAnchor}`} className="tool-trace">
        {trace}
      </div>,
    );
    trace = [];
    traceAnchor = null;
  };

  const flush = () => {
    if (pending.length === 0) {
      // A held-back caption with no groupable call after it (e.g. the run
      // ended on a narration) renders as plain prose instead of vanishing.
      if (pendingCaption) {
        wrapTrace();
        renderProse(`cap-${orphanCap}`, pendingCaption);
        orphanCap++;
        pendingCaption = null;
      }
      return;
    }
    // Keyed by the FIRST activity's own stable index into
    // message.toolActivity — assigned once and never reused — NOT by the
    // segment-scan position. A position-based key breaks under streaming:
    // while a short narration line is still being typed, its FOLLOWING tool
    // segment hasn't arrived yet, so `nextIsGroupable` below can't tell it
    // apart from real prose and this run gets flushed early under one
    // positional key. A moment later the tool call lands, the same line is
    // correctly reclassified as a caption, and the run keeps accumulating
    // before flushing again under a DIFFERENT positional key (e.g.
    // "grp-end"). React sees a different key for what is, to the user, the
    // same group — unmounts the old ToolGroupView and mounts a fresh one
    // with open=false, which is the mid-stream "collapses by itself" bug.
    // The first activity's index survives that reclassification: the group
    // keeps one identity across renders no matter which scan point ends up
    // triggering the flush.
    const key = `grp-${pending[0].index}`;
    if (pending.length === 1 && !isSubagentCard(pending[0].activity)) {
      // یک فراخوانی تکی: narration مدل — اگر بود — به‌صورت ردیف جدا بالای
      // همین ردیف رندر می‌شود (TraceNarration) — مثل Claude.ai که کپشنِ
      // کارِ تکی در کادر جدا بالای ردیف ابزار دیده می‌شود.
      if (captions[0]) {
        trace.push(
          <TraceNarration key={`nar-${key}`} text={captions[0]} />,
        );
      }
      const { activity } = pending[0];
      trace.push(
        <ToolSingleRow key={key} activity={activity} messageId={message.id} />,
      );
    } else {
      // 2+ consecutive read-only calls collapse into ONE trace group even
      // when narrations interleave (caption, tool, caption, tool…): each
      // caption rides INSIDE the group attached to its own call — the last
      // one also becomes the head's summary title (Claude.ai style) — so
      // the run never splits into several floating groups. Pass a COPY:
      // `captions` is reused (cleared) for the next run, and React reads the
      // prop at render time — by-reference passing would hand it an empty
      // array by then.
      // A LONE sub-agent call (explore) also takes this path: ToolGroupView
      // renders it as a pill carrying the short description of what that
      // explore is looking for, which ToolSingleRow cannot show — so a single
      // explore is no longer an anonymous row.
      trace.push(
        <ToolGroupView
          key={key}
          activities={pending}
          captions={captions.slice()}
          live={message.streaming}
        />,
      );
    }
    pending = [];
    captions.length = 0;
    pendingCaption = null;
  };

  const renderProse = (key: string, text: string) => {
    nodes.push(
      <MarkdownProse
        key={key}
        text={cachedPrepare(`${message.id}:seg:${key}`, text)}
      />,
    );
  };

  const segs = message.segments ?? [];
  segs.forEach((seg, i) => {
    if (seg.kind === "user") {
      flush();
      wrapTrace();
      flushEdits();
      const steerMsg = useStore
        .getState()
        .chats.flatMap((c) => c.messages)
        .find((m) => m.id === seg.id);
      if (steerMsg) {
        nodes.push(
          <SegSteerBubble key={i} message={steerMsg} onRetry={onRetry} onEdit={onEdit} editingDisabled={editingDisabled} />,
        );
      }
      return;
    }
    if (seg.kind === "compact") {
      // A mid-turn auto-compact: fold the checkpoint in AT THE POINT it fired,
      // same treatment as an interleaved steer message above — the summary
      // message itself lives in the store (compactChat pushes it there too),
      // this segment just anchors where it renders.
      flush();
      wrapTrace();
      flushEdits();
      const summaryMsg = useStore
        .getState()
        .chats.flatMap((c) => c.messages)
        .find((m) => m.id === seg.id);
      if (summaryMsg) {
        nodes.push(<SummaryBlock key={i} message={summaryMsg} />);
      }
      return;
    }
    if (seg.kind === "artifact") {
      // An artifact card sits where the agent built it, between the prose that
      // introduced it and whatever comes next — not appended at the end.
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(<ArtifactCard key={i} segment={seg} messageId={message.id} />);
      return;
    }
    if (seg.kind === "text") {
      // Whitespace-only text (the model often emits a bare "\n\n" between two
      // tool calls, with no narration around it): pure formatting noise.
      // Falling through to the prose branch would flush the accumulating run
      // and close the trace card — the invisible break that split one logical
      // run into several back-to-back group cards with nothing rendered
      // between them. Skip it: the run keeps accumulating as if it never
      // existed.
      if (!seg.text.trim()) return;

      // Does this text immediately precede a groupable (non-always-visible)
      // tool call? If so, it's the model's narration for that call: render it
      // as its own row INSIDE the trace card, right above the call(s) — not a
      // separate prose paragraph outside the card.
      const next = segs[i + 1];
      const nextActivity =
        next && next.kind === "tool"
          ? message.toolActivity?.[next.index]
          : undefined;
      const nextIsGroupable =
        nextActivity &&
        !ALWAYS_VISIBLE_TOOLS.has(nextActivity.tool) &&
        !isSubagentCard(nextActivity);

      if (nextIsGroupable && isCaptionCandidate(seg.text)) {
        // A narration BEFORE a groupable tool: it belongs to the NEXT call.
        // Do NOT flush here — a narration BETWEEN two calls (caption, tool,
        // caption, tool) must attach to its own call while the run keeps
        // accumulating; flushing would split one logical run into several
        // floating groups (the "groups came out separate" bug).
        pendingCaption = seg.text;
        return;
      }

      // Genuine prose — flush whatever tool run was accumulating.
      flush();
      wrapTrace();
      flushEdits();
      renderProse(String(i), seg.text);
      return;
    }
    const activity = message.toolActivity?.[seg.index];
    if (!activity) return;
    // ران ویرایشی جدا: edit_file/write_file پشت‌سرهم در pendingEdit انباشته
    // می‌شوند و هرگز با ران فقط‌خواندنی (pending) یا گروه ابزارهای دیگر قاطی
    // نمی‌شوند. تک‌ویرایش مثل قبل کارت تکی (ToolCallView) می‌ماند تا Undo و
    // Review تکی هر فایل حفظ شود؛ ۲+ ویرایش در یک ToolEditGroupView جمع می‌شوند.
    if (isEditActivity(activity) && !isSubagentCard(activity)) {
      flush();
      wrapTrace();
      pendingEdit.push({ activity, index: seg.index });
      return;
    }
    // اجرای ساب‌ایجنت دقیقاً مثل یک tool group رندر می‌شود — همان ToolGroupView،
    // همان قاب tool-trace و بازشدن درجا با TraceRowهای فراخوانی‌های داخلی
    // (children) — با این تفاوت که نام ساب‌ایجنت pill اولِ هدر است. هر اجرای
    // موازی کارت مستقل خودش را نگه می‌دارد.
    if (isSubagentCard(activity)) {
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(
        <div key={`exp-${seg.index}`} className="tool-trace">
          <ToolGroupView
            subagent={activity}
            live={message.streaming}
            activities={(activity.children ?? []).map((child, ci) => ({
              activity: child,
              index: ci,
            }))}
          />
        </div>,
      );
      return;
    }
    if (activity.tool === "ask_user") {
      flush();
      wrapTrace();
      flushEdits();
      const ownerChat = useStore
        .getState()
        .chats.find((c) => c.messages.some((m) => m.id === message.id));
      const liveReq = ownerChat?.pendingAsk ?? null;
      nodes.push(
        <AskUserCard
          key={`ask-${seg.index}`}
          req={liveReq}
          activity={activity}
          messageId={message.id}
          inline
          live={!!liveReq}
        />,
      );
      return;
    }
    if (ALWAYS_VISIBLE_TOOLS.has(activity.tool)) {
      flush();
      wrapTrace();
      flushEdits();
      nodes.push(
        <ToolCallView
          key={i}
          activity={activity}
          messageId={message.id}
          onReverted={() =>
            useStore.getState().markToolReverted(message.id, seg.index)
          }
        />,
      );
    } else {
      // شروع ران فقط‌خواندنی: گروه ویرایش قبلی (اگر بود) اول بسته می‌شود تا
      // دو ران هرگز در یک کارت قاطی نشوند.
      flushEdits();
      // Attach the held-back narration to THIS call (per-call captions), then
      // keep accumulating — the run stays one group even with interleaved
      // narrations.
      captions.push(pendingCaption);
      pendingCaption = null;
      pending.push({ activity, index: seg.index });
      // لنگر wrapper = اولین فعالیتِ ران؛ فقط یک‌بار ثبت می‌شود (توضیح
      // traceAnchor بالا) تا کلید کارت trace در همهٔ رندرها ثابت بماند.
      if (traceAnchor === null) traceAnchor = seg.index;
    }
  });
  flush();
  wrapTrace();
  flushEdits();
  return nodes;
}

export const ChatMessageView = memo(
  function ChatMessageView({
    message,
    onRetry,
    onResume,
    onCompactRetry,
    onEdit,
    editingDisabled,
  }: {
    message: ChatMessage;
    onRetry?: (id: string) => void;
    /** Footer Retry for a failed/interrupted TURN: keeps the transcript and
     *  continues the same assistant bubble. Distinct from `onRetry`, which is
     *  the user bubble's Regenerate (truncate + fresh run). */
    onResume?: (id: string) => void;
    /** Footer Retry for a failed compaction (re-runs the summarizer). */
    onCompactRetry?: () => void;
    onEdit?: (messageId: string, newText: string) => void;
    editingDisabled?: boolean;
  }) {
  const isUser = message.role === "user";
  // Narrow subscriptions: reading the whole settings object re-rendered EVERY
  // message on ANY settings change. Only the mode label is needed for render;
  // TTS config is read lazily from getState() inside toggleSpeak.
  const modeLabelStr = useStore((s) =>
    message.mode ? getMode(s.settings, message.mode).label : "",
  );
  const { status: ttsStatus, toggle: ttsToggle, stop: ttsStop } = useTtsPlayback();

  const modeLabel = (_id: string) => modeLabelStr;

  // تصمیم پلی/پاز داخل toggle همگام و اتمیک است (نه با ttsStatus ناهمگام) —
  // کلیک تند هرگز دو پخش همزمان نمی‌سازد. حین پخش → pause درجا، حین pause →
  // resume از همان‌جا (نه از اول)، حین لودینگ → لغو. لغو دستی خطا نیست.
  const toggleSpeak = async () => {
    // Clear any previous banner error for this chat before a new attempt.
    try {
      const prevChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message.id))?.id;
      if (prevChatId) useStore.getState().setChatTtsError(prevChatId, null);
    } catch {
      // Banner clear is best-effort.
    }
    const st = useStore.getState();
    // A live voice session owns the audio output: never start separate message playback over it.
    const liveVoice = (st as unknown as { liveVoiceState?: string }).liveVoiceState;
    if (liveVoice === "live" || liveVoice === "speaking" || liveVoice === "connecting") {
      // Never a silent no-op: tell the user why the speaker button does nothing.
      const liveChatId = st.chats.find((c) => c.messages.some((m) => m.id === message.id))?.id;
      if (liveChatId) postTtsError(liveChatId, "ویس لایو فعال است — ابتدا آن را متوقف کنید");
      return;
    }
    const providers = st.settings.providers ?? [];
    // Build the provider chain: primary first, then ordered fallbacks.
    const toSpeakOpts = (
      provider: (typeof providers)[number],
      model: string | undefined,
      voice: string | undefined,
    ): SpeakProviderOpts => ({
      kind: provider.kind,
      baseUrl: provider.baseUrl ?? "",
      apiKeys: [...(provider.apiKeys ?? (provider.apiKey ? [provider.apiKey] : []))],
      model,
      voice,
    });
    const chain: SpeakProviderOpts[] = [];
    const primary = providers.find((p) => p.id === st.ttsProviderId);
    if (primary) chain.push(toSpeakOpts(primary, st.ttsModel, st.ttsVoice));
    for (const fb of st.ttsFallbacks ?? []) {
      const p = providers.find((x) => x.id === fb.providerId);
      if (!p) continue;
      chain.push(toSpeakOpts(p, fb.model, fb.voice));
    }
    if (chain.length === 0) {
      const msg = "برای پخش صدا ابتدا یک پروایدر TTS در تنظیمات ← مدل‌ها انتخاب کنید";
      const bannerChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message.id))?.id;
      if (bannerChatId) postTtsError(bannerChatId, msg);
      return;
    }
    // Only the final answer is spoken — the working trace (tool narrations,
    // status lines) shown mid-run is never read aloud.
    const speakable = stripBidiMarks(fixZwsp(speakableMessageText(message)));
    if (!speakable.trim()) {
      const msg = "متن قابل خواندنی برای پخش نیست";
      const bannerChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message.id))?.id;
      if (bannerChatId) postTtsError(bannerChatId, msg);
      return;
    }
    try {
      await ttsToggle(speakable, chain);
    } catch (err) {
      const friendly = friendlyTtsError(err);
      if (!friendly) return;
      console.warn("speak failed", err);
      const bannerChatId = useStore.getState().chats.find((c) => c.messages.some((m) => m.id === message.id))?.id;
      if (bannerChatId) postTtsError(bannerChatId, friendly);
    }
  };

  // قطع صدا هنگام شروع پیام جدید یا unmount تا پخش قدیمی روی پیام تازه نماند.
  useEffect(() => {
    if (message.streaming) ttsStop();
  }, [message.streaming, ttsStop]);
  useEffect(() => () => ttsStop(), [ttsStop]);

  // No live token estimate while streaming: the char-based estimate overshot
  // and then "fell back down" to the real provider numbers once the usage event
  // landed, which made the badge flicker up/down during long replies. The badge
  // now appears only once real usage exists (same as the titlebar meter), so it
  // stays stable.

  // Every system message is a context summary (compactChat is the only
  // producer of role=system) — render ALL of them as the collapsed
  // SummaryBlock, including older summaries marked compacted:true, which
  // previously fell through to the prose branch and dumped the FULL
  // summary text into the chat (the auto-compact "full text" bug).
  const isSummary = message.role === "system" && !message.modeSwitch;
  const isModeSwitch = message.modeSwitch === true;

  // Plan card display filtering: when a plan document is attached to this
  // message the plan portion of the streamed reply collapses into the Plan card
  // BELOW the bubble (see planDisplay). Raw content/segments stay untouched —
  // model history and "Copy message" keep the full text.
  const display = planDisplay(message);
  const planDoc = !isUser && !isSummary ? display.planDoc : undefined;
  const displayContent = display.content;
  const displaySegments = display.segments;
  // Non-code documents created or edited this turn (write_document plus doc
  // edits via edit_file/write_file). Rendered as clickable chips below.
  const docPaths = useMemo(() => {
    const docs = docPathsFromActivities(message.toolActivity);
    return dedupDocPaths(docs, message.attachments ?? []);
  }, [message.toolActivity, message.attachments]);
  // Render cap for the plain (non-segmented) assistant reply. Segmented
  // replies render caption slices around tool cards (small by construction);
  // the full text stays in history/copy regardless.
  const cap = useCapped(message.id, displayContent ?? "", !!message.streaming);
  // `cap.over` = a non-streaming reply past RENDER_CAP: the chat paints the
  // capped slice and "Show all" opens the full reply in the side panel.
  const replyText = displayContent ?? message.content ?? "";
  const replyBody = cap.shown;

  // Reading mode: only assistant replies with ≥2 headed sections get the
  // "مطالعه" button — short answers don't need a two-pane viewer.
  const [reading, setReading] = useState(false);
  const sections = useMemo(
    () => (!isUser && !isSummary ? splitSections(message.content) : []),
    [message.content, isUser, isSummary],
  );

  // Mode-switch notices exist so the model knows which mode the next message
  // runs in — the user doesn't want them rendered in the chat. Keep the message
  // in the data (the agent still receives it) but render nothing.
  if (isModeSwitch) return null;
  // Folded messages (auto/manual compact) STILL render: the summary is a
  // checkpoint, not a replacement for the transcript. Hiding them made every
  // chat look like it began at the CONTEXT SUMMARY card and made "Load earlier
  // messages" count records that could never appear. Windowing (see
  // `visibleChatMessages` / `sliceWindow`) keeps the mounted DOM bounded.

  // A steer confirmed by the backend (steer_applied) is rendered inline inside
  // the assistant message it interrupted — hide its own otherwise-bottom bubble.
  // Fallback: if no assistant message actually references this steer as a
  // segment (retry wiped segments, parent truncated/compacted), do NOT hide —
  // otherwise the message suddenly vanishes with no inline copy.
  if (isUser && message.steerInterleaved) {
    const referenced = useStore
      .getState()
      .chats.some((c) =>
        c.messages.some((m) =>
          (m.segments ?? []).some(
            (s) => s.kind === "user" && (s as { id: string }).id === message.id,
          ),
        ),
      );
    if (referenced) return null;
  }

  // The footer carries exactly ONE status at a time. When the notice row is up
  // (an error, an interrupted reply, a retry/compaction status), the send clock
  // and the turn stopwatch are hidden: next to a failure they read as a second,
  // unrelated status — and a stopped run's duration says nothing useful about
  // the error the user is trying to read.
  const hasFooterNotice = !!(
    message.retry ||
    (message.error && !message.streaming) ||
    message.interrupted ||
    message.footerStatus
  );

  // NOT hidden while retrying, even when still empty: the transcript-end retry
  // banner this once deferred to is gone — the retry/status line now lives in
  // THIS message's footer, so hiding the empty message hid the only status the
  // user had (just the Stop button was left).
  const roleLabel =
    message.role === "tool"
      ? "Tools"
      : message.mode
        ? modeLabel(message.mode)
        : "Assistant";

  return (
    <div
      className={`msg ${isUser ? "user" : ""} ${message.error ? "error" : ""}`}
      data-msg-id={message.id}
      data-is-summary={isSummary ? "true" : undefined}
    >
      {/* Role line: assistant/tool modes keep their label; USER messages drop
          the "You" + avatar entirely (user request) — the right-parked bubble
          already says who is speaking. Summary cards carry their own title,
          so no second "Context summary" line above them. */}
      {!isSummary && !isUser && (
      <div className="msg-role">
        {roleLabel}
      </div>
      )}

      {!isUser && message.plan && message.plan.length > 0 && (
        <div
          className="plan-block"
          dir={detectDir(message.plan.map((p) => p.content).join(" "))}
        >
          <div className="plan-head">
            <span className="plan-dot">◎</span>
            <span className="plan-label">Plan</span>
          </div>
          <ul className="plan-list">
            {message.plan.map((item, i) => (
              <li
                // Content is the only stable field (the backend stores no item
                // id), so an index key repainted the wrong row as done/running
                // whenever the agent reordered or appended plan items.
                key={item.id ?? item.content}
                className={`plan-item ${item.status === "completed" ? "done" : item.status === "in_progress" ? "running" : ""}`}
              >
                <span className="plan-item-mark">
                  {item.status === "completed"
                    ? "✓"
                    : item.status === "in_progress"
                      ? "●"
                      : "○"}
                </span>
                <span className="plan-item-content" dir="auto">
                  {cachedPrepare(`${message.id}:plan:${i}`, item.content)}
                </span>
                {typeof item.progress === "number" && item.status !== "completed" && (
                  /* Optional per-item progress (0-100) the agent may report
                     alongside update_plan; the backend stores items verbatim. */
                  <span className="plan-item-progress" dir="ltr" aria-label={`${Math.round(item.progress)}%`}>
                    <span
                      className="plan-item-progress-fill"
                      style={{ width: `${Math.max(0, Math.min(100, item.progress))}%` }}
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!isUser && message.attachments && message.attachments.length > 0 && (
        <div className="msg-attachments" dir="ltr">
          {message.attachments.map((a) => (
            <span
              className="attachment-chip attachment-chip-open"
              key={a}
              role="button"
              tabIndex={0}
              title={`${a} — open in the side panel`}
              // pointerdown, not click: a focus re-render can replace this node
              // before `click` fires (see FileChip). Click stays as a backup.
              onPointerDown={() => openWorkspaceFile(a)}
              onClick={() => openWorkspaceFile(a)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openWorkspaceFile(a);
                }
              }}
            >
              <FileIcon path={a} size={20} />{attachmentBasename(a)}
            </span>
          ))}
        </div>
      )}

      {(isSummary ||
        displayContent ||
        (displaySegments && displaySegments.length > 0)) &&
        (isModeSwitch ? (
          <div className="mode-switch-note" dir="ltr">
            {cachedPrepare(message.id, message.content, "ltr")}
          </div>
        ) : isSummary ? (
          <SummaryBlock message={message} />
        ) : displaySegments && displaySegments.length > 0 ? (
          /* Claude-style interleaved rendering: text slices and tool cards follow
             each other in the exact order the agent produced them, with runs of
             2+ read-only tool calls collapsed into one summary (see renderSegments). */
          <div className="msg-bubble segmented">
            {renderSegments(
              { ...message, segments: displaySegments },
              onRetry,
              onEdit,
              editingDisabled,
            )}
          </div>
        ) : isUser && message.steerPending ? (
          <div className="queued-bubble steer" dir={detectDir(message.content)}>
            <div className="queued-bubble-head">
              <span className="queued-bubble-icon">
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
              </span>
              <span className="queued-bubble-label">
                Steering the running agent…
              </span>
              <span className="queued-bubble-pulse" />
              <button
                className="chip-x queued-bubble-x"
                onClick={() => {
                  const s = useStore.getState();
                  const chat = s.chats.find((c) =>
                    c.messages.some((m) => m.id === message.id),
                  );
                  if (!chat) return;
                  s.removeMessage(chat.id, message.id);
                  void cancelSteer(chat.id, message.id);
                }}
                title="Cancel steer — remove this message"
              >
                ×
              </button>
            </div>
            <QueuedCollapsibleText
              id={message.id}
              text={message.content}
              onEdit={onEdit}
              editingDisabled={editingDisabled}
            />
            {message.attachments && message.attachments.length > 0 && (
              <div className="msg-attachments" dir="ltr">
                {message.attachments.map((a) => (
                  <span
                    className="attachment-chip attachment-chip-open"
                    key={a}
                    role="button"
                    tabIndex={0}
                    title={`${a} — open in the side panel`}
                    // pointerdown, not click: a focus re-render can replace
                    // this node before `click` fires (see FileChip).
                    onPointerDown={() => openWorkspaceFile(a)}
                    onClick={() => openWorkspaceFile(a)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openWorkspaceFile(a);
                      }
                    }}
                  >
                    <FileIcon path={a} size={20} />{attachmentBasename(a)}
                  </span>
                ))}
              </div>
            )}
            {message.images && message.images.length > 0 && (
              <MessageImages images={message.images} />
            )}
          </div>
        ) : isUser ? (
          /* Same fixed dir as the composer (dir={dir}): dir="auto" resolved
             from the first strong char only, so a user message starting with
             a Latin word/digit (e.g. "API key رو بده") flipped to LTR and the
             72ch box hugged the LEFT side even in RTL mode. A fixed dir keeps
             the rendered bubble identical to what the user typed. */
          <UserMessageBubble message={message} onRetry={onRetry} onEdit={onEdit} editingDisabled={editingDisabled} />
        ) : (
          <>
            <div className="msg-bubble">
              <MarkdownProse text={cachedPrepare(message.id, replyBody)} />
            </div>
            {cap.over && (
              <button
                className="msg-expand"
                onClick={() =>
                  useViewerTabs
                    .getState()
                    .openText(textTabTitle(replyText, "Reply"), replyText)
                }
                title={`Full reply is ${fmtSize(replyText.length)} — opens in the side panel`}
              >
                {`Show all (${fmtSize(cap.cut)} more)`}
              </button>
            )}
          </>
        ))}

      {!isUser && docPaths.length > 0 && <DocFileChips paths={docPaths} />}

      {!isUser && planDoc && <PlanDocCard planDoc={planDoc} messageId={message.id} />}


      {!isUser && (
        message.content ||
        message.usage ||
        message.streaming ||
        message.turnElapsedMs != null ||
        message.retry ||
        (message.error && !message.streaming) ||
        message.interrupted ||
        message.footerStatus
      ) && (
        <MessageActionsBar
          text={message.content}
          usage={message.usage ?? null}
          ttsStatus={message.content && !message.streaming ? ttsStatus : undefined}
          onSpeak={
            message.content && !message.streaming
              ? () => {
                  void toggleSpeak();
                }
              : undefined
          }
          onStopTts={ttsStop}
          fork={Boolean(message.content)}
          onFork={() => forkChatWithConfirm(message.id)}
          read={!isSummary && !message.streaming && sections.length >= 2}
          onRead={() => setReading(true)}
        >
          {/* THE one notice slot — every notice that used to be a banner above
              the composer ends up here: retry ladders, plain failures, an
              interrupted reply, and chat-level footer status (compaction
              progress). The pending notice TAKES THE PLACE of the Working pill
              (showing both said the same thing twice). */}
          {message.retry ||
          (message.error && !message.streaming) ||
          message.interrupted ||
          message.footerStatus ? (
            <InlineRetryLine
              sub={
                message.retry
                  ? subRetryInfo(message.retry, message.toolActivity)
                  : undefined
              }
              retry={
                message.retry ??
                (message.error && !message.streaming
                  ? {
                      // A FAILED turn that never entered a retry ladder
                      // (deterministic 4xx, exhausted quota, user Stop) still has
                      // an error to report — and it reports it HERE, in the footer.
                      attempt: 1,
                      maxAttempts: 1,
                      delay: 0,
                      reason: message.errorReason ?? "The turn failed.",
                      gaveUp: true,
                      inline: true,
                    }
                  : message.interrupted
                    ? {
                        attempt: 1,
                        maxAttempts: 1,
                        delay: 0,
                        reason:
                          "Interrupted — this reply was cut off. Send “continue” to resume.",
                        gaveUp: true,
                        inline: true,
                      }
                    : {
                        attempt: message.footerStatus!.attempt ?? 1,
                        maxAttempts: 1,
                        delay: 0,
                        reason: message.footerStatus!.text,
                        gaveUp: message.footerStatus!.kind === "error",
                        inline: true,
                        status: message.footerStatus!.kind !== "error",
                        // Progress field rides through so the row can render a
                        // determinate bar instead of parsing the text back.
                        percent: message.footerStatus!.percent,
                      })
              }
              onManualRetry={
                message.retry || message.error || message.interrupted
                  ? onResume
                    ? () => onResume(message.id)
                    : undefined
                  : message.footerStatus?.action === "compact-retry"
                    ? onCompactRetry
                    : undefined
              }
            />
          ) : (
            message.streaming &&
            // ONE indicator instance for every phase, so the timer never resets:
            // it always counts from the turn's workingStartedAt. The label is the
            // live status when there is one (LSP / tool status) and "Working"
            // otherwise; while the model reasons, an animated icon in front of the
            // label replaces the old "Thinking" pill and its own stopwatch.
            (
              <ThinkingIndicator
                thinking={!!message.thinkingActive}
                label={
                  lspStatusLabel(message.lspStatus) ||
                  message.statusText ||
                  "Working"
                }
                startedAt={message.workingStartedAt}
              />
            )
          )}
          {/* Turn duration + send clock are ONE unit that parks exactly where
              the Working pill sat (measured: pill `left: 18` in RTL). They used
              to be two independent row items each fighting for the footer's
              single auto margin, which is why they drifted ~140px apart instead
              of sitting side by side. The wrapper owns the parking; the two
              readouts inside are plain siblings with a fixed gap.
              Hidden whenever ANY notice row is up (error, interruption, retry,
              compaction): that row already reports state, and a clock/timer
              beside it read as a second, unrelated status. */}
          <MsgClocks
            createdAt={message.createdAt}
            turnElapsedMs={message.turnElapsedMs}
            hide={message.streaming || hasFooterNotice}
          />
        </MessageActionsBar>
      )}

      {reading && (
        <Suspense fallback={null}>
          <ReadingMode message={message} onClose={() => setReading(false)} />
        </Suspense>
      )}
    </div>
  );
  },
  // Custom comparator (see src/lib/messageViewEqual.ts). The percent/attempt/
  // action fields are part of the equality check: Chat.tsx rebuilds
  // `footerStatus` once a second during compaction, and without them the tick
  // compared EQUAL and the progress bar froze at its opening 0%.
  chatMessageViewPropsEqual,
);
