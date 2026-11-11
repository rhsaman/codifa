// SSR/store test for the EXPLORE feature: one sub-agent run's calls live in the
// chat transcript as a ToolGroupView card (agent name in the header, inner
// calls as trace rows once the user expands it).
//
// ۱) openExplore: یک تب explore می‌سازد و کلیک دوباره همان تب را retarget می‌کند
//    (یکی به‌ازای هر چت، نه یک تب به‌ازای هر اجرا).
// ۲) کارت explore در چت: مثل tool group با pill نام ساب‌ایجنت؛ فرزندان فقط با
//    بازشدن درجا رندر می‌شوند، نه در حالت جمع‌شده.
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

console.log("۲) کارت explore در چت: مثل tool group با pill نام؛ فرزندان فقط با بازشدن درجا:");
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
  check(
    "کارت با قاب tool-trace و یک گروه tool-group رندر شد",
    html.includes("tool-trace") && (html.match(/tool-group/g) || []).length === 1,
    html.slice(0, 300),
  );
  check("کارت explore قدیمی رندر نشد", !html.includes("tool-card explore"));
  check(
    "ردیف فرزندان در حالت جمع‌شده رندر نشد",
    !html.includes("explore-call") && !html.includes("trace-row-head"),
  );
  // سر گروه یک <button> بومی است (کلیک‌پذیر و قابل فوکوس با کیبورد) و گروه
  // را درجا باز/بسته می‌کند — همان ساختار گروه ابزار معمولی.
  check(
    "سر گروه به‌صورت دکمهٔ بومی رندر شده",
    /<button[^>]*class="trace-head /.test(html),
    html.slice(0, 300),
  );
  check(
    "نام ساب‌ایجنت («Explore») اولِ هدر است",
    /trace-head-name[^>]*>Explore</.test(html),
    html.slice(0, 300),
  );
  check(
    "نام آخرین tool call (Search Files برای grep) در هدر هست",
    /trace-head-tool[^>]*>Search Files</.test(html),
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
