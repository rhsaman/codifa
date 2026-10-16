// تست واحد برای arrowDir: تبدیل hast (دور فلش span می‌گذارد، کد را دست نمی‌زند) و
// تصمیم mirror بر اساس جای واقعی دو کاراکتر کناریِ فلش.
// اجرا: npx esbuild src/lib/arrowDir.test.ts --bundle --platform=node \
//        --format=esm --outfile=src/lib/.tmp-arrowDir.mjs && node src/lib/.tmp-arrowDir.mjs

import { flowRunsLeft, rehypeArrows } from "./arrowDir"

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`, extra ?? "")
  }
}

type N = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: N[] }
const text = (value: string): N => ({ type: "text", value })
const el = (tagName: string, children: N[]): N => ({ type: "element", tagName, children })
const run = (tree: N) => {
  rehypeArrows()(tree)
  return tree
}
const flat = (n: N): string => (n.children ?? []).map((c) => (c.type === "text" ? `[${c.value}]` : `<${c.tagName}${c.properties?.className ? "." + (c.properties.className as string[]).join(".") : ""}>${flat(c)}</${c.tagName}>`)).join("")

console.log("rehypeArrows")
const p = run(el("p", [text("کم شود (۱۶۰۷MB → ~۴۰۰MB) و ←")]))
check(
  "operands become LTR isolates, the arrow its own span, punctuation stays outside",
  flat(p) === "[کم شود (]<span.md-op>[۱۶۰۷MB]</span>[ ]<span.md-arrow>[→]</span>[ ]<span.md-op>[~۴۰۰MB]</span>[) و ←]",
  flat(p),
)
const op = (p.children ?? []).find((c) => c.tagName === "span" && (c.properties?.className as string[])[0] === "md-op")
check("operand isolates carry dir=ltr", op?.properties?.dir === "ltr", op?.properties)
const chain = run(el("p", [text("A → B → C")]))
check(
  "a chain isolates the middle operand once",
  flat(chain) === "<span.md-op>[A]</span>[ ]<span.md-arrow>[→]</span>[ ]<span.md-op>[B]</span>[ ]<span.md-arrow>[→]</span>[ ]<span.md-op>[C]</span>",
  flat(chain),
)
const glued = run(el("p", [text("src→dest")]))
check(
  "arrow glued to its operands",
  flat(glued) === "<span.md-op>[src]</span><span.md-arrow>[→]</span><span.md-op>[dest]</span>",
  flat(glued),
)
const nextToElement = run(el("p", [el("code", [text("a")]), text(" → "), el("code", [text("b")])]))
check(
  "operand in a neighbouring element: only the arrow is wrapped",
  flat(nextToElement) === "<code>[a]</code>[ ]<span.md-arrow>[→]</span>[ ]<code>[b]</code>",
  flat(nextToElement),
)
const code = run(el("p", [el("code", [text("a -> b → c")]), text(" x")]))
check("inline code is untouched", flat(code) === "<code>[a -> b → c]</code>[ x]", flat(code))
const link = run(el("p", [el("a", [text("go → there")])]))
check("link text is untouched", flat(link) === "<a>[go → there]</a>", flat(link))
const nested = run(el("ul", [el("li", [el("strong", [text("A ⇒ B")])])]))
check("arrows nested in emphasis/lists are found", flat(nested).includes("<span.md-arrow>[⇒]</span>"), flat(nested))
const plain = run(el("p", [text("no arrows here ->  or ←")]))
check("ASCII -> and left arrows are left alone", flat(plain) === "[no arrows here ->  or ←]", flat(plain))
const vs = run(el("p", [text("a →︎ b")]))
check("variation selector stays attached to the arrow", flat(vs).includes("[→︎]"), flat(vs))

console.log("flowRunsLeft")
const box = (l: number, r: number, t = 0, b = 20) => ({ left: l, right: r, top: t, bottom: b })
check("LTR flow: next is to the right -> do not mirror", flowRunsLeft(box(0, 40), box(80, 120)) === false)
check("RTL flow: next is to the left -> mirror", flowRunsLeft(box(80, 120), box(0, 40)) === true)
check("neighbours on different lines -> undecided", flowRunsLeft(box(80, 120, 0, 20), box(0, 40, 30, 50)) === null)
check("zero-size boxes -> undecided", flowRunsLeft(box(0, 0, 0, 0), box(10, 10, 0, 0)) === null)
check("same x -> undecided", flowRunsLeft(box(10, 20), box(10, 20)) === null)

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log("\nall good")
