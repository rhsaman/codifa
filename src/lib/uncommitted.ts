/** ساخت لیست فایل‌های uncommitted از خروجی خام گیت.
 *  منطق مشترک پنل Review و نوار بالای کامپوزر: ترکیب staged و unstaged با
 *  `mergeFileDiffs` + افزودن فایل‌های untracked از status. خالص و تست‌پذیر. */
import { diffStatsFromUnified } from "./toolActivity";
import { mergeFileDiffs, splitUnifiedDiffByFile } from "./reviewDiff";

/** فایل تغییرکرده با دیف و آمار +N -M. */
export interface UncommittedFile {
  path: string;
  diff: string;
  adds: number;
  dels: number;
}

/** از مسیرهای status و دیف‌های خام، لیست نهایی فایل‌ها را می‌سازد:
 *  دیف‌های یک مسیر (staged/unstaged) الحاق می‌شوند تا آمار کامل شود و
 *  مسیرهایی که دیف ندارند (untracked) با آمار صفر اضافه می‌شوند. */
export function buildUncommittedFiles(
  statusPaths: string[],
  unstagedDiff: string,
  stagedDiff: string,
): UncommittedFile[] {
  const parts = mergeFileDiffs([
    splitUnifiedDiffByFile(unstagedDiff),
    splitUnifiedDiffByFile(stagedDiff),
  ]);
  const byPath = new Map(parts.map((p) => [p.path, p.diff]));
  const paths = [...byPath.keys()];
  for (const p of statusPaths) {
    if (!byPath.has(p)) {
      byPath.set(p, "");
      paths.push(p);
    }
  }
  return paths.map((p) => {
    const diff = byPath.get(p) ?? "";
    const s = diff ? diffStatsFromUnified(diff) : { adds: 0, dels: 0 };
    return { path: p, diff, adds: s.adds, dels: s.dels };
  });
}

/** جمع +N -M روی لیست فایل‌ها. */
export function sumDiffStats(
  files: Array<{ adds: number; dels: number }>,
): { adds: number; dels: number } {
  return files.reduce(
    (acc, f) => ({ adds: acc.adds + f.adds, dels: acc.dels + f.dels }),
    { adds: 0, dels: 0 },
  );
}
