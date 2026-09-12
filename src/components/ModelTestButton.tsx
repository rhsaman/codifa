import { useState, type MouseEvent } from "react";
import type { ProviderConfig } from "../types";
import { testModel } from "../lib/api";

/** دکمهٔ تست کنار هر مدل: یک تکمیل کوچک می‌فرستد و نتیجه را نشان می‌دهد.
 *  idle (رعد SVG) → testing (…) → ok (✓ سبز) / fail (✕ قرمز + tooltip خطا).
 *  فقط با کلیک کاربر فایر می‌شود — پاپ‌آپ هنگام باز شدن هیچ درخواستی نمی‌زند.
 *  آیکون رعد عمداً SVG است: کاراکتر ⚡ در macOS به‌صورت ایموجی زرد رندر می‌شود
 *  و color در CSS را نادیده می‌گیرد؛ SVG با currentColor همیشه رنگ CSS (سفید) را می‌گیرد. */
export function ModelTestButton({ cfg, model }: { cfg: ProviderConfig; model: string }) {
  const [state, setState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [msg, setMsg] = useState("");
  const run = async (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (state === "testing") return;
    setState("testing");
    setMsg("");
    try {
      const r = await testModel(cfg, model);
      setState("ok");
      setMsg(r.reply ? `OK — ${r.reply}` : "OK");
    } catch (err) {
      setState("fail");
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <button
      type="button"
      className={`pm-model-test ${state}`}
      onClick={run}
      title={msg || `Test ${model}`}
      aria-label={`Test ${model}`}
    >
      {state === "testing" ? "…" : state === "ok" ? "✓" : state === "fail" ? "✕" : (
        <svg
          className="pm-test-bolt"
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
      )}
    </button>
  );
}
