import type { LayaRun } from "../types";

/** دلیل آماده‌نبودن laya به فارسی برای تنظیمات (دقیق: نصب‌نیست در برابر وزن‌نیست). */
export function layaReasonLabel(reason?: string): string {
  const r = (reason || '').trim().toLowerCase()
  if (!r) return ''
  if (r === 'laya-not-installed') return 'نصب نیست — `pip install laya`'
  if (r === 'laya-weights-missing') return 'وزن دانلود نشده — دکمه دانلود'
  if (r.startsWith('laya-timeout')) return 'کند بود — به مدل بزرگ واگذار شد'
  if (r.startsWith('laya-provider')) return 'پروایدر خارجی جواب نداد — واگذاری'
  if (r.startsWith('low-confidence')) return 'اطمینان پایین — واگذاری'
  if (r === 'abstained') return 'نمی‌دانم — واگذاری'
  return r
}

/** برچسب فارسی مسیر تصمیم laya برای بج کارت. */
export function layaRouteLabel(route: string): string {
  const r = (route || "").trim().toLowerCase();
  if (r === "computer") return "کامپیوتر";
  if (r === "browser") return "مرورگر";
  return "معمولی";
}

/** کلاس حالت کارت laya: لوکال / خارجی / واگذاری به مدل بزرگ. */
export function layaCardTone(run: LayaRun): "local" | "external" | "fallback" {
  if (run.abstained || !run.handled) return "fallback";
  return (run.providerId || "local") === "local" ? "local" : "external";
}

/** درصد نمایشی اطمینان (۰ تا ۱۰۰، clamp شده). */
export function layaConfidencePct(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(100, Math.round(confidence * 100)));
}
