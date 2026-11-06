import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { APP_DIR, useStore } from "../lib/store";
import { clearOrphanScheduleRuns, clearScheduleRuns, listAllScheduleRuns, listScheduleRuns, listSchedules } from "../lib/api";
import { finishedRunIds, unseenRunCount, unseenRunCountForTask } from "../lib/schedule-notify";
import { formatTokens } from "../lib/context";
import { useVimScroll } from "../lib/useVimScroll";
import { applyScroll, scrollDelta } from "../lib/scrollKeys";
import { physicalKey } from "../lib/shortcuts";
import { isPrefixArmed } from "../lib/prefixState";
import { isEditableTarget, markVimRegion, snapshotIntent } from "../lib/panePointer";
import { focusChatInput } from "../lib/chatFocus";
import { ChatBubble } from "./ChatBubble";
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

// The unseen-run counters live in lib/schedule-notify (pure, light) so the dock's
// Inbox badge can use them without loading this chunk; re-exported here.
export { unseenRunCount, unseenRunCountForTask };

/** اندازه‌ی هر صفحه از تاریخچه‌ی اجراها — infinite scroll همین را صف‌به‌صف
 *  می‌کشد تا هرگز کل تاریخچه در رم لود نشود. */
const RUNS_PAGE = 20;
/** سقف ران‌های لودشده برای یک تسک: بعد از این اندازه، صفحات قدیمی دور ریخته
 *  می‌شوند (hasMore دوباره true می‌شود) تا اسکرول طولانی هم رم را نفروشد. */
const MAX_LOADED_RUNS = 200;

/** انتخاب تسک نمایشی Inbox (سازگار با تست‌ها): انتخاب ذخیره‌شده اگر هنوز وجود
 *  دارد، وگرنه تسکی که تازه‌ترین ران را دارد. در UI گرید دیگر auto-pick نمی‌کنیم —
 *  گرید همه‌ی تسک‌ها را نشان می‌دهد و کلیک کاربر به صفحه‌ی همان تسک می‌رود. */
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
  for (const r of runs) {
    const owner = schedules.find((t) => t.id === r.schedule_id);
    if (owner) return owner;
  }
  return schedules[0] ?? null;
}

/** ادغام دو لیست ران بدون تکرار (با id) و مرتب قطعی: جدیدترین اول. */
function mergeRunsDesc(a: ScheduleRun[], b: ScheduleRun[]): ScheduleRun[] {
  const m = new Map<string, ScheduleRun>();
  for (const r of [...a, ...b]) m.set(r.id, r);
  return [...m.values()].sort((x, y) => (y.started_at || 0) - (x.started_at || 0));
}

/** ترتیب کارت‌های گرید اینباکس — بر اساس جدیدترین پیام: تسکی که تازه‌ترین ران
 *  را دارد بالاست؛ تسک‌های بدون ران آخر می‌مانند (میان خودشان: created_at
 *  نزولی تا ترتیب قطعی باشد). */
export function sortGridByLatestRun(
  schedules: ScheduledTask[],
  latestRun: Map<string, ScheduleRun>,
): ScheduledTask[] {
  const at = (t: ScheduledTask): number => latestRun.get(t.id)?.started_at ?? 0;
  return [...schedules].sort((a, b) => {
    const ta = at(a);
    const tb = at(b);
    if (ta > 0 !== (tb > 0)) return ta > 0 ? -1 : 1;
    if (ta > 0 && ta !== tb) return tb - ta;
    return (b.created_at ?? 0) - (a.created_at ?? 0);
  });
}

/** پیش‌نمایش کوتاه پرامپت: متن کامل هرگز به DOM نمی‌رود — یک خط nowrap با
 *  چند KB متن bidi مخلوط، هر reflow (مثلاً درگ عرض) را به سنگین‌ترین عملیات
 *  صفحه تبدیل می‌کند. محدود به ۲۴۰ کاراکتر + علامت ادامه. */
export function promptPreview(prompt: string, max = 240): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** اتصال کلیدهای vim به اینباکس — کامپوننت جدا تا هوک دقیقاً همزمان با mount
 *  شدن محتوا نصب شود. */
function InboxVimScroll({
  inboxRef,
  pageRef,
}: {
  inboxRef: React.RefObject<HTMLDivElement | null>;
  pageRef: React.RefObject<HTMLDivElement | null>;
}) {
  useVimScroll(pageRef, inboxRef);

  // Override مخصوص اینباکس برای caret کهنهٔ WebKit: j/k مال اسکرول صفحهٔ
  // اینباکس‌اند وقتی جدیدترین تعامل کاربر کلیک داخل اینباکس بوده.
  useEffect(() => {
    const dlg = inboxRef.current;
    const page = pageRef.current;
    if (!dlg || !page) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isPrefixArmed()) return;
      const delta = scrollDelta(physicalKey(e), e.shiftKey);
      if (!delta) return;
      const target = e.target as Node | null;
      if (isEditableTarget(target) && dlg.contains(target)) return;
      const st = snapshotIntent();
      if (st.region !== dlg || st.regionAt < st.typingAt) return;
      e.preventDefault();
      e.stopPropagation();
      applyScroll(page, delta, !e.repeat);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return null;
}

/** کارت یک اجرا در صفحهٔ جزئیات — چت‌مانند: هدر خنثی + بدنه مارکداون با فونت چت. */
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
      {run.status === "running" ? (
        <div className="schedule-run-live">
          <span className="schedule-run-spinner" aria-hidden="true" />
          Running…
        </div>
      ) : run.output ? (
        <ChatBubble
          id={run.id}
          content={run.output.slice(0, 8000)}
          className="schedule-inbox-bubble"
        />
      ) : (
        !run.error && <div className="schedule-runs-empty">No output</div>
      )}
    </div>
  );
}

/** کارت گرید یک تسک: نام، کرون، اجرای بعدی و در پاورقی تعداد پیام‌های جدید
 *  (به‌جای pill وضعیت Done) + اسپینر ران زنده + Failed برای خطای خوانده‌شده. */
function GridCard({
  task,
  unseen,
  lastRun,
  onClick,
}: {
  task: ScheduledTask;
  unseen: number;
  lastRun: ScheduleRun | null;
  onClick: () => void;
}) {
  const tokens = lastRun ? scheduleRunTokens(lastRun) : 0;
  return (
    <button
      type="button"
      className="schedule-grid-card"
      onClick={onClick}
      title={`${task.name} — open its runs`}
    >
      <span className="schedule-grid-card-top">
        <span className="schedule-grid-card-name">{task.name}</span>
      </span>
      {!task.enabled && <span className="schedule-grid-paused">Paused</span>}
      <span className="schedule-grid-card-meta">
        {task.cron_label || task.cron || "Once"}
      </span>
      <span className="schedule-grid-card-meta">
        {task.next_run ? `Next: ${formatNextRunFa(task.next_run)}` : "No next run"}
      </span>
      <span className="schedule-grid-card-foot">
        {typeof task.run_count === "number" && task.run_count > 0 ? (
          <span className="schedule-grid-count">{task.run_count} runs</span>
        ) : (
          <span className="schedule-grid-count">No runs yet</span>
        )}
        {unseen > 0 && (
          <span
            className="schedule-grid-status new"
            title={`${unseen} new message${unseen === 1 ? "" : "s"}`}
          >
            {unseen} new
          </span>
        )}
        {lastRun && lastRun.status === "running" && (
          <span className="schedule-grid-status running">
            <span className="schedule-run-spinner" aria-hidden="true" /> running
          </span>
        )}
        {unseen === 0 && lastRun && lastRun.status === "error" && (
          <span className="schedule-grid-status error">{runStatusFa(lastRun.status)}</span>
        )}
        {tokens > 0 && (
          <span className="schedule-grid-count" title={`${tokens} tokens`}>
            {formatTokens(tokens)}
          </span>
        )}
      </span>
    </button>
  );
}

/** Inbox کرون‌ها — دو صفحه:
 *  • GRID: کارت هر تسک (+ کارت اجراهای حذف‌شده‌ها) مرتب بر اساس جدیدترین پیام
 *    (آخرین ران هر کارت، نزولی — sortGridByLatestRun)؛ کلیک → صفحهٔ همان تسک.
 *  • DETAIL: پیام‌های یک تسک (یا اجراهای حذف‌شده‌ها) با تاریخچهٔ صفحه‌بندی‌شده.
 *  قواعد: پیام‌ها فقط مالِ تسک انتخاب‌شده‌اند؛ Clear در هدر نمای فعال را پاک
 *  می‌کند؛ تاریخچه با کرسر صفحه‌بندی می‌شود تا رم bounded بماند.
 */
export function ScheduleInbox() {
  const open = useStore((s) => s.scheduleInboxOpen);
  const setOpen = useStore((s) => s.setScheduleInboxOpen);
  const schedules = useStore((s) => s.schedules);
  const setSchedules = useStore((s) => s.setSchedules);
  const selected = useStore((s) => s.scheduleInboxSelected);
  const setSelected = useStore((s) => s.setScheduleInboxSelected);
  const seen = useStore((s) => s.scheduleRunsSeen);
  const markSeen = useStore((s) => s.markScheduleRunsSeen);
  const dir = APP_DIR;
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [taskRuns, setTaskRuns] = useState<ScheduleRun[] | null>(null);
  const [taskHasMore, setTaskHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [orphanView, setOrphanView] = useState(false);
  const [clearingOrphans, setClearingOrphans] = useState(false);
  const [orphanError, setOrphanError] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);

  const inboxRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = inboxRef.current;
    if (!el) return;
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
    markVimRegion(el);
    return () => {
      const a = document.activeElement;
      if (a && a !== document.body) return;
      const id = useStore.getState().activeChatId;
      if (id) requestAnimationFrame(() => focusChatInput(id));
    };
  }, [open]);

  // عرض پنل — درگ مستقیم روی DOM (بدون re-render) و commit یک‌باره در پایان.
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
    const el = inboxRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startW = el.offsetWidth;
    el.style.width = `${startW}px`;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let last = startW;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(
        360,
        Math.min(window.innerWidth - 24, startW - (ev.clientX - startX)),
      );
      last = w;
      el.style.width = `${w}px`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragCleanup.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem("coder:scheduleInboxWidth", String(last));
      } catch {
        /* حافظه در دسترس نیست */
      }
      setWidth(last);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    dragCleanup.current = onUp;
  };

  const selectedTask: ScheduledTask | null = useMemo(() => {
    if (orphanView || !selected) return null;
    return schedules.find((t) => t.id === selected) ?? null;
  }, [orphanView, schedules, selected]);

  const orphanRuns = useMemo(
    () => runs.filter((r) => !schedules.some((t) => t.id === r.schedule_id)),
    [runs, schedules],
  );

  // آخرین ران هر تسک — برای pill وضعیت روی کارت گرید.
  const latestRunByTask = useMemo(() => {
    const map = new Map<string, ScheduleRun>();
    for (const r of runs) {
      if (!map.has(r.schedule_id)) map.set(r.schedule_id, r);
    }
    return map;
  }, [runs]);

  const refresh = useCallback(async () => {
    const out = await listSchedules();
    if (!("error" in out)) {
      const prev = useStore.getState().schedules;
      if (JSON.stringify(prev) !== JSON.stringify(out)) setSchedules(out);
    }
    const all = await listAllScheduleRuns(50);
    if (!("error" in all)) {
      setRuns((prev) => (JSON.stringify(prev) === JSON.stringify(all) ? prev : all));
    }
  }, [setSchedules]);

  const selectedTaskId = selectedTask?.id ?? null;

  const loadTaskRuns = useCallback(
    async (taskId: string) => {
      const one = await listScheduleRuns(taskId, RUNS_PAGE);
      if ("error" in one) return;
      setTaskRuns(one);
      setTaskHasMore(one.length >= RUNS_PAGE);
      markSeen(finishedRunIds(one));
    },
    [markSeen],
  );

  const loadOlderRuns = useCallback(async () => {
    if (!selectedTaskId || !taskRuns || taskRuns.length === 0) return;
    const oldest = taskRuns[taskRuns.length - 1].started_at || 0;
    if (oldest <= 0) return;
    setLoadingMore(true);
    try {
      const older = await listScheduleRuns(selectedTaskId, RUNS_PAGE, oldest - 0.001);
      if ("error" in older) return;
      const merged = mergeRunsDesc(taskRuns, older);
      const capped = merged.length > MAX_LOADED_RUNS ? merged.slice(0, MAX_LOADED_RUNS) : merged;
      setTaskRuns(capped);
      setTaskHasMore(older.length >= RUNS_PAGE || merged.length > MAX_LOADED_RUNS);
    } finally {
      setLoadingMore(false);
    }
  }, [selectedTaskId, taskRuns]);

  const refreshTaskRuns = useCallback(async () => {
    if (!selectedTaskId) return;
    const one = await listScheduleRuns(selectedTaskId, RUNS_PAGE);
    if ("error" in one) return;
    setTaskRuns((prev) => (prev ? mergeRunsDesc(prev, one) : one));
    markSeen(finishedRunIds(one));
  }, [selectedTaskId, markSeen]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      void refresh();
      void refreshTaskRuns();
    }, 15000);
    return () => clearInterval(t);
  }, [open, refresh, refreshTaskRuns]);

  useEffect(() => {
    if (!open || !selectedTask) {
      setTaskRuns(null);
      setTaskHasMore(false);
      return;
    }
    setConfirmClear(false);
    setClearError(null);
    setPromptOpen(false);
    setTaskRuns(null);
    setTaskHasMore(false);
    void loadTaskRuns(selectedTask.id);
  }, [open, selectedTask, loadTaskRuns]);

  // NOTE: صرفِ بازکردن اینباکس ران‌ها را دیده‌شده علامت نمی‌زند — فقط بازکردن
  // صفحهٔ خودِ تسک (loadTaskRuns/refreshTaskRuns) پیام‌های همان تسک را دیده
  // می‌زند، تا بج «N new» هر کارت تا وقتی واقعا خوانده نشده سر جایش بماند.

  const onChatScroll = useCallback(() => {
    const el = pageRef.current;
    if (!el || loadingMore || !taskHasMore || !selectedTaskId) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 480) {
      void loadOlderRuns();
    }
  }, [loadingMore, taskHasMore, selectedTaskId, loadOlderRuns]);

  const clearTarget: "task" | "orphans" | null = orphanView
    ? orphanRuns.length > 0
      ? "orphans"
      : null
    : selectedTask && (taskRuns?.length ?? 0) > 0
      ? "task"
      : null;

  const goBackToGrid = () => {
    setOrphanView(false);
    setSelected(null);
    setConfirmClear(false);
    setClearError(null);
    setOrphanError(null);
  };

  const clearActiveView = () => {
    if (clearTarget === "task" && selectedTask) {
      setClearing(true);
      setClearError(null);
      void clearScheduleRuns(selectedTask.id)
        .then((out) => {
          if ("error" in out) {
            setClearError(out.error);
            return;
          }
          setTaskRuns([]);
          setTaskHasMore(false);
          setRuns((prev) => prev.filter((r) => r.schedule_id !== selectedTask.id));
          setConfirmClear(false);
          void refresh();
        })
        .catch((err: unknown) => {
          setClearError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setClearing(false));
    } else if (clearTarget === "orphans") {
      setClearingOrphans(true);
      setOrphanError(null);
      void clearOrphanScheduleRuns()
        .then((out) => {
          if ("error" in out) {
            setOrphanError(out.error);
            return;
          }
          setRuns((prev) => prev.filter((r) => schedules.some((t) => t.id === r.schedule_id)));
          setConfirmClear(false);
          void refresh();
        })
        .catch((err: unknown) => {
          setOrphanError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setClearingOrphans(false));
    }
  };

  if (!open) return null;
  const unseen = unseenRunCount(runs, seen);
  const detail = orphanView || !!selectedTask;

  // کارت‌های گرید در یک صفِ بر اساس جدیدترین پیام: هر تسک با زمان آخرین رانش و
  // کارت «تسک‌های حذف‌شده» با جدیدترین ران یتیم — همه نزولی؛ وقتی ران جدید
  // می‌رسد (refresh هر ۱۵ ثانیه) کارتش خودبه‌خود بالا می‌آید.
  const gridItems: { at: number; el: React.ReactNode }[] = sortGridByLatestRun(
    schedules,
    latestRunByTask,
  ).map((t) => ({
    at: latestRunByTask.get(t.id)?.started_at ?? 0,
    el: (
      <GridCard
        key={t.id}
        task={t}
        unseen={unseenRunCountForTask(runs, seen, t.id)}
        lastRun={latestRunByTask.get(t.id) ?? null}
        onClick={() => setSelected(t.id)}
      />
    ),
  }));
  if (orphanRuns.length > 0) {
    gridItems.push({
      at: orphanRuns[0]?.started_at ?? 0,
      el: (
        <button
          type="button"
          className="schedule-grid-card schedule-grid-card--orphan"
          title="Runs of tasks you deleted — their history is kept until cleared"
          onClick={() => setOrphanView(true)}
        >
          <span className="schedule-grid-card-top">
            <span className="schedule-grid-card-name">Deleted tasks</span>
            <span className="schedule-inbox-badge">{orphanRuns.length}</span>
          </span>
          <span className="schedule-grid-card-meta">
            history kept — click to view, Clear removes it
          </span>
        </button>
      ),
    });
  }
  gridItems.sort((a, b) => b.at - a.at);

  return (
    <div className="schedule-inbox-overlay" dir={dir}>
      <InboxVimScroll inboxRef={inboxRef} pageRef={pageRef} />
      <div className="schedule-inbox-backdrop" />
      <div
        ref={inboxRef}
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
          {detail && (
            <button
              className="review-header-btn schedule-inbox-back"
              title="Back to all schedules"
              aria-label="Back to all schedules"
              onClick={goBackToGrid}
            >
              {/* فلش back در هر دو جهت ثابت است (مثل مرورگرها): ‹ — در RTL برعکس نمی‌شود. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
          )}
          {unseen > 0 && <span className="schedule-inbox-badge">{unseen} new</span>}
          {orphanView && (
            <span className="schedule-inbox-title">Runs from deleted tasks</span>
          )}
          {selectedTask && (
            <span className="schedule-inbox-title" title={selectedTask.name}>
              {selectedTask.name}
            </span>
          )}
          <span className="schedule-inbox-head-spacer" />
          <span className="review-header-actions">
            {clearTarget !== null &&
              (!confirmClear ? (
                <button
                  className="review-header-btn schedule-inbox-clear"
                  title={
                    clearTarget === "task"
                      ? `Clear all runs of ${selectedTask?.name ?? ""}`
                      : "Delete runs from deleted tasks"
                  }
                  aria-label={
                    clearTarget === "task"
                      ? `Clear all runs of ${selectedTask?.name ?? ""}`
                      : "Delete runs from deleted tasks"
                  }
                  disabled={clearing || clearingOrphans}
                  onClick={() => {
                    setClearError(null);
                    setOrphanError(null);
                    setConfirmClear(true);
                  }}
                >
                  Clear
                </button>
              ) : (
                <span className="schedule-clear-confirm">
                  <span className="schedule-clear-text">Clear all?</span>
                  <button
                    className="schedule-btn danger"
                    title="Confirm clear"
                    aria-label="Confirm clear"
                    disabled={clearing || clearingOrphans}
                    onClick={clearActiveView}
                  >
                    {clearing || clearingOrphans ? "Clearing…" : "Yes"}
                  </button>
                  <button
                    className="schedule-btn"
                    title="Cancel"
                    aria-label="Cancel"
                    disabled={clearing || clearingOrphans}
                    onClick={() => {
                      setConfirmClear(false);
                      setClearError(null);
                      setOrphanError(null);
                    }}
                  >
                    No
                  </button>
                </span>
              ))}
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
        <div ref={pageRef} className="schedule-inbox-page" onScroll={onChatScroll}>
          {!detail ? (
            // GRID: کارت هر تسک + کارت اجراهای حذف‌شده‌ها
            schedules.length === 0 && orphanRuns.length === 0 ? (
              <div className="schedule-runs-empty">No scheduled tasks yet</div>
            ) : (
              <div className="schedule-inbox-grid">
                {gridItems.map((it) => it.el)}
              </div>
            )
          ) : orphanView ? (
            // DETAIL: اجراهای تسک‌های حذف‌شده
            <div className="schedule-inbox-runs">
              {orphanError && <div className="schedule-error">{orphanError}</div>}
              {orphanRuns.map((r) => (
                <InboxRunCard key={r.id} run={r} />
              ))}
            </div>
          ) : (
            // DETAIL: پیام‌های تسک انتخاب‌شده
            selectedTask && (
              <>
                <div className={`schedule-inbox-prompt${promptOpen ? " open" : ""}`}>
                  <button
                    type="button"
                    className="schedule-inbox-prompt-head"
                    aria-expanded={promptOpen}
                    title={promptOpen ? "Collapse task" : "Show task"}
                    onClick={() => setPromptOpen((v) => !v)}
                  >
                    <span className="schedule-inbox-prompt-label">Task</span>
                    {!promptOpen && (
                      <span className="schedule-inbox-prompt-preview">
                        {promptPreview(selectedTask.prompt)}
                      </span>
                    )}
                    <svg
                      className="schedule-inbox-prompt-chevron"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {promptOpen && (
                    <ChatBubble
                      id={`prompt:${selectedTask.id}`}
                      content={selectedTask.prompt}
                      className="schedule-inbox-bubble"
                    />
                  )}
                </div>
                {clearError && <div className="schedule-error">{clearError}</div>}
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
                    {loadingMore && (
                      <div className="schedule-runs-empty">Loading older runs…</div>
                    )}
                    {!taskHasMore && taskRuns.length >= RUNS_PAGE && (
                      <div className="schedule-runs-empty">— end of history —</div>
                    )}
                  </div>
                )}
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** Docked inbox for the right editor group: forces the inbox store open while
 *  mounted and renders the same overlay content inside a static dock wrapper
 *  (CSS makes the overlay static). Closing the inner X closes the viewer tab. */
export function ScheduleInboxDocked({ onClose }: { onClose: () => void }) {
  const open = useStore((s) => s.scheduleInboxOpen);
  const setOpen = useStore((s) => s.setScheduleInboxOpen);
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
