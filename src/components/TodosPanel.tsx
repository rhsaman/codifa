import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { prepareContent } from "../lib/bidi";
import { ScheduleSection } from "./SchedulePanel";
import type { ChatMessage, LayaRun } from "../types";

/** دلیل آماده‌نبودن laya به فارسی برای تنظیمات (دقیق: نصب‌نیست در برابر وزن‌نیست). */
export function layaReasonLabel(reason?: string): string {
  const r = (reason || '').trim().toLowerCase()
  if (!r) return ''
  if (r === 'laya-not-installed') return 'نصب نیست — `pip install laya`'
  if (r === 'laya-weights-missing') return 'وزن دانلود نشده — دکمه دانلود'
  if (r.startsWith('laya-timeout')) return 'کند بود — به مدل بزرگ واگذار شد'
  if (r.startsWith('laya-provider')) return 'پروایدر خارجی جواب نداد — واگذاری'
  if (r.startsWith('low-confidence')) return 'اطمینان پایین — واگذاری'
  if (r === 'abstained') return 'نمی‌دانم — واگذاری'
  return r
}

/** برچسب فارسی مسیر تصمیم laya برای بج کارت. */
export function layaRouteLabel(route: string): string {
  const r = (route || "").trim().toLowerCase();
  if (r === "computer") return "کامپیوتر";
  if (r === "browser") return "مرورگر";
  return "معمولی";
}

/** کلاس حالت کارت laya: لوکال / خارجی / واگذاری به مدل بزرگ. */
export function layaCardTone(run: LayaRun): "local" | "external" | "fallback" {
  if (run.abstained || !run.handled) return "fallback";
  return (run.providerId || "local") === "local" ? "local" : "external";
}

/** درصد نمایشی اطمینان (۰ تا ۱۰۰، clamp شده). */
export function layaConfidencePct(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(100, Math.round(confidence * 100)));
}

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

/** آیا با رسیدن plan جدید باید پنل راست خودکار باز شود؟
 *  فقط وقتی تودوی تازه ساخته شده (قبلاً خالی، حالا غیرخالی) و پنل بسته است —
 *  به‌روزرسانی‌های بعدیِ وضعیت نباید پنلی که کاربر عمداً بسته را دوباره باز کنند.
 *  خالص (pure) تا تست بتواند مستقیم صدا بزند. */
export function shouldAutoOpenTodosPanel(
  existingCount: number,
  incomingCount: number,
  rightPanelOpen: boolean,
): boolean {
  return !rightPanelOpen && existingCount === 0 && incomingCount > 0;
}

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

/** آرایه خالی پایدار برای سلکتور laya — از ساخت آرایه تازه در هر رندر جلوگیری می‌کند. */
const EMPTY_LAYA_RUNS: LayaRun[] = [];

/** سکشن زنده تصمیم‌های laya زیر todos — فقط تاریخچه چت فعال (آخرین ~۲۰ تا)
 *  با بج مسیر و نوار اطمینان. خالی بودن یعنی هیچ تصمیمی هنوز برای این چت ثبت نشده. */
export function LayaSection() {
  const activeChatId = useStore((s) => s.activeChatId);
  const runs = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.layaRuns ?? EMPTY_LAYA_RUNS,
  );
  const dir = useStore((s) => s.dir);
  const [collapsed, setCollapsed] = useState(false);

  if (!activeChatId) return null;
  if (runs.length === 0) {
    return (
      <div className="sidebar-panel laya-docked" dir={dir} aria-label="Laya decisions">
        <div className="sidebar-panel-head">
          <span className="sidebar-panel-title">Laya</span>
          <span className="sidebar-panel-count">0</span>
        </div>
        <div className="laya-run-empty">هنوز تصمیمی برای این چت ثبت نشده</div>
      </div>
    );
  }
  const shown = runs.slice(-20).slice().reverse();

  return (
    <div
      className={`sidebar-panel laya-docked${collapsed ? " collapsed" : ""}`}
      dir={dir}
      aria-label="Laya decisions"
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
        <span className="sidebar-panel-title">Laya</span>
        <span className="sidebar-panel-count">{runs.length}</span>
      </div>
      {!collapsed && (
        <ul className="laya-run-list">
          {shown.map((run, i) => {
            const pct = layaConfidencePct(run.confidence);
            const tone = layaCardTone(run);
            const toneLabel =
              tone === "local" ? "لوکال" : tone === "external" ? "خارجی" : "واگذاری";
            return (
              <li key={`${run.at}-${i}`} className={`laya-run-card laya-${tone}`}>
                <div className="laya-run-top">
                  <span className={`laya-route-badge route-${(run.route || "normal").toLowerCase()}`}>
                    {layaRouteLabel(run.route)}
                  </span>
                  <span className={`laya-tone-badge tone-${tone}`}>{toneLabel}</span>
                  <span className="laya-run-time">
                    {run.elapsedMs > 0 ? `${run.elapsedMs}ms` : "—"}
                  </span>
                </div>
                <div
                  className="laya-confidence-track"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Laya confidence ${pct} percent`}
                >
                  <div className="laya-confidence-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="laya-run-meta">
                  <span className="laya-confidence-num">{pct}٪</span>
                  {run.reason ? (
                    <span className="laya-run-reason" title={run.reason}>
                      {layaReasonLabel(run.reason) || prepareContent(run.reason, dir)}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** نگه‌داشت سازگاری: رندر شناور قدیمی حذف شد — همیشه null برمی‌گرداند تا
 *  مانت قدیمی در App بی‌اثر بماند. */
export function TodosPanel() {
  return null;
}

/** پنل راست داک‌شده به سبک کلود — میزبان تودوها و بخش‌های آینده.
 *  عرض با درگ لبه (مثل سایدبار، معکوس چون به راست داک شده) و ذخیرهٔ محلی
 *  مثل سایدبار تا بین بازشدن‌ها حفظ شود. */
export function RightPanel() {
  // Lightweight shell: subscribes ONLY to the open flag so Cmd/Ctrl+Shift+B
  // flips instantly. The heavy content (schedules fetch, todos, laya runs,
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
      style={{ width }}
    >
      <div
        className="right-panel-resize-handle"
        title="Drag to resize"
        onMouseDown={startResize}
      />
      <div className="right-panel-body">
        <ScheduleSection />
        <TodosSection />
        <LayaSection />
      </div>
    </aside>
  );
}
