import { useState, type ReactNode } from "react";
import { copyToClipboard } from "../lib/clipboard";
import { fixZwsp, stripBidiMarks } from "../lib/bidi";
import { fmtClock, fmtClockFull, fmtClockTime, fmtElapsed, fmtMonthDay, isToday } from "../lib/time";
import type { TtsStatus } from "../lib/tts";

// THE shared message actions row (`.msg-actions`): usage badge + copy + fork +
// speak + read, identical under chat bubbles, schedule-inbox run outputs and
// reading-mode sections. The chat footer injects its extra rows (retry line,
// thinking indicator) through `children`; standalone surfaces render the bar
// as-is. Copy + clocks are fully internal; speak/fork/read are wired by the
// parent (chat keeps its banner-aware speak; standalone surfaces use
// useSpeakText from lib/tts.ts).

export function UsageBadge({
  input,
  output,
  total,
  live,
}: {
  input: number;
  output: number;
  total: number;
  live?: boolean;
}) {
  const body = `↑ ${fmtTokens(input)} in · ↓ ${live ? "…" : fmtTokens(output)} out`;
  return (
    <span
      className={`msg-usage${live ? " live" : ""}`}
      title={`${total.toLocaleString()} tokens total (${input.toLocaleString()} in, ${output.toLocaleString()} out)`}
      dir="ltr"
    >
      {body}
    </span>
  );
}

function fmtTokens(n?: number): string {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** Worked-duration TIMER only (the sent-time clock/date was removed per user
 *  request). Sits in the LEFT status group, next to the Thinking/Working pill. */
export function MsgClocks({
  turnElapsedMs,
  hide,
}: {
  turnElapsedMs?: number | null;
  hide?: boolean;
  /** Ignored: the sent-time clock/date is gone. */
  createdAt?: number;
}) {
  if (hide || turnElapsedMs == null) return null;
  return (
    <span className="msg-elapsed" dir="ltr">
      {/* The STOPWATCH glyph distinguishes "how long the turn took" from any
          status text beside it. */}
      <svg
        className="msg-elapsed-icon"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10 2h4" />
        <path d="M12 14l3-3" />
        <circle cx="12" cy="14" r="8" />
      </svg>
      {fmtElapsed(turnElapsedMs)}
    </span>
  );
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function MessageActionsBar({
  text,
  usage,
  ttsStatus,
  onSpeak,
  onStopTts,
  fork,
  onFork,
  read,
  onRead,
  children,
}: {
  /** Copy payload — verbatim message/section content. Empty → no copy button. */
  text: string;
  usage?: UsageInfo | null;
  /** Speak button shows only when BOTH are given (parent owns the logic). */
  ttsStatus?: TtsStatus;
  onSpeak?: () => void;
  /** Hard-stop for TTS playback (pause keeps the queue, this clears it). */
  onStopTts?: () => void;
  fork?: boolean;
  onFork?: () => void;
  read?: boolean;
  onRead?: () => void;
  /** Extra rows after the buttons (retry line, thinking indicator, …). */
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyToClipboard(stripBidiMarks(fixZwsp(text)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("copy failed", err);
    }
  };
  const showSpeak = Boolean(onSpeak) && Boolean(ttsStatus);
  return (
    // FIXED geometry in both message directions (user request): the status
    // group (children: retry line, thinking, timer) is ALWAYS flush-left and
    // the tools group (usage + copy/fork/speak/read) ALWAYS flush-right. The
    // row runs direction:ltr for stable sides; the retry chip manages its own
    // bidi internally.
    <div className="msg-actions">
      {children != null && <div className="msg-actions-status">{children}</div>}
      <div className="msg-actions-tools">
      {text && (
        <>
          <button
            className={`msg-copy ${copied ? "copied" : ""}`}
            onClick={copy}
            title={copied ? "Copied" : "Copy message"}
            aria-label={copied ? "Copied" : "Copy message"}
          >
            {copied ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          {fork && onFork && (
            <button
              className="msg-copy msg-fork"
              onClick={onFork}
              title="Fork chat from here"
              aria-label="Fork chat from here"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                <path d="M12 12v3" />
              </svg>
            </button>
          )}
          {showSpeak && (
            <button
              className={`msg-copy msg-speak ${ttsStatus === "speaking" ? "speaking" : ""} ${ttsStatus === "loading" ? "loading" : ""} ${ttsStatus === "paused" ? "paused" : ""}`}
              onClick={onSpeak}
              title={
                ttsStatus === "speaking"
                  ? "توقف موقت"
                  : ttsStatus === "paused"
                    ? "ادامه پخش"
                    : ttsStatus === "loading"
                      ? "لغو"
                      : "خواندن با صدا"
              }
              aria-label={
                ttsStatus === "speaking"
                  ? "Pause"
                  : ttsStatus === "paused"
                    ? "Resume"
                    : ttsStatus === "loading"
                      ? "Cancel"
                      : "Speak"
              }
            >
              {ttsStatus === "loading" ? (
                <svg
                  className="tts-spinner"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                </svg>
              ) : ttsStatus === "speaking" ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 5v14M15 5v14" />
                </svg>
              ) : ttsStatus === "paused" ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              )}
            </button>
          )}
          {/* Hard stop BESIDE pause (user request): pause keeps the queue and
              resumes; this button kills playback AND the pending sentence
              queue outright. Only meaningful while playback is active. */}
          {onStopTts && (ttsStatus === "speaking" || ttsStatus === "paused") && (
            <button
              className="msg-copy msg-speak msg-tts-stop"
              onClick={onStopTts}
              title="توقف پخش"
              aria-label="Stop TTS"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          )}
          {read && onRead && (
            <button
              className="msg-copy"
              onClick={onRead}
              title="Reading mode — study each section separately and ask about it"
              aria-label="Read"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
            </button>
          )}
        </>
      )}
      {usage && (
        <UsageBadge
          input={usage.inputTokens}
          output={usage.outputTokens}
          total={usage.totalTokens}
        />
      )}
      </div>
    </div>
  );
}
