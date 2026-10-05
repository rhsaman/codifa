import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../lib/store";
import { clearOrphanScheduleRuns, clearScheduleRuns, listAllScheduleRuns, listScheduleRuns, listSchedules } from "../lib/api";
import {
  ensureScheduleNotificationPermission,
  findFinishedScheduleRuns,
  notifyScheduleRun,
  notifyScheduleRunBatch,
} from "../lib/schedule-notify";
import { playAlarm } from "../lib/alarm";
import { prepareContent } from "../lib/bidi";
import { formatTokens } from "../lib/context";
import { mdComponents } from "./ChatMessage";
import { useViewerTabs } from "../lib/viewerTabs";
import { formatNextRunFa, runStatusFa } from "./SchedulePanel";
import type { ScheduleRun, ScheduledTask } from "../types";

/** مجموع توکن یک ران از روی usage ثبت‌شده (input+output)؛ ۰ یعنی بدون مصرف ثبت‌شده. */
export function scheduleRunTokens(run: ScheduleRun): number {
  let total = 0;
  for (const u of run.usage?.entries ?? []) {
    total += (u.input || 0) + (u.output || 0);
  }
  return total;
}

/** تعداد اجراهای دیده‌نشده (برای بج نوتیفیکیشن Inbox). */
export function unseenRunCount(runs: ScheduleRun[], seen: string[]): number {
  const seenSet = new Set(seen);
  return runs.filter((r) => !seenSet.has(r.id)).length;
}

/** تعداد اجراهای دیده‌نشده‌ی یک تسک خاص (برای بج کنار هر تسک در لیست Inbox). */
export function unseenRunCountForTask(
  runs: ScheduleRun[],
  seen: string[],
  scheduleId: string,
): number {
  const seenSet = new Set(seen);
  return runs.filter((r) => r.schedule_id === scheduleId && !seenSet.has(r.id)).length;
}

/** انتخاب تسک نمایشی Inbox: انتخاب ذخیره‌شده اگر هنوز وجود دارد، وگرنه تسکی که
 *  تازه‌ترین ران را دارد (نه لزوماً اولین تسک لیست)، وگرنه اولین تسک. */
export function pickInboxTask(
  schedules: ScheduledTask[],
  runs: ScheduleRun[],
  selected: string | null,
): ScheduledTask | null {
  if (schedules.length === 0) return null;
  if (selected) {
    const kept = schedules.find((t) => t.id === selected);
    if (kept) return kept;
  }
  // تازه‌ترین ران اول است (بک‌اند جدیدترین اول می‌دهد) — تسک آن را انتخاب کن
  // تا بج غیرصفر با پنل «No runs yet» همراه نشود.
  for (const r of runs) {
    const owner = schedules.find((t) => t.id === r.schedule_id);
    if (owner) return owner;
  }
  return schedules[0] ?? null;
}

/** رندر مارکداون خروجی کرون دقیقاً با همان رندر چت (فونت، جهت، کد، جدول). */
function InboxMarkdown({ text }: { text: string }) {
  const dir = useStore((s) => s.dir);
  const prepared = useMemo(() => prepareContent(text, dir), [text, dir]);
  return (
    <div className="chat-message markdown-body schedule-inbox-markdown" dir={dir}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

/** کارت یک اجرا در Inbox — چت‌مانند: هدر خنثی + بدنه مارکداون با فونت چت. */
function InboxRunCard({ run }: { run: ScheduleRun }) {
  const tokens = scheduleRunTokens(run);
  return (
    <div className={`schedule-inbox-run ${run.status}`}>
      <div className="schedule-inbox-run-head">
        <span className={`schedule-inbox-status ${run.status}`}>{runStatusFa(run.status)}</span>
        <span className="schedule-inbox-time">
          {new Date(run.started_at * 1000).toLocaleString("en-US")}
        </span>
        {tokens > 0 && (
          <span className="schedule-inbox-tokens" title={`${tokens} tokens`}>
            {formatTokens(tokens)}
          </span>
        )}
      </div>
      {run.error && <div className="schedule-run-error">{run.error}</div>}
      {run.output ? (
        <InboxMarkdown text={run.output.slice(0, 8000)} />
      ) : (
        !run.error && <div className="schedule-runs-empty">No output</div>
      )}
    </div>
  );
}

/** Inbox کرون‌ها: لیست تسک‌ها + چت (تاریخچه اجراها) هر کرون + بج اجرای جدید. */
export function ScheduleInbox() {
  const open = useStore((s) => s.scheduleInboxOpen);
  const setOpen = useStore((s) => s.setScheduleInboxOpen);
  const schedules = useStore((s) => s.schedules);
  const setSchedules = useStore((s) => s.setSchedules);
  const selected = useStore((s) => s.scheduleInboxSelected);
  const setSelected = useStore((s) => s.setScheduleInboxSelected);
  const seen = useStore((s) => s.scheduleRunsSeen);
  const markSeen = useStore((s) => s.markScheduleRunsSeen);
  const dir = useStore((s) => s.dir);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [taskRuns, setTaskRuns] = useState<ScheduleRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [orphanOpen, setOrphanOpen] = useState(false);
  const [clearingOrphans, setClearingOrphans] = useState(false);
  const [confirmClearOrphans, setConfirmClearOrphans] = useState(false);
  const [orphanError, setOrphanError] = useState<string | null>(null);

  // عرض پنل — با درگ لبهٔ چپ (مثل پنل گیت‌دیف) + ذخیرهٔ محلی.
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return 720;
    const vw =
      typeof window.innerWidth === "number" && Number.isFinite(window.innerWidth)
        ? window.innerWidth
        : 1280;
    let saved = NaN;
    try {
      saved = parseInt(localStorage.getItem("coder:scheduleInboxWidth") ?? "", 10);
    } catch {
      saved = NaN;
    }
    const fallback = Math.round(vw * 0.55);
    return Math.max(360, Math.min(vw - 24, Number.isFinite(saved) ? saved : fallback));
  });
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      dragCleanup.current?.();
      dragCleanup.current = null;
    };
  }, []);
  useEffect(() => {
    const onResize = () => {
      setWidth((w) => Math.max(360, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(
        360,
        Math.min(window.innerWidth - 24, startW - (ev.clientX - startX)),
      );
      setWidth(w);
      try {
        localStorage.setItem("coder:scheduleInboxWidth", String(w));
      } catch {
        /* حافظه در دسترس نیست — عرض فقط حفظ نمی‌شود */
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragCleanup.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    dragCleanup.current = onUp;
  };

  const selectedTask: ScheduledTask | null = useMemo(
    () => pickInboxTask(schedules, runs, selected),
    [schedules, runs, selected],
  );

  // ران‌های یتیم (تسک حذف‌شده ولی تاریخچه نگه‌داشته‌شده): در لیست چپ تسکی
  // ندارند ولی در بج شمرده می‌شوند — آن‌ها را جداگانه نگه می‌داریم تا پنل راست
  // به‌جای خالی، همین‌ها را نشان دهد.
  const orphanRuns = useMemo(
    () => runs.filter((r) => !schedules.some((t) => t.id === r.schedule_id)),
    [runs, schedules],
  );

  // ترتیب لیست چپ: تسک‌های با ران تازه‌تر بالا (بج‌دارها گم نمی‌شوند).
  const orderedSchedules = useMemo(() => {
    const latest = new Map<string, number>();
    for (const r of runs) {
      const t = typeof r.started_at === "number" ? r.started_at : 0;
      if (!latest.has(r.schedule_id) || (latest.get(r.schedule_id) ?? 0) < t) {
        latest.set(r.schedule_id, t);
      }
    }
    return [...schedules].sort(
      (a, b) => (latest.get(b.id) ?? -1) - (latest.get(a.id) ?? -1),
    );
  }, [schedules, runs]);

  const refresh = useCallback(async () => {
    const out = await listSchedules();
    if (!("error" in out)) {
      // بدون تغییر واقعی state را عوض نکن — وگرنه هر پولینگ هویت
      // selectedTask عوض می‌شود و چت مدام به حالت Loading برمی‌گردد.
      const prev = useStore.getState().schedules;
      if (JSON.stringify(prev) !== JSON.stringify(out)) setSchedules(out);
    }
    const all = await listAllScheduleRuns(50);
    if (!("error" in all)) {
      setRuns((prev) => (JSON.stringify(prev) === JSON.stringify(all) ? prev : all));
    }
  }, [setSchedules]);

  const selectedTaskId = selectedTask?.id ?? null;

  const refreshTaskRuns = useCallback(async () => {
    if (!selectedTaskId) return;
    const one = await listScheduleRuns(selectedTaskId, 20);
    if (!("error" in one)) setTaskRuns(one);
  }, [selectedTaskId]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // پولینگ سبک هنگام باز بودن Inbox تا اجرای جدید (نوتیفیکیشن) دیده شود.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => void refresh(), 15000);
    return () => clearInterval(t);
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !selectedTask) {
      setTaskRuns(null);
      return;
    }
    // تسک عوض شد → تأییدیه Clear تسک قبلی را دور بریز.
    setConfirmClear(false);
    setClearError(null);
    setTaskRuns(null);
    void (async () => {
      const out = await listScheduleRuns(selectedTask.id, 20);
      if (!("error" in out)) {
        setTaskRuns(out);
        markSeen(out.map((r) => r.id));
      }
    })();
  }, [open, selectedTask, markSeen]);

  // باز شدن Inbox همه اجراهای فعلی را «دیده» می‌کند تا بج صفر شود.
  useEffect(() => {
    if (open && runs.length > 0) markSeen(runs.map((r) => r.id));
  }, [open, runs, markSeen]);

  // ران‌های نمایشی تسک انتخاب‌شده: اجتماع پاسخ مستقیم تسک و کش سراسری runs
  // (حذف تکراری با id، جدیدترین اول) تا با بج ناسازگار نشود — هر کدام تازه‌تر
  // باشد همان دیده می‌شود و نژاد پولینگ «بج دارد ولی پنل خالی است» می‌رود.
  const displayedRuns: ScheduleRun[] | null = useMemo(() => {
    if (!selectedTask) return taskRuns;
    const fromAll = runs.filter((r) => r.schedule_id === selectedTask.id);
    if (!taskRuns) return fromAll.length > 0 ? fromAll : null;
    const merged = new Map<string, ScheduleRun>();
    for (const r of [...taskRuns, ...fromAll]) merged.set(r.id, r);
    return [...merged.values()].sort(
      (a, b) => (b.started_at || 0) - (a.started_at || 0),
    );
  }, [taskRuns, runs, selectedTask]);

  // تسکی که تازه‌ترین ران دیده‌نشده را دارد — برای دکمه پرش وقتی پنل راست خالی است.
  const newestUnseenTaskId = useMemo(() => {
    const seenSet = new Set(seen);
    for (const r of runs) {
      if (!seenSet.has(r.id) && schedules.some((t) => t.id === r.schedule_id)) {
        return r.schedule_id;
      }
    }
    return null;
  }, [runs, seen, schedules]);

  if (!open) return null;
  const unseen = unseenRunCount(runs, seen);

  return (
    <div className="schedule-inbox-overlay" dir={dir}>
      <div className="schedule-inbox-backdrop" onClick={() => setOpen(false)} />
      <div
        className="schedule-inbox"
        role="dialog"
        aria-label="Schedule inbox"
        style={{ width: `${width}px` } as React.CSSProperties}
      >
        <div
          className="schedule-inbox-resize-handle"
          title="Drag to resize"
          onMouseDown={startResize}
        />
        <div className="schedule-inbox-head" dir="ltr">
          {unseen > 0 && <span className="schedule-inbox-badge">{unseen} new</span>}
          <span className="schedule-inbox-head-spacer" />
          <span className="review-header-actions">
            <button
              className="review-header-btn"
              title="Refresh"
              aria-label="Refresh"
              onClick={() => {
                setLoading(true);
                void Promise.all([refresh(), refreshTaskRuns()]).finally(() => setLoading(false));
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
            </button>
            <button
              className="review-header-btn schedule-inbox-close"
              title="Close inbox"
              aria-label="Close inbox"
              onClick={() => setOpen(false)}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </span>
        </div>
        <div className="schedule-inbox-body">
          <div className="schedule-inbox-list">
            {orderedSchedules.length === 0 ? (
              <div className="schedule-runs-empty">No scheduled tasks yet</div>
            ) : (
              orderedSchedules.map((t) => {
                const taskUnseen = unseenRunCountForTask(runs, seen, t.id);
                return (
                  <button
                    key={t.id}
                    className={`schedule-inbox-item${selectedTask?.id === t.id ? " active" : ""}`}
                    onClick={() => setSelected(t.id)}
                  >
                    <span className="schedule-item-name">{t.name}</span>
                    {taskUnseen > 0 && (
                      <span className="schedule-inbox-badge">{taskUnseen}</span>
                    )}
                    <span className="schedule-item-sub">{formatNextRunFa(t.next_run)}</span>
                  </button>
                );
              })
            )}
            {orphanRuns.length > 0 && (
              <div className="schedule-inbox-orphan-toggle">
                <button
                  className="schedule-btn"
                  title="Show runs from deleted tasks"
                  aria-label="Show runs from deleted tasks"
                  aria-expanded={orphanOpen}
                  onClick={() => setOrphanOpen((v) => !v)}
                >
                  {orphanOpen ? "Hide" : "Show"} {orphanRuns.length} run{orphanRuns.length > 1 ? "s" : ""} from deleted task{orphanRuns.length > 1 ? "s" : ""}
                </button>
              </div>
            )}
          </div>
          <div className="schedule-inbox-chat">
            {!selectedTask ? (
              orphanRuns.length > 0 ? (
                <div className="schedule-inbox-runs">
                  <div className="schedule-inbox-chat-head">
                    <span className="schedule-inbox-prompt-label">Runs from deleted tasks</span>
                    <span className="schedule-inbox-head-spacer" />
                    {!confirmClearOrphans ? (
                      <button
                        className="schedule-btn danger"
                        title="Delete runs from deleted tasks"
                        aria-label="Delete runs from deleted tasks"
                        disabled={clearingOrphans}
                        onClick={() => {
                          setOrphanError(null);
                          setConfirmClearOrphans(true);
                        }}
                      >
                        Clear
                      </button>
                    ) : (
                      <span className="schedule-clear-confirm">
                        <span className="schedule-clear-text">Delete all?</span>
                        <button
                          className="schedule-btn danger"
                          title="Confirm delete"
                          aria-label="Confirm delete"
                          disabled={clearingOrphans}
                          onClick={() => {
                            setClearingOrphans(true);
                            setOrphanError(null);
                            void clearOrphanScheduleRuns()
                              .then((out) => {
                                if ("error" in out) {
                                  setOrphanError(out.error);
                                  return;
                                }
                                setRuns((prev) =>
                                  prev.filter((r) => schedules.some((t) => t.id === r.schedule_id)),
                                );
                                setConfirmClearOrphans(false);
                                setOrphanOpen(false);
                                void refresh();
                              })
                              .catch((err: unknown) => {
                                setOrphanError(err instanceof Error ? err.message : String(err));
                              })
                              .finally(() => setClearingOrphans(false));
                          }}
                        >
                          {clearingOrphans ? "Clearing…" : "Yes"}
                        </button>
                        <button
                          className="schedule-btn"
                          title="Cancel"
                          aria-label="Cancel"
                          disabled={clearingOrphans}
                          onClick={() => {
                            setConfirmClearOrphans(false);
                            setOrphanError(null);
                          }}
                        >
                          No
                        </button>
                      </span>
                    )}
                  </div>
                  {orphanError && <div className="schedule-error">{orphanError}</div>}
                  {orphanRuns.slice(0, 20).map((r) => (
                    <InboxRunCard key={r.id} run={r} />
                  ))}
                </div>
              ) : (
                <div className="schedule-runs-empty">Select a task to see its runs</div>
              )
            ) : (
              <>
                <div className="schedule-inbox-chat-head">
                  <strong>{selectedTask.name}</strong>
                  <span className="schedule-item-cron">
                    {selectedTask.cron_label || selectedTask.cron || "Once"}
                  </span>
                  <span className="schedule-inbox-head-spacer" />
                  {!confirmClear ? (
                    <button
                      className="schedule-btn danger"
                      title="Clear this task's inbox"
                      aria-label="Clear this task's inbox"
                      disabled={clearing || !taskRuns || taskRuns.length === 0}
                      onClick={() => {
                        setClearError(null);
                        setConfirmClear(true);
                      }}
                    >
                      Clear
                    </button>
                  ) : (
                    <span className="schedule-clear-confirm">
                      <span className="schedule-clear-text">Clear inbox?</span>
                      <button
                        className="schedule-btn danger"
                        title="Confirm clear"
                        aria-label="Confirm clear"
                        disabled={clearing}
                        onClick={() => {
                          if (!selectedTask) return;
                          setClearing(true);
                          setClearError(null);
                          void clearScheduleRuns(selectedTask.id)
                            .then((out) => {
                              if ("error" in out) {
                                setClearError(out.error);
                                return;
                              }
                              setTaskRuns([]);
                              // کش سراسری را هم همان‌جا خالی کن تا اجتماع displayedRuns
                              // ران‌های پاک‌شده را تا پولینگ بعدی زنده نکند.
                              setRuns((prev) =>
                                prev.filter((r) => r.schedule_id !== selectedTask.id),
                              );
                              setConfirmClear(false);
                              void refresh();
                            })
                            .catch((err: unknown) => {
                              setClearError(err instanceof Error ? err.message : String(err));
                            })
                            .finally(() => setClearing(false));
                        }}
                      >
                        {clearing ? "Clearing…" : "Yes"}
                      </button>
                      <button
                        className="schedule-btn"
                        title="Cancel"
                        aria-label="Cancel"
                        disabled={clearing}
                        onClick={() => {
                          setConfirmClear(false);
                          setClearError(null);
                        }}
                      >
                        No
                      </button>
                    </span>
                  )}
                </div>
                {clearError && <div className="schedule-error">{clearError}</div>}
                <div className="schedule-inbox-prompt">
                  <div className="schedule-inbox-prompt-label">Task</div>
                  <InboxMarkdown text={selectedTask.prompt} />
                </div>
                {loading && <div className="schedule-runs-empty">Loading…</div>}
                {!displayedRuns ? (
                  <div className="schedule-runs-empty">Loading…</div>
                ) : displayedRuns.length === 0 ? (
                  <>
                    <div className="schedule-runs-empty">No runs yet</div>
                    {newestUnseenTaskId && newestUnseenTaskId !== selectedTask.id && (
                      <button
                        className="schedule-btn"
                        onClick={() => setSelected(newestUnseenTaskId)}
                      >
                        Show latest run
                      </button>
                    )}
                    {orphanRuns.length > 0 && (
                      <div className="schedule-inbox-orphan-section">
                        <div className="schedule-inbox-orphan-head">
                          <button
                            className="schedule-btn"
                            title="Show runs from deleted tasks"
                            aria-label="Show runs from deleted tasks"
                            aria-expanded={orphanOpen}
                            onClick={() => setOrphanOpen((v) => !v)}
                          >
                            {orphanOpen ? "Hide" : "Show"} {orphanRuns.length} run{orphanRuns.length > 1 ? "s" : ""} from deleted task{orphanRuns.length > 1 ? "s" : ""}
                          </button>
                          <span className="schedule-inbox-head-spacer" />
                          <button
                            className="review-header-btn"
                            title="Refresh deleted runs"
                            aria-label="Refresh deleted runs"
                            onClick={() => {
                              setLoading(true);
                              void refresh().finally(() => setLoading(false));
                            }}
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
                          </button>
                          {!confirmClearOrphans ? (
                            <button
                              className="schedule-btn danger"
                              title="Delete runs from deleted tasks"
                              aria-label="Delete runs from deleted tasks"
                              disabled={clearingOrphans}
                              onClick={() => {
                                setOrphanError(null);
                                setConfirmClearOrphans(true);
                              }}
                            >
                              Clear
                            </button>
                          ) : (
                            <span className="schedule-clear-confirm">
                              <span className="schedule-clear-text">Delete all?</span>
                              <button
                                className="schedule-btn danger"
                                title="Confirm delete"
                                aria-label="Confirm delete"
                                disabled={clearingOrphans}
                                onClick={() => {
                                  setClearingOrphans(true);
                                  setOrphanError(null);
                                  void clearOrphanScheduleRuns()
                                    .then((out) => {
                                      if ("error" in out) {
                                        setOrphanError(out.error);
                                        return;
                                      }
                                      setRuns((prev) =>
                                        prev.filter((r) => schedules.some((t) => t.id === r.schedule_id)),
                                      );
                                      setConfirmClearOrphans(false);
                                      setOrphanOpen(false);
                                      void refresh();
                                    })
                                    .catch((err: unknown) => {
                                      setOrphanError(err instanceof Error ? err.message : String(err));
                                    })
                                    .finally(() => setClearingOrphans(false));
                                }}
                              >
                                {clearingOrphans ? "Clearing…" : "Yes"}
                              </button>
                              <button
                                className="schedule-btn"
                                title="Cancel"
                                aria-label="Cancel"
                                disabled={clearingOrphans}
                                onClick={() => {
                                  setConfirmClearOrphans(false);
                                  setOrphanError(null);
                                }}
                              >
                                No
                              </button>
                            </span>
                          )}
                        </div>
                        {orphanError && <div className="schedule-error">{orphanError}</div>}
                        {orphanOpen && (
                          <div className="schedule-inbox-runs">
                            {orphanRuns.slice(0, 20).map((r) => (
                              <InboxRunCard key={r.id} run={r} />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="schedule-inbox-runs">
                      {displayedRuns.map((r) => (
                        <InboxRunCard key={r.id} run={r} />
                      ))}
                    </div>
                    {orphanRuns.length > 0 && (
                      <div className="schedule-inbox-orphan-section">
                        <div className="schedule-inbox-orphan-head">
                          <button
                            className="schedule-btn"
                            title="Show runs from deleted tasks"
                            aria-label="Show runs from deleted tasks"
                            aria-expanded={orphanOpen}
                            onClick={() => setOrphanOpen((v) => !v)}
                          >
                            {orphanOpen ? "Hide" : "Show"} {orphanRuns.length} run{orphanRuns.length > 1 ? "s" : ""} from deleted task{orphanRuns.length > 1 ? "s" : ""}
                          </button>
                          <span className="schedule-inbox-head-spacer" />
                          {!confirmClearOrphans ? (
                            <button
                              className="schedule-btn danger"
                              title="Delete runs from deleted tasks"
                              aria-label="Delete runs from deleted tasks"
                              disabled={clearingOrphans}
                              onClick={() => {
                                setOrphanError(null);
                                setConfirmClearOrphans(true);
                              }}
                            >
                              Clear
                            </button>
                          ) : (
                            <span className="schedule-clear-confirm">
                              <span className="schedule-clear-text">Delete all?</span>
                              <button
                                className="schedule-btn danger"
                                title="Confirm delete"
                                aria-label="Confirm delete"
                                disabled={clearingOrphans}
                                onClick={() => {
                                  setClearingOrphans(true);
                                  setOrphanError(null);
                                  void clearOrphanScheduleRuns()
                                    .then((out) => {
                                      if ("error" in out) {
                                        setOrphanError(out.error);
                                        return;
                                      }
                                      setRuns((prev) =>
                                        prev.filter((r) => schedules.some((t) => t.id === r.schedule_id)),
                                      );
                                      setConfirmClearOrphans(false);
                                      setOrphanOpen(false);
                                      void refresh();
                                    })
                                    .catch((err: unknown) => {
                                      setOrphanError(err instanceof Error ? err.message : String(err));
                                    })
                                    .finally(() => setClearingOrphans(false));
                                }}
                              >
                                {clearingOrphans ? "Clearing…" : "Yes"}
                              </button>
                              <button
                                className="schedule-btn"
                                title="Cancel"
                                aria-label="Cancel"
                                disabled={clearingOrphans}
                                onClick={() => {
                                  setConfirmClearOrphans(false);
                                  setOrphanError(null);
                                }}
                              >
                                No
                              </button>
                            </span>
                          )}
                        </div>
                        {orphanError && <div className="schedule-error">{orphanError}</div>}
                        {orphanOpen && (
                          <div className="schedule-inbox-runs">
                            {orphanRuns.slice(0, 20).map((r) => (
                              <InboxRunCard key={r.id} run={r} />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** دکمه Inbox در تایتل‌بار با بج اجرای دیده‌نشده (نوتیفیکیشن کرون).
 * ران‌هایی که به وضعیت پایانی رسیده‌اند (از running به done/error، یا ران‌هایی
 * که بین دو پولینگ تمام شده‌اند) اعلان سیستم‌عامل و آلارم صوتی می‌دهند تا حتی
 * وقتی Inbox باز نیست، کاربر خبردار شود؛ رانِ در حال اجرا هرگز اعلان نمی‌دهد. */
export function ScheduleInboxButton() {
  const seen = useStore((s) => s.scheduleRunsSeen);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const prevStatusesRef = useRef<Map<string, ScheduleRun["status"]> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const out = await listAllScheduleRuns(50);
      if (cancelled || "error" in out) return;
      setRuns(out);
      // اعلان OS + آلارم فقط برای ران‌هایی که از پولینگ قبلی به وضعیت پایانی
      // رسیده‌اند (بدون تکرار): اولین پولینگ فقط baseline می‌سازد و رانِ
      // running هرگز اعلان نمی‌دهد — فقط پایان کار اعلان دارد.
      const prev = prevStatusesRef.current;
      if (prev !== null) {
        const finished = findFinishedScheduleRuns(prev, out);
        for (const r of finished) {
          playAlarm(r.status === "error" ? "error" : "alert");
        }
        if (finished.length > 0) {
          const openInbox = () => {
            void import("../lib/viewerTabs").then(({ useViewerTabs }) => {
              useViewerTabs.getState().openInbox();
            });
            useStore.getState().setScheduleInboxOpen(true);
          };
          if (await ensureScheduleNotificationPermission()) {
            if (finished.length === 1) {
              const r = finished[0];
              const name = useStore
                .getState()
                .schedules.find((t) => t.id === r.schedule_id)?.name;
              notifyScheduleRun(r, name, openInbox);
            } else {
              notifyScheduleRunBatch(finished.length, openInbox);
            }
          }
        }
      }
      prevStatusesRef.current = new Map(out.map((r) => [r.id, r.status]));
    };
    void tick();
    const t = setInterval(() => void tick(), 30000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const unseen = unseenRunCount(runs, seen);
  const hasTab = useViewerTabs((s) => s.tabs.some((t) => t.kind === 'inbox'));
  return (
    <button
      className="titlebar-icon-btn schedule-inbox-btn"
      title={unseen > 0 ? `${unseen} new schedule runs` : "Schedule inbox"}
      aria-label="Schedule inbox"
      aria-pressed={hasTab}
      onClick={() => {
        const vt = useViewerTabs.getState();
        const existing = vt.tabs.find((t) => t.kind === 'inbox');
        if (existing) {
          vt.closeViewer(existing.id);
          useStore.getState().setScheduleInboxOpen(false);
        } else {
          vt.openInbox();
          useStore.getState().setScheduleInboxOpen(true);
        }
      }}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
      {unseen > 0 && <span className="schedule-inbox-badge">{unseen}</span>}
    </button>
  );
}

/** Docked inbox for the right editor group: forces the inbox store open while
 *  mounted and renders the same overlay content inside a static dock wrapper
 *  (CSS makes the overlay static). Closing the inner X closes the viewer tab. */
export function ScheduleInboxDocked({ onClose }: { onClose: () => void }) {
  const open = useStore((s) => s.scheduleInboxOpen);
  const setOpen = useStore((s) => s.setScheduleInboxOpen);
  // Close the tab only on a true→false transition AFTER mounting: the first
  // effect run adopts whatever the flag was when the tab opened (openInbox
  // pre-sets it true), otherwise an unguarded `if (!open) onClose()` here
  // closed the tab in the same tick it opened and dumped the user on the
  // previously active tab (e.g. the git diff).
  const prevOpenRef = useRef<boolean | null>(null);
  useEffect(() => {
    setOpen(true);
  }, [setOpen]);
  useEffect(() => {
    if (prevOpenRef.current === null) {
      prevOpenRef.current = open;
      return;
    }
    if (prevOpenRef.current && !open) onClose();
    prevOpenRef.current = open;
  }, [open, onClose]);
  return (
    <div className="viewer-inbox-wrap">
      <ScheduleInbox />
    </div>
  );
}
