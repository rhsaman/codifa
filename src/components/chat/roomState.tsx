import { AutoRetryScheduler } from '../../lib/retry'
import { useStore } from '../../lib/store'
import { THINKING_DESCS, THINKING_LABELS, THINKING_OPTIONS } from '../../lib/thinking-options'

export const LIVE_TTS_OWNER = 9007199;
export const PLAN_APPROVE_TOKEN = "__plan_approve__";
export const PLAN_DISMISS_TOKEN = "__plan_dismiss__";

// ---- Per-chat auto-retry runtime, shared by EVERY mounted ChatPanel ----
// These used to live in per-instance refs. The panel REMOUNTS on every chat
// switch (and every window mounts its own panel), so the error-retry ladder
// armed by the previous instance kept a live timer nothing could reach:
// Stop in the freshly-mounted panel stopped a brand-new scheduler while the
// orphaned timer fired anyway, and the turn the user had just stopped
// restarted on its own ("pressed Stop, it still auto-retries"). Module scope
// gives ONE scheduler / stop flag / attempt count per chat id, so Stop from
// any panel — even a remount — drops ladders armed by any other instance.
export const CHAT_ERROR_MAX_RETRIES = 10;
export const chatStopped = new Map<string, boolean>();
export const chatAutoRetry = new Map<string, AutoRetryScheduler>();
export const autoRetryFor = (chatId: string): AutoRetryScheduler => {
  let sched = chatAutoRetry.get(chatId);
  if (!sched) {
    sched = new AutoRetryScheduler();
    chatAutoRetry.set(chatId, sched);
  }
  return sched;
};

// A compaction reports its percent from WALL-CLOCK budget spent, so a fast
// summary legitimately finishes while the bar is still around 40–60%. Clearing
// the row at that instant looked like the job was cut off midway. Hold the row
// at 100% long enough for the fill transition to visibly land, then dismiss it.
export const COMPACT_DONE_HOLD_MS = 900;
export const compactDoneTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function holdCompactComplete(chatId: string): void {
  const st = useStore.getState();
  const chat = st.chats.find((c) => c.id === chatId);
  if (!chat) return;
  const prev = chat.compactProgress;
  // Keep `compacting` true through the hold: the footer derives the row from
  // that flag, and the per-second clock keeps it painted.
  st.setChatCompacting(chatId, true);
  st.setChatCompactProgress(chatId, {
    phase: "done",
    attempt: prev?.attempt ?? 0,
    attempts: prev?.attempts ?? 0,
    model: prev?.model ?? "",
    providerId: prev?.providerId ?? "",
    percent: 100,
    budgetSecs: 0,
    elapsedSecs: 0,
    at: Date.now(),
  });
  const pending = compactDoneTimers.get(chatId);
  if (pending) clearTimeout(pending);
  compactDoneTimers.set(
    chatId,
    setTimeout(() => {
      compactDoneTimers.delete(chatId);
      // A NEW compaction may have started during the hold; its progress is no
      // longer "done", so this stale timer must not clear its row.
      const cur = useStore.getState().chats.find((c) => c.id === chatId);
      if (cur?.compactProgress?.phase === "done") {
        useStore.getState().setChatCompacting(chatId, false);
      }
    }, COMPACT_DONE_HOLD_MS),
  );
}
export function clearCompactHold(chatId: string): void {
  const pending = compactDoneTimers.get(chatId);
  if (pending) {
    clearTimeout(pending);
    compactDoneTimers.delete(chatId);
  }
}

// THINKING_OPTIONS / THINKING_LABELS / THINKING_DESCS live in the shared
// src/lib/thinking-options.ts module so Settings → Tools rows can render the
// exact same picker (imported below next to the other lib imports).

