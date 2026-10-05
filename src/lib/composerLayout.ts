// Helpers for the composer compact/expanded layout.
//
// The composer stays in a short single row (context ring + plus | input |
// voice + send) while the draft fits on one visual line. Once the draft wraps
// to more than one visual line — via an explicit newline or via text wrapping
// — the input moves to a full-width row above the action icons.
export function shouldExpandComposer(
  input: string,
  scrollHeight: number,
  singleLineHeight: number,
  currentlyExpanded = false,
): boolean {
  if (input.includes("\n")) return true;
  // Hysteresis band against subpixel flicker: expand past +4, collapse only
  // back at +2, so borderline drafts stick to their current mode instead of
  // bouncing up and down while typing.
  return scrollHeight > singleLineHeight + (currentlyExpanded ? 2 : 4);
}

// Compact row metrics: .composer-input-row.compact has padding 1px 8px 3px
// (padX 16) and gap 4px with two gaps around the input. Kept here so the
// mirror width never depends on the live row style (which changes with the
// expanded class and would oscillate).
export const COMPACT_PAD_X = 16;
export const COMPACT_GAP = 4;

export function compactInputWidth(
  rowClientWidth: number,
  leftW: number,
  rightW: number,
): number {
  return Math.max(
    80,
    rowClientWidth - COMPACT_PAD_X - leftW - rightW - COMPACT_GAP * 2,
  );
}

// Fit the textarea to its content up to maxHeight. Overflow stays hidden so
// no scrollbar appears until the content actually reaches the cap.
export function composerHeight(
  scrollHeight: number,
  maxHeight = 200,
): { height: number; overflowY: "hidden" | "auto" } {
  const height = Math.min(Math.max(scrollHeight, 0), maxHeight);
  return { height, overflowY: scrollHeight > maxHeight + 1 ? "auto" : "hidden" };
}
