// Bottom clearance for the floating composer + ask/perm cards.
//
// The composer is absolutely positioned over the bottom of the conversation
// (position: absolute; bottom: 0) and the ask/perm cards anchor above it
// (bottom: calc(100% + 10px)). The scroll container needs enough padding-bottom
// so the last message never hides behind that floating UI.
//
// - 210px is the baseline that clears the idle composer (matches the CSS
//   default on .chat-scroll).
// - When a card is open we add its height plus the 10px gap above the composer.
// - A 24px safety margin keeps the last message comfortably visible.
export function composerScrollPadding(composerH: number, cardH: number | null): number {
  const card = cardH ? cardH + 10 : 0;
  return Math.max(210, composerH + card + 24);
}