import type { MouseEvent } from "react";
import { useModelTests, type MixedTestEntry } from "../lib/useModelTests";
import { TestBoltsIcon } from "./ModelTestButton";

/** دکمهٔ تست گروهی برای لیست‌های مختلط (چند-پروایدر): سربرگ تب «Recent» و
 *  سربرگ تب «Checked» در پیکر مدل هر دو از همین دکمه استفاده می‌کنند — با یک
 *  کلیک همهٔ مدل‌های لیست با استخر همزمانی محدود تست می‌شوند و نتیجهٔ هر مدل
 *  روی دکمهٔ تکی خودش می‌نشیند. خود دکمه فقط دو حالت دارد: idle (رعد) و
 *  testing (…) — ✓/✕ عمداً فقط روی دکمهٔ تک‌تک مدل‌ها دیده می‌شود؛
 *  جمع‌بندی در tooltip. `label` فقط متن tooltip/aria را می‌سازد و `runKey`
 *  جلوی اجرای همزمان دومِ همان لیست را می‌گیرد. */
export function RecentTestButton({
  entries,
  label = "recent",
  runKey = "recent",
}: {
  entries: MixedTestEntry[];
  label?: string;
  runKey?: string;
}) {
  const { getMixedSummary, runMixed } = useModelTests();
  const s = getMixedSummary(entries);

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (s.running || entries.length === 0) return;
    runMixed(entries, runKey);
  };

  const title =
    entries.length === 0
      ? `No ${label} models to test`
      : s.running
        ? `Testing ${label} models… (${s.done}/${s.total} done)`
        : s.total > 0 && s.done === s.total && s.fail === 0
          ? `All ${s.total} ${label} models OK`
          : s.fail > 0
            ? `${label}: ${s.ok} OK · ${s.fail} failed — ${s.firstFail}`
            : `Test all ${entries.length} ${label} models`;

  return (
    <button
      type="button"
      className={`pm-recent-test${s.running ? " testing" : ""}`}
      onClick={onClick}
      title={title}
      aria-label={`Test all ${label} models`}
    >
      {s.running ? "…" : <TestBoltsIcon />}
    </button>
  );
}
