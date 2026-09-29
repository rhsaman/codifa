import type { MouseEvent } from "react";
import type { ProviderConfig } from "../types";
import { useModelTests } from "../lib/useModelTests";

/** آیکون رعد دکمهٔ تست تکی مدل. عمداً SVG است: کاراکتر ⚡ در macOS به‌صورت
 *  ایموجی زرد رندر می‌شود و color در CSS را نادیده می‌گیرد؛ SVG با
 *  currentColor همیشه رنگ CSS (سفید) را می‌گیرد. */
export function TestBoltIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      className="pm-test-bolt"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
    </svg>
  );
}

/** آیکون رعد دوتایی دکمهٔ «تست همهٔ مدل‌های پروایدر» — دو رعد کوچک‌تر با
 *  یک جابه‌جایی مورب تا معنای «تست گروهی» را برساند و از رعد تکیِ تست
 *  مدل متمایز شود. همان SVG با currentColor برای رنگ CSS. */
export function TestBoltsIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      className="pm-test-bolt"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9 2 1 12h5l-1 7 8-10H8l1-7z" />
      <path d="M17 7l-6 8h4.5l-.9 6.5L21 11.5h-4.5L17 7z" opacity="0.65" />
    </svg>
  );
}

/** آیکون سنجاق دکمهٔ پین مدل اخیر — SVG با currentColor مثل آیکون رعد:
 *  آزاد = خطی (outline) کم‌رنگ، پین‌شده = توپر (filled) به رنگ accent. */
export function PinIcon({ filled, size = 13 }: { filled: boolean; size?: number }) {
  return (
    <svg
      className="pm-recent-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
    </svg>
  );
}

/** آیکون ضربدر دکمهٔ حذف از لیست اخیر — SVG با currentColor تا هاور قرمز
 *  تمیز رندر شود (کاراکتر ✕ در وزن و تراز یکدست نیست). */
export function RemoveIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      className="pm-recent-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** دکمهٔ تست کنار هر مدل — کنترل‌شده از استور مشترک useModelTests تا
 *  «تست همهٔ مدل‌های پروایدر» بتواند همین دکمه را هم پیش ببرد.
 *  idle (رعد) → testing (…) → ok (✓ سبز) / fail (✕ قرمز + tooltip خطا).
 *  فقط با کلیک کاربر فایر می‌شود — پاپ‌آپ هنگام باز شدن هیچ درخواستی نمی‌زند. */
export function ModelTestButton({ cfg, model }: { cfg: ProviderConfig; model: string }) {
  const { getStatus, run } = useModelTests();
  const st = getStatus(cfg, model);
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (st.status === "testing") return;
    run(cfg, model);
  };
  return (
    <button
      type="button"
      className={`pm-model-test ${st.status}`}
      onClick={onClick}
      title={st.msg || `Test ${model}`}
      aria-label={`Test ${model}`}
    >
      {st.status === "testing" ? "…" : st.status === "ok" ? "✓" : st.status === "fail" ? "✕" : <TestBoltIcon />}
    </button>
  );
}
