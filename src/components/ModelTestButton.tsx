import type { MouseEvent } from "react";
import type { ProviderConfig } from "../types";
import { useModelTests } from "../lib/useModelTests";

/** آیکون رعد مشترک بین دکمهٔ تست تکی مدل و دکمهٔ تست پروایدر. عمداً SVG
 *  است: کاراکتر ⚡ در macOS به‌صورت ایموجی زرد رندر می‌شود و color در CSS
 *  را نادیده می‌گیرد؛ SVG با currentColor همیشه رنگ CSS (سفید) را می‌گیرد. */
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
