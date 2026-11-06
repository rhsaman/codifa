import type { MouseEvent } from "react";
import { isGroupTestable, useModelTests, type MixedTestEntry } from "../lib/useModelTests";
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
  // مدل‌های پروایدرهایی که تست گروهیشان خاموش است در این دکمه شرکت دارند؛
  // دکمهٔ تکیِ خودشان دست‌نخورده می‌ماند.
  const testable = entries.filter((e) => isGroupTestable(e.cfg)).length;
  const skipped = entries.length - testable;
  const noneTestable = entries.length > 0 && testable === 0;

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (s.running || testable === 0) return;
    runMixed(entries, runKey);
  };

  const title = noneTestable
    ? `Group test is off for every provider in this list — turn it on in Settings → Providers`
    : entries.length === 0
      ? `No ${label} models to test`
      : s.running
        ? `Testing ${label} models… (${s.done}/${s.total} done)`
        : s.total > 0 && s.done === s.total && s.fail === 0
          ? `All ${s.total} ${label} models OK`
          : s.fail > 0
            ? `${label}: ${s.ok} OK · ${s.fail} failed — ${s.firstFail}`
            : skipped > 0
              ? `Test ${testable} ${label} models (${skipped} skipped — group test is off for their provider)`
              : `Test all ${entries.length} ${label} models`;

  return (
    <button
      type="button"
      className={`pm-recent-test${s.running ? " testing" : ""}${noneTestable ? " off" : ""}`}
      onClick={onClick}
      disabled={noneTestable}
      title={title}
      aria-label={`Test all ${label} models`}
    >
      {s.running ? "…" : <TestBoltsIcon />}
    </button>
  );
}
