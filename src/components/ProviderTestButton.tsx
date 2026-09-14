import type { MouseEvent } from "react";
import type { ProviderConfig } from "../types";
import { useModelTests } from "../lib/useModelTests";
import { TestBoltsIcon } from "./ModelTestButton";

/** دکمهٔ تست کنار نام هر پروایدر: با یک کلیک همهٔ مدل‌های آن پروایدر با
 *  استخر همزمانی محدود تست می‌شوند و نتیجهٔ هر مدل روی دکمهٔ تکی خودش
 *  می‌نشیند. خود دکمه فقط دو حالت دارد: idle (رعد) و testing (…) —
 *  ✓/✕ عمداً فقط روی دکمهٔ تک‌تک مدل‌ها دیده می‌شود؛ جمع‌بندی در tooltip. */
export function ProviderTestButton({ cfg, models }: { cfg: ProviderConfig; models: string[] }) {
  const { getSummary, runAll } = useModelTests();
  const s = getSummary(cfg, models);

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (s.running || models.length === 0) return;
    runAll(cfg, models);
  };

  const title =
    models.length === 0
      ? `No models to test on ${cfg.name}`
      : s.running
        ? `Testing ${cfg.name} models… (${s.done}/${s.total} done)`
        : s.total > 0 && s.done === s.total && s.fail === 0
          ? `All ${s.total} models of ${cfg.name} OK`
          : s.fail > 0
            ? `${cfg.name}: ${s.ok} OK · ${s.fail} failed — ${s.firstFail}`
            : `Test all ${models.length} models of ${cfg.name}`;

  return (
    <button
      type="button"
      className={`pm-provider-test${s.running ? " testing" : ""}`}
      onClick={onClick}
      title={title}
      aria-label={`Test all models of ${cfg.name}`}
    >
      {s.running ? "…" : <TestBoltsIcon />}
    </button>
  );
}
