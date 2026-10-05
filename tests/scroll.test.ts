import { isAtBottom, distanceFromBottom, classifyScrollEvent, popupRowScrollTop, scrollPopupRowIntoView } from "../src/lib/scroll";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log("  ✅", name);
  else {
    failed++;
    console.error("  ❌", name, extra ?? "");
  }
}

console.log("isAtBottom:");
check(
  "در پایین (scrollTop = scrollHeight - clientHeight)",
  isAtBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 }) === true,
);
check(
  "کمی بالاتر از پایین (در حد eps) هنوز پایین حساب می‌شود",
  isAtBottom({ scrollHeight: 1000, scrollTop: 895, clientHeight: 100 }) === true,
);
check(
  "اسکرول به بالا → false",
  isAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 100 }) === false,
);
check(
  "با eps سفارشی (آستانهٔ تنگ‌تر)",
  isAtBottom({ scrollHeight: 1000, scrollTop: 890, clientHeight: 100 }, 5) === false,
);

console.log("distanceFromBottom:");
check(
  "در پایین → 0",
  distanceFromBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 }) === 0,
);
check(
  "اسکرول به بالا → فاصلهٔ مثبت",
  distanceFromBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 100 }) === 400,
);
check(
  "چند پیکسل از پایین → همان چند پیکسل",
  distanceFromBottom({ scrollHeight: 1000, scrollTop: 895, clientHeight: 100 }) === 5,
);

console.log("classifyScrollEvent:");
check(
  "programmatic scroll with no restore is reanchor, never cancel",
  (() => {
    const r = classifyScrollEvent(null, true);
    return r.fromReanchor === true && r.cancelRestore === false;
  })(),
);
check(
  "user scroll with no restore is a normal event",
  (() => {
    const r = classifyScrollEvent(null, false);
    return r.fromReanchor === false && r.cancelRestore === false;
  })(),
);
check(
  "user scroll during restore cancels restore",
  (() => {
    const r = classifyScrollEvent({ id: "m1", offset: 10 }, false);
    return r.fromReanchor === false && r.cancelRestore === true;
  })(),
);
check(
  "programmatic scroll during restore is reanchor, never cancel",
  (() => {
    const r = classifyScrollEvent({ id: "m1", offset: 10 }, true);
    return r.fromReanchor === true && r.cancelRestore === false;
  })(),
);

console.log("popupRowScrollTop:");
check(
  "ردیف پایین‌تر از نما → اسکرول به پایین",
  popupRowScrollTop({ scrollTop: 0, clientHeight: 200, rowTop: 500, rowHeight: 40 }) === 500 + 40 - 200 + 8,
);
check(
  "ردیف بالاتر از نما → اسکرول به بالا",
  popupRowScrollTop({ scrollTop: 400, clientHeight: 200, rowTop: 100, rowHeight: 40 }) === 100 - 8,
);
check(
  "ردیف داخل نما → بدون تغییر",
  popupRowScrollTop({ scrollTop: 0, clientHeight: 200, rowTop: 50, rowHeight: 40 }) === 0,
);

console.log("scrollPopupRowIntoView:");
check(
  "ردیف فعال پایین لیست، کانتینر را اسکرول می‌دهد (نه پنجره)",
  (() => {
    const row = { offsetTop: 500, offsetHeight: 40, offsetParent: null, scrollIntoView: () => {} };
    const container = { scrollTop: 0, clientHeight: 200, querySelector: (sel: string) => (sel === ".hist-card.kbd" ? row : null) };
    const ok = scrollPopupRowIntoView(container as unknown as HTMLElement, ".hist-card.kbd");
    return ok && (container as { scrollTop: number }).scrollTop === 500 + 40 - 200 + 8;
  })(),
);
check(
  "بدون ردیف فعال → false و بدون اسکرول",
  (() => {
    const container = { scrollTop: 0, clientHeight: 200, querySelector: () => null };
    const ok = scrollPopupRowIntoView(container as unknown as HTMLElement, ".hist-card.kbd");
    return ok === false && (container as { scrollTop: number }).scrollTop === 0;
  })(),
);

if (failed > 0) {
  console.error(`\n❌ ${failed} تست ناموفق`);
  process.exit(1);
}
console.log("\n✅ همه تستهای isAtBottom پاس شدند");
