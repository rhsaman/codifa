// Wall-clock formatting for message timestamps (chat transcript) and sidebar
// activity ages. All user-facing strings are English.
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (d.toDateString() === new Date().toDateString()) return time;
  const date = d.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
  });
  return `${date} ${time}`;
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
export function fmtAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
