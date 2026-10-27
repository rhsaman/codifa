// Unit tests for src/lib/slash.ts: slash parsing, pretty labels (no slash),
// prompt history and pinning (max 3).
// Run: node --experimental-strip-types src/lib/slash.test.ts

import {
  isSlashCommand,
  parseSlashInput,
  prettySlashLabel,
  slashTokenRange,
  slashCaretAt,
  migrateCommandNames,
  forgetCommands,
  SUBCOMMANDS,
  slashBody,
  commandFlags,
  slashFlagAt,
  flagValues,
  flagValueRows,
  flagPickInsert,
  parseScheduleFlags,
  stripFlagTokens,
  hasLandedFlag,
  recordHistory,
  togglePin,
  historyRows,
  historyTitle,
  historyMeta,
  recordCommandUsage,
  loadCommandUsage,
  sortCommandsByUsage,
  sortByRecentUsage,
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
  const p = parseSlashInput("/skill install owner/repo")
  check("name lowercased", p?.name === "skill", p)
  check("args kept", p?.args === "install owner/repo", p)
  check("bare command", parseSlashInput("/undo")?.name === "undo")
  check("non-slash is null", parseSlashInput("hi") === null)
}

console.log("3) prettySlashLabel has no leading slash:")
{
  check("compact", prettySlashLabel("/compact") === "Compact context")
  check(
    "skill with args",
    prettySlashLabel("/skill install owner/repo") === "Skill: install owner/repo",
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

console.log("6) historyRows bottom-anchored (oldest top, pins bottom):")
{
  const rows = historyRows(["b", "a"], ["/compact"])
  check("oldest first", rows[0] === "a" && rows[1] === "b", rows)
  check("pin last at bottom", rows[rows.length - 1] === "/compact", rows)
  check("no duplicate pin", rows.filter((r) => r === "/compact").length === 1, rows)
}

console.log("7) historyTitle/historyMeta (Codex-style card lines):")
{
  check("slash title = raw command name", historyTitle("/skill foo bar") === "skill")
  check("slash meta = args", historyMeta("/skill foo bar") === "foo bar")
  check("bare command meta = pretty label", historyMeta("/compact") === "Compact context")
  const long = "a fairly long prompt that should be truncated"
  check("plain title truncated with ellipsis", historyTitle(long).endsWith("…") && historyTitle(long).length <= 31, historyTitle(long))
  check("plain meta = full text", historyMeta("hello world") === "hello world")
}

console.log("8) slashTokenRange (composer token highlight):")
{
  const r1 = slashTokenRange("/compact foo")
  check("token covers /compact", r1?.start === 0 && r1?.end === 8, r1)
  const raw2 = "  /skill install foo"
  const r2 = slashTokenRange(raw2)
  check(
    "leading spaces kept",
    r2 !== null && raw2.slice(r2.start, r2.end) === "/skill",
    r2,
  )
  check("plain text is null", slashTokenRange("hello") === null)
  check("bare slash is null", slashTokenRange("/") === null)
}

console.log("9) recordCommandUsage + sortCommandsByUsage (recent-first popup):")
{
  let u: string[] = []
  u = recordCommandUsage("/compact", u)
  u = recordCommandUsage("/undo", u)
  u = recordCommandUsage("/compact extra args", u)
  check("last used moves to front", u[0] === "compact" && u[1] === "undo", u)
  check("args stripped to bare name", !u.some((x) => x.includes(" ")), u)
  const before = [...u]
  u = recordCommandUsage("plain text", u)
  check("non-slash ignored", JSON.stringify(u) === JSON.stringify(before), u)
  u = recordCommandUsage("/", u)
  check("bare slash ignored", JSON.stringify(u) === JSON.stringify(before), u)
  const cmds = [{ name: "help" }, { name: "compact" }, { name: "undo" }, { name: "clear" }]
  const sorted = sortCommandsByUsage(cmds, ["undo", "compact"])
  check(
    "used first newest-first",
    sorted[0].name === "undo" && sorted[1].name === "compact",
    sorted.map((c) => c.name),
  )
  check(
    "unused keep original order",
    sorted[2].name === "help" && sorted[3].name === "clear",
    sorted.map((c) => c.name),
  )
  check("empty usage keeps order", JSON.stringify(sortCommandsByUsage(cmds, [])) === JSON.stringify(cmds))
}

console.log("10) command usage persists across popup opens (storage round-trip):")
{
  const store: Record<string, string> = {}
  const stub = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v) },
    removeItem: (k: string) => { delete store[k] },
  }
  const g = globalThis as Record<string, unknown>
  const prevStorage = g.localStorage
  g.localStorage = stub
  try {
    recordCommandUsage("/compact")
    recordCommandUsage("/undo")
    const loaded = loadCommandUsage()
    check("storage keeps newest first", loaded[0] === "undo" && loaded[1] === "compact", loaded)
    const cmds = [{ name: "help" }, { name: "compact" }, { name: "undo" }]
    const sorted = sortCommandsByUsage(cmds, loaded)
    check("reopened popup sorts recent first", sorted[0].name === "undo" && sorted[1].name === "compact", sorted.map((c) => c.name))
  } finally {
    if (prevStorage === undefined) delete g.localStorage
    else g.localStorage = prevStorage
  }
}

console.log("11) /goal persistent goal labels:")
{
  const gp = parseSlashInput("/goal all tests pass")
  check("goal name is goal", gp?.name === "goal", gp)
  check("goal args kept", gp?.args === "all tests pass", gp)
  check("goal label with args", prettySlashLabel("/goal all tests pass") === "Goal: all tests pass")
  check("goal label bare", prettySlashLabel("/goal") === "Set a persistent goal")
}

console.log("12) sortByRecentUsage (shared command/skill sort):")
{
  const items = [{ slug: "b" }, { slug: "a" }, { slug: "c" }]
  const sorted = sortByRecentUsage(items, ["a"], (x) => x.slug)
  check("used first", sorted[0].slug === "a", sorted.map((x) => x.slug))
  check("unused keep order", sorted[1].slug === "b" && sorted[2].slug === "c", sorted.map((x) => x.slug))
}

console.log("13) slashCaretAt (multi-level completion):")
{
  // Level 1: the command itself is still being typed.
  const l1 = slashCaretAt("/plu", 4)
  check("level 0 on the command word", l1?.index === 0 && l1?.word === "plu", l1)
  // Level 2: after a space the caret owns the SUB-command, not the command.
  const l2 = slashCaretAt("/plugin ins", 11)
  check("level 1 after a space", l2?.index === 1 && l2?.word === "ins", l2)
  check("the command is remembered", l2?.prev[0] === "plugin", l2)
  // Level 3: the value the sub-command asked for.
  const l3 = slashCaretAt("/plugin install own", 19)
  check("level 2 is the value", l3?.index === 2 && l3?.word === "own" && l3?.prev[1] === "install", l3)
  // Level 4: the sub-folder / ref of an install.
  const l4 = slashCaretAt("/plugin install owner/repo sub", 28)
  check("level 3 keeps going", l4?.index === 3 && l4?.word === "sub", l4)
  // A caret inside an EARLIER word re-targets that word, so moving the caret
  // back re-opens the level it belongs to instead of closing the menu.
  const back = slashCaretAt("/plugin install x", 8)
  check("caret inside the sub-command", back?.index === 1 && back?.word === "install", back)
  check("trailing space yields an empty word", slashCaretAt("/plugin ", 8)?.word === "")
  check("plain text is null", slashCaretAt("hello", 3) === null)
}

console.log("14) SUBCOMMANDS table drives the menu and help:")
{
  check("plugin lists install/remove", (SUBCOMMANDS.plugin ?? []).some((s) => s.name === "install") && (SUBCOMMANDS.plugin ?? []).some((s) => s.name === "remove"), SUBCOMMANDS.plugin?.map((s) => s.name))
  check("skill update takes a name", (SUBCOMMANDS.skill ?? []).find((s) => s.name === "update")?.arg === "name")
  check("install takes a repo then free text", (SUBCOMMANDS.plugin ?? []).find((s) => s.name === "install")?.arg === "repo" && (SUBCOMMANDS.plugin ?? []).find((s) => s.name === "install")?.rest === "free")
  // A value level whose `rest` is `repo` would offer the repo names again for
  // the sub-folder and the branch — those are free text, not repo references.
  // Installing a connector bundle was implemented in the dispatcher but missing
  // from this table, so the menu could not offer it and `/help` hid it.
  check(
    "mcp offers install too (it was dispatcher-only)",
    (SUBCOMMANDS.mcp ?? []).some((s) => s.name === "install"),
    SUBCOMMANDS.mcp?.map((s) => s.name),
  )
  check("install does not complete path/ref with repo names", ["plugin", "skill", "mcp"].every((v) => { const s = (SUBCOMMANDS[v] ?? []).find((x) => x.name === "install"); return s?.rest === "free" }), [SUBCOMMANDS.plugin, SUBCOMMANDS.skill, SUBCOMMANDS.mcp])
  check("create is free text", (SUBCOMMANDS.mcp ?? []).find((s) => s.name === "create")?.arg === "free")
  check("goal has clear", (SUBCOMMANDS.goal ?? []).some((s) => s.name === "clear"))
}

console.log("15) slashBody drops the sub-command the menu itself offered:")
{
  // `/schedule create هر روز گزارش بده` used to forward the whole tail, so the
  // model was handed the description "create هر روز گزارش بده" inside a sentence
  // that already said "Create or edit a scheduled task …".
  check(
    "a known sub-command is stripped",
    slashBody("/schedule", "create هر روز گزارش بده") === "هر روز گزارش بده",
    slashBody("/schedule", "create هر روز گزارش بده"),
  )
  check("plain /plugin create drops it too", slashBody("/plugin", "create eurusd") === "eurusd")
  check("the same word works without a leading slash", slashBody("artifact", "create a chart") === "a chart")
  // A line with NO sub-command keeps every word: stripping the first one would
  // silently delete it from the description the model receives.
  check(
    "no sub-command keeps the whole tail",
    slashBody("/plugin", "یک پلاگین برای فارکس بساز") === "یک پلاگین برای فارکس بساز",
    slashBody("/plugin", "یک پلاگین برای فارکس بساز"),
  )
  check("an unknown first word is not a sub-command", slashBody("/skill", "frobnicate things") === "frobnicate things")
  check("empty stays empty", slashBody("/plugin", "   ") === "")
  check("a bare sub-command leaves nothing to describe", slashBody("/schedule", "create") === "")
  // Only the FIRST word: a description may legitimately contain a sub-command
  // name later on.
  check(
    "the rest is untouched",
    slashBody("/schedule", "create run this create task") === "run this create task",
    slashBody("/schedule", "create run this create task"),
  )
}

console.log("16) migrateCommandNames rewrites the stored lists once:")
{
  const store: Record<string, string> = {
    "coder:promptHistory": JSON.stringify(["/create-skill foo", "plain"]),
    "coder:pinnedCommands": JSON.stringify(["/create-mcp bar"]),
    "coder:commandUsage": JSON.stringify(["create-skill", "compact"]),
  }
  const stub = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v) },
    removeItem: (k: string) => { delete store[k] },
  }
  const g = globalThis as Record<string, unknown>
  const prevStorage = g.localStorage
  g.localStorage = stub
  try {
    migrateCommandNames()
    check("history renamed", store["coder:promptHistory"].includes("/skill foo") && !store["coder:promptHistory"].includes("create-skill"), store["coder:promptHistory"])
    check("pins renamed", store["coder:pinnedCommands"].includes("/mcp bar"), store["coder:pinnedCommands"])
    check("usage renamed", JSON.parse(store["coder:commandUsage"])[0] === "skill", store["coder:commandUsage"])
    // Idempotent: a second run must not touch an already-migrated list.
    const before = JSON.stringify(store)
    migrateCommandNames()
    check("second run is a no-op", JSON.stringify(store) === before, store)
  } finally {
    if (prevStorage === undefined) delete g.localStorage
    else g.localStorage = prevStorage
  }
}

console.log("16) forgetCommands drops the commands of a deleted plugin:")
{
  // A bundle's skills become `/`-commands; deleting the bundle removed them from
  // the palette but NOT from the history, the pins and the usage order, so the
  // dead name kept coming back as a pin and as a suggestion.
  const store: Record<string, string> = {
    "coder:promptHistory": JSON.stringify(["/notes-taker do it", "/compact", "/skill update x"]),
    "coder:pinnedCommands": JSON.stringify(["/notes-taker", "/plan"]),
    "coder:commandUsage": JSON.stringify(["notes-taker", "compact"]),
  }
  const stub = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = String(v)
    },
    removeItem: (k: string) => {
      delete store[k]
    },
  }
  const g = globalThis as Record<string, unknown>
  const prevStorage = g.localStorage
  g.localStorage = stub
  try {
    forgetCommands(["notes-taker"])
    check("its history line is gone", !store["coder:promptHistory"].includes("notes-taker"), store["coder:promptHistory"])
    check("other history lines survive", store["coder:promptHistory"].includes("/compact") && store["coder:promptHistory"].includes("/skill update x"), store["coder:promptHistory"])
    check("its pin is gone", !store["coder:pinnedCommands"].includes("notes-taker") && store["coder:pinnedCommands"].includes("/plan"), store["coder:pinnedCommands"])
    check("its usage is gone", !JSON.parse(store["coder:commandUsage"]).includes("notes-taker"), store["coder:commandUsage"])
    // A shared word is not a prefix match: `/skill` must not die with it.
    forgetCommands(["skill"])
    check("a built-in is only removed by its own name", !store["coder:promptHistory"].includes("/skill update x"), store["coder:promptHistory"])
    check("an empty list is a no-op", (() => {
      const before = JSON.stringify(store)
      forgetCommands([])
      return JSON.stringify(store) === before
    })())
  } finally {
    if (prevStorage === undefined) delete g.localStorage
    else g.localStorage = prevStorage
  }
}

console.log("17) schedule --flags: names, values and parsing:")
{
  check(
    "schedule offers the three flags",
    commandFlags("/schedule").map((f) => f.name).join(",") === "--skills,--mcp,--plugins",
    commandFlags("/schedule").map((f) => f.name),
  )
  check("a command without flags offers none", commandFlags("/plugin").length === 0)
  check(
    "each flag reads a real value list",
    commandFlags("/schedule").map((f) => f.values).join(",") === "skill,mcp,plugin",
    commandFlags("/schedule").map((f) => f.values),
  )

  // The flag-name level: `--mcp` typed at value level.
  const fl = slashFlagAt(slashCaretAt("/schedule create x --mc", 22)!, "/schedule")
  check("a flag word is recognized while typing", fl?.flag === "--mc", fl)
  check("no '=' yet means no typed value", fl?.typed === "", fl)
  // The value level: `--skills=fo` must complete `fo`, not the whole token.
  const fv = slashFlagAt(slashCaretAt("/schedule create x --skills=fo", 29)!, "/schedule")
  check("the flag is found with a value", fv?.flag === "--skills" && fv?.typed === "fo", fv)
  // A plain argument is not a flag, or the value menu would never open.
  check(
    "a plain value is not a flag",
    slashFlagAt(slashCaretAt("/schedule create هر", 18)!, "/schedule") === null,
  )
  check(
    "an unknown flag is rejected",
    slashFlagAt(slashCaretAt("/schedule create x --nope", 24)!, "/schedule") === null,
  )
  check("flagValues splits on commas", flagValues("a,b").join("|") === "a|b")
  check("flagValues ignores blanks", flagValues(" a , , b ").join("|") === "a|b")
  check("flagValues of empty is empty", flagValues("").length === 0)
}

console.log("18) parseScheduleFlags / stripFlagTokens:")
{
  // Repeating the flag ACCUMULATES, so picking several skills builds one list.
  const rep = parseScheduleFlags("create nightly --skills=a --skills=b,c --mcp=x --plugins=z")
  check("repeat accumulates", rep.skills.join(",") === "a,b,c", rep.skills)
  check("mcp is read", rep.mcp_servers.join(",") === "x", rep.mcp_servers)
  check("plugins is read", rep.plugins.join(",") === "z", rep.plugins)
  const none = parseScheduleFlags("create nightly report")
  check(
    "no flags = empty arrays",
    none.skills.length === 0 && none.mcp_servers.length === 0 && none.plugins.length === 0,
    none,
  )
  // The description must survive untouched — flags are arguments, not prose.
  check(
    "the description survives minus the flags",
    stripFlagTokens("create هر روز گزارش بده --skills=a") === "create هر روز گزارش بده",
    stripFlagTokens("create هر روز گزارش بده --skills=a"),
  )
  check("no flags leaves the text alone", stripFlagTokens("create foo") === "create foo")
  check("an unknown --word is kept", stripFlagTokens("create foo --nope") === "create foo --nope")
}

console.log("19) flagValueRows: the rows a --flag token offers:")
{
  const skills = ["anthropic-skills", "brainstorming", "data-analysis"]
  check("an empty fragment offers the whole list", flagValueRows(skills, "").length === 3)
  // The regression: `an` matched nothing through `rankMatches`, so the popup
  // read "No matching commands" while `anthropic-skills` was right there.
  check(
    "a fragment that matches nothing still shows the list",
    flagValueRows(skills, "zz").length === 3,
    flagValueRows(skills, "zz"),
  )
  check(
    "a matching fragment ranks the match first",
    flagValueRows(skills, "br")[0] === "brainstorming",
    flagValueRows(skills, "br"),
  )
  check(
    "a partial fragment still finds the name",
    flagValueRows(skills, "an")[0] === "anthropic-skills",
    flagValueRows(skills, "an"),
  )
  check(
    "an already-picked value is dropped",
    !flagValueRows(skills, "a,brainstorming").includes("brainstorming"),
    flagValueRows(skills, "a,brainstorming"),
  )
  // After a comma the user is choosing the NEXT value, so the fragment resets
  // and the whole remaining list is offered again.
  check(
    "a fresh value after a comma lists everything unpicked",
    flagValueRows(skills, "brainstorming,").length === 2,
    flagValueRows(skills, "brainstorming,"),
  )
  // The pick-again regression: a COMPLETE pick used to rank as a prefix, leave
  // one row (itself), the picked-filter dropped it, and the popup collapsed to
  // "All selected" with the whole rest of the list unshown.
  check(
    "a complete pick keeps offering the rest of the list",
    flagValueRows(skills, "brainstorming").length === 2,
    flagValueRows(skills, "brainstorming"),
  )
}

console.log("20) flagPickInsert: what a value pick writes over the typed part:")
{
  const skills = ["anthropic-skills", "brainstorming", "data-analysis"]
  // The pick-two regression: with `--skills=a` present, picking `b` wrote back
  // only `b`, so the first pick vanished from the line.
  check(
    "a second pick appends to the first",
    flagPickInsert("brainstorming", "data-analysis", skills) === "brainstorming,data-analysis",
    flagPickInsert("brainstorming", "data-analysis", skills),
  )
  // A partial fragment is its completion, not a kept stray (`an` +
  // `anthropic-skills` → `anthropic-skills`, never `an,anthropic-skills`).
  check(
    "a partial fragment is replaced by its completion",
    flagPickInsert("an", "anthropic-skills", skills) === "anthropic-skills",
    flagPickInsert("an", "anthropic-skills", skills),
  )
  check(
    "a mixed list keeps complete picks and replaces the fragment",
    flagPickInsert("anthropic-skills,an", "anthropic-skills", skills) === "anthropic-skills,anthropic-skills" &&
      flagPickInsert("brainstorming,da", "data-analysis", skills) === "brainstorming,data-analysis",
    flagPickInsert("brainstorming,da", "data-analysis", skills),
  )
  check("no pick yet writes the value itself", flagPickInsert("", "brainstorming", skills) === "brainstorming")
}

console.log("21) hasLandedFlag: when the flag menu stops auto-opening:")
{
  check("no flag is not landed", !hasLandedFlag(["create", "nightly", "report"]))
  check("a bare --flag is open, not landed", !hasLandedFlag(["create", "--skills"]))
  check("an empty value (--skills=) is open, not landed", !hasLandedFlag(["create", "--skills="]))
  check("a value word lands the flag", hasLandedFlag(["create", "--skills=brainstorming"]))
  check("a comma list lands the flag", hasLandedFlag(["create", "--skills=a,b", "nightly"]))
  check("an em-dash token counts too", hasLandedFlag(["create", "—skills=a,b"]))
  check("a non-flag word with = is prose, not landed", !hasLandedFlag(["create", "x=y"]))
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
} else {
  console.log("\nAll tests passed. ✅")
}
