import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../lib/store";
import { prepareContent } from "../lib/bidi";
import type { ChatMessage } from "../types";

/** عرض ثابت پنل شناور (px) — برای clamp افقی و مهاجرت موقعیت قدیمی. */
const PANEL_W = 300;

/** وضعیت ذخیره‌شدهٔ پنل Todos (localStorage با کلید `coder:todoPanel`):
 *  فاصله از لبهٔ راست پنجره، فاصله از بالا، حالت جمع‌شده و ارتفاع محتوا.
 *  لنگرِ «راست» یعنی با بزرگ/کوچک‌شدن پنجره، فاصله از لبهٔ راست خودکار
 *  حفظ می‌شود و پنل از گوشه نمی‌پرد. */
interface TodoPanelUi {
  right?: number;
  y?: number;
  collapsed?: boolean;
  /** ارتفاع قدیمی (قبل از per-chat) — فقط به‌عنوان fallback چت‌های
   *  بدون ارتفاع ذخیره‌شده استفاده می‌شود. */
  height?: number;
  /** ارتفاع‌های صریحِ ریسایزشده به‌ازای هر چت — کلید = chatId؛ چت بدون
   *  رکورد پیش‌فرضِ بر اساس تعداد todo می‌گیرد. */
  heights?: Record<string, number>;
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

/** خواندن وضعیت ذخیره‌شدهٔ پنل؛ مهاجرت از نسخهٔ x (لنگر چپ) به right
 *  (لنگر راست) و قبل از آن فیلدهای todo قدیمیِ `coder:sidebarUi`. */
export function loadTodoPanelUi(): TodoPanelUi {
  try {
    const raw = localStorage.getItem("coder:todoPanel");
    if (raw) {
      const p = JSON.parse(raw) as TodoPanelUi & { x?: number };
      const { x, ...rest } = p;
      const ui: TodoPanelUi =
        rest.right === undefined && x !== undefined
          ? { ...rest, right: window.innerWidth - x - PANEL_W }
          : rest;
      // ارتفاع ۳۲۰ پیش‌فرض قدیمی بود (خیلی بلند) — در همهٔ مسیرها به
      // پیش‌فرض جدید ریست می‌شود؛ ارتفاع‌های دیگر انتخاب عمدی کاربرند.
      return ui.height === 320 ? { ...ui, height: undefined } : ui;
    }
    const legacy = localStorage.getItem("coder:sidebarUi");
    if (legacy) {
      const l = JSON.parse(legacy) as {
        todoCollapsed?: boolean;
        todoHeight?: number;
      };
      return {
        collapsed: l.todoCollapsed,
        height: l.todoHeight === 320 ? undefined : l.todoHeight,
      };
    }
  } catch {
    /* JSON خراب — پیش‌فرض‌ها برمی‌گردند */
  }
  return {};
}

/** پنل شناور همیشه قابل‌گرفتن بماند: افقی حداقل ۴۰px از پنل داخل
 *  viewport بماند؛ عمودی هدر (بالای پنل) از بالا/پایین پنجره بیرون نزند. */
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

/** ارتفاع مؤثر یک چت: اول ارتفاع صریحِ ریسایزشدهٔ همان چت، بعد ارتفاع قدیمی
 *  عمومی (fallback ذخیره‌های قدیمی) و در نهایت پیش‌فرض بر اساس تعداد todoها.
 *  خالص (pure) تا تست بتواند مستقیم صدا بزند. */
export function heightForChat(
  heights: Record<string, number> | undefined,
  legacyHeight: number | undefined,
  chatId: string,
  todoCount: number,
): number {
  return heights?.[chatId] ?? legacyHeight ?? defaultHeightFor(todoCount);
}

export function TodosPanel() {
  const chats = useStore((s) => s.chats);
  const activeChatId = useStore((s) => s.activeChatId);
  const dir = useStore((s) => s.dir);

  const todos = latestTodos(
    chats.find((c) => c.id === activeChatId)?.messages ?? [],
  );

  const [ui] = useState(loadTodoPanelUi);
  // جای پیش‌فرض: گوشهٔ بالا-راست، زیر نوار عنوان (titlebar ۳۸px + ۸px حاشیه).
  const [pos, setPos] = useState(() => ({
    right: ui.right ?? 16,
    y: ui.y ?? 46,
  }));
  const [collapsed, setCollapsed] = useState(ui.collapsed ?? false);
  const chatId = activeChatId || "";
  // ارتفاع‌های صریحِ ریسایزشدهٔ هر چت (کلید = chatId). ارتفاع مؤثر از همین
  // نقشه derive می‌شود: چتِ ریسایزشده مقدار خودش را نگه می‌دارد (سوییچ
  // چت همان مقدار برمی‌گردد) و چتِ بدون ریسایز زنده با تعداد todoهایش
  // بزرگ/کوچک می‌شود.
  const [heights, setHeights] = useState<Record<string, number>>(
    ui.heights ?? {},
  );
  const height = heightForChat(heights, ui.height, chatId, todos.length);

  // ذخیره با debounce (درگ هر فریم state عوض می‌کند؛ نوشتن localStorage در
  // هر فریم درگ را می‌لرزاند) + flush هم‌زمان روی بستن اپ — همان الگوی
  // coder:sidebarUi در سایدبار.
  const persist = () => {
    try {
      localStorage.setItem(
        "coder:todoPanel",
        JSON.stringify({
          right: pos.right,
          y: pos.y,
          collapsed,
          // ارتفاع قدیمی فقط pass-through می‌شود (fallback ذخیره‌های قدیمی)؛
          // ارتفاع‌های صریح فقط از ریسایز می‌آیند — چت‌های بدون ریسایز روی
          // پیش‌فرضِ بر اساس تعداد todo می‌مانند.
          height: ui.height,
          heights,
        }),
      );
    } catch {
      /* خطای quota — ذخیره نمی‌شود */
    }
  };
  useEffect(() => {
    const t = setTimeout(persist, 250);
    return () => clearTimeout(t);
  }, [pos, collapsed, heights]);
  useEffect(() => {
    window.addEventListener("coder:flush-ui", persist);
    window.addEventListener("beforeunload", persist);
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("coder:flush-ui", persist);
      window.removeEventListener("beforeunload", persist);
      window.removeEventListener("pagehide", persist);
    };
  }, [pos, collapsed, heights]);

  // ریسپانسیو: چون لنگر «راست/بالا» است، فاصله از لبه‌ها با تغییر اندازهٔ
  // پنجره خودکار حفظ می‌شود؛ فقط اگر پنل بیرون از viewport بیفتد (مثلاً
  // مانیتور کوچک‌تر) به داخل کشیده می‌شود.
  useEffect(() => {
    const clamp = () =>
      setPos((p) => {
        const c = clampPos(p.right, p.y, window.innerWidth, window.innerHeight);
        return c.right === p.right && c.y === p.y ? p : c;
      });
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  // درگ هدر برای جابه‌جایی پنل. کلیکِ بدون حرکت همچنان collapse را toggle
  // می‌کند — با پرچم suppressClick بعد از درگ واقعی، click دور می‌شود.
  const moveDrag = useRef<{
    startX: number;
    startY: number;
    right: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const startMove = (e: React.MouseEvent) => {
    e.preventDefault();
    moveDrag.current = {
      startX: e.clientX,
      startY: e.clientY,
      right: pos.right,
      y: pos.y,
      moved: false,
    };
    const onMove = (ev: MouseEvent) => {
      if (!moveDrag.current) return;
      const dx = ev.clientX - moveDrag.current.startX;
      const dy = ev.clientY - moveDrag.current.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moveDrag.current.moved = true;
      setPos(
        clampPos(
          moveDrag.current.right - dx,
          moveDrag.current.y + dy,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    };
    const onUp = () => {
      if (moveDrag.current?.moved) suppressClick.current = true;
      moveDrag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // هندل بالای بدنه: کشیدن به پایین = کوچک‌شدن از بالا. y پنل هم‌زمان
  // با ارتفاع جابه‌جا می‌شود تا لبهٔ پایین پنل سر جای خودش بماند و فقط
  // لبهٔ بالا حرکت کند — همان رفتار ریسایز پنجره‌های OS.
  const heightDrag = useRef<{
    startY: number;
    startH: number;
    panelY: number;
  } | null>(null);
  const startHeightResize = (e: React.MouseEvent) => {
    e.preventDefault();
    heightDrag.current = {
      startY: e.clientY,
      startH: height,
      panelY: pos.y,
    };
    const onMove = (ev: MouseEvent) => {
      // مقادیر درگ را قبل از setPos در متغیر محلی می‌گیریم — updaterِ
      // setPos ممکن است بعد از mouseup اجرا شود، وقتی ref را null کرده‌ایم.
      const drag = heightDrag.current;
      if (!drag) return;
      const dy = ev.clientY - drag.startY;
      const h = Math.max(60, Math.min(760, drag.startH - dy));
      setHeights((prev) => withChatHeight(prev, chatId, h));
      setPos((p) => ({
        ...p,
        y: Math.max(8, drag.panelY + (drag.startH - h)),
      }));
    };
    const onUp = () => {
      heightDrag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // هندل پایین بدنه: کشیدن به پایین = بزرگ‌شدن از پایین (y ثابت می‌ماند).
  const startBottomResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const h = Math.max(60, Math.min(760, startH + dy));
      setHeights((prev) => withChatHeight(prev, chatId, h));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (todos.length === 0) return null;

  return createPortal(
    <div
      className={`sidebar-panel todos-float${collapsed ? " collapsed" : ""}`}
      dir={dir}
      style={{ right: pos.right, top: pos.y }}
    >
      <div
        className="sidebar-panel-head"
        title="Drag to move · click to collapse"
        onMouseDown={startMove}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          setCollapsed((v) => !v);
        }}
      >
        <span className="sidebar-panel-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="sidebar-panel-title">Todos</span>
        <span className="sidebar-panel-count">
          {todos.filter((t) => t.status === "completed").length}/{todos.length}
        </span>
      </div>
      {!collapsed && (
        <>
          {/* دستگیرهٔ بالا: با position:absolute روی لبهٔ بالای کادر
              (روی هدر) — کشیدن به بالا بزرگ می‌کند (y هم‌زمان جابه‌جا
              می‌شود). */}
          <div
            className="sidebar-panel-resize"
            title="Drag down to shrink from the top, up to grow"
            onMouseDown={startHeightResize}
          />
          {/* height ثابت (نه maxHeight) تا ریسایز همیشه اثر بصری داشته
              باشد حتی وقتی محتوا کوتاه‌تر است — لیست خودش اسکرول می‌شود. */}
          <ul className="sidebar-todos-list" style={{ height }}>
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
          {/* دستگیرهٔ پایین: روی لبهٔ پایین باکس (بعد از لیست) — کشیدن
              به پایین بزرگ می‌کند. */}
          <div
            className="sidebar-panel-resize bottom"
            title="Drag down to grow, up to shrink from the bottom"
            onMouseDown={startBottomResize}
          />
        </>
      )}
    </div>,
    document.body,
  );
}
