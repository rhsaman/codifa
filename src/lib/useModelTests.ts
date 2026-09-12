import { useCallback, useSyncExternalStore } from "react";
import type { ProviderConfig } from "../types";
import { testModel } from "./api";

/** وضعیت تست یک مدل: idle → testing → ok / fail (با پیام خطای واقعی). */
export type ModelTestStatus = "idle" | "testing" | "ok" | "fail";

export interface ModelTestEntry {
  status: ModelTestStatus;
  msg: string;
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

/** استور مشترک نتایج تست. چون «تست همهٔ مدل‌های پروایدر» باید بتواند همان
 *  دکمه‌های تکی را همزمان پیش ببرد، وضعیت‌ها مرکزی نگه داشته می‌شوند و
 *  دکمه‌ها با useSyncExternalStore از یک snapshot تغییرناپذیر می‌خوانند. */
let snapshot: ReadonlyMap<string, ModelTestEntry> = new Map();
const EMPTY: ReadonlyMap<string, ModelTestEntry> = snapshot;
const listeners = new Set<() => void>();
const providerRuns = new Set<string>();

function key(cfg: ProviderConfig, model: string): string {
  return `${cfg.id}/${model}`;
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

/** خواندن مستقیم وضعیت یک مدل — بدون هوک (برای تست‌ها و مصرف خارج از React). */
export function getTestEntry(cfg: ProviderConfig, model: string): ModelTestEntry {
  return snapshot.get(key(cfg, model)) ?? IDLE;
}

/** پاک‌کردن همهٔ نتایج ثبت‌شده. */
export function clearModelTests(): void {
  snapshot = EMPTY;
  for (const l of listeners) l();
}

/** تست یک مدل: نتیجه در استور مشترک ثبت می‌شود تا دکمهٔ تکی و جمع‌بندی
 *  پروایدر هر دو از یک منبع بخوانند. اگر همان مدل از قبل در حال تست باشد
 *  دوباره فایر نمی‌شود. */
export async function runModelTest(cfg: ProviderConfig, model: string): Promise<void> {
  const k = key(cfg, model);
  if (snapshot.get(k)?.status === "testing") return;
  setEntry(k, { status: "testing", msg: "" });
  try {
    const r = await testModel(cfg, model);
    setEntry(k, { status: "ok", msg: r.reply ? `OK — ${r.reply}` : "OK" });
  } catch (err) {
    setEntry(k, { status: "fail", msg: err instanceof Error ? err.message : String(err) });
  }
}

/** تست همهٔ مدل‌های یک پروایدر با استخر همزمانی محدود — هر نتیجه به‌محض
 *  رسیدن روی دکمهٔ تکی همان مدل می‌نشیند. اجرای همزمان دوم برای همان
 *  پروایدر نادیده گرفته می‌شود. */
export async function runProviderTests(
  cfg: ProviderConfig,
  models: string[],
  pool = 3,
): Promise<void> {
  if (models.length === 0 || providerRuns.has(cfg.id)) return;
  providerRuns.add(cfg.id);
  try {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < models.length) {
        const m = models[cursor++];
        await runModelTest(cfg, m);
      }
    };
    await Promise.all(Array.from({ length: Math.min(pool, models.length) }, worker));
  } finally {
    providerRuns.delete(cfg.id);
  }
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

/** هوک دسترسی به استور تست مدل‌ها — دکمهٔ تکی هر مدل و دکمهٔ «تست همه»
 *  پروایدر هر دو از همین هوک می‌خوانند تا همیشه هم‌نما باشند. */
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
  const run = useCallback((cfg: ProviderConfig, model: string): void => {
    void runModelTest(cfg, model);
  }, []);
  const runAll = useCallback((cfg: ProviderConfig, models: string[]): void => {
    void runProviderTests(cfg, models);
  }, []);
  return { getStatus, getSummary, run, runAll };
}
