// SSR/store test for the EXPLORE feature: one sub-agent run's calls live in the
// right-hand panel, never expanded in the chat transcript.
//
// ۱) openExplore: یک تب explore می‌سازد و کلیک دوباره همان تب را retarget می‌کند
//    (یکی به‌ازای هر چت، نه یک تب به‌ازای هر اجرا).
// ۲) کارت explore در چت: فرزندان فقط در پنل راست رندر می‌شوند، نه داخل چت.
// ۳) تب پنل: اجرای از‌دست‌رفته پیام graceful نشان می‌دهد (بدون کرش).
import "./_globals.ts";

const { renderToString } = await import("react-dom/server");
const { ExplorePanel } = await import("../src/components/ExplorePanel");
const { ChatMessageView } = await import("../src/components/ChatMessage");
const { useViewerTabs } = await import("../src/lib/viewerTabs");

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`, extra ?? "");
  }
}

function resetViewer() {
  useViewerTabs.setState({
    tabs: [],
    activeId: null,
    paneOpen: false,
    panelMode: false,
  } as never);
}

console.log("۱) openExplore → یک تب explore برای همان اجرا:");
{
  resetViewer();
  useViewerTabs.getState().openExplore("m-explore", 2, "Explore files");
  const st = useViewerTabs.getState();
  const exploreTabs = st.tabs.filter((t) => t.kind === "explore");
  check("دقیقاً یک تب explore ساخته شد", exploreTabs.length === 1, st.tabs);
  const tab = exploreTabs[0];
  check("تب به اجرای درست اشاره می‌کند", tab?.exploreMessageId === "m-explore" && tab?.exploreIndex === 2, tab);
  check("پنل راست باز شد", st.paneOpen === true);
  check("تب ساخته‌شده فعال است", st.activeId === tab?.id, st.activeId);

  // کلیک روی اجرای دیگر: همان تب به‌روز می‌شود (بدون تب اضافه).
  useViewerTabs.getState().openExplore("m-other", 5, "Explore docs");
  const st2 = useViewerTabs.getState();
  check("تب تکراری ساخته نشد", st2.tabs.filter((t) => t.kind === "explore").length === 1, st2.tabs);
  check(
    "همان تب به اجرای جدید اشاره می‌کند",
    st2.tabs.find((t) => t.kind === "explore")?.exploreIndex === 5,
    st2.tabs.find((t) => t.kind === "explore"),
  );
}

console.log("۲) کارت explore در چت: فرزندان فقط در پنل راست، نه در چت:");
{
  resetViewer();
  const msg = {
    id: "m-explore",
    role: "assistant" as const,
    content: "",
    createdAt: Date.now(),
    segments: [{ kind: "tool", index: 0 }] as never,
    toolActivity: [
      {
        tool: "explore",
        status: "done",
        args: { description: "map the reviewer flow" },
        summary: "map the reviewer flow",
        children: [
          { tool: "read", status: "done", args: { filePath: "src/a.ts" }, summary: "src/a.ts" },
          { tool: "grep", status: "done", args: { pattern: "openReview" }, summary: "3 hits" },
        ],
      },
    ] as never,
  };
  const html = renderToString(<ChatMessageView message={msg} />);
  check("کارت explore رندر شد", html.includes("tool-card explore"), html.slice(0, 300));
  check("ردیف فرزندان داخل چت رندر نشد", !html.includes("explore-call"));
  // سر کارت یک <button> بومی است (کلیک‌پذیر و قابل فوکوس با کیبورد) و به
  // openExplore وصل شده — همان چیزی که واقعاً رندر می‌شود، نه role تکراری.
  check(
    "سر کارت به‌صورت دکمهٔ بومی رندر شده و به پنل وصل است",
    html.includes('<button type="button" class="trace-head explore-card-open"'),
    html.slice(0, 300),
  );
  check(
    "نام و تعداد هر tool call در کارت نمایش داده شد",
    html.includes("explore-tool-chip") &&
      html.includes("explore-tool-n") &&
      html.includes("Read File") &&
      html.includes("Search Files"),
    html.slice(0, 400),
  );
}

console.log("۳) پنل explore: اجرای از‌دست‌رفته پیام روشن می‌دهد:");
{
  const html = renderToString(
    <ExplorePanel chatId="no-such-chat" messageId="no-such-msg" index={0} />,
  );
  check("پیام «از حافظه رفته» نشان داده شد", html.includes("viewer-empty"));
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`);
  process.exit(1);
}
console.log("\nهمه تست‌های پنل explore پاس شدند ✅");
process.exit(0);
