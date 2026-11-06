/** Small SVG icons shared by the right-panel cards (This turn's tools,
 *  Background terminals, Agent plan). All use currentColor, so the CSS decides
 *  the colour in every theme — the old text glyphs (▾ ▸ ✓ ● ○) rendered with
 *  uneven weight and, on macOS, sometimes as coloured emoji. */

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** Card chevron — points down when open, rotates to point right when folded
 *  (the rotation itself is CSS, so it animates). */
export function PanelChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      {...base}
      width="12"
      height="12"
      strokeWidth={2.4}
      className={`sidebar-panel-chevron-svg${collapsed ? " collapsed" : ""}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Checklist — the Agent plan card. */
export function PlanIcon({ size = 14 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M3.5 6l1.2 1.2L6.8 5M3.5 12l1.2 1.2L6.8 11M3.5 18l1.2 1.2L6.8 17" />
    </svg>
  );
}

/** Wrench — the "This turn's tools" card. */
export function ToolsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L3.5 17.2a1.8 1.8 0 0 0 2.6 2.6l5.8-5.8a4 4 0 0 0 5.1-5.4l-2.4 2.4-2.1-.6-.6-2.1 2.4-2.4z" />
    </svg>
  );
}

/** Terminal prompt — the Background terminals card. */
export function TerminalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      <rect x="2.5" y="4" width="19" height="16" rx="3" />
      <path d="M7 9.5l3 2.8-3 2.8M12.5 15.5H17" />
    </svg>
  );
}

/** Check mark inside a finished step's circle. */
export function StepCheckIcon() {
  return (
    <svg {...base} width="10" height="10" strokeWidth={3.2}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
