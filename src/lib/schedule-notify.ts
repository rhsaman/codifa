import type { ScheduleRun } from "../types";

/** مجموع توکن یک ران (input+output) از روی usage ثبت‌شده. */
export function scheduleRunTokenTotal(run: ScheduleRun): number {
  let total = 0;
  for (const u of run.usage?.entries ?? []) {
    total += (u.input || 0) + (u.output || 0);
  }
  return total;
}

/** مجموع توکن هر تسک: schedule_id → مجموع توکن همه ران‌هایش. خالص برای تست. */
export function taskTokenTotals(runs: ScheduleRun[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs ?? []) {
    if (!r || typeof r.schedule_id !== "string" || !r.schedule_id) continue;
    out[r.schedule_id] = (out[r.schedule_id] ?? 0) + scheduleRunTokenTotal(r);
  }
  return out;
}

/** Runs that just REACHED a terminal status since the previous poll: either a
 *  previously-running run finished, or a run finished entirely between two
 *  polls (its id was not in the previous snapshot). A run that was already
 *  terminal in the previous snapshot is never re-notified, and the baseline
 *  poll (prev === null) never notifies — old runs must stay silent. Pure for
 *  tests. */
export function findFinishedScheduleRuns(
  prev: ReadonlyMap<string, ScheduleRun["status"]> | null,
  runs: ScheduleRun[],
): ScheduleRun[] {
  if (!prev) return [];
  return (runs ?? []).filter((r) => {
    if (!r) return false;
    if (r.status !== "done" && r.status !== "error") return false;
    const before = prev.get(r.id);
    return before === undefined || before === "running";
  });
}

/** Schedule ids with a run still in flight, from the run rows. The schedule
 *  page remounts on every tab switch, so component state cannot be the source
 *  of truth for the spinner — the backend rows are (the inbox reads the same
 *  rows). Pure for tests. */
export function liveRunningMap(runs: ScheduleRun[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of runs ?? []) {
    if (r && r.schedule_id && r.status === "running") out[r.schedule_id] = true;
  }
  return out;
}

/** Unseen runs that are FINISHED (done/error): the inbox badge count. A run
 *  still in flight (`running`) never counts — the badge says "there is a result
 *  to read", and a live run has none yet. It starts counting the moment it
 *  settles, because `finishedRunIds` (what gets recorded as seen) never
 *  includes a running run either. Pure for tests. */
export function unseenRunCount(runs: ScheduleRun[], seen: string[]): number {
  const seenSet = new Set(seen);
  return runs.filter((r) => r.status !== "running" && !seenSet.has(r.id)).length;
}

/** `unseenRunCount` scoped to one task (the badge beside each task in the
 *  inbox list). */
export function unseenRunCountForTask(
  runs: ScheduleRun[],
  seen: string[],
  scheduleId: string,
): number {
  const seenSet = new Set(seen);
  return runs.filter(
    (r) => r.schedule_id === scheduleId && r.status !== "running" && !seenSet.has(r.id),
  ).length;
}

/** Run ids that may be recorded as "seen": finished runs only. Marking a live
 *  run seen would make its result arrive already-read — no badge when it
 *  settles. Pure for tests. */
export function finishedRunIds(runs: ScheduleRun[]): string[] {
  return runs.filter((r) => r.status !== "running").map((r) => r.id);
}

/** اجازه اعلان سیستم‌عامل را در صورت نیاز می‌گیرد؛ false یعنی اعلان ممکن نیست.
 *  پوستهٔ دسکتاپ (Tauri) از پلاگین نیتیو استفاده می‌کند — Web Notification API
 *  داخل WKWebView بی‌صدا هیچ‌چیز نشان نمی‌دهد — و مرورگر (حالت serve) همان
 *  وب API را دارد؛ فقط آن‌جا ممکن است پرامپت اجازه لازم شود. */
export async function ensureScheduleNotificationPermission(): Promise<boolean> {
  try {
    const coder = typeof window === "undefined" ? undefined : window.coder;
    if (coder?.notifyOs) return true; // دسکتاپ: پلاگین نیتیو، بدون پرامپت
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission !== "denied") {
      const p = await Notification.requestPermission();
      return p === "granted";
    }
    return false;
  } catch {
    return false;
  }
}

/** یک اعلان سیستم‌عامل برای ران پایانیافته نشان می‌دهد (best-effort، بدون
 * throw). دسکتاپ از طریق `window.coder.notifyOs` (پلاگین نیتیو تارِی) می‌رود؛
 * در مرورگر Web Notification API — آن‌جا کلیک روی اعلان (در صورت پشتیبانی)
 * `onOpen` را صدا می‌زند تا Inbox باز شود. */
export function notifyScheduleRun(
  run: ScheduleRun,
  taskName: string | null | undefined,
  onOpen?: () => void,
): void {
  try {
    const name = (taskName ?? "").trim() || "Scheduled task";
    const status = run.status === "error" ? "Failed" : run.status === "running" ? "Running" : "Done";
    const tokens = scheduleRunTokenTotal(run);
    const body = tokens > 0 ? `${status} · ${tokens} tokens` : status;
    const coder = typeof window === "undefined" ? undefined : window.coder;
    if (coder?.notifyOs) {
      void coder.notifyOs(name, body);
      return;
    }
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const n = new Notification(name, { body });
    if (onOpen) n.onclick = () => onOpen();
  } catch {
    /* اعلان شکست خورد — بج داخل اپ کافی است */
  }
}

/** اعلان تجمیعی وقتی چند ران تازه هم‌زمان دیده شدند (جلوگیری از اسپم اعلان). */
export function notifyScheduleRunBatch(count: number, onOpen?: () => void): void {
  try {
    const coder = typeof window === "undefined" ? undefined : window.coder;
    if (coder?.notifyOs) {
      void coder.notifyOs("Scheduled tasks", `${count} new schedule runs`);
      return;
    }
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const n = new Notification("Scheduled tasks", {
      body: `${count} new schedule runs`,
    });
    if (onOpen) n.onclick = () => onOpen();
  } catch {
    /* اعلان شکست خورد — بج داخل اپ کافی است */
  }
}
