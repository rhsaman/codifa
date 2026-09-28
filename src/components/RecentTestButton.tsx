import type { MouseEvent } from "react";
import { useModelTests, type MixedTestEntry } from "../lib/useModelTests";
import { TestBoltsIcon } from "./ModelTestButton";

/** دکمهٔ تست کنار برچسب «Recent»: با یک کلیک همهٔ مدل‌های اخیر (از چند
 *  پروایدر مختلف) با استخر همزمانی محدود تست می‌شوند و نتیجهٔ هر مدل روی
 *  دکمهٔ تکی خودش می‌نشیند. خود دکمه فقط دو حالت دارد: idle (رعد) و
 *  testing (…) — ✓/✕ عمداً فقط روی دکمهٔ تک‌تک مدل‌ها دیده می‌شود؛
 *  جمع‌بندی در tooltip. */
export function RecentTestButton({ entries }: { entries: MixedTestEntry[] }) {
  const { getMixedSummary, runMixed } = useModelTests();
  const s = getMixedSummary(entries);

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (s.running || entries.length === 0) return;
    runMixed(entries);
  };

  const title =
    entries.length === 0
      ? "No recent models to test"
      : s.running
        ? `Testing recent models… (${s.done}/${s.total} done)`
        : s.total > 0 && s.done === s.total && s.fail === 0
          ? `All ${s.total} recent models OK`
          : s.fail > 0
            ? `Recent: ${s.ok} OK · ${s.fail} failed — ${s.firstFail}`
            : `Test all ${entries.length} recent models`;

  return (
    <button
      type="button"
      className={`pm-recent-test${s.running ? " testing" : ""}`}
      onClick={onClick}
      title={title}
      aria-label="Test all recent models"
    >
      {s.running ? "…" : <TestBoltsIcon />}
    </button>
  );
}
