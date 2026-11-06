// Wall-clock formatting for message timestamps (chat transcript) and sidebar
// activity ages. All user-facing strings are English.
export function isToday(ts: number): boolean {
  return new Date(ts).toDateString() === new Date().toDateString();
}

// Month + day only ("Nov 2") — the footer renders this as a separate, dimmer
// chip ahead of the clock, so the combined `fmtClock` string below is only used
// where a single self-contained label is needed.
export function fmtMonthDay(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function fmtClock(ts: number): string {
  const time = fmtClockTime(ts);
  if (isToday(ts)) return time;
  return `${fmtMonthDay(ts)} ${time}`;
}

/** Time only, never the date — for callers that render the date separately. */
export function fmtClockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtClockFull(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// Compact relative age for the sidebar ("5m", "2h", "3d") — deliberately
// short so chat rows stay narrow; the exact time lives in the title tooltip.
// ALWAYS relative: past a month it switches to "3mo", past a year to "1y" —
// a full date would widen the row (and mix formats within one list).
export function fmtAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** «چه مدت طول کشید» — ms → "840ms" / "12.3s" / "2m 5s". هم‌راستا با fmtTime
 *  در ToolCallView؛ از ChatMessageView به اینجا منتقل شد تا MessageActionsBar
 *  (فوتر مشترک چت/اینباکس/مطالعه) هم بدون import چرخه‌ای استفاده کند. */
export function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${totalSec.toFixed(1)}s`;
}
