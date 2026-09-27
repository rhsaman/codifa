import { useEffect, useMemo, useState } from "react";
import type { ReviewFile, ReviewTurn, ToolActivity } from "../types";
import { aggregateTurnStats, diffStatsFromUnified } from "../lib/toolActivity";
import { DiffView } from "./ToolCallView";

/** ساخت ReviewTurn از روی فعالیت‌های ابزار یک پیام — فقط edit_file/write_file با diff. */
export function buildReviewTurn(
  messageId: string,
  activities: ToolActivity[],
): ReviewTurn | null {
  const files: ReviewFile[] = [];
  const walk = (list: ToolActivity[]) => {
    for (const a of list) {
      if (
        (a.tool === "edit_file" || a.tool === "write_file") &&
        a.diff &&
        typeof a.args?.path === "string"
      ) {
        const s = a.diffStats ?? diffStatsFromUnified(a.diff);
        files.push({ path: a.args.path, adds: s.adds, dels: s.dels, diff: a.diff });
      }
      if (a.children) walk(a.children);
    }
  };
  walk(activities);
  if (files.length === 0) return null;
  const totals = aggregateTurnStats(activities);
  return { id: messageId, files, adds: totals.adds, dels: totals.dels };
}

/**
 * پنل Review به سبک کدکس — هدر با دراپ‌داون «Last Turn» و شمارش +N -M،
 * لیست فایل‌های تغییرکرده، و دیف تک‌ستونی فایل انتخاب‌شده.
 */
export function ReviewPanel({
  turn,
  onClose,
}: {
  turn: ReviewTurn;
  onClose?: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string>("");
  // انتخاب پیش‌فرض = اولین فایل؛ اگر حین استریم فایل‌های ترن تغییر کردند و
  // انتخاب فعلی دیگر موجود نبود، به اولین فایل برگرد.
  useEffect(() => {
    setSelectedPath((cur) =>
      cur && turn.files.some((f) => f.path === cur)
        ? cur
        : (turn.files[0]?.path ?? ""),
    );
  }, [turn.files]);
  const selected = useMemo(
    () => turn.files.find((f) => f.path === selectedPath) ?? turn.files[0],
    [turn.files, selectedPath],
  );

  return (
    <div className="review-panel" dir="ltr">
      <div className="review-header">
        <span className="review-title">Review</span>
        <span className="review-turn-select">Last Turn</span>
        <span className="review-counts">
          <span className="review-count-add">+{turn.adds}</span>{" "}
          <span className="review-count-del">-{turn.dels}</span>
        </span>
        {onClose && (
          <button className="review-close" title="Close" onClick={onClose}>
            ✕
          </button>
        )}
      </div>
      <div className="review-files">
        {turn.files.map((f) => (
          <button
            key={f.path}
            className={`review-file-row${selected?.path === f.path ? " selected" : ""}`}
            onClick={() => setSelectedPath(f.path)}
          >
            <span className="review-file-icon">📄</span>
            <span className="review-file-path">{f.path}</span>
            <span className="review-file-counts">
              <span className="review-count-add">+{f.adds}</span>{" "}
              <span className="review-count-del">-{f.dels}</span>
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="review-diff">
          <DiffView diff={selected.diff} path={selected.path} />
        </div>
      )}
    </div>
  );
}
