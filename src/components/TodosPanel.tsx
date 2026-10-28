import { useEffect, useRef, useState } from "react";
import { ensureChatHydrated, useStore } from "../lib/store";
import { useViewerTabs } from "../lib/viewerTabs";
import { prepareContent } from "../lib/bidi";
import { listAgentTerminals, stopAgentTerminal } from "../lib/api";
import type { AgentTerminalInfo } from "../lib/api";
import {
  formatRunningFor,
  runningAgentTerminals,
} from "../lib/agentTerminals";
import { TurnUsagePanel } from "./TurnUsagePanel";
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
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId) ?? null);
  const activeChatId = useStore((s) => s.activeChatId);
  const dir = useStore((s) => s.dir);

  // `messages` is empty while the transcript is still on disk; the todos appear
  // as soon as the body is hydrated (the panel re-renders on that update).
  // This panel also triggers the fetch, so opening the right panel on a chat
  // whose body is not in memory never shows an empty todo list by accident.
  const needsBody = chat?.hydrated === false;
  useEffect(() => {
    if (activeChatId && needsBody) void ensureChatHydrated(activeChatId);
  }, [activeChatId, needsBody]);
  const todos = latestTodos(needsBody ? [] : chat?.messages ?? []);

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

  if (todos.length === 0) {
    // A page, not a floating card: returning null left the whole pane blank
    // with no hint about what belongs here or how to get it. The empty state
    // names the actor (the agent) and the trigger (a plan), so the pane reads
    // as "nothing yet", not "broken".
    return (
      <div className="sidebar-panel todos-docked todos-empty" dir={dir}>
        <div className="sidebar-panel-head">
          <span className="sidebar-panel-title">Todos</span>
        </div>
        <div className="sidebar-todos-empty">
          <p className="sidebar-todos-empty-title">No todos yet</p>
          <p className="sidebar-todos-empty-text">
            The agent fills this list while it works — each step of its plan
            appears here and checks off as it lands.
          </p>
        </div>
      </div>
    );
  }

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
            {todos.map((t) => (
              <li
                // Key on the content: the backend never writes an item id
                // (plans.rs strips it), and the list is rewritten as work
                // progresses — an index key moved the done/running class onto
                // whatever row happened to land on the old index.
                key={t.content}
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

/** بخش Terminals — ترمینال‌های بک‌گراندِ ایجنت (run_terminal با background=true،
 *  مثل «Start vite dev server» در zcode): عنوان + شمارندهٔ «N in background»،
 *  یک ردیف به‌ازای هر ترمینال زندهٔ همین چت با تایمر «Running for …» و دکمهٔ
 *  Stop. فهرست هر ۲ ثانیه از بک‌اند پول می‌شود (registry سمت Rust است و بعد از
 *  تمام‌شدن ترن هم زنده می‌ماند)؛ تایمر خودش هر ثانیه تیک می‌خورد. چیزی برای
 *  نشان‌دادن نیست، بخش اصلاً رندر نمی‌شود تا پنل بی‌دلیل شلوغ نشود. */
export function TerminalsSection() {
  const activeChatId = useStore((s) => s.activeChatId);
  const dir = useStore((s) => s.dir);
  const [terminals, setTerminals] = useState<AgentTerminalInfo[]>([]);
  // دکمه‌هایی که کلیک شده‌اند تا پول بعدی تایید کند — بدون این، دابل‌کلیک دو
  // بار POST می‌زد و دکمه تا تایید بک‌اند فعال می‌ماند.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activeChatId) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const rows = await listAgentTerminals(activeChatId);
        if (alive) setTerminals(rows);
      } catch {
        /* بک‌اند هنوز بالا نیست — آخرین فهرست می‌ماند */
      }
      if (alive) timer = window.setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeChatId]);

  const running = runningAgentTerminals(terminals);
  // تیک ثانیه‌ای فقط وقتی چیزی در حال اجراست — وقتی ردیفی نیست، هیچ چیز هر
  // ثانیه عوض نمی‌شود که رندر تازه بخواهد.
  const hasRunning = running.length > 0;
  useEffect(() => {
    if (!hasRunning) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [hasRunning]);

  if (!hasRunning) return null;

  const stop = (id: string) => {
    setStopping((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    void stopAgentTerminal(id);
  };

  return (
    <div className="sidebar-panel terminals-docked" dir={dir}>
      <div className="sidebar-panel-head">
        <span className="sidebar-panel-title">Terminals</span>
        <span className="terminals-bg-count">
          {running.length} in background
        </span>
      </div>
      <ul className="terminals-list">
        {running.map((t) => (
          <li className="terminals-item" key={t.id}>
            <span className="terminals-icon" aria-hidden="true">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2.5" y="4" width="19" height="16" rx="3" />
                <path d="M7 9.5l3 2.8-3 2.8" />
                <path d="M12.5 15.5H17" />
              </svg>
            </span>
            <div className="terminals-body">
              <div
                className="terminals-command"
                title={`${t.command}\n${t.cwd}\nLog: ${t.log_path}`}
              >
                {t.command}
              </div>
              <div className="terminals-meta">
                <span className="terminals-elapsed">
                  Running for {formatRunningFor(now - t.started_at_ms)}
                </span>
                <button
                  type="button"
                  className="terminals-stop"
                  disabled={stopping.has(t.id)}
                  onClick={() => stop(t.id)}
                >
                  <span className="terminals-stop-square" aria-hidden="true" />
                  {stopping.has(t.id) ? "Stopping…" : "Stop"}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
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
        {/* What the turn RAN with sits ABOVE the plan: the skills/connectors
            answer "is the right tool set loaded?" before the checklist of what
            it did — and it is the card that changes turn to turn. */}
        <TurnUsagePanel />
        {/* ترمینال‌های بک‌گراند ایجنت بالای تودوها: وضعیت «الان زنده» است و
            ردیفش با خروج پروسه محو می‌شود؛ وقتی چیزی نیست اصلاً رندر نمی‌شود. */}
        <TerminalsSection />
        <TodosSection />
      </div>
    </aside>
  );
}

