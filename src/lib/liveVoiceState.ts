/**
 * Live voice session state, shared by every mounted chat panel.
 *
 * The session (microphone, STT loop, realtime socket) is a global resource, so
 * its state cannot live in one chat component's `useState`: with split windows
 * or a chat switch each mounted panel would keep its own copy, and two panels
 * could each start a session. The owner chat id and the state therefore live in
 * the app store, and panels broadcast changes through `setLiveVoiceSession`.
 *
 * Kept in its own module (no store/app imports) so it stays framework-free and
 * both the store and the UI can share the type without a cycle.
 */
export type LiveVoiceState = 'idle' | 'connecting' | 'live' | 'speaking' | 'closed' | 'error'

/** True while a session actually holds the microphone (or is acquiring it). */
export function isLiveVoiceBusy(state: LiveVoiceState): boolean {
  return state === 'connecting' || state === 'live' || state === 'speaking'
}

// ── تک‌نوبت‌بودن میکروفن ──────────────────────────────────────────────────────
// هر پنل چت نمونهٔ خودش از سشن (chunked یا realtime) را می‌سازد، پس store به
// تنهایی جلوی شروع دومی را نمی‌گیرد: اگر چت دیگری همین لحظه کلیک کند، هر دو
// سشن دستگاه را باز می‌کنند و یک جملهٔ گفته‌شده در هر دو چت پیام می‌شود. این
// ماژول قفلِ میکروفن را با شناسهٔ چت نگه می‌دارد تا فقط یک سشن واقعاً کار کند.

/** Chat id of the single session allowed to own the microphone. */
let liveVoiceLease: string | null = null;

/**
 * Claim the microphone for one chat's live session.
 *
 * Returns false when another chat already holds it — the caller must not open a
 * device, and the UI hides the live button for it anyway.
 */
export function claimLiveVoice(chatId: string | null): boolean {
  if (!chatId) return false;
  if (liveVoiceLease !== null && liveVoiceLease !== chatId) return false;
  liveVoiceLease = chatId;
  return true;
}

/**
 * Bind the lease to the live state so it is never left dangling: a session that
 * is already running takes the lease for its chat, and the lease is released as
 * soon as no session is busy — which also covers an owner panel that unmounted
 * without an explicit stop.
 */
export function syncLiveVoiceLease(chatId: string | null | undefined, busy: boolean): void {
  if (!busy) {
    liveVoiceLease = null;
    return;
  }
  if (chatId) liveVoiceLease = chatId;
}

/** Release the lease, optionally only when it belongs to `chatId`. */
export function releaseLiveVoice(chatId?: string | null): void {
  if (chatId === undefined || chatId === null || liveVoiceLease === chatId) liveVoiceLease = null;
}
