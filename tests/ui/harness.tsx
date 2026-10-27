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
 *   composer    — one empty chat; composer/paste tests.
 *   queue       — a long steer-pending user message plus long/short queued and
 *                 steer bubbles; folding/clamping tests.
 *   empty       — no active chat; shell/empty-state tests.
 *   longhistory — 300 messages with a saved MID-history scroll position, so the
 *                 mounted window starts large; scrolling back to the newest
 *                 message must release those pages (transcript trim).
 *
 * Exposed on `window.__ui` for browser drivers (the app's browser tools, etc.):
 *   __ui.store               zustand store — .getState() / .setState(patch)
 *   __ui.dispatchPaste(text) dispatch a ClipboardEvent paste on .composer-input
 *   __ui.longText            N-line sample text for fold/clamp cases
 *   __ui.renderedMessages()  ids of the currently MOUNTED messages — the DOM
 *                            window size, used to assert the transcript trim
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

const artifactDoc = `<!DOCTYPE html>
<html><body style="font:14px system-ui;background:#0b0e14;color:#e6e6e6">
<h3 style="margin:0 0 8px">Fleet dashboard</h3>
<div id="v">waiting for live data…</div>
<script>
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m) return;
  if (m.source === "probe") {
    parent.postMessage({ source: "codifa-artifact", id: 2, tool: m.tool, args: {} }, "*");
    return;
  }
  if (m.source !== "codifa-artifact-reply") return;
  const text = m.ok ? m.result : "error: " + m.error;
  document.getElementById("v").textContent = text;
  // Report the received text back so a driver can assert the round trip
  // without reaching into an opaque-origin frame.
  parent.postMessage({ source: "codifa-artifact-received", id: m.id, text }, "*");
});
parent.postMessage({ source: "codifa-artifact", id: 1, tool: "list_containers", args: {} }, "*");
<\/script>
</body></html>`;

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
    case "longhistory": {
      // Long transcript PLUS a saved mid-history scroll position. The restore
      // path deliberately renders everything from the anchor up, so the panel
      // mounts a large window on first paint — exactly the state that used to
      // persist for the rest of the session because `msgLimit` only ever grew.
      // A driver scrolls back to the newest message and asserts the DOM shrinks.
      const COUNT = 300;
      const messages = Array.from({ length: COUNT }, (_, i) => ({
        id: `m${i + 1}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i + 1} of the long-history harness scenario`,
        createdAt: now + i,
      }));
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [
          chat({
            messages,
            scrollPos: { id: "m100", offset: 0, atBottom: false },
          }),
        ],
      };
    }
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
    case "artifact":
      // A multi-file artifact: the transcript card carries the supporting-file
      // list, and opening it docks the sandboxed preview tab. The panel also
      // answers a page's `mcp-call` message, so a driver can post one and see
      // the result flow back into the frame.
      return {
        root: "/tmp/codifa-ui-harness",
        activeChatId: "c1",
        chats: [
          chat({
            messages: [
              {
                id: "m1",
                role: "user",
                content: "build a dashboard with a rust backend",
                createdAt: now,
              },
              {
                id: "m2",
                role: "assistant",
                createdAt: now + 1,
                content: "",
                segments: [
                  {
                    kind: "artifact",
                    id: "dash",
                    title: "Fleet dashboard",
                    artifactKind: "html",
                    content: artifactDoc,
                    version: 2,
                    assets: ["backend.rs", "data.json"],
                  },
                ],
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
  renderedMessages(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-msg-id]")).map(
      (n) => n.dataset.msgId ?? "",
    );
  },
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
if (params.get("scenario") === "schedules") {
  // LIVE schedule-panel/inbox harness. The panel reads every row through the
  // sidecar HTTP API, so point `getSidecarUrl` at a REAL backend_light server
  // (examples/backend_live.rs) — its port arrives via `?backend=<port>` and is
  // remembered in localStorage so a reload keeps the same server. With a real
  // backend behind it this exercises the actual routes: save/toggle/run + the
  // run rows the inbox renders (running spinner, error body, done output).
  const coder = (window as unknown as { coder: Record<string, unknown> }).coder;
  const remember = (port: string) => {
    try {
      localStorage.setItem("codifa-ui:backend", port);
    } catch {
      /* private mode — the URL param still works for this page load */
    }
  };
  const fromUrl = params.get("backend");
  if (fromUrl) remember(fromUrl);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("codifa-ui:backend");
  } catch {
    stored = null;
  }
  const port = fromUrl ?? stored;
  if (!port) {
    root.render(
      <div style={{ padding: 24, font: "13px system-ui", color: "#e66" }}>
        No backend port. Open with ?backend=&lt;port of examples/backend_live.rs&gt;
      </div>,
    );
  } else {
    const base = `http://127.0.0.1:${port}`;
    coder.getSidecarUrl = () => Promise.resolve(base);
    coder.probeSidecar = () => Promise.resolve(true);
    const realFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Same-origin absolutization: the panel builds paths like "/schedules",
      // so prefix the live backend before they hit the page origin (vite).
      const target = url.startsWith("/") ? `${base}${url}` : url;
      return realFetch(target, init);
    }) as typeof window.fetch;
    const { ScheduleSection } = await import("../../src/components/SchedulePanel");
    const { ScheduleInbox } = await import("../../src/components/ScheduleInbox");
    const { useStore } = await import("../../src/lib/store");
    (window as any).__ui.schedule = {
      /** Seed the store rows directly (no listing round trip). */
      seed(tasks: unknown[]) {
        (useStore as any).setState({ schedules: tasks });
        // The panel's mount effect fetches only once `loaded` is true (in the
        // real app the persisted-state hydrate sets it); a bare mount in the
        // harness never hydrates, so seed() opens the same gate itself.
        (useStore as any).setState({ loaded: true });
      },
      /** Open the inbox overlay with one task selected. */
      openInbox(id?: string) {
        const s = (useStore as any).getState();
        if (id) s.setScheduleInboxSelected(id);
        s.setScheduleInboxOpen(true);
      },
      closeInbox() {
        (useStore as any).getState().setScheduleInboxOpen(false);
      },
      /** Re-list from the backend into the store (the panel's own refresh). */
      async refresh() {
        const mod = await import("../../src/lib/api");
        const rows = await mod.listSchedules();
        if (!Array.isArray(rows)) return rows;
        (useStore as any).setState({ schedules: rows });
        return rows;
      },
    };
    root.render(
      <div style={{ display: "flex", height: "100vh", background: "var(--bg, #0b0e14)" }}>
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }} dir="rtl">
          <ScheduleSection />
        </div>
        <ScheduleInbox />
      </div>,
    );
  }
} else if (params.get("scenario") === "diff") {
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
  //
  // `?sidecar=<port>` points the marketplace browse at a stub router (see
  // tests/ui/market-stub.mjs): without it every index read answers "no
  // backend" and the kind tabs have nothing to show, which is exactly what a
  // driver must be able to tell apart from a broken tab.
  const sidecarPort = params.get("sidecar") ?? "";
  if (sidecarPort) {
    const coder = (window as unknown as { coder: Record<string, unknown> }).coder;
    coder.getSidecarUrl = () => Promise.resolve(`http://127.0.0.1:${sidecarPort}`);
    coder.probeSidecar = () => Promise.resolve(true);
  }
  const { SettingsModal } = await import("../../src/components/SettingsModal");
  root.render(
    <SettingsModal onClose={() => {}} initialTab={params.get("tab") ?? "tools"} />,
  );
} else if (params.get("scenario") === "artifact") {
  // The real multi-file artifact flow, exercised through the REAL panel. Both
  // bridge calls go to the sidecar over HTTP, so this stubs `fetch` at that
  // boundary: `/artifacts/assets` answers the supporting-file list and
  // `/mcp/call` records the page's request. That way the panel's own parsing,
  // its narrow message guard and its reply are all under test.
  let mcpCalls: Array<{ tool: string; servers: string[] }> = [];
  // The panel reaches the sidecar through `getSidecarUrl`; without a URL both
  // effects bail out and the file list and page channel look dead. Point it at
  // a stub host — every request below is answered by the fetch stub, so nothing
  // ever leaves the page.
  const coder = (window as unknown as { coder: Record<string, unknown> }).coder;
  coder.getSidecarUrl = () => Promise.resolve("http://127.0.0.1:1");
  coder.probeSidecar = () => Promise.resolve(true);
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/artifacts/assets")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            files: [
              { path: "backend.rs", content: "fn main() {}" },
              { path: "data.json", content: '{"ok":true}' },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url.includes("/mcp/call")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        tool?: string;
        servers?: Record<string, unknown>;
      };
      mcpCalls.push({ tool: body.tool ?? "", servers: Object.keys(body.servers ?? {}) });
      return Promise.resolve(
        new Response(JSON.stringify({ result: `stub result for ${body.tool}` }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof window.fetch;
  (window as any).__ui.mcpCalls = () => mcpCalls;
  const { ArtifactPanel } = await import("../../src/components/ArtifactPanel");
  const { useStore } = await import("../../src/lib/store");
  const { useViewerTabs } = await import("../../src/lib/viewerTabs");
  (window as any).__ui.viewer = useViewerTabs;
  // One connector enabled, exactly as the composer would pass it: the page may
  // ask for a tool, and only this server's tools are reachable.
  (useStore as any).setState({
    settings: {
      ...(useStore as any).getState().settings,
      mcpServers: { proxmox: { url: "http://127.0.0.1:9/mcp" } },
      mcpEnabled: ["proxmox"],
    },
  });
  useViewerTabs.getState().openArtifact("c1", {
    id: "dash",
    title: "Fleet dashboard",
    kind: "html",
    body: artifactDoc,
    version: 2,
  });
  root.render(
    <div style={{ display: "flex", height: "100vh", background: "var(--bg, #0b0e14)" }}>
      <ArtifactPanel
        title="Fleet dashboard"
        kind="html"
        body={artifactDoc}
        chatId="c1"
        id="dash"
      />
    </div>,
  );
} else {
  root.render(<ChatPanel />);
}