import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../lib/store";
import { clearScheduleRuns, listAllScheduleRuns, listScheduleRuns, listSchedules } from "../lib/api";
import { prepareContent } from "../lib/bidi";
import { mdComponents } from "./ChatMessage";
import { formatNextRunFa, runStatusFa } from "./SchedulePanel";
import type { ScheduleRun, ScheduledTask } from "../types";

/** تعداد اجراهای دیده‌نشده (برای بج نوتیفیکیشن Inbox). */
export function unseenRunCount(runs: ScheduleRun[], seen: string[]): number {
  const seenSet = new Set(seen);
  return runs.filter((r) => !seenSet.has(r.id)).length;
}

/** رندر مارکداون خروجی کرون دقیقاً با همان رندر چت (فونت، جهت، کد، جدول). */
function InboxMarkdown({ text }: { text: string }) {
  const dir = useStore((s) => s.dir);
  const prepared = useMemo(() => prepareContent(text, dir), [text, dir]);
  return (
    <div className="chat-message markdown-body schedule-inbox-markdown" dir="auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

/** کارت یک اجرا در Inbox — چت‌مانند: هدر خنثی + بدنه مارکداون با فونت چت. */
function InboxRunCard({ run }: { run: ScheduleRun }) {
  return (
    <div className={`schedule-inbox-run ${run.status}`}>
      <div className="schedule-inbox-run-head">
        <span className={`schedule-inbox-status ${run.status}`}>{runStatusFa(run.status)}</span>
        <span className="schedule-inbox-time">
          {new Date(run.started_at * 1000).toLocaleString("en-US")}
        </span>
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
    () => schedules.find((t) => t.id === selected) ?? schedules[0] ?? null,
    [schedules, selected],
  );

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
              className="review-header-btn"
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
            {schedules.length === 0 ? (
              <div className="schedule-runs-empty">No scheduled tasks yet</div>
            ) : (
              schedules.map((t) => (
                <button
                  key={t.id}
                  className={`schedule-inbox-item${selectedTask?.id === t.id ? " active" : ""}`}
                  onClick={() => setSelected(t.id)}
                >
                  <span className="schedule-item-name">{t.name}</span>
                  <span className="schedule-item-sub">{formatNextRunFa(t.next_run)}</span>
                </button>
              ))
            )}
          </div>
          <div className="schedule-inbox-chat">
            {!selectedTask ? (
              <div className="schedule-runs-empty">Select a task to see its runs</div>
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
                {!taskRuns ? (
                  <div className="schedule-runs-empty">Loading…</div>
                ) : taskRuns.length === 0 ? (
                  <div className="schedule-runs-empty">No runs yet</div>
                ) : (
                  <div className="schedule-inbox-runs">
                    {taskRuns.map((r) => (
                      <InboxRunCard key={r.id} run={r} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** دکمه Inbox در تایتل‌بار با بج اجرای دیده‌نشده (نوتیفیکیشن کرون). */
export function ScheduleInboxButton() {
  const setOpen = useStore((s) => s.setScheduleInboxOpen);
  const seen = useStore((s) => s.scheduleRunsSeen);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const out = await listAllScheduleRuns(50);
      if (!cancelled && !("error" in out)) setRuns(out);
    };
    void tick();
    const t = setInterval(() => void tick(), 30000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const unseen = unseenRunCount(runs, seen);
  return (
    <button
      className="dir-toggle schedule-inbox-btn"
      title={unseen > 0 ? `${unseen} new schedule runs` : "Schedule inbox"}
      aria-label="Schedule inbox"
      onClick={() => setOpen(true)}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
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
