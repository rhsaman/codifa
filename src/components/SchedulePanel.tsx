import { useCallback, useEffect, useState } from "react";
import { useStore } from "../lib/store";
import {
  deleteSchedule,
  listAllScheduleRuns,
  listScheduleRuns,
  listSchedules,
  runScheduleNow,
  saveSchedule,
} from "../lib/api";
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

/** Create/edit form for a scheduled task. */
function ScheduleForm(props: {
  initial?: ScheduledTask | null;
  defaultRoot: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { initial, defaultRoot, onDone, onCancel } = props;
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const presetValue = cronToPresetValue(initial?.cron);
  const isPreset = CRON_PRESET_VALUES.has(presetValue);
  const [cron, setCron] = useState(isPreset ? presetValue : "");
  const [customCron, setCustomCron] = useState(isPreset ? "" : (initial?.cron ?? "").trim());
  const [useCustom, setUseCustom] = useState(!isPreset && presetValue !== "");
  const [root, setRoot] = useState(initial?.root ?? defaultRoot);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dir = useStore((s) => s.dir);

  const submit = async () => {
    const finalCron = useCustom ? customCron.trim() : cron;
    if (!prompt.trim()) {
      setError("Task prompt is empty");
      return;
    }
    setSaving(true);
    setError(null);
    const out = await saveSchedule({
      id: initial?.id,
      name: name.trim() || "Scheduled task",
      prompt: prompt.trim(),
      cron: finalCron,
      enabled: initial?.enabled ?? true,
      root: root.trim() || defaultRoot,
      mode: initial?.mode || "coder",
    });
    setSaving(false);
    if ("error" in out) {
      setError(out.error);
      return;
    }
    onDone();
  };

  return (
    <div className="schedule-form" dir={dir}>
      <label className="schedule-field">
        <span className="schedule-label">Task name</span>
        <input
          className="schedule-input"
          placeholder="e.g. Morning report"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Task name"
          dir="auto"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="schedule-field">
        <span className="schedule-label">Task prompt</span>
        <textarea
          className="schedule-input schedule-prompt"
          placeholder="What should be done?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          aria-label="Task prompt"
          dir="auto"
          spellCheck={false}
        />
      </label>
      <label className="schedule-field">
        <span className="schedule-label">Repeat</span>
        <select
          className="schedule-input schedule-select"
          value={useCustom ? "__custom" : cron}
          onChange={(e) => {
            if (e.target.value === "__custom") setUseCustom(true);
            else {
              setUseCustom(false);
              setCron(e.target.value);
            }
          }}
          aria-label="Repeat"
        >
          {CRON_PRESETS.map((p) => (
            <option key={p.label} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="__custom">Custom cron…</option>
        </select>
      </label>
      {useCustom && (
        <input
          className="schedule-input schedule-mono"
          placeholder="0 9 * * *"
          value={customCron}
          onChange={(e) => setCustomCron(e.target.value)}
          aria-label="Custom cron"
          dir="ltr"
        />
      )}
      <label className="schedule-field">
        <span className="schedule-label">Working directory</span>
        <input
          className="schedule-input schedule-mono"
          placeholder="/path/to/workspace"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          aria-label="Workspace path"
          dir="ltr"
        />
      </label>
      {error && <div className="schedule-error">{error}</div>}
      <div className="schedule-actions">
        <button className="btn" onClick={() => void submit()} disabled={saving}>
          {saving ? "Saving…" : initial ? "Save" : "Create task"}
        </button>
        <button className="btn secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A task row with run/pause/edit/delete buttons (بدون نمایش پاسخ؛ خروجی فقط در Inbox). */
function ScheduleRow(props: { task: ScheduledTask; tokens: number; onChanged: () => void }) {
  const { task, tokens, onChanged } = props;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const dir = useStore((s) => s.dir);
  const activeRoot = useStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root);
  const openInbox = useStore((s) => s.setScheduleInboxOpen);
  const selectInbox = useStore((s) => s.setScheduleInboxSelected);

  const toggleEnabled = async () => {
    setBusy(true);
    const out = await saveSchedule({
      id: task.id,
      name: task.name,
      prompt: task.prompt,
      cron: task.cron,
      enabled: !task.enabled,
      root: task.root,
      mode: task.mode,
    });
    setBusy(false);
    if (!("error" in out)) onChanged();
  };

  const remove = async () => {
    setBusy(true);
    const out = await deleteSchedule(task.id);
    setBusy(false);
    if (!("error" in out)) onChanged();
  };

  const runNow = async () => {
    if (running) return;
    setRunning(true);
    setRunError(null);
    const startedAt = Date.now();
    const out = await runScheduleNow(task.id);
    if ("error" in out) {
      setRunning(false);
      setRunError(out.error);
      return;
    }
    // بک‌اند run_id همان اجرا را برمی‌گرداند؛ پولینگ دقیق همان ران (نه «آخرین
    // ران») + سقف ۱۰ دقیقه تا اسپینر برای همیشه گیر نکند. رکورد running یتیم
    // (قدیمی‌تر از ۱۵ دقیقه) هم پایان‌یافته حساب می‌شود.
    const targetRunId = "run_id" in out ? out.run_id : undefined;
    const STALE_RUNNING_MS = 15 * 60 * 1000;
    try {
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const runs = await listScheduleRuns(task.id, 5);
        if (!Array.isArray(runs) || runs.length === 0) continue;
        const target = targetRunId
          ? runs.find((r) => r.id === targetRunId)
          : runs[0];
        if (!target) continue;
        if (target.status !== "running") break;
        const ageMs = Date.now() - target.started_at * 1000;
        if (ageMs > STALE_RUNNING_MS) break;
        // اگر بک‌اند run_id نداد و جدیدترین ران از شروع ما قدیمی‌تر است،
        // یعنی اجرای ما هنوز ثبت نشده — ادامه بده.
        if (!targetRunId && target.started_at * 1000 < startedAt - 5000) continue;
      }
    } catch {
      // خطای پولینگ مهم نیست؛ فقط اسپینر را رها می‌کنیم
    }
    setRunning(false);
    onChanged();
  };

  const openInInbox = () => {
    selectInbox(task.id);
    openInbox(true);
  };

  if (editing) {
    return (
      <ScheduleForm
        initial={task}
        defaultRoot={activeRoot}
        onDone={() => {
          setEditing(false);
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className={`schedule-item${task.enabled ? "" : " disabled"}`} dir={dir}>
      <div className="schedule-item-head" role="button" tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <span className="sidebar-panel-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="schedule-item-name">{task.name}</span>
        <span className="schedule-item-cron">{task.cron_label || task.cron || "Once"}</span>
      </div>
      <div className="schedule-item-sub">
        {formatNextRunFa(task.next_run)}
        {typeof task.run_count === "number" && task.run_count > 0 ? ` · ${task.run_count} runs` : ""}
        {tokens > 0 ? ` · ${formatTokens(tokens)} tokens` : ""}
      </div>
      {expanded && (
        <div className="schedule-item-body">
          <div className="schedule-row">
            <button className="schedule-btn schedule-icon-btn" onClick={() => void runNow()} disabled={busy || running} title="Run now" aria-label="Run now">
              {running ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3" /></svg>
              )}
            </button>
            <button className="schedule-btn schedule-icon-btn" onClick={() => void toggleEnabled()} disabled={busy} title={task.enabled ? "Pause" : "Resume"} aria-label={task.enabled ? "Pause" : "Resume"}>
              {task.enabled ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
              )}
            </button>
            <button className="schedule-btn schedule-icon-btn" onClick={() => setEditing(true)} title="Edit" aria-label="Edit">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
            </button>
            <button className="schedule-btn schedule-icon-btn danger" onClick={() => void remove()} disabled={busy} title="Delete" aria-label="Delete">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            </button>
            <button className="schedule-btn schedule-icon-btn" onClick={openInInbox} title="Open in inbox" aria-label="Open in inbox">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
            </button>
          </div>
          {runError && <div className="schedule-error">{runError}</div>}
        </div>
      )}
    </div>
  );
}

/** Schedule section above todos in the right panel — create form + task list. */
export function ScheduleSection() {
  const schedules = useStore((s) => s.schedules);
  const setSchedules = useStore((s) => s.setSchedules);
  const formOpen = useStore((s) => s.scheduleFormOpen);
  const setFormOpen = useStore((s) => s.setScheduleFormOpen);
  const dir = useStore((s) => s.dir);
  const activeRoot = useStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  // مجموع توکن مصرفی هر تسک (از usage ران‌ها) — روی خود تسک نمایش داده می‌شود،
  // نه در model usage که فقط مصرف چت فعال است.
  const [taskTokens, setTaskTokens] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    const out = await listSchedules();
    setLoading(false);
    if (!("error" in out)) setSchedules(out);
    const all = await listAllScheduleRuns(200);
    if (!("error" in all)) setTaskTokens(taskTokenTotals(all));
  }, [setSchedules]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        <button
          className="schedule-add-btn"
          title="New task"
          aria-label="New task"
          onClick={(e) => {
            e.stopPropagation();
            setFormOpen(true);
            setCollapsed(false);
          }}
        >
          ＋
        </button>
      </div>
      {!collapsed && (
        <div className="schedule-list">
          {formOpen && (
            <ScheduleForm
              defaultRoot={activeRoot}
              onDone={() => {
                setFormOpen(false);
                void refresh();
              }}
              onCancel={() => setFormOpen(false)}
            />
          )}
          {loading && schedules.length === 0 ? (
            <div className="schedule-runs-empty">Loading…</div>
          ) : schedules.length === 0 && !formOpen ? (
            <div className="schedule-runs-empty">No scheduled tasks — press ＋ to create one</div>
          ) : (
            schedules.map((t) => <ScheduleRow key={t.id} task={t} tokens={taskTokens[t.id] ?? 0} onChanged={() => void refresh()} />)
          )}
        </div>
      )}
    </div>
  );
}
