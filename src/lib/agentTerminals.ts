import type { AgentTerminalInfo } from "./api";

/** فقط ترمینال‌های هنوز در حال اجرا — پنل فقط همین‌ها را نشان می‌دهد (مثل
 *  zcode) و ردیف خروج‌شده با اولین پول بعدی محو می‌شود. خالص (pure) تا تست
 *  مستقیم صدا بزند. */
export function runningAgentTerminals(
  rows: AgentTerminalInfo[],
): AgentTerminalInfo[] {
  return (rows ?? []).filter((t) => t && t.running);
}

/** چند میلی‌ثانیه بعد از خروج، ردیف هنوز در پنل می‌ماند (با کد خروجش).
 *  دستور کوتاهی که بین دو پول ۲ثانیه‌ای زاده و مرده‌اند بدون این پنجره
 *  هیچ‌وقت دیده نمی‌شد — تنها فیلترِ ممکن «running» بود. ثابت است و روی
 *  همان آرایهٔ هر پول اعمال می‌شود؛ هیچ انباشت حافظه‌ای ندارد. */
export const TERMINAL_EXIT_GRACE_MS = 30_000;

/** ردیف‌هایی که پنل نشان می‌دهد: زنده‌ها + خروج‌یافته‌های داخل پنجرهٔ grace.
 *  ردیفِ بدون exited_at_ms (بک‌اند قدیمی، یا ردیف مردهٔ قدیمی روی دیسک) مثل
 *  قبل فقط تا وقتی زنده است دیده می‌شود. خالص (pure) تا تست مستقیم صدا بزند. */
export function visibleAgentTerminals(
  rows: AgentTerminalInfo[],
  now: number,
): AgentTerminalInfo[] {
  return (rows ?? []).filter(
    (t) =>
      t &&
      (t.running ||
        (t.exited_at_ms != null &&
          now >= t.exited_at_ms &&
          now - t.exited_at_ms <= TERMINAL_EXIT_GRACE_MS)),
  );
}

/** برچسب وضعیت ردیف خروج‌یافته: «exit 0» / «exit 3» و وقتی کد ثبت نشده
 *  (مثلاً kill از بیرون) «finished». خالص (pure) تا تست مستقیم صدا بزند. */
export function terminalExitLabel(t: AgentTerminalInfo): string {
  return t.exit_code === null || t.exit_code === undefined
    ? "finished"
    : `exit ${t.exit_code}`;
}

/** «Running for …» به سبک zcode: «18m 35s». زیر یک دقیقه فقط ثانیه، بعد از
 *  یک ساعت ساعت هم می‌آید. خالص (pure) تا تست مستقیم صدا بزند. */
export function formatRunningFor(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
