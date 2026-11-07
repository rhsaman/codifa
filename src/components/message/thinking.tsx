import { detectDir } from '../../lib/bidi'
import { fallbackReason, humanizeError } from '../../lib/errorText'
import { fmtElapsed } from '../../lib/time'
import type { ChatMessage } from '../../types'
import { exploreToolCounts } from '../ExploreCard'
import { ToolEditGroupView, ToolGroupView, isSubagentCard } from '../ToolCallView'
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'

import { cachedPrepareText } from './shared'
export const fmtTokens = (n?: number): string => {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
};

export const THINKING_MIN_H = 56;
export const THINKING_MAX_H = 320;
export const THINKING_DEFAULT_H = 84;

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(THINKING_DEFAULT_H);
  const textRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  /** Removers for an in-flight height drag; run on unmount (the agent may
   *  re-render/replace this block mid-drag) so the window listeners never leak. */
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const empty = text.trim().length === 0;
  // While collapsed, show the latest streamed line (truncated to one line)
  // instead of a word count, so the user sees live reasoning progress.
  const lastLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  const label = empty
    ? "Thinking…"
    : open
      ? "Hide thinking"
      : lastLine
        ? `Thinking — ${lastLine}`
        : "Thinking…";
  useEffect(() => {
    const el = textRef.current;
    if (!el || !open || empty || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, open, empty]);
  // Detach an interrupted height-drag's window listeners when this block
  // unmounts (the agent can replace it mid-drag while streaming).
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag.current = { startY: e.clientY, startH: height };
    const onMove = (ev: PointerEvent) => {
      if (!drag.current) return;
      const next = drag.current.startH + (ev.clientY - drag.current.startY);
      setHeight(Math.max(THINKING_MIN_H, Math.min(THINKING_MAX_H, next)));
    };
    const onUp = () => {
      drag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    // Stash the removers so an unmount mid-drag can detach them.
    resizeCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  };

  return (
    <div
      className={`thinking-block ${open ? "open" : ""}${empty ? " busy" : ""}`}
    >
      <button className="thinking-head" onClick={() => setOpen((o) => !o)}>
        <span className={`thinking-dot${empty ? " busy" : ""}`}>
          {empty ? <span className="spinner" /> : "✦"}
        </span>
        <span className="thinking-label">{label}</span>
        {!empty && <span className={`chev ${open ? "open" : ""}`}>▾</span>}
      </button>
      {open && !empty && (
        <>
          <div
            className="thinking-text"
            ref={textRef}
            style={{ height }}
            dir={detectDir(text)}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToBottom.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {cachedPrepareText(text)}
          </div>
          <div
            className="thinking-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize thinking panel"
            onPointerDown={startResize}
          >
            <span className="thinking-resizer-grip" />
          </div>
        </>
      )}
    </div>
  );
}


/** Countdown seconds left in a retry delay. Pure so it can be called from the
 *  `useState` initializer AND from every clock tick (the retry line recomputes
 *  from the wall clock instead of decrementing a local counter, so background
 *  sleep or a delayed timer can never make the countdown lie). */
export function computeLeft(delay: number, startedAt: number | undefined): number {
  if (delay <= 0) return 0;
  // Backend backoff carries jitter as a float (e.g. 16.8277s) — ceil once
  // here so the line never renders a fractional "in 16.82…s".
  if (!startedAt) return Math.ceil(delay);
  const deadline = startedAt + delay * 1000;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

/** The compact inline retry line — the message-footer replacement for the
 *  transcript-end RetryBanner (removed). Every automatic retry marks itself
 *  `inline` (the chat-error ladder, the sub-agent ladders, the watchdog) and
 *  renders HERE instead: one muted line beside the Working pill, the full
 *  provider error reachable through the hover card. A gave-up line keeps the
 *  manual one-click Retry. */
export function InlineRetryLine({
  retry,
  sub,
  onManualRetry,
}: {
  retry: NonNullable<ChatMessage["retry"]>;
  /** Sub-agent line content (user request): while the ladder still cycles the
   *  line reports WHAT the run is doing — its live model name and the tools it
   *  has called — instead of the provider error. */
  sub?: { model: string; tools: string[] };
  onManualRetry?: () => void;
}) {
  // The countdown re-arms on every NEW retry cycle (attempt/startedAt bump
  // without a remount — the same fix the RetryBanner needed: a cycle that
  // ended at 0 must not pin the next cycle at 0).
  const [left, setLeft] = useState(() => computeLeft(retry.delay, retry.startedAt));
  useEffect(() => {
    const tick = () => setLeft(computeLeft(retry.delay, retry.startedAt));
    tick();
    if (retry.delay <= 0 || retry.gaveUp) return;
    // 250ms is well below the one-second display step: the shown number flips
    // on the real second boundary instead of drifting with interval latency.
    const t = setInterval(tick, 250);
    // A laptop that slept through the delay must land on the true remaining
    // time (usually 0) the moment the window is visible again.
    const sync = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  }, [retry.delay, retry.startedAt, retry.attempt, retry.gaveUp]);
  const gaveUp = retry.gaveUp === true;
  // A sub-agent line that is still cycling (user request): the error never
  // shows INLINE — the line carries its live model + tool tally instead, so it
  // reads as status, not failure. The error itself stays reachable through the
  // hover card (`data-full-error` below): with the tally replacing the reason
  // span, that card is the only place a cycling ladder's provider error shows.
  // Only a terminal give-up keeps the error in the line itself: the Retry
  // button beside it needs a reason to make sense.
  const subLive = sub && !gaveUp ? sub : null;
  // A footer STATUS line (no ladder) rides through the same component: compact
  // progress, an interrupted reply, and plain (non-retried) failures all use
  // this one visual slot, so the footer is the single place state is reported.
  const isStatus = retry.status === true;
  // A compaction row is MEASURABLE: it carries a real 0-100 that advances with
  // both the summarizer's own reporting and the backend's wall-clock budget, so
  // it gets a determinate bar instead of dots. Every other status (an ack, an
  // interruption) has no honest percentage and stays plain text.
  const progressPct =
    isStatus && typeof retry.percent === "number"
      ? Math.max(0, Math.min(100, Math.round(retry.percent)))
      : null;
  // Provider bodies arrive pasted in raw (escaped JSON, several screen lines)
  // — the line shows the humanized sentence; the tooltip carries everything.
  const detail = retry.fallback
    ? fallbackReason(retry.reason ?? "")
    : humanizeError(retry.reason ?? "");
  // Hover must reveal the WHOLE error, readable — not the raw provider body.
  // `retry.reason` is typically escaped JSON (`{"error":{"message":"…",
  // "type":"tokens",…}}`), which a tooltip renders as unreadable noise; the
  // same humanizer the line uses, called with no cap, yields the full sentence.
  // Falling back to the raw text keeps plain reasons (no embedded JSON) intact.
  const fullDetail = retry.fallback
    ? fallbackReason(retry.reason ?? "", 100000)
    : humanizeError(retry.reason ?? "", 100000);
  // Sub-agent retries name their owner ("explore") so a compact line still
  // says WHICH ladder is cycling. Same dedup rule as the banner: repeating
  // the tool inside an agent label that already names it is noise.
  const who = [
    retry.agent ?? "",
    retry.tool &&
    retry.agent &&
    !retry.agent.toLowerCase().includes(retry.tool.toLowerCase())
      ? `tool: ${retry.tool}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
  const counting = !gaveUp && retry.delay > 0;
  // "retrying…" is GONE: the three pulsing dots already say "in progress", and
  // the word next to them said it twice. The countdown is just the bare
  // remaining seconds ("8s", never "in 8s"); once it reaches zero the text
  // disappears and only the dots remain.
  // The countdown is the only live control surface: a manual Retry must not
  // appear while the ladder is still cycling. It is offered only after all
  // attempts are spent (`gaveUp`), so a manual Retry never abbreviates the cap.
  const countdown = counting && left > 0 ? `${left}s` : "";
  const cap =
    retry.maxAttempts > 1 ? `${retry.attempt}/${retry.maxAttempts}` : `${retry.attempt}`;
  // The reason is the part that explains WHY the turn is cycling, so it gets its
  // own red span instead of being glued onto the counter in dim grey. It stays
  // on ONE line and truncates (full text in the tooltip), so a 4-screen provider
  // body never wraps the footer taller or pushes the Retry button out of view.
  // A sub-agent model hard-failed and the tool FELL BACK to another model. That
  // is not a "retry": nothing is being re-attempted, the ladder already moved
  // on. It gets its own wording so the footer does not claim a cycle that is
  // not happening — matching what the old (now removed) banner said.
  const label = retry.fallback
    ? gaveUp
      ? "sub-agent failed"
      : "switched model"
    : isStatus
      ? retry.reason ?? ""
      : gaveUp
        ? retry.maxAttempts > 1
          ? `failed after ${retry.attempt} tries`
          : "failed"
        : `retry ${cap}`;
  // The sub-agent line shows the MODEL NAME itself (user request) — the
  // ladder's live rung, which the backend emits already pointing at the next
  // model on a fallback — not the words "switched model". If the event carried
  // no model, degrade to the generic label.
  const shownLabel = subLive ? subLive.model || label : label;
  // No leading glyph: the row already says "retry 3/10" and the pulsing dots
  // carry the activity. A second ↻ before the counter read as a separate
  // control. After the ladder gives up, the glyph lives INSIDE the Retry button.
  // Drives the chip's colour (`--tone` in CSS): one value per kind of row so
  // an error, a live retry, a model switch and a compaction read differently
  // at a glance instead of all sharing one grey line.
  const tone =
    progressPct !== null
      ? "progress"
      : gaveUp
        ? "error"
        : subLive
          ? // A live sub-agent line reads as status (accent), never as the
            // warn/error the word "switched model" + red body used to paint.
            "info"
          : retry.fallback
            ? "warn"
            : isStatus
              ? "info"
              : "retry";
  return (
    // NO `dir` on this span: it is the ABSOLUTELY POSITIONED element, and a
    // `dir` here would make `inset-inline-end` resolve against THAT direction
    // instead of the footer's — in RTL the line then stayed pinned right.
    // The LTR pin belongs on the inner wrapper, which is what keeps the
    // "↻ retry 7/10 — reason — in 7s" order stable.
    <span
      className="msg-retry-inline"
      data-state={tone}
      /* Custom hover card: the NATIVE `title` has a ~1s delay, gets dropped when
         the pointer jitters, and cannot wrap a multi-sentence provider body —
         which is why hovering "did not show the full error". The card below is
         CSS-only (no portal, no JS), appears instantly, and wraps to 46ch. */
      data-full-error={fullDetail || retry.reason || undefined}
    >
      {/* Mirrors the Working pill's proven structure (`.msg-thinking` →
          `.msg-thinking-inner`): the OUTER span only parks the line — it inherits
          the footer's direction so `margin-inline-start: auto` lands on the
          same edge the pill occupies. The INNER span pins `dir="ltr"` and owns
          the content, so the visual order is identical in LTR and RTL and has
          nothing to do with the direction used for parking. */}
      {/* PARKING vs CONTENT ORDER are two different axes and live on two
          different elements, exactly like the Working pill
          (`.msg-thinking` parks, `.msg-thinking-inner` orders):
            - the OUTER span inherits the footer's direction, so its
              `margin-inline-start: auto` lands on the pill's side;
            - this INNER row forces LTR, so the sentence always reads
              `↻ retry 4/10 → reason → dots → Retry` in both locales. */}
      <span className="msg-retry-inline-row" dir="ltr">
      <span className="msg-retry-inline-head" dir="ltr">
        {who && <span className="msg-retry-inline-who">{who}</span>}
        <span
          className={`msg-retry-inline-count${subLive ? " msg-retry-inline-model" : ""}`}
          /* The model id is the one part that ellipsizes on a narrow footer —
             the full name stays reachable on hover. */
          title={subLive?.model || undefined}
        >
          {shownLabel}
        </span>
        {progressPct !== null && (
          // The number sits in the head; the determinate bar is drawn as the
          // chip's own bottom edge (below), so it adds height, not width, and
          // cannot crowd the clock/timer beside the footer.
          <span className="msg-retry-inline-pct">{progressPct}%</span>
        )}
      </span>
      {counting && (
        // Dots + countdown are their own group placed right after the counter.
        // They used to live at the END of the line, which put them after the
        // ellipsized reason ("…reached…  • • •") where they read as part of
        // the sentence instead of as activity.
        <span className="msg-retry-inline-wait" dir="ltr">
          <span className="msg-retry-inline-dots" aria-hidden>
            <i /><i /><i />
          </span>
          {countdown && (
            <span className="msg-retry-inline-wait-label">{countdown}</span>
          )}
        </span>
      )}
      {/* A status row already puts the whole sentence in `label`, so echoing
          `detail` printed it twice ("Undo applied — … Undo applied — …").
          Only ladder/fallback rows carry a separate reason. A live sub-agent
          row NEVER shows the reason (user request) — not even when the run has
          called no tools yet, which is exactly when a model switch fires (the
          sub-agent's first LLM call failed, so there is nothing to tally). The
          tools fill in as the run works; until then the line is agent+model. */}
      {subLive ? (
        subLive.tools.length > 0 && (
          <span className="msg-retry-inline-tools" dir="ltr">
            {subLive.tools.join(" · ")}
          </span>
        )
      ) : (
        detail &&
        !isStatus && (
          <span
            className="msg-retry-inline-reason"
            dir="ltr"
            data-full-error={fullDetail || detail}
          >
            {detail}
          </span>
        )
      )}
      {gaveUp && onManualRetry && (
        <button
          className="msg-retry-inline-btn"
          onClick={onManualRetry}
          aria-label="Retry — resumes where it stopped without redoing completed work"
          dir="ltr"
        >
          {/* The ↻ lives INSIDE the button now: a bare glyph next to a "Retry"
              label read as two separate controls. `dir="ltr"` above pins the
              button's insides LTR so the glyph stays LEFT of the Latin label
              even in an RTL footer (the outer line still inherits RTL, which it
              needs for its own positioning). */}
          <span className="msg-retry-inline-btn-icon" aria-hidden>
            ↻
          </span>
          Retry
        </button>
      )}
      </span>
      {progressPct !== null && (
        <span
          className="msg-retry-inline-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPct}
        >
          <span
            className="msg-retry-inline-bar-fill"
            style={{ width: `${progressPct}%` }}
          />
        </span>
      )}
    </span>
  );
}

/** Sub-agent retry content (user request): the live model name and the tools
 *  the run has called, read off the message's own explore card. `retry.tool`
 *  is set only for tool-owned (sub-agent) ladders — empty for the main agent —
 *  so this returns undefined for every ordinary retry/error/status row. Among
 *  parallel runs of the same tool, the still-running one wins (its tally is
 *  the one growing while the ladder cycles). */
export function subRetryInfo(
  retry: NonNullable<ChatMessage["retry"]>,
  toolActivity: ChatMessage["toolActivity"],
): { model: string; tools: string[] } | undefined {
  if (!retry.tool || retry.status) return undefined;
  const runs = (toolActivity ?? []).filter((a) => a.tool === retry.tool);
  const run = runs.find((a) => a.status === "running") ?? runs[runs.length - 1];
  if (!run && !retry.model) return undefined;
  return {
    model: retry.model || run?.model || "",
    tools: run
      ? exploreToolCounts(run).map((c) => `${c.label} ×${c.count}`)
      : [],
  };
}

export function localWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * نشانگر «در حال فکر کردن / در حال کار» که در ردیف فوتر پیام (سمت مخالف
 * کپی/usage) نمایش داده می‌شود. ۳ نقطهٔ لودینگ از سمت راست شروع به پر شدن
 * می‌کنند (نقطهٔ اول = سمت راست زودتر روشن می‌شود) تا هر ۳ تا پر شوند، سپس
 * چرخه از اول تکرار می‌شود. `label` برچسب حالت را تعیین می‌کند: «Thinking»
 * وقتی مدل reasoning تولید می‌کند و «Working» وقتی ایجنت مشغول کار است ولی
 * think نمی‌کند (اجرای ابزار، انتظار برای نتیجه و…).
 */
export function ThinkingIndicator({
  startedAt,
  label = "Thinking",
}: {
  startedAt?: number;
  label?: string;
}) {
  const [elapsed, setElapsed] = useState(() => {
    const base = startedAt ?? Date.now();
    return Date.now() - base;
  });
  useEffect(() => {
    const base = startedAt ?? Date.now();
    setElapsed(Date.now() - base);
    const id = setInterval(() => setElapsed(Date.now() - base), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <span className="msg-thinking" aria-label={label}>
      <span className="msg-thinking-inner" dir="ltr">
        <span className="msg-thinking-text">{label}</span>
        <span className="msg-thinking-dots" aria-hidden="true">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </span>
        <span className="msg-thinking-elapsed">{fmtElapsed(elapsed)}</span>
      </span>
    </span>
  );
}

// Only tools that write to the workspace filesystem render as their own
// visible edit UI (diff + revert) — every other tool (including
// memory/skill/connector saves) sweeps into the collapsed Claude-app-style
// trace group. Background sub-agents are also always-visible (isSubagentCard
// below) so the sub-agent never hides inside the collapsed group.
// ویرایش‌های پشت‌سرهم (edit_file/write_file) در یک گروه ویرایش جدا
// (ToolEditGroupView) جمع می‌شوند — نه کارت تکی جدا، نه قاطی با گروه
// ابزارهای فقط‌خواندنی.
export const ALWAYS_VISIBLE_TOOLS = new Set(["edit_file", "write_file", "ask_user"]);

/** Interleave text slices with tool cards (Claude-style), but collapse runs of
 *  2+ consecutive read-only/non-mutating tool calls (grep/glob/read/
 *  web_search/run_terminal/search_memory) into one ToolGroupView so a
 *  search-heavy turn doesn't stack a full-height row per call. Anything in
 *  ALWAYS_VISIBLE_TOOLS always breaks the run and renders as its own full card
 *  (diff/confirmation visible), same as before. */
/** Shared rendering for a user message bubble + its action buttons (retry/copy).
 *  Used both for standalone user messages and for interleaved steer segments so
 *  the icons always match the main user message. `className` is applied to the
 *  bubble wrapper (e.g. "seg-steer" for the interleaved steer look). */
// Claude-style folding threshold for long user text (attachments/images
// always stay visible, only the text clamps).
export const USER_COLLAPSE_CHARS = 600;
export const USER_COLLAPSE_LINES = 10;

/** True when text overflows a folded bubble: too many characters or too many
 *  lines. Shared by user bubbles, queued/steer bubbles and the composer's
 *  pasted-text cards so every surface folds at the same size. */
export function isCollapsibleText(text: string): boolean {
  return (
    text.length > USER_COLLAPSE_CHARS ||
    text.split("\n").length > USER_COLLAPSE_LINES
  );
}

/** Tab title for a full-text side panel: the first non-empty line, capped. */
export function textTabTitle(text: string, fallback: string): string {
  const firstLine = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!firstLine) return fallback;
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

/** Refined pen-nib edit icon (pen-line style): slimmer nib plus a baseline
 *  reads as "edit text" and stays crisp at 16px next to retry/copy icons. */
export function EditIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
    </svg>
  );
}

