import type { ChatMessage } from "../types";

/** Props that can change what a single transcript message renders. Kept as a
 *  standalone type so the memo comparator is testable without a DOM: every
 *  streamed token rebuilds the active chat object and the parent re-renders
 *  with a fresh `chat.messages` array, so only a real content/state change may
 *  re-parse markdown. */
export interface ChatMessageViewPropsLike {
  message: ChatMessage;
  onRetry?: (id: string) => void;
  onResume?: (id: string) => void;
  onCompactRetry?: () => void;
  onEdit?: (messageId: string, newText: string) => void;
  editingDisabled?: boolean;
}

/** Comparator for the memoized ChatMessageView.
 *
 *  `footerStatus` is rebuilt by Chat.tsx every second while a compaction runs
 *  (elapsed / budget derivation). Comparing only `.text` and `.kind` made every
 *  tick compare EQUAL, so the component skipped the render and the determinate
 *  progress bar froze at 0% for the whole job. `.percent` (and the attempt /
 *  action fields that share that row) MUST stay in this list. */
export function chatMessageViewPropsEqual(
  prev: ChatMessageViewPropsLike,
  next: ChatMessageViewPropsLike,
): boolean {
  if (prev.onRetry !== next.onRetry) return false;
  if (prev.onResume !== next.onResume) return false;
  if (prev.onCompactRetry !== next.onCompactRetry) return false;
  if (prev.onEdit !== next.onEdit) return false;
  if (prev.editingDisabled !== next.editingDisabled) return false;
  const a = prev.message;
  const b = next.message;
  // Unchanged messages keep their object identity (see updateMessage) and skip
  // via the fast path; the field-wise fallback also skips when the store
  // recreates an identical record.
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.content === b.content &&
    a.streaming === b.streaming &&
    a.thinking === b.thinking &&
    a.thinkingActive === b.thinkingActive &&
    a.thinkingStartedAt === b.thinkingStartedAt &&
    a.workingStartedAt === b.workingStartedAt &&
    a.turnElapsedMs === b.turnElapsedMs &&
    a.error === b.error &&
    // `errorReason` and `footerStatus` decide whether the footer renders a
    // notice at all. Without them here, the prop change created by
    // `{ ...m, footerStatus }` in Chat.tsx compared EQUAL and the component
    // skipped re-rendering — the footer notice never appeared.
    a.errorReason === b.errorReason &&
    a.footerStatus?.text === b.footerStatus?.text &&
    a.footerStatus?.kind === b.footerStatus?.kind &&
    a.footerStatus?.percent === b.footerStatus?.percent &&
    a.footerStatus?.elapsedSecs === b.footerStatus?.elapsedSecs &&
    a.footerStatus?.budgetSecs === b.footerStatus?.budgetSecs &&
    a.footerStatus?.attempt === b.footerStatus?.attempt &&
    a.footerStatus?.attempts === b.footerStatus?.attempts &&
    a.footerStatus?.action === b.footerStatus?.action &&
    a.retry === b.retry &&
    a.toolActivity === b.toolActivity &&
    a.segments === b.segments &&
    a.plan === b.plan &&
    a.planDoc === b.planDoc &&
    a.attachments === b.attachments &&
    a.images === b.images &&
    a.usage === b.usage &&
    a.compacted === b.compacted &&
    a.mode === b.mode &&
    a.modeSwitch === b.modeSwitch &&
    a.steerPending === b.steerPending &&
    a.steerInterleaved === b.steerInterleaved &&
    (a as { statusText?: string }).statusText ===
      (b as { statusText?: string }).statusText &&
    (a as { lspStatus?: unknown }).lspStatus ===
      (b as { lspStatus?: unknown }).lspStatus &&
    a.interrupted === b.interrupted
  );
}
