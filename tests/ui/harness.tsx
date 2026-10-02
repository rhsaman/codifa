/**
 * Live UI test harness for codifa's renderer.
 *
 * Open it through the web-only dev server (no Electron, no sidecar):
 *
 *   npm run dev:web
 *   → http://localhost:<port>/tests/ui/harness.html?scenario=<name>
 *
 * The real ChatPanel mounts against a stubbed `window.coder` (see
 * harness.html) and the zustand store is seeded per `?scenario=`:
 *
 *   composer — one empty chat; composer/paste tests.
 *   queue    — a long steer-pending user message plus long/short queued and
 *              steer bubbles; folding/clamping tests.
 *   empty    — no active chat; shell/empty-state tests.
 *
 * Exposed on `window.__ui` for browser drivers (playwright MCP tools, etc.):
 *   __ui.store               zustand store — .getState() / .setState(patch)
 *   __ui.dispatchPaste(text) dispatch a ClipboardEvent paste on .composer-input
 *   __ui.longText            N-line sample text for fold/clamp cases
 *
 * Notes for drivers:
 *   - React re-renders asynchronously: after any state-changing evaluate, wait
 *     ~300-500ms before asserting on the DOM.
 *   - Synthetic (untrusted) paste events NEVER trigger the browser's native
 *     insertion. A short paste must be asserted via `event.defaultPrevented
 *     === false` (the app takes the native path), not via textarea contents.
 */
import { createRoot } from "react-dom/client";
import { ChatPanel } from "../../src/components/Chat";
import { PlanPanel } from "../../src/components/PlanPanel";
import { useStore } from "../../src/lib/store";
import { injectThemeStyles } from "../../src/lib/themes";
import "../../src/styles/global.css";

injectThemeStyles();

const longText = (label: string, lines = 40) =>
  Array.from(
    { length: lines },
    (_, i) => `${label} line ${i + 1} for the live UI harness`,
  ).join("\n");

function initialState(scenario: string | null) {
  const now = Date.now();
  const chat = (extra: Record<string, unknown>) => ({
    id: "c1",
    title: "UI harness chat",
    mode: "coder",
    root: "/tmp/codifa-ui-harness",
    createdAt: now,
    updatedAt: now,
    messages: [],
    ...extra,
  });

  switch (scenario) {
    case "queue":
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [
          chat({
            messages: [
              {
                id: "m1",
                role: "user",
                content: longText("steer", 40),
                createdAt: now,
                steerPending: true,
              },
            ],
            queued: [
              { id: "q1", text: longText("queue", 40), kind: "queue", createdAt: now },
              { id: "q2", text: "short steer text", kind: "steer", createdAt: now },
            ],
          }),
        ],
      };
    case "empty":
      return { root: "/tmp/codifa-ui-harness", activeChatId: "", chats: [] };
    case "plan":
      // Plan-mode flow: planner reply (preamble + tool card) collapsed into a
      // Plan card, plus the pending plan-approval ask above the composer.
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [
          chat({
            mode: "plan",
            messages: [
              {
                id: "m1",
                role: "user",
                content: "برای رفع باگ لاگین پلن بنویس",
                createdAt: now,
              },
              {
                id: "m2",
                role: "assistant",
                mode: "plan",
                createdAt: now,
                content:
                  "دو نکته کلیدی پیدا کردم. هر دو تایید شد — پلن نهایی رو می‌بینم:\n" +
                  "## Plan\n1. **backend/graph.py** — کوت کردن گیت laya قبل از bind_tools\n" +
                  "2. **src/components/Chat.tsx** — نمایش کارت پلن و درخواست تأیید\n" +
                  "3. **backend/tests/test_plan_approval.py** — تست‌های گیت تأیید\n" +
                  "test: `pytest backend/tests/test_plan_approval.py`\n\n" +
                  "Files: backend/graph.py, src/components/Chat.tsx\n" +
                  "- هدف: توقف هدرِ توکن\n- سه فایل تغییر می‌کند\n- نتیجه: پلن پایدار",
                planDoc: {
                  title: "",
                  body:
                    "## Plan\n1. **backend/graph.py** — کوت کردن گیت laya قبل از bind_tools\n" +
                    "2. **src/components/Chat.tsx** — نمایش کارت پلن و درخواست تأیید\n" +
                    "3. **backend/tests/test_plan_approval.py** — تست‌های گیت تأیید\n" +
                    "test: `pytest backend/tests/test_plan_approval.py`\n\n" +
                    "Files: backend/graph.py, src/components/Chat.tsx\n" +
                    "- هدف: توقف هدرِ توکن\n- سه فایل تغییر می‌کند\n- نتیجه: پلن پایدار",
                  preamble: "دو نکته کلیدی پیدا کردم. هر دو تایید شد — پلن نهایی رو می‌بینم:",
                },
                toolActivity: [
                  {
                    tool: "grep",
                    status: "done",
                    args: { pattern: "laya" },
                    summary: "12 matches",
                  },
                ],
                segments: [
                  { kind: "text", text: "دو نکته کلیدی پیدا کردم. هر دو تایید شد — پلن نهایی رو می‌بینم:\n" },
                  { kind: "tool", index: 0 },
                ],
              },
            ],
            pendingAsk: {
              id: "a-harness",
              question: "Implementation plan",
              options: ["Approve — exit plan mode and start implementation"],
              style: "plan_approval",
            },
          }),
        ],
      };
    case "plan-panel":
    case "app":
      // Docked Plan viewer tab content (plan-panel = standalone full-width;
      // app = full App shell with the Plan tab open in the viewer group).
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [
          chat({
            messages: [
              {
                id: "m2",
                role: "assistant",
                mode: "plan",
                createdAt: now,
                content: "## Plan",
                planDoc: {
                  title: "Laya gate fix",
                  body:
                    "## Plan: رفع گیت Laya\n\n" +
                    "1. **backend/graph.py** — کوت کردن گیت laya قبل از `bind_tools_parallel`؛ امروز یک فراخوانی ۲-ابزاری با `step_route → cheap_step` خطای \"2 tool calls in one step not supported\" می‌دهد.\n" +
                    "2. **src/components/Chat.tsx** — پلن استریم‌شده در کارت Plan جمع می‌شود و پرامپت تأیید اضافه می‌شود.\n" +
                    "3. **backend/tests/test_plan_approval.py** — تست‌های جدید گیت.\n\n" +
                    "**test:** `pytest backend/tests/test_plan_approval.py` + `ruff check backend`\n\n" +
                    "Files: backend/graph.py, src/components/Chat.tsx, backend/tests/test_plan_approval.py\n" +
                    "- هدف: توقف هدررفت توکن در استپ‌های ارزان شکست‌خورده\n- سه فایل تغییر می‌کند\n- نتیجه: مسیریابی پایدار هر استپ",
                },
              },
            ],
          }),
        ],
      };
    case "composer":
    default:
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [chat({})],
      };
  }
}

const params = new URLSearchParams(window.location.search);
(useStore as any).setState(initialState(params.get("scenario")));// Browser drivers reach the store through this handle to seed or assert state.
(window as any).__ui = {
  store: useStore,
  longText,
  dispatchPaste(text: string) {
    const ta = document.querySelector<HTMLTextAreaElement>(".composer-input");
    if (!ta) throw new Error(".composer-input not found");
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const ev = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(ev);
    return { defaultPrevented: ev.defaultPrevented };
  },
};

const root = createRoot(document.getElementById("root")!);
if (params.get("scenario") === "plan-panel") {
  // Standalone docked Plan panel (the App viewer group isn't mounted here).
  root.render(
    <div style={{ display: "flex", height: "100vh", background: "var(--bg, #0b0e14)" }}>
      <PlanPanel />
    </div>,
  );
} else if (params.get("scenario") === "app") {
  // Full App shell (titlebar + sidebar + chat + viewer group) for real-dock
  // geometry checks (RTL insets, split widths). Plan tab opens after mount.
  const { App } = await import("../../src/App");
  const { useViewerTabs } = await import("../../src/lib/viewerTabs");
  root.render(<App />);
  useViewerTabs.getState().openPlan();
} else {
  root.render(<ChatPanel />);
}
