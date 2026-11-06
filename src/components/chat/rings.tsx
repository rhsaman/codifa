
export const CTX_POPOVER_WIDTH = 300;

/** Client-side mirror of the server's GOAL_MAX_EXTRA_TURNS (backend/goals.py).
 *  The server is authoritative; this just avoids firing one wasted turn on a
 *  stale [GOAL CONTINUES] marker. Keep in sync with the backend value. */
export const MAX_GOAL_TURNS = 15;

/** Reason text after a backend goal marker, e.g. "[GOAL CONTINUES] <reason>".
 *  Fed into the next loop prompt as guidance (Claude-style). Capped so a
 *  verbose judge cannot bloat the prompt. */
export function goalReasonAfter(content: string, marker: string): string {
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
export function ContextRing({ pct }: { pct: number | null }) {
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

/** Shown while a chat's transcript is still being fetched (index-only row).
 *  The body lives in its own file on disk now, so a freshly opened chat has a
 *  short window where only its metadata is in memory — rendering the empty
 *  state there would read as "this chat lost all its messages". */
export function ChatLoader() {
  return (
    <div className="chat-loader" data-testid="chat-hydrating">
      <span className="spinner" />
      <span>Loading conversation…</span>
    </div>
  );
}

