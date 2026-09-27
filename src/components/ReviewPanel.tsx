import { useEffect, useMemo, useState } from "react";
import type { ReviewFile, ReviewTurn, ToolActivity } from "../types";
import { aggregateTurnStats, diffStatsFromUnified } from "../lib/toolActivity";
import { useStore } from "../lib/store";
import { useReviewPanel } from "../lib/reviewPanel";
import { copyToClipboard } from "../lib/clipboard";
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

/** پسوند فایل برای بج کدکس (`css`, `tsx`, …) — فایل بدون پسوند «file». */
function extLabel(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "file";
}

/** پنل Review به سبک کدکس — تب `Review` با دراپ‌داون «Last Turn» و شمارش
 *  +N -M، لیست فایل‌های تغییرکرده، و دیف دوستونی فایل انتخاب‌شده.
 *  داده‌ی ترن از `messageId` در استور خوانده می‌شود تا حین استریم زنده بماند. */
export function ReviewPanel() {
  const { messageId, selectedPath, selectPath, close } = useReviewPanel();
  const [copied, setCopied] = useState(false);

  // فعالیت‌های ابزار پیام جاری — مستقیم از استور تا با هر رویداد جدید به‌روز شود.
  const activities = useStore(
    (s) =>
      s.chats
        .find((c) => c.messages.some((m) => m.id === messageId))
        ?.messages.find((m) => m.id === messageId)?.toolActivity,
  );

  const turn = useMemo(
    () => (messageId && activities ? buildReviewTurn(messageId, activities) : null),
    [messageId, activities],
  );

  // انتخاب پیش‌فرض = فایل کلیک‌شده، وگرنه اولین فایل؛ اگر انتخاب فعلی حین
  // استریم ناپدید شد به اولین فایل برمی‌گردد.
  useEffect(() => {
    if (!turn) return;
    const has = turn.files.some((f) => f.path === selectedPath);
    if (!has) selectPath(turn.files[0]?.path ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn?.files]);

  const selected =
    turn?.files.find((f) => f.path === selectedPath) ?? turn?.files[0];

  const copyDiff = async () => {
    if (!selected) return;
    const ok = await copyToClipboard(selected.diff);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <aside className="review-panel" dir="ltr">
      <div className="review-tabs">
        <span className="review-tab">
          Review
          <button className="review-tab-x" title="Close" onClick={close}>
            ✕
          </button>
        </span>
      </div>
      <div className="review-header">
        <span className="review-turn-select">Last Turn ▾</span>
        {turn && (
          <span className="review-counts">
            <span className="review-count-add">+{turn.adds}</span>
            <span className="review-count-del">-{turn.dels}</span>
          </span>
        )}
        <span className="review-header-actions">
          <button className="review-icon-btn" title="More">···</button>
          <button className="review-icon-btn" title="Split view">⇔</button>
          <button
            className={`review-icon-btn${copied ? " copied" : ""}`}
            title="Copy diff"
            onClick={() => void copyDiff()}
          >
            {copied ? "✓" : "⧉"}
          </button>
        </span>
      </div>

      {!turn ? (
        <div className="review-empty">No changes in this turn.</div>
      ) : (
        <>
          <div className="review-files">
            {turn.files.map((f) => (
              <button
                key={f.path}
                className={`review-file-row${selected?.path === f.path ? " selected" : ""}`}
                onClick={() => selectPath(f.path)}
              >
                <span className="review-file-ext">{extLabel(f.path)}</span>
                <span className="review-file-path">{f.path}</span>
                <span className="review-file-counts">
                  <span className="review-count-add">+{f.adds}</span>
                  <span className="review-count-del">-{f.dels}</span>
                </span>
                <span className="review-file-open" aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
          {selected && (
            <div className="review-diff">
              <div className="review-diff-head">
                <span className="review-file-ext">
                  {extLabel(selected.path)}
                </span>
                <span className="review-file-path">{selected.path}</span>
                <span className="review-file-counts">
                  <span className="review-count-add">+{selected.adds}</span>
                  <span className="review-count-del">-{selected.dels}</span>
                </span>
                <span className="review-file-open" aria-hidden="true">↗</span>
              </div>
              <DiffView diff={selected.diff} path={selected.path} mode="split" />
            </div>
          )}
        </>
      )}
    </aside>
  );
}