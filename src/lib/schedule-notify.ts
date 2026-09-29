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

/** ران‌های واقعاً جدید: در لیست قبلی نبودند و دیده هم نشده‌اند. خالص برای تست. */
export function findNewScheduleRuns(
  prevIds: ReadonlySet<string> | readonly string[],
  runs: ScheduleRun[],
  seen: readonly string[],
): ScheduleRun[] {
  const prev = prevIds instanceof Set ? prevIds : new Set(prevIds);
  const seenSet = new Set(seen ?? []);
  return (runs ?? []).filter((r) => r && !prev.has(r.id) && !seenSet.has(r.id));
}

/** اجازه اعلان سیستم‌عامل را در صورت نیاز می‌گیرد؛ false یعنی اعلان ممکن نیست. */
export async function ensureScheduleNotificationPermission(): Promise<boolean> {
  try {
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

/** یک اعلان سیستم‌عامل برای ران جدید نشان می‌دهد (best-effort، بدون throw).
 * کلیک روی اعلان (در صورت پشتیبانی) `onOpen` را صدا می‌زند تا Inbox باز شود. */
export function notifyScheduleRun(
  run: ScheduleRun,
  taskName: string | null | undefined,
  onOpen?: () => void,
): void {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const name = (taskName ?? "").trim() || "Scheduled task";
    const status = run.status === "error" ? "Failed" : run.status === "running" ? "Running" : "Done";
    const tokens = scheduleRunTokenTotal(run);
    const body = tokens > 0 ? `${status} · ${tokens} tokens` : status;
    const n = new Notification(name, { body });
    if (onOpen) n.onclick = () => onOpen();
  } catch {
    /* اعلان شکست خورد — بج داخل اپ کافی است */
  }
}

/** اعلان تجمیعی وقتی چند ران تازه هم‌زمان دیده شدند (جلوگیری از اسپم اعلان). */
export function notifyScheduleRunBatch(count: number, onOpen?: () => void): void {
  try {
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
