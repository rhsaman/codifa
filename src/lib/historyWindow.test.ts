// Unit tests for the History turn limit (Settings → General): the wire history
// must be trimmed to the last N turns while compacted summaries survive.
// Run: npm run test:frontend  (registered in tests/run-frontend.sh)
import { applyHistoryLimit } from "./historyWindow"

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, extra ?? "")
  }
}

const U = (s: string) => ({ role: "user", content: s })
const A = (s: string) => ({ role: "assistant", content: s })
const S = (s: string) => ({ role: "system", content: s })

console.log("1) limit <= 0 keeps the full history (Off, the default):")
{
  const h = [U("u1"), A("a1"), U("u2"), A("a2")]
  check("0 -> unchanged", applyHistoryLimit(h, 0) === h)
  check("-1 -> unchanged", applyHistoryLimit(h, -1) === h)
  check("NaN -> unchanged", applyHistoryLimit(h, NaN) === h)
}

console.log("2) only the last N turns survive:")
{
  const h = [U("u1"), A("a1"), U("u2"), A("a2"), U("u3"), A("a3")]
  const out = applyHistoryLimit(h, 2)
  check(
    "2 turns kept (u2..a3)",
    JSON.stringify(out) === JSON.stringify(h.slice(2)),
  )
  check("first entry is the turn's user message", out[0].content === "u2")
}

console.log("3) fewer turns than the limit keeps everything:")
{
  const h = [U("u1"), A("a1")]
  check(
    "1 turn, limit 5 -> unchanged",
    JSON.stringify(applyHistoryLimit(h, 5)) === JSON.stringify(h),
  )
}

console.log("4) system summaries are always kept, in front:")
{
  const h = [
    S("[Compacted earlier context]"),
    U("u1"),
    A("a1"),
    U("u2"),
    A("a2"),
    U("u3"),
    A("a3"),
  ]
  const out = applyHistoryLimit(h, 1)
  check(
    "summary kept in front",
    out[0].role === "system" && out[0].content.includes("Compacted"),
  )
  check("summary + exactly one turn", out.length === 3)
  check("tail is u3/a3", out[1].content === "u3" && out[2].content === "a3")
}

console.log("5) tool call/result pairs are never orphaned:")
{
  const h = [
    U("u1"),
    { role: "assistant", content: "", tool_calls: [{ id: "t1" }] },
    { role: "tool", tool_call_id: "t1", content: "r1" },
    A("a1"),
    U("u2"),
    A("a2"),
  ]
  const out = applyHistoryLimit(h, 1)
  check(
    "kept only the last turn",
    JSON.stringify(out) === JSON.stringify(h.slice(4)),
  )
  check("no orphaned tool result at the head", out[0].role === "user")
}

console.log("6) the limit counts USER messages, not raw entries:")
{
  // One user turn can be followed by several assistant entries (rotate/steer).
  const h = [U("u1"), A("a1"), A("a1b"), U("u2"), A("a2")]
  check("2 turns kept -> all 5 entries", applyHistoryLimit(h, 2).length === 5)
  const one = applyHistoryLimit(h, 1)
  check(
    "last turn = u2 + a2 only",
    one.length === 2 && one[0].content === "u2" && one[1].content === "a2",
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log("\nAll history window checks passed")
