import type { ReviewTurn, ToolActivity } from "../types";
import { diffStatsFromUnified, editTargetOf } from "./toolActivity";

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
  // `diffs`/`adds`/`dels` sum every edit of the file (the fallback for
  // transcripts the backend never sent a net diff for); `net` is the NET diff
  // of the file since the turn's first edit of it, taken from the LAST edit that
  // carries one — what `git diff` would show: an edit that a later edit undid
  // nets to nothing instead of counting twice.
  const byPath = new Map<
    string,
    { adds: number; dels: number; diffs: string[]; net?: string }
  >();
  const walk = (list: ToolActivity[]) => {
    for (const a of list) {
      if (a.tool === "edit_file" || a.tool === "write_file") {
        // Per-file entries when the backend sent them (a batch call names a
        // different file per entry): each file is attributed ITS OWN stats and
        // net diff. Without them, the card's aggregate `diff` would be booked
        // entirely under the first file's path. The fallback keeps older
        // transcripts (single aggregate diff, one target) working as before.
        const perFile: { path: string; diff: string; turnDiff?: string }[] = a.diffs
          ? a.diffs.map((e) => ({ path: e.path, diff: e.diff, turnDiff: e.turnDiff }))
          : a.diff
            ? [{ path: reviewPathOf(a), diff: a.diff, turnDiff: a.turnDiff }]
            : [];
        for (const { path, diff, turnDiff } of perFile) {
          if (!path || !diff || !inReview(path)) continue;
          const s = diffStatsFromUnified(diff);
          const cur = byPath.get(path);
          if (cur) {
            cur.adds += s.adds;
            cur.dels += s.dels;
            cur.diffs.push(diff);
            cur.net = turnDiff;
          } else {
            byPath.set(path, { adds: s.adds, dels: s.dels, diffs: [diff], net: turnDiff });
          }
        }
      }
      if (a.children) walk(a.children);
    }
  };
  walk(activities);
  if (byPath.size === 0) return null;
  const files: ReviewTurn["files"] = [];
  for (const [path, v] of byPath) {
    if (v.net === undefined) {
      // No net diff for this file (older transcript): sum the edits as before.
      files.push({ path, adds: v.adds, dels: v.dels, diff: v.diffs.join("\n") });
    } else if (v.net !== "") {
      const s = diffStatsFromUnified(v.net);
      files.push({ path, adds: s.adds, dels: s.dels, diff: v.net });
    }
    // v.net === "": the turn's edits cancelled out — no net change, no row.
  }
  if (files.length === 0) return null;
  // Totals are summed from the listed files, so the header can never count a
  // file the list below does not show.
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  return { id: messageId, files, adds, dels };
}
