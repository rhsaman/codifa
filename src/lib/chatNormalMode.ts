/**
 * Vim-style mode keys for the chat column.
 *
 * Two strokes mirror the editor muscle memory the rest of the app already uses:
 *
 *   `i`        — from NORMAL mode (the transcript has the user's attention but
 *                no text caret), enter INSERT: focus the composer.
 *   `Ctrl+C`   — from INSERT with an empty selection, leave the composer and
 *                give the attention back to the transcript.
 *
 * `Ctrl+C` is COPY, so it may only act when there is nothing to copy: a live
 * text selection (or a non-empty caret range) keeps its default meaning, and
 * only the empty-selection case is ours. Both rules are PURE — the decision
 * takes plain booleans/strings, so it is unit-testable without React or a DOM.
 */

/** Whether a bare `i` should move the caret into the composer. */
export function shouldEnterInsert(opts: {
  /** The event target, if it already receives text. */
  targetIsEditable: boolean
  /** Whether the target is the chat's own composer. */
  targetIsComposer: boolean
  /** A dialog/palette owns the keyboard right now. */
  dialogOpen: boolean
  /** A modifier chord is in flight (Ctrl+X prefix, Ctrl/Cmd/Alt held). */
  chordActive: boolean
}): boolean {
  if (opts.chordActive || opts.dialogOpen) return false
  // Typing already: `i` is a letter, not a mode switch.
  if (opts.targetIsEditable || opts.targetIsComposer) return false
  return true
}

/**
 * Whether an empty-selection `Ctrl+C` inside the composer should hand focus
 * back to the transcript instead of copying.
 *
 * `selection` is the selected text: anything non-blank means the user has a
 * real copy to perform, so the chord stays untouched.
 */
export function shouldLeaveInsert(opts: {
  /** The caret sits in this chat's composer. */
  caretInComposer: boolean
  /** The composer's currently selected text ("" when collapsed). */
  selection: string
  /** A dialog/palette owns the keyboard right now. */
  dialogOpen: boolean
}): boolean {
  // A running stream does NOT veto this: Ctrl+C only moves the caret (it never
  // stops the turn), so it must work while the model is streaming too.
  if (opts.dialogOpen) return false
  if (!opts.caretInComposer) return false
  // Something is selected: this is a real COPY. Leave it alone.
  return opts.selection.trim().length === 0
}
