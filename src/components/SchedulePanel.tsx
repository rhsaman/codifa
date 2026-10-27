import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../lib/store";
import { api } from "../lib/fs";
import { deleteSchedule, listAllScheduleRuns, listScheduleRuns, listSchedules, runScheduleNow, saveSchedule } from "../lib/api";
import { formatTokens } from "../lib/context";
import { liveRunningMap, taskTokenTotals } from "../lib/schedule-notify";
import type { ScheduleRun, ScheduledTask } from "../types";

/** Format next_run for display (Today/Tomorrow/date). `nowRef` is only for tests so the Today/Tomorrow boundary never depends on the wall clock. */
export function formatNextRunFa(nextRun: number | null | undefined, nowRef?: Date): string {
  if (!nextRun) return "No next run";
  const d = new Date(nextRun * 1000);
  const now = nowRef ?? new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const hm = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Today ${hm}`;
  if (isTomorrow) return `Tomorrow ${hm}`;
  return `${d.toLocaleDateString("en-US")} ${hm}`;
}

/** Display status of a run (done/error/running). */
export function runStatusFa(status: ScheduleRun["status"]): string {
  if (status === "done") return "Done";
  if (status === "error") return "Failed";
  return "Running";
}

const CRON_PRESETS = [
  { value: "", label: "Once" },
  { value: "*/15 * * * *", label: "Every 15 minutes" },
  { value: "0 * * * *", label: "Hourly" },
  { value: "0 9 * * *", label: "Daily (9 AM)" },
  { value: "0 9 * * 1", label: "Weekly (Mon 9 AM)" },
];

const CRON_PRESET_VALUES = new Set(CRON_PRESETS.map((p) => p.value));

/** نگاشت کرون ذخیره‌شده (نرمال‌شده بک‌اند) به مقدار select فرم.
 * بک‌اند presetها را نرمال می‌کند (مثلاً daily → ‎"0 9 * * *"‎)، پس cron
 * ذخیره‌شده با valueهای نمایشی یکی نیست؛ این تابع هر دو شکل (قدیمی/نرمال)
 * را به value درست select برمی‌گرداند تا ویرایش بعدی Repeat را درست نشان دهد. */
export function cronToPresetValue(cron: string | null | undefined): string {
  const c = (cron ?? "").trim().toLowerCase();
  if (!c || c === "once") return "";
  if (CRON_PRESET_VALUES.has(c)) return c;
  const legacy: Record<string, string> = {
    "every 15 minutes": "*/15 * * * *",
    hourly: "0 * * * *",
    daily: "0 9 * * *",
    weekly: "0 9 * * 1",
  };
  return legacy[c] ?? c;
}

/** One stored task: always expanded — Run now, Pause/Resume, Delete and
 *  open-in-inbox stay visible without a click. Creating and editing live in
 *  the `/schedule` chat command — the row only toggles or fires the task. */
function ScheduleRow(props: {
  task: ScheduledTask;
  tokens: number;
  onChanged: () => void;
  onError: (msg: string) => void;
  /** Derived from the backend's run rows (see `liveRunningMap`): keeps the
   *  spinner honest when this row REMOUNTS mid-run — the local flag below dies
   *  with the mount, the run on the backend does not. */
  liveRunning?: boolean;
}) {
  const { task, tokens, onChanged, onError, liveRunning } = props;
  const [busy, setBusy] = useState(false);
  // Stays true from "Run now" until the SPAWNED run on the backend actually
  // finishes (the POST returns at once — the run itself is async), so the
  // button shows progress for the whole job, not just the request.
  const [running, setRunning] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Local flag covers the POST window (before the run row exists); the derived
  // flag takes over the moment the row lands — panel and inbox share it.
  const isRunning = running || !!liveRunning;
  const dir = useStore((s) => s.dir);
  const selectInbox = useStore((s) => s.setScheduleInboxSelected);

  const remove = async () => {
    setBusy(true);
    const out = await deleteSchedule(task.id);
    setBusy(false);
    if (!("error" in out)) onChanged();
  };

  // Selects the task's thread AND opens the inbox TAB (viewerTabs.openInbox
  //  flips the store flag too): only setting the flag left the pane on whatever
  //  tab it already showed — the click looked dead from the schedule page.
  const openInInbox = () => {
    selectInbox(task.id);
    void import("../lib/viewerTabs").then(({ useViewerTabs }) => {
      useViewerTabs.getState().openInbox();
    });
  };

  // The run agents log the trace under the synthetic chat `schedule-<sid>`
  //  (scheduler.rs AgentRequest.chat_id), so the trace panel reads THAT chat's
  //  log; the tab carries the same chat id so it stays visible from any chat.
  const openTrace = () => {
    void import("../lib/viewerTabs").then(({ useViewerTabs }) => {
      useViewerTabs.getState().openTraces(`schedule-${task.id}`, "all", undefined, task.name);
    });
  };

  const runNow = async () => {
    setRunning(true);
    const started = Date.now() / 1000;
    const out = await runScheduleNow(task.id);
    if ("error" in out) {
      setRunning(false);
      onError(`Run failed: ${out.error}`);
      return;
    }
    onChanged();
    // The backend writes status=running on disk and flips it to done/error at
    // the end: poll the run history until OUR run (started just now) settles,
    // with a hard cap (~15 min) so a stuck run never pins the button forever.
    for (let i = 0; i < 450; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const runs = await listScheduleRuns(task.id, 5);
      if ("error" in runs) break;
      // Small skew allowance: the run row's started_at is the backend clock.
      const live = runs.find((r) => r.started_at >= started - 1);
      if (live && live.status !== "running") break;
    }
    setRunning(false);
    onChanged();
  };

  // Pause/Resume is a full upsert of the stored task with `enabled` flipped:
  // the backend keeps every other field and recomputes next_run on the next
  // scheduler tick (a stale one is healed, never burst-run).
  const toggleEnabled = async () => {
    setBusy(true);
    const out = await saveSchedule({ ...task, enabled: !task.enabled });
    setBusy(false);
    if ("error" in out) onError(out.error);
    else onChanged();
  };

  return (
    <div className={`schedule-item${task.enabled ? "" : " disabled"}`} dir={dir}>
      <div className="schedule-item-head">
        <span className={`schedule-status-dot${task.enabled ? "" : " paused"}`} aria-hidden="true" />
        <span className="schedule-item-name" title={task.name}>{task.name}</span>
        <span className="schedule-item-cron" title={task.cron || undefined}>{task.cron_label || task.cron || "Once"}</span>
      </div>
      <div className="schedule-item-sub">
        <span className="schedule-item-next">{formatNextRunFa(task.next_run)}</span>
        {typeof task.run_count === "number" && task.run_count > 0 ? (
          <span className="schedule-item-meta"> · {task.run_count} runs</span>
        ) : null}
        {tokens > 0 ? (
          <span className="schedule-item-meta"> · {formatTokens(tokens)} tokens</span>
        ) : null}
        {!task.enabled ? <span className="schedule-pill paused">Paused</span> : null}
      </div>
      <div className="schedule-item-body">
          {task.prompt ? (
            <p className="schedule-prompt-text" title={task.prompt}>
              {task.prompt}
            </p>
          ) : null}
          <div className="schedule-row schedule-toolbar" role="toolbar" aria-label={`Actions for ${task.name}`}>
            <button className="schedule-btn schedule-icon-btn" onClick={() => void runNow()} disabled={busy || isRunning} title={isRunning ? `Running ${task.name}…` : `Run ${task.name} now`} aria-label={isRunning ? `Running ${task.name}` : `Run ${task.name} now`}>
              {isRunning ? (
                <span className="schedule-btn-spinner" aria-hidden="true" />
              ) : (
                // A bolt, not a play triangle: Resume below is the play icon,
                // and the two identical triangles read as one button twice.
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>
              )}
            </button>
            <button className="schedule-btn schedule-icon-btn" onClick={() => void toggleEnabled()} disabled={busy} title={task.enabled ? `Pause ${task.name}` : `Resume ${task.name}`} aria-label={task.enabled ? `Pause ${task.name}` : `Resume ${task.name}`}>
              {task.enabled ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              )}
            </button>
            <button className={`schedule-btn schedule-icon-btn danger${confirmingDelete ? " active" : ""}`} onClick={() => setConfirmingDelete((v) => !v)} disabled={busy} title={`Delete ${task.name}`} aria-label={`Delete ${task.name}`} aria-expanded={confirmingDelete}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            </button>
            <button className="schedule-btn schedule-icon-btn" onClick={openTrace} title={`Trace ${task.name}`} aria-label={`Trace ${task.name}`}>
              {/* Activity pulse: the run's own log (LLM + tool calls), distinct
                  from the inbox icon which shows the finished outputs. */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
            </button>
            <button className="schedule-btn schedule-icon-btn" onClick={openInInbox} title={`Open ${task.name} in inbox`} aria-label={`Open ${task.name} in inbox`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
            </button>
          </div>
          {confirmingDelete ? (
            <div className="schedule-confirm" role="alert">
              <span className="schedule-confirm-text">Delete “{task.name}”? This cannot be undone.</span>
              <div className="schedule-confirm-actions">
                <button className="schedule-btn danger-solid" onClick={() => void remove()} disabled={busy}>
                  Delete
                </button>
                <button className="schedule-btn" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                  Keep
                </button>
              </div>
            </div>
          ) : null}
      </div>
    </div>
  );
}

/** Schedule page: the stored tasks and their state (created from `/schedule`). */
export function ScheduleSection() {
  const schedules = useStore((s) => s.schedules);
  const setSchedules = useStore((s) => s.setSchedules);
  const dir = useStore((s) => s.dir);
  const loaded = useStore((s) => s.loaded);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // مجموع توکن مصرفی هر تسک (از usage ران‌ها) — روی خود تسک نمایش داده می‌شود،
  // نه در model usage که فقط مصرف چت فعال است.
  const [taskTokens, setTaskTokens] = useState<Record<string, number>>({});
  // Tasks with a run still in flight, derived from the run rows. This page
  // remounts on every tab switch, so a row-local useState cannot be the
  // source of truth: the backend's run rows are (the inbox reads the same).
  const [liveRunning, setLiveRunning] = useState<Record<string, boolean>>({});

  const applyRuns = useCallback((all: ScheduleRun[] | { error: string }) => {
    if ("error" in all) return;
    setTaskTokens(taskTokenTotals(all));
    setLiveRunning(liveRunningMap(all));
  }, []);

  // While anything is in flight, poll the run rows lightly so the derived
  // spinner settles the moment the backend flips the row to done/error —
  // no manual refresh needed after coming back to this page.
  const anyLive = useMemo(() => Object.values(liveRunning).some(Boolean), [liveRunning]);
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      const all = await listAllScheduleRuns(200);
      inFlight = false;
      if (!stopped) applyRuns(all);
    };
    void tick();
    if (!anyLive) return () => { stopped = true; };
    const iv = setInterval(() => void tick(), 3000);
    return () => { stopped = true; clearInterval(iv); };
  }, [anyLive, applyRuns]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const out = await listSchedules();
    setLoading(false);
    if ("error" in out) {
      setError(out.error);
    } else {
      setSchedules(out);
    }
    applyRuns(await listAllScheduleRuns(200));
  }, [setSchedules, applyRuns]);

  // Load on mount AND when persisted state finishes loading: on app startup the
  // panel can mount before `loaded` (and before the sidecar URL is known), so a
  // mount-only fetch hits "Python agent not ready" once and gets stuck on the
  // error/empty state. Gating on `loaded` retries the fetch as soon as the app
  // is actually ready.
  useEffect(() => {
    if (!collapsed && loaded) void refresh();
  }, [collapsed, loaded, refresh]);

  // The sidecar can (re)start after the first fetch failed (cold start, crash
  // recovery): re-refresh when the main process announces a new sidecar URL so
  // the list populates without requiring a manual Retry / collapse toggle.
  useEffect(() => {
    if (collapsed) return;
    const unsub = api.onSidecarChanged(() => {
      void refresh();
    });
    return unsub;
  }, [collapsed, refresh]);

  return (
    <div className="sidebar-panel schedule-docked" dir={dir}>
      <div
        className="sidebar-panel-head"
        role="button"
        tabIndex={0}
        title="Click to collapse"
        onClick={() => setCollapsed((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed((v) => !v);
          }
        }}
      >
        <span className="sidebar-panel-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="sidebar-panel-title">Schedules</span>
        {schedules.length > 0 && (
          <span className="sidebar-panel-count">{schedules.length}</span>
        )}
      </div>
      {!collapsed && (
        <div className="schedule-list">
          {loading && schedules.length === 0 ? (
            <div className="schedule-loading" aria-live="polite" aria-busy="true">
              <div className="schedule-skeleton" />
              <div className="schedule-skeleton short" />
              <span className="schedule-loading-text">Loading schedules…</span>
            </div>
          ) : error && schedules.length === 0 ? (
            <div className="schedule-empty" role="alert">
              <span className="schedule-empty-icon" aria-hidden="true">⚠</span>
              <p className="schedule-empty-text">{error}</p>
              <button className="btn secondary" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          ) : schedules.length === 0 ? (
            <div className="schedule-empty">
              <span className="schedule-empty-icon" aria-hidden="true">⏰</span>
              <p className="schedule-empty-title">No scheduled tasks yet</p>
              <p className="schedule-empty-text">
                Tasks are created from the chat: type <code>/schedule &lt;description&gt;</code> and the
                agent sets up the cron, the workspace and the prompt.
              </p>
            </div>
          ) : (
            schedules.map((t) => <ScheduleRow key={t.id} task={t} tokens={taskTokens[t.id] ?? 0} liveRunning={liveRunning[t.id] ?? false} onChanged={() => void refresh()} onError={setError} />)
          )}
        </div>
      )}
    </div>
  );
}
