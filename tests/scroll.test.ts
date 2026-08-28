import { isAtBottom } from "../src/lib/scroll";

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

if (failed > 0) {
  console.error(`\n❌ ${failed} تست ناموفق`);
  process.exit(1);
}
console.log("\n✅ همه تستهای isAtBottom پاس شدند");
