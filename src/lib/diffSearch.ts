/** ابزارهای جست‌وجو داخل دیف (هایلایت + فیلتر فایل‌ها).
 *  خالص و بدون وابستگی به React تا مستقیم تست شود. */

/** یک تکه‌ی متن با پرچم هایلایت. */
export interface HighlightPart {
  text: string;
  hit: boolean;
}

/** متن را بر اساس کوئری (case-insensitive) به بخش‌های عادی/هایلایت می‌شکند.
 *  کوئری خالی یعنی بدون هایلایت (کل متن یک تکه‌ی عادی). */
export function splitHighlightParts(
  text: string,
  query: string,
): HighlightPart[] {
  const q = query.trim().toLowerCase();
  if (!q || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out: HighlightPart[] = [];
  let i = 0;
  while (i < text.length) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      out.push({ text: text.slice(i), hit: false });
      break;
    }
    if (j > i) out.push({ text: text.slice(i, j), hit: false });
    out.push({ text: text.slice(j, j + q.length), hit: true });
    i = j + q.length;
  }
  return out;
}

/** تعداد رخدادهای case-insensitive کوئری در متن. */
export function countOccurrences(haystack: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q || !haystack) return 0;
  const lower = haystack.toLowerCase();
  let n = 0;
  let i = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) return n;
    n++;
    i = j + q.length;
  }
}

/** آیا فایل (مسیر یا دیف) با کوئری می‌خوانَد — کوئری خالی یعنی همه. */
export function fileMatchesQuery(
  file: { path: string; diff: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    file.path.toLowerCase().includes(q) || file.diff.toLowerCase().includes(q)
  );
}

/** همه‌ی موقعیت‌های شروع رخداد (غیرهم‌پوشان، case-insensitive). */
export function findAllOccurrences(text: string, query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q || !text) return [];
  const lower = text.toLowerCase();
  const out: number[] = [];
  let i = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) return out;
    out.push(j);
    i = j + q.length;
  }
}

/** یک قدم جلو/عقب در حلقه‌ی رخدادها (مثل VSCode با wrap-around).
 *  `total` صفر یعنی رخدادی نیست → ‎-1‎. */
export function stepHitIndex(
  current: number,
  total: number,
  dir: 1 | -1,
): number {
  if (total <= 0) return -1;
  const c = Number.isFinite(current) && current >= 0 ? current : dir === 1 ? -1 : 0;
  return (((c + dir) % total) + total) % total;
}

/** نگاشت ایندکس سراسری رخداد به فایل و ایندکس محلی داخل آن فایل.
 *  `counts` تعداد رخداد هر فایل (به همان ترتیب لیست) است. */
export function locateHit(
  counts: number[],
  globalIndex: number,
): { fileIndex: number; localIndex: number } | null {
  const total = counts.reduce((n, c) => n + c, 0);
  if (total <= 0) return null;
  let g = ((globalIndex % total) + total) % total;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] ?? 0;
    if (g < c) return { fileIndex: i, localIndex: g };
    g -= c;
  }
  return null;
}
/** یک ردیف دیفِ پارس‌شده (زیرمجموعه‌ی ساختاری `DiffRow` در `reviewDiff` —
 *  عمداً بدون ایمپورت تا چرخه‌ی وابستگی پیش نیاید). */
export type DiffHitRow =
  | { type: "hunk" | "info"; text: string }
  | {
      type: "same" | "del" | "add" | "mod";
      before: string;
      after: string;
    };

/** تعداد رخدادهای قابل‌ناوبری داخل یک دیف — دقیقاً همان ترتیبی که `DiffView`
 *  رندر و هایلایت می‌کند (فقط خط‌های before/after؛ سرفصل هانک هایلایت نمی‌شود).
 *  ردیف‌ها را با `parseDiffRows` از `reviewDiff` بساز و بده. */
export function countDiffHits(rows: DiffHitRow[], query: string): number {
  const q = query.trim();
  if (!q) return 0;
  let n = 0;
  for (const row of rows) {
    if ("text" in row) continue;
    if (row.type === "same" || row.type === "add") {
      n += countOccurrences(row.after, q);
    } else if (row.type === "del") {
      n += countOccurrences(row.before, q);
    } else {
      n += countOccurrences(row.before, q) + countOccurrences(row.after, q);
    }
  }
  return n;
}

export function filterFilesByQuery<T extends { path: string; diff: string }>(
  files: T[],
  query: string,
): T[] {
  if (!query.trim()) return files;
  return files.filter((f) => fileMatchesQuery(f, query));
}
