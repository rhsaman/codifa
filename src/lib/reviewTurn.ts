import type { ReviewTurn, ToolActivity } from "../types";
import { aggregateTurnStats, diffStatsFromUnified, editTargetOf } from "./toolActivity";

/** مسیر فایلِ یک فعالیت ویرایش (`path` یا `filePath`) — خالی یعنی غیر-ویرایشی. */
export function reviewPathOf(a: ToolActivity): string {
  return editTargetOf(a.args);
}

/** ساخت ReviewTurn از روی فعالیت‌های ابزار یک پیام — فقط edit_file/write_file با diff.
 *  به‌ازای هر مسیر یکتا فقط یک ردیف برمی‌گردد: ویرایش‌های تکراری همان فایل در
 *  یک ترن ادغام می‌شوند (جمع +N -M و الحاق دیف‌ها) تا لیست فایل تکراری نشان ندهد. */
/**
 * Whether a path may appear in the Review panel.
 *
 * The panel lists WORKSPACE files (its other view is git status), so an edit to a
 * path outside the project — `/tmp/split_tests.py`, a script in the user's home —
 * has no diff to review and no repo entry to stage: listing it there offered
 * "Review ↗" and a git row for a file git never sees. The CHAT card still shows
 * it (name + diff), which is where a stray write is actually noticed.
 *
 * A workspace-relative path is always in; an absolute one must really live under
 * `root` (trailing slashes ignored, so `/repo/` and `/repo` agree).
 */
export function isReviewablePath(root: string | undefined, path: string): boolean {
  if (!path) return false;
  if (!path.startsWith("/")) return true;
  const dir = (root ?? "").replace(/\/+$/, "");
  return dir !== "" && (path === dir || path.startsWith(`${dir}/`));
}

export function buildReviewTurn(
  messageId: string,
  activities: ToolActivity[],
  root?: string,
): ReviewTurn | null {
  const inReview = (path: string) => isReviewablePath(root, path);
  const byPath = new Map<string, { adds: number; dels: number; diffs: string[] }>();
  const walk = (list: ToolActivity[]) => {
    for (const a of list) {
      if (
        (a.tool === "edit_file" || a.tool === "write_file") &&
        a.diff
      ) {
        const path = reviewPathOf(a);
        if (path && inReview(path)) {
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
  // Totals come from the SAME filtered walk, so the header can never count a
  // file the list below does not show.
  const totals = aggregateTurnStats(activities, inReview);
  return { id: messageId, files, adds: totals.adds, dels: totals.dels };
}
