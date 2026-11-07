import { useCallback, useSyncExternalStore } from "react";
import type { ProviderConfig } from "../types";
import { providerKeys, testModel, testModelsBatch } from "./api";

/** وضعیت تست یک مدل: idle → testing → ok / fail (با پیام خطای واقعی). */
export type ModelTestStatus = "idle" | "testing" | "ok" | "fail";

export interface ModelTestEntry {
  status: ModelTestStatus;
  msg: string;
  /** Exact moment a passing test finished (stamped once at result time, not at
   *  render time — a render-time Date.now() would tie every just-tested model
   *  and defeat the Checked tab's most-recent-first ordering). */
  okAt?: number;
}

/** جمع‌بندی تست‌های یک پروایدر — برای دکمهٔ «تست همهٔ مدل‌ها». */
export interface ProviderTestSummary {
  running: boolean;
  ok: number;
  fail: number;
  done: number;
  total: number;
  firstFail: string;
}

const IDLE: ModelTestEntry = { status: "idle", msg: "" };

/** آیا پروایدر در «تست گروهی» شرکت دارد؟ پیش‌فرض بله؛ فقط groupTest === false کنارش می‌گذارد.
 *  تست تکیِ مدل (runModelTest) همیشه مجاز است و این فلگ روی آن اثری ندارد. */
export function isGroupTestable(cfg: ProviderConfig): boolean {
  return cfg.groupTest !== false;
}

/** ورودی تست مختلط (مدل + کانفیگ پروایدرش) — برای لیست‌هایی مثل Recent که
 *  مدل‌ها از چند پروایدر مختلف می‌آیند. */
export interface MixedTestEntry {
  cfg: ProviderConfig;
  model: string;
}

/** استور مشترک نتایج تست. چون «تست همهٔ مدل‌های پروایدر» باید بتواند همان
 *  دکمه‌های تکی را همزمان پیش ببرد، وضعیت‌ها مرکزی نگه داشته می‌شوند و
 *  دکمه‌ها با useSyncExternalStore از یک snapshot تغییرناپذیر می‌خوانند. */
let snapshot: ReadonlyMap<string, ModelTestEntry> = new Map();
const EMPTY: ReadonlyMap<string, ModelTestEntry> = snapshot;
const listeners = new Set<() => void>();
const providerRuns = new Set<string>();
/** Which provider/model each snapshot key belongs to. The key itself embeds
 *  baseUrl + keys (so a config change gets a fresh result), which makes it
 *  impossible to parse reliably — this side map lets a REAL chat failure
 *  invalidate every result for the same provider/model. */
const owners = new Map<string, { providerId: string; model: string }>();

function key(cfg: ProviderConfig, model: string): string {
  return `${cfg.id}/${cfg.kind}/${cfg.baseUrl ?? ""}/${providerKeys(cfg).join(",")}/${model}`;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getSnapshot = (): ReadonlyMap<string, ModelTestEntry> => snapshot;
const getServerSnapshot = (): ReadonlyMap<string, ModelTestEntry> => EMPTY;

function setEntry(k: string, patch: Partial<ModelTestEntry>): void {
  const cur = snapshot.get(k) ?? IDLE;
  const next = new Map(snapshot);
  next.set(k, { ...cur, ...patch });
  snapshot = next;
  for (const l of listeners) l();
}

/** Record a result and remember which provider/model it belongs to. */
function setEntryFor(
  cfg: ProviderConfig,
  model: string,
  patch: Partial<ModelTestEntry>,
): void {
  const k = key(cfg, model);
  owners.set(k, { providerId: cfg.id, model });
  // Stamp the pass moment here, at result time — the Checked tab sort and the
  // persisted lastOkAt both read this exact timestamp.
  setEntry(k, patch.status === "ok" ? { okAt: Date.now(), ...patch } : patch);
}

/** خواندن مستقیم وضعیت یک مدل — بدون هوک (برای تست‌ها و مصرف خارج از React). */
export function getTestEntry(cfg: ProviderConfig, model: string): ModelTestEntry {
  return snapshot.get(key(cfg, model)) ?? IDLE;
}

/** پاک‌کردن همهٔ نتایج ثبت‌شده. */
export function clearModelTests(): void {
  snapshot = EMPTY;
  owners.clear();
  for (const l of listeners) l();
}

/** حذف نتیجهٔ تست «یک» مدل: نتیجهٔ ✓ سبز به idle برمی‌گردد — مدل از تب
 *  Checked پیکر می‌رود و دکمهٔ ⚡ آن دوباره رعد خالی نشان می‌دهد. فقط روی
 *  نتیجهٔ ok اثر دارد (نتیجهٔ fail دست‌نخورده می‌ماند). */
export function dismissModelTest(cfg: ProviderConfig, model: string): void {
  const k = key(cfg, model);
  if (snapshot.get(k)?.status === "ok") setEntry(k, { status: "idle", msg: "" });
}

/** A REAL chat turn just failed on this provider/model. A green tick claims the
 *  model can serve a turn, so any turn error disproves it — demote every live
 *  result for the pair to `fail`. Matching is by provider/model, not by
 *  snapshot key: the key also embeds baseUrl/keys, which can change while a
 *  result is still on screen. The caller also removes the persisted checked
 *  entry (see Chat.tsx), so a stale ✓ cannot survive the failure. */
export function markModelTestFailed(
  providerId: string,
  model: string,
  msg: string,
): void {
  if (!providerId || !model) return;
  let changed = false;
  const next = new Map(snapshot);
  for (const [k, e] of snapshot) {
    const o = owners.get(k);
    if (o?.providerId === providerId && o.model === model) {
      next.set(k, { ...e, status: "fail", msg });
      changed = true;
    }
  }
  if (!changed) return;
  snapshot = next;
  for (const l of listeners) l();
}

/** پاک‌کردن کلی نتایج موفق: همهٔ ✓ها به idle برمی‌گردند (تب Checked خالی
 *  می‌شود) ولی نتایج fail حفظ می‌شوند — همان کاری که دکمهٔ ✕ سربرگ تب
 *  Checked انجام می‌دهد. */
export function clearCheckedTests(): void {
  let changed = false;
  const next = new Map(snapshot);
  for (const [k, e] of snapshot) {
    if (e.status === "ok") {
      next.set(k, { status: "idle", msg: "" });
      changed = true;
    }
  }
  if (changed) {
    snapshot = next;
    for (const l of listeners) l();
  }
}

/** تست یک مدل: نتیجه در استور مشترک ثبت می‌شود تا دکمهٔ تکی و جمع‌بندی
 *  پروایدر هر دو از یک منبع بخوانند. اگر همان مدل از قبل در حال تست باشد
 *  دوباره فایر نمی‌شود. */
export async function runModelTest(cfg: ProviderConfig, model: string): Promise<void> {
  const k = key(cfg, model);
  if (snapshot.get(k)?.status === "testing") return;
  setEntryFor(cfg, model, { status: "testing", msg: "" });
  try {
    const r = await testModel(cfg, model);
    setEntryFor(cfg, model, { status: "ok", msg: r.reply ? `OK — ${r.reply}` : "OK" });
  } catch (err) {
    setEntryFor(cfg, model, {
      status: "fail",
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

/** تست همهٔ مدل‌های یک پروایدر — یک راندتریپ بچ (سریع) با فالبک تکی. هر نتیجه
 *  روی دکمهٔ تکی همان مدل می‌نشیند. اجرای همزمان دوم با همان کلید نادیده
 *  گرفته می‌شود. در هر دو انتخاب‌گر (کامپوزر و تنظیمات) همین مسیر اجرا می‌شود. */
export async function runProviderTests(
  cfg: ProviderConfig,
  models: string[],
  pool = 10,
): Promise<void> {
  if (!isGroupTestable(cfg) || models.length === 0 || providerRuns.has(key(cfg, "__all__"))) return;
  providerRuns.add(key(cfg, "__all__"));
  try {
    const uniq = [...new Set(models)];
    for (const m of uniq) {
      const k = key(cfg, m);
      if (snapshot.get(k)?.status !== "testing") setEntryFor(cfg, m, { status: "testing", msg: "" });
    }
    try {
      const results = await testModelsBatch(cfg, uniq);
      const seen = new Set(results.map((r) => r.model));
      for (const r of results) {
        setEntryFor(cfg, r.model, r.ok
          ? { status: "ok", msg: r.reply ? `OK — ${r.reply}` : "OK" }
          : { status: "fail", msg: r.error || "model test failed" });
      }
      const missing = uniq.filter((m) => !seen.has(m));
      if (missing.length > 0) {
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < missing.length) {
            const m = missing[cursor++];
            try {
              const r = await testModel(cfg, m);
              setEntryFor(cfg, m, { status: "ok", msg: r.reply ? `OK — ${r.reply}` : "OK" });
            } catch (err) {
              setEntryFor(cfg, m, {
                status: "fail",
                msg: err instanceof Error ? err.message : String(err),
              });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(pool, missing.length) }, worker));
      }
      return;
    } catch {
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < uniq.length) {
          const m = uniq[cursor++];
          try {
            const r = await testModel(cfg, m);
            setEntryFor(cfg, m, { status: "ok", msg: r.reply ? `OK — ${r.reply}` : "OK" });
          } catch (err) {
            setEntryFor(cfg, m, {
              status: "fail",
              msg: err instanceof Error ? err.message : String(err),
            });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(pool, uniq.length) }, worker));
    }
  } finally {
    providerRuns.delete(key(cfg, "__all__"));
  }
}

/** تست لیست مختلط (مثل Recent: مدل‌هایی از چند پروایدر مختلف) — گروه‌بندی
 *  بر اساس کانفیگ پروایدر و یک راندتریپ بچ برای هر گروه (سریع). هر نتیجه روی
 *  دکمهٔ تکی همان مدل می‌نشیند. اجرای همزمان دوم با کلید یکسان نادیده گرفته
 *  می‌شود. در هر دو انتخاب‌گر (کامپوزر و تنظیمات) همین مسیر اجرا می‌شود. */
const mixedRuns = new Set<string>();

function groupKey(cfg: ProviderConfig): string {
  return [cfg.id, cfg.kind, cfg.baseUrl ?? "", providerKeys(cfg).join(",")].join("|");
}

export async function runMixedTests(
  entries: MixedTestEntry[],
  pool = 10,
  runKey = "recent",
): Promise<void> {
  // پروایدرهایی که تست گروهیشان خاموش است از لیست مختلط کنار گذاشته می‌شوند.
  entries = entries.filter((e) => isGroupTestable(e.cfg));
  if (entries.length === 0 || mixedRuns.has(runKey)) return;
  mixedRuns.add(runKey);
  try {
    for (const e of entries) {
      const k = key(e.cfg, e.model);
      if (snapshot.get(k)?.status !== "testing") setEntryFor(e.cfg, e.model, { status: "testing", msg: "" });
    }
    const groups = new Map<string, { cfg: ProviderConfig; models: string[] }>();
    for (const e of entries) {
      const gk = groupKey(e.cfg);
      let g = groups.get(gk);
      if (!g) {
        g = { cfg: e.cfg, models: [] };
        groups.set(gk, g);
      }
      if (!g.models.includes(e.model)) g.models.push(e.model);
    }
    const groupList = [...groups.values()];
    let cursor = 0;
    const groupPool = Math.min(4, groupList.length);
    const worker = async (): Promise<void> => {
      while (cursor < groupList.length) {
        const g = groupList[cursor++];
        try {
          const results = await testModelsBatch(g.cfg, g.models);
          const seen = new Set(results.map((r) => r.model));
          for (const r of results) {
            setEntryFor(g.cfg, r.model, r.ok
              ? { status: "ok", msg: r.reply ? `OK — ${r.reply}` : "OK" }
              : { status: "fail", msg: r.error || "model test failed" });
          }
          for (const m of g.models.filter((x) => !seen.has(x))) {
            try {
              const r = await testModel(g.cfg, m);
              setEntryFor(g.cfg, m, { status: "ok", msg: r.reply ? `OK — ${r.reply}` : "OK" });
            } catch (err) {
              setEntryFor(g.cfg, m, {
                status: "fail",
                msg: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch {
          let inner = 0;
          const innerWorker = async (): Promise<void> => {
            while (inner < g.models.length) {
              const m = g.models[inner++];
              try {
                const r = await testModel(g.cfg, m);
                setEntryFor(g.cfg, m, { status: "ok", msg: r.reply ? `OK — ${r.reply}` : "OK" });
              } catch (err) {
                setEntryFor(g.cfg, m, {
                  status: "fail",
                  msg: err instanceof Error ? err.message : String(err),
                });
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(pool, g.models.length) }, innerWorker));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, groupPool) }, worker));
  } finally {
    mixedRuns.delete(runKey);
  }
}

function summarizeMixed(
  snap: ReadonlyMap<string, ModelTestEntry>,
  entries: MixedTestEntry[],
): ProviderTestSummary {
  let ok = 0;
  let fail = 0;
  let running = false;
  let firstFail = "";
  entries = entries.filter((e) => isGroupTestable(e.cfg));
  for (const e of entries) {
    const s = snap.get(key(e.cfg, e.model));
    if (!s) continue;
    if (s.status === "testing") running = true;
    else if (s.status === "ok") ok++;
    else if (s.status === "fail") {
      fail++;
      if (!firstFail) firstFail = s.msg;
    }
  }
  return { running, ok, fail, done: ok + fail, total: entries.length, firstFail };
}

function summarize(
  snap: ReadonlyMap<string, ModelTestEntry>,
  cfg: ProviderConfig,
  models: string[],
): ProviderTestSummary {
  let ok = 0;
  let fail = 0;
  let running = false;
  let firstFail = "";
  for (const m of models) {
    const e = snap.get(key(cfg, m));
    if (!e) continue;
    if (e.status === "testing") running = true;
    else if (e.status === "ok") ok++;
    else if (e.status === "fail") {
      fail++;
      if (!firstFail) firstFail = e.msg;
    }
  }
  return { running, ok, fail, done: ok + fail, total: models.length, firstFail };
}

/** هوک دسترسی به استور تست مدل‌ها — دکمهٔ تکی هر مدل و دکمه‌های «تست همه»
 *  (پروایدر و Recent) هر سه از همین هوک می‌خوانند تا همیشه هم‌نما باشند. */
export function useModelTests() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const getStatus = useCallback(
    (cfg: ProviderConfig, model: string): ModelTestEntry => snap.get(key(cfg, model)) ?? IDLE,
    [snap],
  );
  const getSummary = useCallback(
    (cfg: ProviderConfig, models: string[]): ProviderTestSummary => summarize(snap, cfg, models),
    [snap],
  );
  const getMixedSummary = useCallback(
    (entries: MixedTestEntry[]): ProviderTestSummary => summarizeMixed(snap, entries),
    [snap],
  );
  const run = useCallback((cfg: ProviderConfig, model: string): void => {
    void runModelTest(cfg, model);
  }, []);
  const runAll = useCallback((cfg: ProviderConfig, models: string[]): void => {
    void runProviderTests(cfg, models);
  }, []);
  const runMixed = useCallback((entries: MixedTestEntry[], runKey = "recent"): void => {
    void runMixedTests(entries, 10, runKey);
  }, []);
  const dismiss = useCallback((cfg: ProviderConfig, model: string): void => {
    dismissModelTest(cfg, model);
  }, []);
  const clearChecked = useCallback((): void => {
    clearCheckedTests();
  }, []);
  return { getStatus, getSummary, getMixedSummary, run, runAll, runMixed, dismiss, clearChecked };
}
