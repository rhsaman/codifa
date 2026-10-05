/** پارسرهای دیف برای نمای Review به سبک کدکس.
 *
 *  - `parseDiffRows` ردیف‌های یکپارچه/هم‌تراز را برمی‌گرداند (DiffView کارت ابزار).
 *  - `parseSideBySide` همان ردیف‌ها را به‌هم‌راه جداکنندهٔ «N unmodified lines»
 *    بین هانک‌ها می‌دهد — کدکس خطوط دست‌نخوردهٔ بین دو هانک را جمع می‌کند و
 *    فقط شمارششان را نشان می‌دهد.
 */

/** یک ردیف دیف: «del/add/mod/same» دو طرف before/after دارند (هم‌تراز)،
 *  «hunk/info» فقط متن دارند. */
export type DiffRow =
  | { type: "hunk" | "info"; text: string }
  | {
      type: "same" | "del" | "add" | "mod";
      before: string;
      after: string;
      bLine: number;
      aLine: number;
    };

/** یکی از دو ستون نمای دوستونی. */
export type SideBySideItem =
  | { kind: "rows"; rows: DiffRow[]; key: string }
  | { kind: "gap"; count: number; key: string };

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface ParsedHunk {
  header: string;
  /** شماره‌ی خط شروع/تعداد خطوط در فایل جدید (برای محاسبهٔ گپ بین هانک‌ها). */
  newStart: number;
  newCount: number;
  rows: DiffRow[];
}

/** دیف unified را به هانک‌ها با ردیف‌های هم‌تراز before/after تبدیل می‌کند. */
function parseHunks(diff: string): ParsedHunk[] {
  const out: ParsedHunk[] = [];
  let cur: ParsedHunk | null = null;
  let bLine = 0;
  let aLine = 0;
  let pendingDel: string[] = [];
  let pendingAdd: string[] = [];

  // یک بلوک حذف/افزودن را به ردیف‌های هم‌تراز (mod/del/add) تبدیل می‌کند.
  const flushPairs = () => {
    if (!pendingDel.length && !pendingAdd.length) return;
    const n = Math.max(pendingDel.length, pendingAdd.length);
    for (let i = 0; i < n; i++) {
      const hasB = i < pendingDel.length;
      const hasA = i < pendingAdd.length;
      const type: DiffRow["type"] = hasB && hasA ? "mod" : hasB ? "del" : "add";
      cur?.rows.push({
        type,
        before: hasB ? pendingDel[i] : "",
        after: hasA ? pendingAdd[i] : "",
        bLine: hasB ? bLine : -1,
        aLine: hasA ? aLine : -1,
      });
      if (hasB) bLine++;
      if (hasA) aLine++;
    }
    pendingDel = [];
    pendingAdd = [];
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    const hm = HUNK_RE.exec(line);
    if (hm) {
      flushPairs();
      bLine = parseInt(hm[1], 10);
      aLine = parseInt(hm[3], 10);
      cur = {
        header: line,
        newStart: aLine,
        newCount: hm[4] ? parseInt(hm[4], 10) : 1,
        rows: [],
      };
      out.push(cur);
    } else if (!cur) {
      // خط قبل از اولین هانک (دیف ناقص) — نادیده بگیر.
      continue;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      flushPairs();
      cur.rows.push({ type: "info", text: line });
    } else if (line.startsWith("-")) {
      pendingDel.push(line.slice(1));
    } else if (line.startsWith("+")) {
      pendingAdd.push(line.slice(1));
    } else {
      flushPairs();
      cur.rows.push({
        type: "same",
        before: line.slice(1),
        after: line.slice(1),
        bLine,
        aLine,
      });
      bLine++;
      aLine++;
    }
  }
  flushPairs();
  return out;
}

/** دیف را به لیست تخت ردیف‌ها تبدیل می‌کند (هدر هر هانک هم یک ردیف «hunk» است). */
export function parseDiffRows(diff: string): DiffRow[] {
  const out: DiffRow[] = [];
  for (const h of parseHunks(diff)) {
    out.push({ type: "hunk", text: h.header });
    out.push(...h.rows);
  }
  return out;
}

/** دیف دوستونی: هر هانک یک بلوک ردیف، و بین دو هانک یک گپ
 *  «N unmodified lines» (به سبک کدکس). */
export function parseSideBySide(diff: string): SideBySideItem[] {
  const hunks = parseHunks(diff);
  const items: SideBySideItem[] = [];
  let prevNewEnd = 0;
  hunks.forEach((h, i) => {
    const gap = h.newStart - prevNewEnd - 1;
    if (i > 0 && gap > 0) {
      items.push({ kind: "gap", count: gap, key: `gap-${i}` });
    }
    items.push({ kind: "rows", rows: h.rows, key: `hunk-${i}` });
    prevNewEnd = h.newStart + h.newCount - 1;
  });
  return items;
}

/** یک تکه دیف متعلق به یک فایل. */
export interface FileDiff {
  path: string;
  diff: string;
}

/** چند تکه‌دیف (مثلاً staged و unstaged) را به‌ازای هر مسیر ادغام می‌کند —
 *  دیف‌های یک مسیر به‌ترتیب ورودی الحاق می‌شوند تا آمار +N -M کامل شود. */
export function mergeFileDiffs(groups: FileDiff[][]): FileDiff[] {
  const order: string[] = [];
  const byPath = new Map<string, string[]>();
  for (const group of groups) {
    for (const f of group) {
      if (!f.path) continue;
      const cur = byPath.get(f.path);
      if (cur) cur.push(f.diff);
      else {
        byPath.set(f.path, [f.diff]);
        order.push(f.path);
      }
    }
  }
  return order.map((path) => ({
    path,
    diff: (byPath.get(path) ?? []).join("\n"),
  }));
}

/** دیف چندفایلی گیت (با سرفصل‌های `diff --git`) را به تکه‌های تک‌فایلی
 *  می‌شکند تا پنل Review بتواند همان لیست فایل ترن را نشان بدهد. */
export function splitUnifiedDiffByFile(diff: string): FileDiff[] {
  const out: FileDiff[] = [];
  let cur: string[] | null = null;
  let curPath = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur) out.push({ path: curPath, diff: cur.join("\n") });
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      curPath = m ? m[2] : line.slice("diff --git ".length);
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) out.push({ path: curPath, diff: cur.join("\n") });
  return out.filter((f) => f.path.length > 0);
}
