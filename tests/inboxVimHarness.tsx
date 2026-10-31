/**
 * Dev-only manual harness: mounts the REAL ScheduleInbox (with the real
 * useVimScroll/panePointer wiring) in a plain browser, with the desktop bridge
 * stubbed and the sidecar endpoints mocked, so j/k scrolling can be driven and
 * measured end-to-end without the Tauri shell.
 *
 * Run: npm run dev  →  open /tests/inbox-vim.html
 * In-page helpers: window.__t.state() / __t.press('j') / __t.focusComposer()
 */
import React from "react";
import { createRoot } from "react-dom/client";

// ---------------------------------------------------------------------------
// window.coder stub — MUST exist before lib/api loads (its module init calls
// api.onSidecarChanged at import time).
// ---------------------------------------------------------------------------
const coderStub: Record<string, unknown> = {
  getSidecarUrl: () => Promise.resolve("http://mock.sidecar"),
  probeSidecar: () => Promise.resolve("http://mock.sidecar"),
  getEnv: () => Promise.resolve(null),
  onSidecarChanged: () => () => {},
  onSidecarDead: () => () => {},
  onFlushPersist: () => () => {},
  flushPersistDone: () => {},
  onMigrateProgress: () => () => {},
  onBackupProgress: () => () => {},
  storeGet: () => Promise.resolve(null),
  storeSet: () => Promise.resolve(true),
  chatGet: () => Promise.resolve(null),
  getDataPath: () => Promise.resolve("/tmp/codifa-harness"),
  hasSettingsFile: () => Promise.resolve(false),
};
(window as unknown as Record<string, unknown>).coder = coderStub;

// ---------------------------------------------------------------------------
// Sidecar mock: the four endpoints the inbox polls.
// ---------------------------------------------------------------------------
const now = Math.floor(Date.now() / 1000);
const TASK = {
  id: "t1",
  name: "rivals-seo-article",
  prompt:
    "Weekly SEO article for healerglobal.com, original content (Persian), based on competitor research.\n\n" +
    "COMPETITOR SCAN (PERSIAN SITES ONLY):\n1. web_search using PERSIAN queries…\n".repeat(12),
  cron: "0 9 * * *",
  cron_label: "Every day at 09:00",
  enabled: true,
  root: "/tmp/codifa-harness",
  mode: "build",
  next_run: now + 3600,
};
const RUNS = [1, 2, 3].map((i) => ({
  id: `r${i}`,
  schedule_id: "t1",
  status: i === 3 ? "running" : "done",
  output:
    `## گزارش اجرای ${i}\n\n- نتیجهٔ اول: متن نمونهٔ بلند فارسی برای پر کردن صفحه و تست اسکرول. `.repeat(
      120,
    ) +
    "\n\n```bash\necho hello\n```",
  started_at: now - i * 3600,
  usage: { entries: [{ input: 1200, output: 3400 }] },
}));
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (path === "/health") return json({ ok: true });
  if (path === "/schedules") return json({ schedules: [TASK] });
  if (path.startsWith("/schedule-runs")) return json({ runs: RUNS });
  if (/^\/schedules\/[^/]+\/runs/.test(path)) return json({ runs: RUNS });
  return realFetch(input, init);
}) as typeof window.fetch;

// ---------------------------------------------------------------------------
// Harness UI: a fake chat window (transcript scroller + composer) wired with
// the REAL useVimScroll exactly like Chat.tsx, next to the REAL ScheduleInbox
// docked like the viewer pane.
// ---------------------------------------------------------------------------
const FakeChat = (props: {
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
}) => (
  <div ref={props.panelRef} className="harness-chat-panel">
    <div ref={props.scrollerRef} className="harness-transcript">
      {Array.from({ length: 30 }, (_, i) => (
        <p key={i}>پیام چت شمارهٔ {i + 1} — متن نمونه برای اسکرول.</p>
      ))}
    </div>
    <textarea
      className="harness-composer"
      placeholder="composer (stale-caret source)"
    />
  </div>
);

async function main() {
  await import("../src/styles/global.css");
  const { useStore } = await import("../src/lib/store");
  const { ScheduleInbox } = await import("../src/components/ScheduleInbox");
  const { useVimScroll } = await import("../src/lib/useVimScroll");
  const panePointer = await import("../src/lib/panePointer");
  const scrollKeys = await import("../src/lib/scrollKeys");
  const shortcuts = await import("../src/lib/shortcuts");

  // Debug surface: the REAL modules, for live inspection from the driver.
  (window as unknown as Record<string, unknown>).__m = {
    panePointer,
    scrollKeys,
    shortcuts,
  };

  useStore.setState({ scheduleInboxOpen: true, dir: "rtl" } as never);

  const chatScrollerRef = React.createRef<HTMLDivElement>();
  const chatPanelRef = React.createRef<HTMLDivElement>();
  const ChatKeys = () => {
    useVimScroll(chatScrollerRef, chatPanelRef);
    return null;
  };

  const root = createRoot(document.getElementById("root")!);
  root.render(
    <div className="harness">
      <ChatKeys />
      <FakeChat scrollerRef={chatScrollerRef} panelRef={chatPanelRef} />
      <div className="viewer-content harness-viewer">
        <div className="viewer-inbox-wrap">
          <ScheduleInbox />
        </div>
      </div>
    </div>,
  );

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const chatEl = () =>
    document.querySelector<HTMLElement>(".schedule-inbox-chat");

  (window as unknown as Record<string, unknown>).__t = {
    state: () => {
      const el = chatEl();
      const dlg = document.querySelector<HTMLElement>(".schedule-inbox");
      return {
        chatScrollTop: el?.scrollTop ?? null,
        scrollHeight: el?.scrollHeight ?? null,
        clientHeight: el?.clientHeight ?? null,
        overflowY: el ? getComputedStyle(el).overflowY : null,
        direction: el ? getComputedStyle(el).direction : null,
        dialogMounted: !!dlg,
        active: document.activeElement
          ? `${document.activeElement.tagName}.${
              (document.activeElement as HTMLElement).className || ""
            }`.slice(0, 80)
          : null,
      };
    },
    press: async (key: string) => {
      const target =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : document.body;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: `Key${key.toUpperCase()}`,
          bubbles: true,
          cancelable: true,
        }),
      );
      await sleep(500);
      return (window as unknown as Record<string, unknown>).__t && undefined;
    },
    focusComposer: () => {
      (document.querySelector(".harness-composer") as HTMLTextAreaElement | null)?.focus();
    },
    clickInboxCard: () => {
      const el = document.querySelector<HTMLElement>(".schedule-inbox-run");
      if (!el) return false;
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return true;
    },
  };

  // Minimal layout CSS (the real classes come from global.css).
  const style = document.createElement("style");
  style.textContent = `
    html, body, #root { height: 100%; margin: 0; }
    .harness { display: flex; height: 100%; }
    .harness-chat-panel { width: 38%; display: flex; flex-direction: column; border-right: 1px solid #444; }
    .harness-transcript { flex: 1; overflow-y: auto; padding: 12px; }
    .harness-composer { height: 60px; }
    .harness-viewer { flex: 1; }
  `;
  document.head.appendChild(style);

  await sleep(800);
  console.info("[harness] ready — use window.__t");
}

void main();
