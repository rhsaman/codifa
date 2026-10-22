import { useCallback, useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { api } from "../lib/fs";
import { deleteSchedule, listAllScheduleRuns, listSchedules } from "../lib/api";
import { formatTokens } from "../lib/context";
import { taskTokenTotals } from "../lib/schedule-notify";
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

/** One stored task: what it is set to, plus Delete and open-in-inbox.
 *
 *  Creating and editing moved to the `/schedule` chat command, so this row has
 *  no form, no pause and no run-now button — the panel only reports state. */
function ScheduleRow(props: { task: ScheduledTask; tokens: number; onChanged: () => void }) {
  const { task, tokens, onChanged } = props;
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dir = useStore((s) => s.dir);
  const openInbox = useStore((s) => s.setScheduleInboxOpen);
  const selectInbox = useStore((s) => s.setScheduleInboxSelected);

  const remove = async () => {
    setBusy(true);
    const out = await deleteSchedule(task.id);
    setBusy(false);
    if (!("error" in out)) onChanged();
  };

  const openInInbox = () => {
    selectInbox(task.id);
    openInbox(true);
  };

  return (
    <div className={`schedule-item${task.enabled ? "" : " disabled"}`} dir={dir}>
      <div
        className="schedule-item-head"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${task.name} — ${expanded ? "collapse" : "expand"}`}
        onClick={() => {
          setExpanded((v) => !v);
          setConfirmingDelete(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <span className={`schedule-status-dot${task.enabled ? "" : " paused"}`} aria-hidden="true" />
        <span className="sidebar-panel-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
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
      {expanded && (
        <div className="schedule-item-body">
          {task.prompt ? (
            <p className="schedule-prompt-text" title={task.prompt}>
              {task.prompt}
            </p>
          ) : null}
          <div className="schedule-row schedule-toolbar" role="toolbar" aria-label={`Actions for ${task.name}`}>
            <button className={`schedule-btn schedule-icon-btn danger${confirmingDelete ? " active" : ""}`} onClick={() => setConfirmingDelete((v) => !v)} disabled={busy} title={`Delete ${task.name}`} aria-label={`Delete ${task.name}`} aria-expanded={confirmingDelete}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
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
      )}
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
    const all = await listAllScheduleRuns(200);
    if (!("error" in all)) setTaskTokens(taskTokenTotals(all));
  }, [setSchedules]);

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
            schedules.map((t) => <ScheduleRow key={t.id} task={t} tokens={taskTokens[t.id] ?? 0} onChanged={() => void refresh()} />)
          )}
        </div>
      )}
    </div>
  );
}
