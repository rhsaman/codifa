import type { ReviewTurn, ToolActivity } from "../types";
import { aggregateTurnStats, diffStatsFromUnified } from "./toolActivity";

/** مسیر فایلِ یک فعالیت ویرایش (`path` یا `filePath`) — خالی یعنی غیر-ویرایشی. */
export function reviewPathOf(a: ToolActivity): string {
  const p = a.args?.path ?? a.args?.filePath;
  return typeof p === "string" ? p : "";
}

/** ساخت ReviewTurn از روی فعالیت‌های ابزار یک پیام — فقط edit_file/write_file با diff.
 *  به‌ازای هر مسیر یکتا فقط یک ردیف برمی‌گردد: ویرایش‌های تکراری همان فایل در
 *  یک ترن ادغام می‌شوند (جمع +N -M و الحاق دیف‌ها) تا لیست فایل تکراری نشان ندهد. */
export function buildReviewTurn(
  messageId: string,
  activities: ToolActivity[],
): ReviewTurn | null {
  const byPath = new Map<string, { adds: number; dels: number; diffs: string[] }>();
  const walk = (list: ToolActivity[]) => {
    for (const a of list) {
      if (
        (a.tool === "edit_file" || a.tool === "write_file") &&
        a.diff
      ) {
        const path = reviewPathOf(a);
        if (path) {
          const s = a.diffStats ?? diffStatsFromUnified(a.diff);
          const cur = byPath.get(path);
          if (cur) {
            cur.adds += s.adds;
            cur.dels += s.dels;
            cur.diffs.push(a.diff);
          } else {
            byPath.set(path, { adds: s.adds, dels: s.dels, diffs: [a.diff] });
          }
        }
      }
      if (a.children) walk(a.children);
    }
  };
  walk(activities);
  if (byPath.size === 0) return null;
  const files = [...byPath.entries()].map(([path, v]) => ({
    path,
    adds: v.adds,
    dels: v.dels,
    diff: v.diffs.join("\n"),
  }));
  const totals = aggregateTurnStats(activities);
  return { id: messageId, files, adds: totals.adds, dels: totals.dels };
}
