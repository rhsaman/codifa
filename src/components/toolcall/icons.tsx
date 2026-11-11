import type { ToolActivity } from '../../types'

export function IconChevron({
  open,
  className,
  caret,
}: {
  open?: boolean;
  className?: string;
  /** A call row's own mark: the same right→down turn as the group header
   *  (closed points right, open points down), but smaller and thinner. */
  caret?: boolean;
}) {
  if (caret) {
    return (
      <svg
        className={`${className ?? ""} ${open ? "open" : ""}`}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{
          transition: "transform 0.18s ease",
          transform: open ? "rotate(90deg)" : "rotate(0deg)",
        }}
      >
        <path d="M9 18l6-6-6-6" />
      </svg>
    );
  }
  return (
    <svg
      className={`${className ?? ""} ${open ? "open" : ""}`}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transition: "transform 0.18s ease",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
      }}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export function IconCheck({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function IconX({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

/** Running → spinner, done → check, error → ✗, denied → ⏹. Exported so the
 *  explore/sub-agent card shows the exact same glyphs as every tool row. */
export function StatusIcon({ status }: { status: ToolActivity["status"] }) {
  if (status === "running") return <span className="spinner" />;
  if (status === "error") return <IconX className="status-err" />;
  if (status === "denied") return <span className="status-denied">⏹</span>;
  return <IconCheck className="status-ok" />;
}

/** Mini shell-prompt glyph (chevron + underscore) for terminal trace rows —
 *  the terminal counterpart of the file squircle: one quiet theme-accent mark
 *  that lets the eye pick command rows out of a run of calls. */
export function TerminalRowIcon() {
  return (
    <svg
      className="trace-row-term-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 7l5 5-5 5" />
      <path d="M13 17h6" />
    </svg>
  );
}

/** Extract a clean host label (e.g. "github.com") from a URL for the
 *  favicon + source chip. Falls back to the raw URL when it can't parse. */
