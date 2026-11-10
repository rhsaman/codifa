import { useEffect, useRef, useState } from "react";
import { APP_DIR, ensureChatTail, useStore } from "../lib/store";
import { useViewerTabs } from "../lib/viewerTabs";
import { prepareContent } from "../lib/bidi";
import { dirByText, isolateLtrRuns } from "../lib/ltrIslands";
import { listAgentTerminals, stopAgentTerminal } from "../lib/api";
import type { AgentTerminalInfo } from "../lib/api";
import {
  formatRunningFor,
  visibleAgentTerminals,
  terminalExitLabel,
} from "../lib/agentTerminals";
import { TurnUsagePanel } from "./TurnUsagePanel";
import {
  PanelChevron,
  PlanIcon,
  StepCheckIcon,
  TerminalIcon,
} from "./PanelIcons";
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

/* ── عرض پنل راست: یک منبع حقیقت ────────────────────────────────────────
   قبلاً پنل فقط با `window.innerWidth` کلمپ می‌شد، پس سایدبار و ستون چت
   را نادیده می‌گرفت و با پنل اسپلیت (viewer) هم هم‌اهنگ نبود؛ نتیجه: عرض
   پنل با هر ری‌سایز پنجره بی‌سروصدا عوض می‌شد و روی چت می‌افتاد. حالا
   سقف از عرض واقعی `.app-body` منهای سایدبار و منهای یک نوار قابل‌استفاده
   برای چت حساب می‌شود. */

/** کوچک‌ترین عرض پنل راست (px). */
export const RIGHT_PANEL_MIN_WIDTH = 220;

/** عرض پیش‌فرض پنل راست وقتی کاربر هنوز خودش درگ نکرده (px).
 *  برابر با حداقل است: پنل همیشه در باریک‌ترین حالت مجاز سایت باز می‌شود. */
export const RIGHT_PANEL_DEFAULT_WIDTH = RIGHT_PANEL_MIN_WIDTH;

/** عرض *زندهٔ* پنل راست که رندر شده، برای اینکه پنل اسپلیت (viewer) آن را
 *  از فضای خودش کم کند و دو پنل روی هم نیفتند. وقتی پنل راست باز نیست
 *  صفر است. */
export const rightPanelLiveWidth = { current: 0 };

/** عرض فعلی پنل راست برای مصرف‌کننده‌های بیرونی (App/clampSplitWidth). */
export function getRightPanelLiveWidth(): number {
  return rightPanelLiveWidth.current;
}

/** نوار حداقلی که ستون چت باید کنار پنل راست نگه دارد (px) — هم‌خوان با
 *  CHAT_MIN_WIDTH در lib/viewerTabs تا هر دو پنل یک قانون داشته باشند. */
export const CHAT_KEEP_MIN_WIDTH = 320;

/** عرض سایدبار از توکن CSS `--sidebar-w` (پیش‌فرض 264px طبق :root). */
function sidebarWidth(): number {
  if (typeof window === "undefined") return 264;
  try {
    const v = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"),
    );
    return Number.isFinite(v) && v > 0 ? v : 264;
  } catch {
    return 264;
  }
}

/** بزرگ‌ترین عرض مجاز پنل راست در یک عرض ظرف مشخص.
 *  @param appBodyWidth عرض واقعی `.app-body` (کل پنجره منهای حاشیه‌ها)
 *  @param reservedچپ      عرض اشغال‌شده در سمت چپ (سایدبار + ستون چت)
 *
 *  سقف = appBody − reservedچپ، و اگر چیزی برای آن نماند، عریض‌ترین
 *  مقداری که هنوز هم ستون چت را زیر حد خودش نمی‌برد. حداقل همیشه
 *  RIGHT_PANEL_MIN_WIDTH است تا پنل هرگز کوچک‌تر از خودش نشود. */
export function rightPanelMaxWidth(appBodyWidth: number): number {
  const body =
    Number.isFinite(appBodyWidth) && appBodyWidth > 0
      ? appBodyWidth
      : typeof window !== "undefined"
        ? window.innerWidth
        : 1024;
  const reserved = sidebarWidth() + CHAT_KEEP_MIN_WIDTH;
  const max = body - reserved;
  if (!Number.isFinite(max)) return RIGHT_PANEL_DEFAULT_WIDTH;
  // وقتی پنجره خیلی باریک است، پنل را به‌جای صفر کردن قفل نمی‌کنیم
  // (پنل باید همیشه بار باشد) اما هرگز از حداقل هم کوچک‌تر نمی‌شود.
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(max));
}

/** کلمپ عرض درخواستی بین حداقل پنل و سقفِ ظرف فعلی. */
export function clampRightPanelWidth(
  width: number,
  appBodyWidth?: number,
): number {
  const body = appBodyWidth as number;
  const max = rightPanelMaxWidth(body);
  const n = Number.isFinite(width) ? width : RIGHT_PANEL_DEFAULT_WIDTH;
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(max, Math.round(n)));
}

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
  const dir = APP_DIR;

  // `messages` is empty while the transcript is still on disk; the todos appear
  // as soon as the newest page is hydrated (the panel re-renders on that
  // update). Only the tail is fetched — the latest plan always lives near the
  // end, and full-hydrating here would defeat transcript pagination.
  const needsBody = chat?.hydrated === false;
  useEffect(() => {
    if (activeChatId && needsBody) void ensureChatTail(activeChatId);
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
    // No plan yet → NO card. An empty shell with "No todos yet" was just noise
    // on top of the resting page; the page-level hint (TodosPageEmptyHint, the
    // :only-child trick in global.css) speaks only when EVERY card is empty.
    return null;
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
        <span className="sidebar-panel-chevron">
          <PanelChevron collapsed={collapsed} />
        </span>
        <span className="sidebar-panel-title">Agent plan</span>
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
          <div className="sidebar-todos-summary">
            <div
              className="sidebar-todos-progress"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${done} of ${todos.length} steps done`}
            >
              <div className="sidebar-todos-progress-fill" style={{ width: `${pct}%` }} />
            </div>
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
                  {t.status === "completed" ? (
                    <StepCheckIcon />
                  ) : t.status === "in_progress" ? (
                    <span className="sidebar-todo-spin" aria-hidden="true" />
                  ) : null}
                </span>
                <span className="sidebar-todo-content" dir={dirByText(t.content)}>
                  {isolateLtrRuns(prepareContent(t.content))}
                </span>
                {typeof t.progress === "number" && t.status !== "completed" && (
                  <span
                    className="plan-item-progress"
                    dir="ltr"
                    aria-label={`${Math.round(t.progress)}%`}
                  >
                    <span
                      className="plan-item-progress-fill"
                      style={{ width: `${Math.max(0, Math.min(100, t.progress))}%` }}
                    />
                  </span>
                )}
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
 *  مثل «Start vite dev server» در zcode): عنوان + شمارندهٔ «N running»،
 *  یک ردیف به‌ازای هر ترمینال زندهٔ همین چت با تایمر «Running for …» و دکمهٔ
 *  Stop. فهرست هر ۲ ثانیه از بک‌اند پول می‌شود (registry سمت Rust است و بعد از
 *  تمام‌شدن ترن هم زنده می‌ماند)؛ تایمر خودش هر ثانیه تیک می‌خورد. ردیف‌های
 *  خروج‌یافتهٔ تازه هم تا پایان پنجرهٔ grace با کد خروج می‌مانند — دستور کوتاهی
 *  که بین دو پول تمام می‌شود بدون این هیچ‌وقت دیده نمی‌شد. چیزی برای
 *  نشان‌دادن نیست، بخش اصلاً رندر نمی‌شود تا پنل بی‌دلیل شلوغ نشود. */
export function TerminalsSection() {
  const activeChatId = useStore((s) => s.activeChatId);
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

  // زنده‌ها + خروج‌یافته‌های داخل پنجرهٔ grace. با Date.now() در خودِ رندر
  // محاسبه می‌شود تا انقضای grace بدون تایمر اضافه، با همان پول بعدی (≤۲s)
  // اعمال شود — نه state اضافه، نه رندر تازه‌ای که فقط برای انقضا بخورد.
  const visible = visibleAgentTerminals(terminals, Date.now());
  const running = visible.filter((t) => t.running);
  // تیک ثانیه‌ای فقط وقتی چیزی در حال اجراست — وقتی ردیفی نیست، هیچ چیز هر
  // ثانیه عوض نمی‌شود که رندر تازه بخواهد.
  const hasRunning = running.length > 0;
  useEffect(() => {
    if (!hasRunning) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [hasRunning]);

  if (visible.length === 0) return null;

  const stop = (id: string) => {
    setStopping((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    void stopAgentTerminal(id);
  };

  return (
    // Always LTR: the rows are shell commands (mono, English) — an RTL locale
    // must not mirror them. The plan card below keeps the app's direction.
    <div className="sidebar-panel terminals-docked" dir="ltr">
      <div className="sidebar-panel-head">
        <span className="sidebar-panel-icon">
          <TerminalIcon />
        </span>
        <span className="sidebar-panel-title">Background terminals</span>
        {hasRunning && (
          <span className="terminals-bg-count">
            {running.length} running
          </span>
        )}
      </div>
      <ul className="terminals-list">
        {visible.map((t) => (
          <li
            className={`terminals-item${t.running ? "" : " exited"}`}
            key={t.id}
          >
            <span className="terminals-icon" aria-hidden="true">
              <TerminalIcon size={15} />
            </span>
            <div className="terminals-body">
              <div
                className="terminals-command"
                title={`${t.command}\n${t.cwd}\nLog: ${t.log_path}`}
              >
                {t.command}
              </div>
              <div className="terminals-meta">
                {t.running ? (
                  <>
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
                  </>
                ) : (
                  <span
                    className={`terminals-exit${t.exit_code ? " bad" : ""}`}
                  >
                    {terminalExitLabel(t)}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** تنها چیزی که وقتی هر سه کارت صفحه Todos خالی‌اند دیده می‌شود. کارت‌ها
 *  وقتی خالی‌اند اصلاً رندر نمی‌شوند، پس این خط آن‌وقت تنها فرزند container
 *  است — و همان لحظه قانون `:only-child` در global.css آن را نمایان می‌کند.
 *  با آمدن هر کارت واقعی، hint خودبه‌خود محو می‌شود (بدون state اضافه). */
export function TodosPageEmptyHint() {
  const dir = APP_DIR;
  return (
    <div className="todos-page-empty" dir={dir}>
      <span className="todos-page-empty-icon">
        <PlanIcon size={22} />
      </span>
      <p className="todos-page-empty-title">Nothing here yet</p>
      <p className="todos-page-empty-text">
        The agent&apos;s plan, tools and background terminals will appear here
        as it works.
      </p>
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
  // دو لایهٔ عرض:
  //  • `chosen` — چیزی که کاربر با درگ انتخاب کرده (در localStorage)؛ هرگز
  //    با باریک‌شدن موقت پنجره بازنویسی نمی‌شود.
  //  • `width`  — عرض واقعیِ رندرشده؛ بعد از بازشدن و با هر ری‌سایز واقعیِ
  //    `.app-body` کلمپ می‌شود تا هیچ‌وقت روی چت/سایدبار نریزد.
  const [chosen, setChosen] = useState<number>(() => {
    if (typeof window === "undefined") return RIGHT_PANEL_DEFAULT_WIDTH;
    const saved = (() => {
      try {
        return parseInt(localStorage.getItem("coder:rightPanelWidth") ?? "", 10);
      } catch {
        return NaN;
      }
    })();
    // سقف پیش‌فرض: مقدار ذخیره‌شده فقط اگر از پیش‌فرض باریک‌تر باشد پذیرفته
    // می‌شود؛ در غیر این‌صورت پنل به پیش‌فرض (حداقلِ سایت) برمی‌گردد.
    return Number.isFinite(saved)
      ? Math.min(saved, RIGHT_PANEL_DEFAULT_WIDTH)
      : RIGHT_PANEL_DEFAULT_WIDTH;
  });
  // عرض رندرشده هرگز از انتخاب کاربر بزرگ‌تر نمی‌شود؛ مقدار ذخیره‌شدهٔ قدیمی
  // (مثلاً ۴۰۰) با پیش‌فرض جدید (۲۲۰) جایگزین می‌شود تا کاربری که یک‌بار درگ
  // کرده برای همیشه پنل پهن نبیند. بالا بردن دستی همیشه ممکن است.
  const [width, setWidth] = useState(() =>
    Math.min(chosen, RIGHT_PANEL_DEFAULT_WIDTH),
  );
  const asideRef = useRef<HTMLElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);

  // اندازهٔ ظرف واقعی: `.app-body` میزبان پنل است؛ عرضش = پنجره منهای
  // حاشیه‌ها. از ResizeObserver استفاده می‌کنیم (همان الگوی App.tsx) نه
  // window.innerWidth — تا تغییر عرض سایدبار هم حساب شود.
  const appBodyWidth = () => {
    const el = asideRef.current?.parentElement;
    const w = el?.clientWidth ?? 0;
    return w > 0 ? w : window.innerWidth;
  };

  const persist = (w: number) => {
    try {
      localStorage.setItem("coder:rightPanelWidth", String(w));
    } catch {
      /* حافظه در دسترس نیست — عرض فقط حفظ نمی‌شود */
    }
  };

  useEffect(() => {
    // اولین کلمپ: عرض ذخیره‌شده را در ظرف واقعی جا می‌دهیم.
    setWidth(clampRightPanelWidth(chosen, appBodyWidth()));
    const el = asideRef.current?.parentElement;
    if (!el || typeof ResizeObserver === "undefined") {
      // فالبک: بدون ResizeObserver فقط به ری‌سایز پنجره گوش می‌دهیم.
      const onResize = () => setWidth(clampRightPanelWidth(chosen, appBodyWidth()));
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const ro = new ResizeObserver(() => {
      setWidth(clampRightPanelWidth(chosen, el.clientWidth));
    });
    ro.observe(el);
    return () => ro.disconnect();
    // `chosen` عمداً خارج از deps: کلمپ با تغییر انتخاب کاربر (درگ) خودش
    // مستقیم ست می‌شود؛ اگر داخل deps بیاید هر حرکت درگ یک Observer نو می‌سازد.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen]);

  useEffect(() => {
    return () => {
      dragCleanup.current?.();
      dragCleanup.current = null;
    };
  }, []);

  // عرض زنده را برای پنل اسپلیت منتشر می‌کنیم و موقع بسته‌شدن صفرش می‌کنیم
  // تا فضای پنل آزاد بماند.
  useEffect(() => {
    rightPanelLiveWidth.current = width;
    return () => {
      rightPanelLiveWidth.current = 0;
    };
  }, [width]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const bodyLen = startW; // فقط برای وضوح؛ سقف از appBodyWidth خوانده می‌شود
    void bodyLen;
    const onMove = (ev: MouseEvent) => {
      const max = rightPanelMaxWidth(appBodyWidth());
      const raw = startW - (ev.clientX - startX);
      const w = Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(max, Math.round(raw)));
      setWidth(w);
      setChosen(w);
      persist(w);
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
      ref={asideRef}
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
        {/* هر سه کارت خالی‌اند → همین خط؛ هیچ کارتی خالی نمایش داده نمی‌شود. */}
        <TodosPageEmptyHint />
      </div>
    </aside>
  );
}

