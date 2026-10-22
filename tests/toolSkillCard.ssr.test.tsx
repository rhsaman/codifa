// SSR sanity test for the tool card a skill load renders in chat.
// A `load_skill` call used to read `load_skill  name:ponytail` and dump the raw
// arg (`name: pony`) in the expanded body — the tool name doubled as the label
// and its only meaningful arg was printed as machine text. The card must label
// itself and show the SKILL, not the arg key.

;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  innerWidth: 1200,
  innerHeight: 800,
  localStorage: {
    _d: {} as Record<string, string>,
    getItem(k: string) {
      return this._d[k] ?? null
    },
    setItem(k: string, v: string) {
      this._d[k] = String(v)
    },
    removeItem(k: string) {
      delete this._d[k]
    },
  },
  coder: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return undefined
        return async () => ({ ok: true, data: null })
      },
    },
  ),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).openExternal = async () => {}

const React = await import("react")
const { renderToStaticMarkup } = await import("react-dom/server")
const { ToolCallView, ToolSingleRow, toolLabel } = await import("../src/components/ToolCallView")

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

const loadSkill = {
  tool: "load_skill",
  // The backend stamps the tool NAME as the summary — the reason the row used
  // to read like a log line instead of "Load Skill · ponytail".
  summary: "load_skill",
  args: { name: "ponytail" },
  status: "done" as const,
  callId: "call-1",
  elapsedMs: 7,
}

console.log("1) the label names the action:");
check("load_skill has a human label", toolLabel("load_skill") === "Load Skill", toolLabel("load_skill"))
check(
  "the legacy `skill` alias renders the same label",
  toolLabel("skill") === "Load Skill",
  toolLabel("skill"),
)

console.log("2) the collapsed row shows the skill, not the arg key:");
const html = renderToStaticMarkup(
  React.createElement(ToolSingleRow, { activity: loadSkill as any }),
)
check("the row does not print `name:` in its head", !html.includes("name:ponytail"), html.slice(0, 400))
check("the row does not print the raw tool name twice", !html.includes(">load_skill<"), html.slice(0, 400))
check("the skill name is visible on the row", html.includes("ponytail"), html.slice(0, 400))
check("the row is labelled Load Skill", html.includes("Load Skill"), html.slice(0, 400))

console.log("3) the row body does not repeat the tool name as a summary:");
{
  // The chat transcript renders a plain call through ToolSubRow, which prints
  // the arg chips AND the backend summary side by side. For `load_skill` the
  // summary is the literal tool name, so the row read
  // "Load Skill  ponytail  load_skill".
  const { ToolSubRow } = await import("../src/components/ToolCallView")
  const sub = renderToStaticMarkup(
    React.createElement(ToolSubRow, { activity: loadSkill as any }),
  )
  check("the skill name is the row detail", sub.includes("ponytail"), sub)
  check("the tool name is not printed as a second detail", !sub.includes("load_skill"), sub)
  check("no raw `name:` arg leaks into the row", !sub.includes("name:"), sub)
}

console.log("4) the full card head states which skill was loaded:");
{
  // The card's own label is only "Load Skill" and the raw `name` arg is
  // filtered out of the head chips, so without a dedicated span the card never
  // said WHICH skill the turn pulled in.
  const card = renderToStaticMarkup(
    React.createElement(ToolCallView, { activity: loadSkill as any }),
  )
  check("the card head names the skill", card.includes("ponytail"), card.slice(0, 600))
  check("the card head labels the action", card.includes("Load Skill"), card.slice(0, 600))
  check("the skill is its own chip, not an arg key", !card.includes("name:ponytail"), card.slice(0, 600))
  check(
    "the card body does not repeat the tool name as a summary",
    !card.includes('class="tool-summary"'),
    card.slice(0, 600),
  )
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
