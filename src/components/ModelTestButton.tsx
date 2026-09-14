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
