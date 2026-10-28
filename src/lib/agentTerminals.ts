import type { AgentTerminalInfo } from "./api";

/** فقط ترمینال‌های هنوز در حال اجرا — پنل فقط همین‌ها را نشان می‌دهد (مثل
 *  zcode) و ردیف خروج‌شده با اولین پول بعدی محو می‌شود. خالص (pure) تا تست
 *  مستقیم صدا بزند. */
export function runningAgentTerminals(
  rows: AgentTerminalInfo[],
): AgentTerminalInfo[] {
  return (rows ?? []).filter((t) => t && t.running);
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
