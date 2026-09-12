import type { MouseEvent } from "react";
import type { ProviderConfig } from "../types";
import { useModelTests } from "../lib/useModelTests";
import { TestBoltIcon } from "./ModelTestButton";

/** دکمهٔ تست کنار نام هر پروایدر: با یک کلیک همهٔ مدل‌های آن پروایدر با
 *  استخر همزمانی محدود تست می‌شوند و نتیجهٔ هر مدل روی دکمهٔ تکی خودش
 *  می‌نشیند. خود دکمه جمع‌بندی را نشان می‌دهد:
 *  idle (رعد) → testing (…) → همهٔ OK (✓ سبز) / هر خطا (✕ قرمز + tooltip). */
export function ProviderTestButton({ cfg, models }: { cfg: ProviderConfig; models: string[] }) {
  const { getSummary, runAll } = useModelTests();
  const s = getSummary(cfg, models);
  let state: "idle" | "testing" | "ok" | "fail" = "idle";
  if (s.running) state = "testing";
  else if (s.total > 0 && s.done === s.total) state = s.fail === 0 ? "ok" : "fail";

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
      className={`pm-provider-test ${state}`}
      onClick={onClick}
      title={title}
      aria-label={`Test all models of ${cfg.name}`}
    >
      {state === "testing" ? "…" : state === "ok" ? "✓" : state === "fail" ? "✕" : <TestBoltIcon />}
    </button>
  );
}
