import { useStore } from "../lib/store";
import type { RunMode } from "../types";

/** The two upper-level personas, in render order. Both always render: a
 *  segmented toggle that drops a side reads as a plain button, not a switch. */
const ORDER: RunMode[] = ["chat", "code"];

const LABEL: Record<RunMode, string> = {
  chat: "Chat mode \u2014 general-purpose agent",
  code: "Code mode \u2014 software-engineering agent",
};

const TITLE: Record<RunMode, string> = {
  chat: "Chat: answers, writing, research, files, shell \u2014 code is one job among many.",
  code: "Code: reads, plans and writes this project.",
};

/** Chat / Code persona switch for the CURRENT workspace.
 *
 *  Rides the window strip next to the traffic lights. The persona is a WORKSPACE
 *  setting (the whole project switches together), so this writes through
 *  `setRunMode(activeWorkspaceKey, \u2026)` and survives a restart. Chat is the
 *  default: a workspace with no stored choice runs the general-purpose agent.
 *
 *  Design: one recessed track with a raised pill that SLIDES to the selected
 *  half. State is carried by four stacked cues so it can never be ambiguous —
 *  the pill's position, its light fill, the inverted (dark) glyph on top of it,
 *  and the selected button's own brighter weight. Width is handled in CSS (the
 *  cluster measures its host and steps the control down); it never hides an
 *  icon. */
export function RunModeSwitch() {
  const activeKey = useStore((s) => s.activeWorkspaceKey);
  const stored = useStore((s) => s.workspaceRunModes[s.activeWorkspaceKey]);
  const setRunMode = useStore((s) => s.setRunMode);
  const mode: RunMode = stored === "code" ? "code" : "chat";
  return (
    <span
      className="run-mode-switch"
      role="radiogroup"
      aria-label="Agent persona"
      // Drives the sliding pill and the thumb's travel. The pill is a sibling
      // pseudo-element, so it cannot read `aria-checked` off the buttons.
      data-mode={mode}
    >
      {ORDER.map((id) => (
        <button
          key={id}
          type="button"
          className="run-mode-btn"
          role="radio"
          aria-checked={mode === id}
          aria-label={LABEL[id]}
          title={TITLE[id]}
          onClick={() => setRunMode(activeKey, id)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.9}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            {id === "chat" ? (
              // Rounded speech bubble with a short tail on the lower left.
              // The bubble body is centred on (12.5, 11); the tail adds only
              // enough to balance the lower-left corner, so the ink box stays
              // square about the button's centre instead of sinking.
              <>
                <path d="M12.5 3.75A8.25 8.25 0 0 0 4.25 12c0 1.62.47 3.13 1.28 4.4L4.4 20.1a.5.5 0 0 0 .63.63l3.7-1.13A8.25 8.25 0 1 0 12.5 3.75z" />
              </>
            ) : (
              // Angle brackets on the same optical weight as the bubble. Ink
              // spans 16x12 on the 24 grid (near-square after stroke), both
              // apexes on the vertical centre and mirrored about x=12.
              <>
                <path d="M9 6.5 3.5 12 9 17.5" />
                <path d="m15 6.5 5.5 5.5-5.5 5.5" />
              </>
            )}
          </svg>
        </button>
      ))}
    </span>
  );
}
