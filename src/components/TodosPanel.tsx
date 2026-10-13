import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { useViewerTabs } from "../lib/viewerTabs";
import { prepareContent } from "../lib/bidi";
import { ScheduleSection } from "./SchedulePanel";
import { listSubagents, stopSubagent, type SubagentJob } from "../lib/api";
import type { ChatMessage } from "../types";

/** آخرین plan غیرخالی بین پیام‌های یک چت (جدیدترین برنده) — منبع دادهٔ پنل.
 *  خالص (pure) تا تست بتواند مستقیم صدا بزند (همان الگوی buildGroups). */
export function latestTodos(
  messages: ChatMessage[],
): NonNullable<ChatMessage["plan"]> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const plan = messages[i].plan;
    if (plan && plan.length > 0) return plan;
  }
  return [];
}

/** عرض ثابت پنل شناور قدیمی (px) — فقط برای clamp و مهاجرت موقعیت قدیمی. */
const PANEL_W = 300;

/** وضعیت ذخیره‌شدهٔ پنل Todos (localStorage با کلید `coder:todoPanel`):
 *  حالت جمع‌شده و ارتفاع‌های per-chat. موقعیت (right/y) نسخهٔ شناور قدیمی
 *  است و فقط برای مهاجرت خوانده می‌شود — پنل جدید داک‌شده است و موقعیت ندارد. */
export interface TodoPanelUi {
  right?: number;
  y?: number;
  collapsed?: boolean;
  /** ارتفاع‌های صریحِ ریسایزشده به‌ازای هر چت — کلید = chatId؛ چت بدون
   *  رکورد پیش‌فرضِ بر اساس تعداد todo می‌گیرد. */
  heights?: Record<string, number>;
}

/** خواندن وضعیت ذخیره‌شدهٔ پنل؛ مهاجرت از نسخهٔ x (لنگر چپ) به right
 *  (لنگر راست) و قبل از آن فیلدهای todo قدیمیِ `coder:sidebarUi`. */
export function loadTodoPanelUi(): TodoPanelUi {
  try {
    const raw = localStorage.getItem("coder:todoPanel");
    if (raw) {
      const p = JSON.parse(raw) as TodoPanelUi & { x?: number; v?: number };
      const { x, v, ...rest } = p;
      const ui: TodoPanelUi =
        rest.right === undefined && x !== undefined
          ? { ...rest, right: window.innerWidth - x - PANEL_W }
          : rest;
      // مهاجرت یک‌بارهٔ v2: نسخهٔ باگ‌دار قبلی ارتفاع جاریِ چت فعال (حتی
      // پیش‌فرضِ) را در heights می‌نوشت؛ رکوردهای آلوده از ریسایز واقعی
      // قابل تفکیک نیستند → با اولین اجرای v2 همهٔ ارتفاع‌ها ریست
      // می‌شوند تا پیش‌فرضِ بر اساس تعداد todo دوباره حاکم شود.
      if (v !== 2) return { right: ui.right, y: ui.y, collapsed: ui.collapsed };
      return ui;
    }
    const legacy = localStorage.getItem("coder:sidebarUi");
    if (legacy) {
      const l = JSON.parse(legacy) as { todoCollapsed?: boolean };
      // todoHeight قدیمی سراسری بود و زیر مدل per-chat جا نمی‌شود —
      // نادیده گرفته می‌شود تا پیش‌فرضِ بر اساس تعداد todo اعمال شود.
      return { collapsed: l.todoCollapsed };
    }
  } catch {
    /* JSON خراب — پیش‌فرض‌ها برمی‌گردند */
  }
  return {};
}

/** سازگاری با تست‌ها و مهاجرت موقعیت قدیمی: افقی حداقل ۴۰px از پنل داخل
 *  viewport بماند؛ عمودی هدر از بالا/پایین بیرون نزند. پنل داک‌شدهٔ جدید
 *  از این استفاده نمی‌کند (موقعیت ندارد). */
export function clampPos(right: number, y: number, vw: number, vh: number) {
  return {
    right: Math.max(-(PANEL_W - 40), Math.min(vw - 40, right)),
    y: Math.max(8, Math.min(vh - 40, y)),
  };
}

/** ارتفاع پیش‌فرض لیست بر اساس تعداد todoها: هر آیتم ~۱۷px (فونت ۱۲ با
 *  line-height 1.4) + گپ ۵px + پدینگ پایین لیست — تا همهٔ آیتم‌ها بدون
 *  اسکرول جا شوند. خالص (pure) تا تست بتواند مستقیم صدا بزند. */
export function defaultHeightFor(count: number): number {
  return Math.max(60, Math.min(760, Math.round(count * 22 + 6)));
}

/** ادغام ارتفاع جدید یک چت در نقشهٔ heights بدون از دست دادن ارتفاع
 *  چت‌های دیگر. خالص (pure) تا تست بتواند مستقیم صدا بزند. */
export function withChatHeight(
  heights: Record<string, number> | undefined,
  chatId: string,
  height: number,
): Record<string, number> {
  return chatId ? { ...heights, [chatId]: height } : { ...heights };
}

/** ارتفاع مؤثر یک چت: ارتفاع صریحِ ریسایزشدهٔ همان چت و در غیر این صورت
 *  پیش‌فرض بر اساس تعداد todoها. خالص (pure) تا تست مستقیم صدا بزند. */
export function heightForChat(
  heights: Record<string, number> | undefined,
  chatId: string,
  todoCount: number,
): number {
  return heights?.[chatId] ?? defaultHeightFor(todoCount);
}

/** پنل راست هرگز خودکار باز نمی‌شود — حتی با رسیدن plan/تودوی تازه؛
 *  فقط کاربر با دکمه/میان‌بر آن را باز می‌کند. (تابع کمکی قبلیِ بازشدن خودکار
 *  عمداً حذف شده تا هیچ مسیری نتواند پنل را بدون خواست کاربر باز کند.) */

/** بخش تودوهای داخل پنل راست داک‌شده — بدون درگ و شناور بودن؛ ارتفاع
 *  کاملاً داینامیک از روی محتواست (بدون height ثابت؛ لیست خودش به‌اندازهٔ
 *  متن‌ها بلند می‌شود و فقط سقف max-height دارد تا اسکرول بیاید). */
export function TodosSection() {
  const chats = useStore((s) => s.chats);
  const activeChatId = useStore((s) => s.activeChatId);
  const dir = useStore((s) => s.dir);

  const todos = latestTodos(
    chats.find((c) => c.id === activeChatId)?.messages ?? [],
  );

  const [ui] = useState(loadTodoPanelUi);
  const [collapsed, setCollapsed] = useState(ui.collapsed ?? false);

  // ذخیرهٔ حالت جمع‌شدن با debounce + flush روی بستن اپ.
  const persist = () => {
    try {
      localStorage.setItem(
        "coder:todoPanel",
        JSON.stringify({ collapsed, v: 2 }),
      );
    } catch {
      /* خطای quota — ذخیره نمی‌شود */
    }
  };
  useEffect(() => {
    const t = setTimeout(persist, 250);
    return () => clearTimeout(t);
  }, [collapsed]);
  useEffect(() => {
    window.addEventListener("coder:flush-ui", persist);
    window.addEventListener("beforeunload", persist);
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("coder:flush-ui", persist);
      window.removeEventListener("beforeunload", persist);
      window.removeEventListener("pagehide", persist);
    };
  }, [collapsed]);

  if (todos.length === 0) return null;

  const done = todos.filter((t) => t.status === "completed").length;
  const pct = todos.length === 0 ? 0 : Math.round((done / todos.length) * 100);

  return (
    <div
      className={`sidebar-panel todos-docked${collapsed ? " collapsed" : ""}`}
      dir={dir}
    >
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
        <span className="sidebar-panel-title">Todos</span>
        {/* Opens the saved plan document (Plan viewer tab). stopPropagation on
            click AND keydown keeps the parent head's collapse toggle from
            firing — the head itself is a role="button" with Enter/Space. */}
        <button
          type="button"
          className="sidebar-panel-plan-btn"
          aria-label="View saved plan"
          title="View saved plan"
          onClick={(e) => {
            e.stopPropagation();
            useViewerTabs.getState().openPlan(activeChatId);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <svg
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
            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
          </svg>
        </button>
        <span className="sidebar-panel-count">
          {done}/{todos.length}
        </span>
      </div>
      {!collapsed && (
        <>
          <div
            className="sidebar-todos-progress"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${done} of ${todos.length} todos done`}
          >
            <div className="sidebar-todos-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <ul className="sidebar-todos-list">
            {todos.map((t, i) => (
              <li
                key={i}
                className={`sidebar-todo-item ${t.status === "completed" ? "done" : t.status === "in_progress" ? "running" : ""}`}
              >
                <span className="sidebar-todo-mark">
                  {t.status === "completed"
                    ? "✓"
                    : t.status === "in_progress"
                      ? "●"
                      : "○"}
                </span>
                <span className="sidebar-todo-content">
                  {prepareContent(t.content, dir)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** نگه‌داشت سازگاری: رندر شناور قدیمی حذف شد — همیشه null برمی‌گرداند تا
 *  مانت قدیمی در App بی‌اثر بماند. */
export function TodosPanel() {
  return null;
}

/** عمر یک job ساب‌ایجنت به شکل m:ss — خالص تا تست مستقیم صدا بزند. */
export function subagentAge(
  createdAt: number,
  now: number = Date.now() / 1000,
): string {
  const s = Math.max(0, Math.round(now - createdAt));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** برچسب وضعیت ساب‌ایجنت برای title/dot — خالص تا تست مستقیم صدا بزند. */
export function subagentStatusLabel(status: string): string {
  if (status === "running") return "running";
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "stopped") return "stopped";
  return status || "unknown";
}

/** بخش ساب‌ایجنت‌های پس‌زمینه در پنل راست: job های per-chat همین چت
 *  (poll هر ۳ ثانیه؛ فقط وقتی job هست رندر می‌شود) با دکمهٔ stop برای
 *  job های در حال اجرا — همان مسیری که task_stop ابزارِ ایجنت اصلی است. */
export function SubagentsSection() {
  const activeChatId = useStore((s) => s.activeChatId);
  const dir = useStore((s) => s.dir);
  const [jobs, setJobs] = useState<SubagentJob[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);

  useEffect(() => {
    if (!activeChatId) return;
    let alive = true;
    const tick = async () => {
      const js = await listSubagents(activeChatId);
      if (alive) setJobs(js);
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [activeChatId]);

  if (!activeChatId || jobs.length === 0) return null;
  const runningCount = jobs.filter((j) => j.status === "running").length;

  const onStop = async (taskId: string) => {
    setStopping(taskId);
    try {
      await stopSubagent(activeChatId, taskId);
      setJobs(await listSubagents(activeChatId));
    } finally {
      setStopping(null);
    }
  };

  const openTrace = (j: SubagentJob) => {
    useViewerTabs
      .getState()
      .openTraces(activeChatId, "all", j.task_id, j.description || j.task_id);
  };

  return (
    <div
      className={`sidebar-panel subagents-docked${collapsed ? " collapsed" : ""}`}
      dir={dir}
    >
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
        <span className="sidebar-panel-title">Sub-agents</span>
        {runningCount > 0 ? (
          <span className="sidebar-panel-count live">{runningCount} running</span>
        ) : (
          <span className="sidebar-panel-count">{jobs.length}</span>
        )}
      </div>
      {!collapsed && (
        <ul className="sidebar-subagents-list">
          {jobs.map((j) => {
            const statusLabel = subagentStatusLabel(j.status);
            return (
              <li
                key={j.task_id}
                className={`sidebar-subagent-item status-${j.status}`}
              >
                <span
                  className="sidebar-subagent-mark"
                  title={statusLabel}
                  aria-label={statusLabel}
                >
                  {j.status === "completed"
                    ? "✓"
                    : j.status === "failed"
                      ? "✕"
                      : j.status === "stopped"
                        ? "⏹"
                        : ""}
                </span>
                <button
                  type="button"
                  className="sidebar-subagent-main"
                  title={`Open sub-agent trace — ${j.task_id}`}
                  aria-label={`Open trace of ${j.description || j.task_id}`}
                  onClick={() => openTrace(j)}
                >
                  <span className="sidebar-subagent-desc">
                    {prepareContent(j.description || j.task_id, dir)}
                  </span>
                  {j.status === "running" && (
                    <span className="sidebar-subagent-meta">
                      {subagentAge(j.created_at)}
                      {j.steering ? " · steered" : ""}
                    </span>
                  )}
                </button>
                {j.status === "running" ? (
                  <button
                    className="sidebar-subagent-stop"
                    title={`Stop ${j.task_id}`}
                    aria-label={`Stop ${j.description || j.task_id}`}
                    disabled={stopping === j.task_id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onStop(j.task_id);
                    }}
                  >
                    {stopping === j.task_id ? "…" : "✕"}
                  </button>
                ) : (
                  <span className="sidebar-subagent-open" aria-hidden="true">
                    ›
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** پنل راست داک‌شده به سبک کلود — میزبان تودوها و بخش‌های آینده.
 *  عرض با درگ لبه (مثل سایدبار، معکوس چون به راست داک شده) و ذخیرهٔ محلی
 *  مثل سایدبار تا بین بازشدن‌ها حفظ شود. */
export function RightPanel() {
  // Lightweight shell: subscribes ONLY to the open flag so Cmd/Ctrl+Shift+B
  // flips instantly. The heavy content (schedules fetch, todos,
  // width state, resize listeners) mounts only when open.
  const open = useStore((s) => s.rightPanelOpen);
  if (!open) return null;
  return <RightPanelContent />;
}

function RightPanelContent() {
  // عرض پنل — با درگ لبه (مثل سایدبار، معکوس چون به راست داک شده) و
  // ذخیرهٔ محلی تا بین بازشدن‌ها حفظ شود.
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return 300;
    const vw =
      typeof window.innerWidth === "number" &&
      Number.isFinite(window.innerWidth)
        ? window.innerWidth
        : 1024;
    const saved = (() => {
      try {
        return parseInt(localStorage.getItem("coder:rightPanelWidth") ?? "", 10);
      } catch {
        return NaN;
      }
    })();
    const n = Number.isFinite(saved) ? saved : 300;
    return Math.max(220, Math.min(Math.max(220, vw - 24), n));
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
      setWidth((w) => Math.max(220, Math.min(window.innerWidth - 24, w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(
        220,
        Math.min(window.innerWidth - 24, startW - (ev.clientX - startX)),
      );
      setWidth(w);
      try {
        localStorage.setItem("coder:rightPanelWidth", String(w));
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

  return (
    <aside
      className="right-panel"
      role="complementary"
      aria-label="Right panel"
      style={{
        width,
        flex: "0 0 auto",
        alignSelf: "stretch",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        maxHeight: "100%",
        overflow: "hidden",
      }}
    >
      <div
        className="right-panel-resize-handle"
        title="Drag to resize"
        onMouseDown={startResize}
      />
      <div
        className="right-panel-body"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          minWidth: 0,
          overflowY: "auto",
          overscrollBehavior: "contain",
        }}
      >
        <ScheduleSection />
        <SubagentsSection />
        <TodosSection />
      </div>
    </aside>
  );
}
