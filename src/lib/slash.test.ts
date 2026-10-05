// Unit tests for src/lib/slash.ts: slash parsing, pretty labels (no slash),
// prompt history and pinning (max 3).
// Run: node --experimental-strip-types src/lib/slash.test.ts

import {
  isSlashCommand,
  parseSlashInput,
  prettySlashLabel,
  slashTokenRange,
  recordHistory,
  togglePin,
  historyRows,
  historyTitle,
  historyMeta,
  MAX_HISTORY,
  MAX_PINS,
} from "./slash"

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

console.log("1) isSlashCommand:")
{
  check("slash detected", isSlashCommand("/compact") === true)
  check("slash with leading space", isSlashCommand("  /help") === true)
  check("plain text is not slash", isSlashCommand("hello") === false)
  check("empty is not slash", isSlashCommand("   ") === false)
}

console.log("2) parseSlashInput:")
{
  const p = parseSlashInput("/create-skill summarize logs")
  check("name lowercased", p?.name === "create-skill", p)
  check("args kept", p?.args === "summarize logs", p)
  check("bare command", parseSlashInput("/undo")?.name === "undo")
  check("non-slash is null", parseSlashInput("hi") === null)
}

console.log("3) prettySlashLabel has no leading slash:")
{
  check("compact", prettySlashLabel("/compact") === "Compact context")
  check(
    "create-skill with args",
    prettySlashLabel("/create-skill summarize logs") === "Create skill: summarize logs",
  )
  check("undo", prettySlashLabel("/undo") === "Undo last exchange")
  check("no slash in label", !prettySlashLabel("/clear").startsWith("/"))
  check("non-slash passthrough", prettySlashLabel("hello") === "hello")
}

console.log("4) recordHistory dedupes and caps:")
{
  let h: string[] = []
  h = recordHistory("/compact", h)
  h = recordHistory("hello", h)
  h = recordHistory("/compact", h)
  check("re-submit moves to front", h[0] === "/compact" && h.length === 2, h)
  let big: string[] = []
  for (let i = 0; i < MAX_HISTORY + 10; i++) big = recordHistory(`p${i}`, big)
  check("capped at MAX_HISTORY", big.length === MAX_HISTORY, big.length)
  check("newest first", big[0] === `p${MAX_HISTORY + 9}`, big[0])
}

console.log("5) togglePin caps at 3, toggle off removes:")
{
  let pins: string[] = []
  pins = togglePin("/compact", pins)
  pins = togglePin("/undo", pins)
  pins = togglePin("/help", pins)
  pins = togglePin("/new", pins)
  check("max 3 pins", pins.length === MAX_PINS, pins)
  check("oldest evicted", !pins.includes("/compact") && pins.includes("/new"), pins)
  pins = togglePin("/new", pins)
  check("toggle off removes", !pins.includes("/new") && pins.length === 2, pins)
}

console.log("6) historyRows puts pins first:")
{
  const rows = historyRows(["b", "a"], ["/compact"])
  check("pin first", rows[0] === "/compact", rows)
  check("no duplicate pin", rows.filter((r) => r === "/compact").length === 1, rows)
}

console.log("7) historyTitle/historyMeta (Codex-style card lines):")
{
  check("slash title = raw command name", historyTitle("/create-skill foo bar") === "create-skill")
  check("slash meta = args", historyMeta("/create-skill foo bar") === "foo bar")
  check("bare command meta = pretty label", historyMeta("/compact") === "Compact context")
  const long = "a fairly long prompt that should be truncated"
  check("plain title truncated with ellipsis", historyTitle(long).endsWith("…") && historyTitle(long).length <= 31, historyTitle(long))
  check("plain meta = full text", historyMeta("hello world") === "hello world")
}

console.log("8) slashTokenRange (composer token highlight):")
{
  const r1 = slashTokenRange("/compact foo")
  check("token covers /compact", r1?.start === 0 && r1?.end === 8, r1)
  const raw2 = "  /create-skill foo"
  const r2 = slashTokenRange(raw2)
  check(
    "leading spaces kept",
    r2 !== null && raw2.slice(r2.start, r2.end) === "/create-skill",
    r2,
  )
  check("plain text is null", slashTokenRange("hello") === null)
  check("bare slash is null", slashTokenRange("/") === null)
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
} else {
  console.log("\nAll tests passed. ✅")
}
