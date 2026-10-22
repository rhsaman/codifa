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
 * Exposed on `window.__ui` for browser drivers (the app's browser tools, etc.):
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

/** A small unified diff so the click-opened preview has something to scroll. */
const sampleDiff = (label: string) =>
  [
    `--- a/src/${label}.ts`,
    `+++ b/src/${label}.ts`,
    "@@ -1,7 +1,9 @@",
    " const a = 1",
    "-const b = 2",
    `+const b = 3 // ${label}`,
    " const c = 4",
    " const d = 5",
    `+const e = 6 // ${label} continued`,
    " const f = 7",
    " const g = 8",
  ].join("\n");

function initialState(scenario: string | null) {
  const now = Date.now();
  const chat = (extra: Record<string, unknown>) => ({
    id: "c1",
    title: "UI harness chat",
    mode: "build",
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
    case "terminal":
      // Terminal panel with a stubbed pty (see the driver below): lets a
      // browser driver assert that a fit does NOT oscillate — every resize
      // pushed to the pty makes the shell redraw its prompt line, which is
      // what looked like "extra characters typed by themselves".
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [chat({})],
        terminalPanelOpen: true,
      };
    case "explore":
      // Two PARALLEL explore runs in one step plus a read: the group header
      // must show one pill per explore carrying its short description (so the
      // user can tell what each one is looking for) instead of collapsing
      // them into a single "Explore ×2" count.
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [
          chat({
            messages: [
              {
                id: "m1",
                role: "assistant",
                createdAt: now,
                content: "",
                toolActivity: [
                  {
                    tool: "explore",
                    status: "running",
                    args: {
                      description: "Find the auth flow",
                      prompt: "where is login handled",
                    },
                  },
                  {
                    tool: "explore",
                    status: "done",
                    args: {
                      description: "Map the settings store",
                      prompt: "how are settings persisted",
                    },
                    summary: "4 files",
                  },
                  { tool: "read", status: "done", args: { filePath: "a.ts" }, summary: "1 file" },
                ],
              },
            ],
          }),
        ],
      };
    case "retry":
      // A sub-agent (explore) retry banner mid-turn, plus a completed tool
      // card above it. Drives the "Sub-agent retrying (attempt N/10)" banner
      // and proves the parent's own tool events keep it alive.
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [
          chat({
            messages: [
              {
                id: "m1",
                role: "user",
                content: "explore the retry logic",
                createdAt: now,
              },
              {
                id: "m2",
                role: "assistant",
                createdAt: now,
                content: "",
                toolActivity: [
                  {
                    tool: "explore",
                    status: "running",
                    args: {
                      description: "Map the retry ladder",
                      prompt: "where is the retry ladder defined",
                    },
                  },
                ],
                retry: {
                  attempt: 3,
                  maxAttempts: 10,
                  delay: 10,
                  reason: "provider returned 429 (rate limit)",
                  model: "claude-sonnet-4-5",
                  agent: "explore subagent",
                  tool: "explore",
                  reconnecting: true,
                  startedAt: now,
                },
              },
            ],
          }),
        ],
      };
    case "retry-main":
      // The MAIN agent retry banner — the reference the sub-agent must match.
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [
          chat({
            messages: [
              {
                id: "m1",
                role: "user",
                content: "do the thing",
                createdAt: now,
              },
              {
                id: "m2",
                role: "assistant",
                createdAt: now,
                content: "",
                retry: {
                  attempt: 3,
                  maxAttempts: 10,
                  delay: 10,
                  reason: "provider returned 429 (rate limit)",
                  model: "claude-sonnet-4-5",
                  agent: "main agent",
                  reconnecting: true,
                  startedAt: now,
                },
              },
            ],
          }),
        ],
      };
    case "retry-giveup":
      // A sub-agent that exhausted its ladder: the banner must survive the
      // finished turn (gaveUp) and offer Retry.
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [
          chat({
            messages: [
              {
                id: "m1",
                role: "user",
                content: "explore the retry logic",
                createdAt: now,
              },
              {
                id: "m2",
                role: "assistant",
                createdAt: now,
                content: "",
                retry: {
                  attempt: 10,
                  maxAttempts: 10,
                  delay: 0,
                  reason: "sub-agent failed: provider unreachable",
                  model: "claude-haiku-4-5",
                  agent: "explore subagent",
                  tool: "explore",
                  gaveUp: true,
                },
              },
            ],
          }),
        ],
      };
    case "hoverdiff":
      // Three stacked edit rows in ONE message. The diff preview is CLICK-opened
      // from the `Review ↗` pill: clicking one row's pill must show THAT file's
      // diff (never a neighbour's), stay up until ✕/Escape/outside press, and
      // offer Copy/Reply when text inside it is selected. A plain row click must
      // still open the side Review panel instead.
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [
          chat({
            messages: [
              {
                id: "m1",
                role: "assistant",
                createdAt: now,
                content: "",
                toolActivity: ["first", "second", "third"].map((label) => ({
                  tool: "edit_file",
                  status: "done",
                  args: { path: `src/${label}.ts` },
                  diff: sampleDiff(label),
                  diffStats: { adds: 3, dels: 1 },
                })),
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
if (params.get("scenario") === "diff") {
  // DiffView alone: lets a browser driver select diff text and assert the
  // Copy/Reply toolbar appears instead of the comment editor opening directly.
  const { DiffView } = await import("../../src/components/ToolCallView");
  const sample = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,3 +1,3 @@",
    " const a = 1",
    "-const b = 2",
    "+const b = 3",
    " const c = 4",
  ].join("\n");
  root.render(
    <div style={{ padding: 24, background: "var(--bg, #0b0e14)" }}>
      <DiffView diff={sample} path="x.ts" layout="unified" />
    </div>,
  );
} else if (params.get("scenario") === "terminal") {
  // Stub the pty bridge: one live session, and a counter of every resize the
  // panel pushes (the oscillation signal). Data is echoed back so the screen
  // renders something.
  const resizes: Array<{ cols: number; rows: number }> = [];
  const writes: string[] = [];
  const dataCbs: Array<(id: string, data: string) => void> = [];
  const coder = (window as unknown as { coder: Record<string, unknown> }).coder;
  coder.terminalCreate = () =>
    Promise.resolve({ id: "t1", shell: "zsh", cwd: "/tmp/codifa-ui-harness" });
  coder.terminalList = () =>
    Promise.resolve([{ id: "t1", shell: "zsh", cwd: "/tmp/codifa-ui-harness" }]);
  coder.terminalWrite = (_id: string, data: string) => {
    writes.push(data);
    // Echo like a shell would, so the screen shows the typed text.
    dataCbs.forEach((cb) => cb("t1", data));
    return Promise.resolve(true);
  };
  coder.terminalResize = (_id: string, cols: number, rows: number) => {
    resizes.push({ cols, rows });
    return Promise.resolve(true);
  };
  coder.terminalKill = () => Promise.resolve(true);
  coder.onTerminalData = (cb: (id: string, data: string) => void) => {
    dataCbs.push(cb);
    return () => {
      const i = dataCbs.indexOf(cb);
      if (i >= 0) dataCbs.splice(i, 1);
    };
  };
  coder.onTerminalExit = () => () => {};
  // `emitData` drives the pty -> renderer direction directly: a driver can
  // replay a REAL captured byte stream (exactly what the Rust pty reader
  // forwards) into the mounted xterm and inspect how it renders, including
  // ANSI colours, without a live shell.
  (window as any).__term = {
    resizes,
    writes,
    emitData: (data: string) => dataCbs.forEach((cb) => cb("t1", data)),
  };
  const { TerminalPanel } = await import("../../src/components/TerminalPanel");
  root.render(<TerminalPanel />);
} else if (params.get("scenario") === "diff") {
  // Diff panel (git/review) for the highlight -> Copy/Reply flow: a selection
  // must arm the toolbar, and the reply must state the path + line ONCE (the
  // `[path line N]` marker the diff embeds is stripped by formatFileComment).
  const { DiffView } = await import("../../src/components/ToolCallView");
  root.render(
    <div style={{ padding: 20, background: "var(--bg, #0b0e14)", color: "#ddd" }}>
      <DiffView
        diff={"@@ -1,4 +1,5 @@\n context line\n-removed line\n+added line\n+another added\n"}
        path="backend/tests/test_test_execution_rule.py"
      />
    </div>,
  );
} else if (params.get("scenario") === "plan-panel") {
  // Standalone docked Plan panel (the App viewer group isn't mounted here).
  root.render(
    <div style={{ display: "flex", height: "100vh", background: "var(--bg, #0b0e14)" }}>
      <PlanPanel />
    </div>,
  );
} else if (params.get("scenario") === "browser") {
  // Real BrowserPanel against the REAL native Rust router (src-tauri/src/browser.rs).
  // `?port=<router port>` points the panel's sidecarFetch at the running app, so
  // this exercises the migrated /browser/* endpoints end-to-end in a browser.
  const port = params.get("port") ?? "";
  const coder = (window as unknown as { coder: Record<string, unknown> }).coder;
  coder.getSidecarUrl = () => Promise.resolve(port ? `http://127.0.0.1:${port}` : null);
  coder.probeSidecar = () => Promise.resolve(true);
  const { BrowserPanel } = await import("../../src/components/BrowserPanel");
  root.render(
    <div style={{ display: "flex", height: "100vh", background: "var(--bg, #0b0e14)" }}>
      <BrowserPanel chatId="probe-native" />
    </div>,
  );
} else if (params.get("scenario") === "app") {
  // Full App shell (titlebar + sidebar + chat + viewer group) for real-dock
  // geometry checks (RTL insets, split widths). Plan tab opens after mount.
  const { default: App } = await import("../../src/App");
  const { useViewerTabs } = await import("../../src/lib/viewerTabs");
  // The viewer-tabs store is a second zustand store; expose it so a driver
  // can open files and assert the rail/pane without importing a duplicate
  // module instance.
  (window as any).__ui.viewer = useViewerTabs;
  root.render(<App />);
  useViewerTabs.getState().openPlan();
} else if (params.get("scenario") === "settings") {
  // Standalone Settings modal, so a browser driver can visually check the
  // grouped tabs and the Tools rows. `?tab=<id>` picks the initial tab.
  const { SettingsModal } = await import("../../src/components/SettingsModal");
  root.render(
    <SettingsModal onClose={() => {}} initialTab={params.get("tab") ?? "tools"} />,
  );
} else {
  root.render(<ChatPanel />);
}