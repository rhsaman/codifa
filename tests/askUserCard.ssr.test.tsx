// SSR sanity test for the multi-select ask_user choice card.
// Mock the Electron/browser bridge before importing modules.
;(globalThis as any).window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  innerWidth: 1200,
  innerHeight: 800,
  localStorage: {
    _d: {} as Record<string, string>,
    getItem(k: string) { return this._d[k] ?? null },
    setItem(k: string, v: string) { this._d[k] = String(v) },
    removeItem(k: string) { delete this._d[k] },
  },
  coder: new Proxy({}, {
    get: () => async () => ({ ok: true, data: "http://sidecar" }),
  }),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage
;(globalThis as any).openExternal = async () => {}

const React = await import("react")
const { renderToStaticMarkup } = await import("react-dom/server")
const { AskUserCard } = await import("../src/components/AskUserCard")
const {
  toggleSelected,
  joinAnswer,
  canSubmit,
  joinSectionAnswer,
  canSubmitSections,
  toggleSectionSelected,
} = await import("../src/lib/askUser")

const el = React.createElement
let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else { failed++; console.error(`  ❌ ${name}`, extra ?? "") }
}

const req = {
  id: "ask-1",
  question: "Which boxes?",
  options: ["One", "Two", "Three"],
  selected: [0],
  freeText: "",
}

console.log("1) helper: multi-selection toggle + answer formatting:")
{
  check("toggle in", toggleSelected([], 0).join(",") === "0", toggleSelected([], 0))
  check("toggle out", toggleSelected([0], 0).join(",") === "", toggleSelected([0], 0))
  check("combine two labels", joinAnswer(["One", "Two"], [0, 1], "") === "One\nTwo", joinAnswer(["One", "Two"], [0, 1], ""))
  check("single label stays bare", joinAnswer(["One"], [0], "") === "One")
  check("free text only", joinAnswer(["One"], [], "hello") === "hello")
  check("combined free text", joinAnswer(["One"], [0], "y") === "One\ny", joinAnswer(["One"], [0], "y"))
  check("can submit with selection", canSubmit(["One"], [0], "") === true)
  check("cannot submit empty", canSubmit(["One"], [], "") === false)
}

console.log("2) card renders options as checkboxes:")
{
  const html = renderToStaticMarkup(el(AskUserCard as any, { req, inline: true, live: false }))
  check("renders agent badge", html.includes("Agent Question"))
  check("renders question", html.includes("Which boxes?"))
  check("shows first option", html.includes("One"))
  check("shows second option", html.includes("Two"))
  check("shows checkbox mark", html.includes("☑") || html.includes("☐"))
  check("reflects selection", html.includes("ask-option selected"))
  check("inline class present", html.includes("ask-card-inline"))
  check("submit button present", html.includes("Apply"))
}

console.log("3) answered state keeps question and answer visible:")
{
  const done: any = { tool: "ask_user", status: "done", args: { question: "Which boxes?", options: ["One", "Two"] }, resultText: "One\ny" }
  const html = renderToStaticMarkup(el(AskUserCard as any, { req: null, activity: done, inline: true, live: false }))
  check("keeps question", html.includes("Which boxes?"))
  check("shows combined answer", html.includes("One") && html.includes("y"))
  check("hides submit button", !html.includes(">Apply<"))
}

console.log("4) multi-part sections render and gate the joint submit:")
{
  check(
    "section answer joins one line per section",
    joinSectionAnswer(
      [
        { title: "Chart", options: ["Bar", "Line"] },
        { title: "Range", options: ["Day", "Week"] },
      ],
      [[0, 1], [1]],
    ) === "Chart: Bar, Line\nRange: Week",
    joinSectionAnswer(
      [
        { title: "Chart", options: ["Bar", "Line"] },
        { title: "Range", options: ["Day", "Week"] },
      ],
      [[0, 1], [1]],
    ),
  )
  check("incomplete sections cannot submit", canSubmitSections([{ title: "A", options: ["x"] }, { title: "B", options: ["y"] }], [[0], []]) === false)
  check("all sections answered can submit", canSubmitSections([{ title: "A", options: ["x"] }, { title: "B", options: ["y"] }], [[0], [0]]) === true)
  check("toggle inside section 2 touches only section 2", JSON.stringify(toggleSectionSelected([[], [1]], 1, 0)) === "[[],[0,1]]", JSON.stringify(toggleSectionSelected([[], [1]], 1, 0)))

  const secReq = {
    id: "ask-sec",
    question: "Report setup",
    options: [],
    sections: [
      { title: "Chart", options: ["Bar", "Line"] },
      { title: "Range", options: ["Day", "Week"] },
    ],
    secSelected: [[0], []],
  }
  const html = renderToStaticMarkup(el(AskUserCard as any, { req: secReq, inline: true, live: false }))
  check("renders both section titles", html.includes("Chart") && html.includes("Range"))
  check("renders section options", html.includes("Bar") && html.includes("Week"))
  check(
    "apply disabled until EVERY section answered",
    html.includes('class="btn ask-send" disabled'),
    html.slice(html.indexOf("ask-send") - 60, html.indexOf("ask-send") + 40),
  )
  check("every section offers writing its own answer", (html.match(/ask-option-own/g) ?? []).length === 2)
}

console.log("4b) flat card own-answer tick gates the text field:")
{
  const flat = { id: "ask-flat", question: "Which boxes?", options: ["One", "Two"], selected: [] }
  const html = renderToStaticMarkup(el(AskUserCard as any, { req: flat, inline: true, live: false }))
  check("flat card offers writing its own answer", html.includes("ask-option-own"))
  check("flat answer field hidden until the tick", !html.includes("ask-input"))

  const ticked = { ...flat, own: true, freeText: "just the blue ones" }
  const tickedHtml = renderToStaticMarkup(el(AskUserCard as any, { req: ticked, inline: true, live: false }))
  check("ticked flat card reveals the answer field", tickedHtml.includes("ask-input"))
  check("ticked flat card renders the typed answer", tickedHtml.includes("just the blue ones"))
  check(
    "ticked own answer unlocks apply",
    !tickedHtml.includes('class="btn ask-send" disabled'),
  )
}

console.log("5) own answer per section:")
{
  const secs = [{ title: "Chart", options: ["Bar", "Line"] }, { title: "Range", options: ["Day", "Week"] }]
  check(
    "own answer alone satisfies a section",
    canSubmitSections(secs, [[0], []], [false, true], ["", "Last 3 days"]) === true,
  )
  check(
    "ticked but empty own answer does not count",
    canSubmitSections(secs, [[0], []], [false, true], ["", "  "]) === false,
  )
  check(
    "unticked text is ignored",
    canSubmitSections(secs, [[0], []], [false, false], ["", "Last 3 days"]) === false,
  )
  check(
    "own answer is sent as that section's answer",
    joinSectionAnswer(secs, [[0], []], [false, true], ["", "Last 3 days"]) === "Chart: Bar\nRange: Last 3 days",
    joinSectionAnswer(secs, [[0], []], [false, true], ["", "Last 3 days"]),
  )
  check(
    "options and own answer can combine",
    joinSectionAnswer(secs, [[0], [1]], [true, false], ["stacked", ""]) === "Chart: Bar, stacked\nRange: Week",
  )
  check(
    "no own-answer arguments keeps the old behavior",
    joinSectionAnswer(secs, [[0], [1]], undefined, undefined) === "Chart: Bar\nRange: Week",
  )

  const ownReq = {
    id: "ask-own",
    question: "Report setup",
    options: [],
    sections: secs,
    secSelected: [[0], []],
    secOwn: [false, true],
    secFreeText: ["", "Last 3 days"],
  }
  const ownHtml = renderToStaticMarkup(el(AskUserCard as any, { req: ownReq, inline: true, live: false }))
  check("ticked section reveals its own input", ownHtml.includes("ask-section-input"))
  check("own answer text is rendered", ownHtml.includes("Last 3 days"))
  check(
    "ticked own answer unlocks apply",
    !ownHtml.includes('class="btn ask-send" disabled'),
    ownHtml.slice(ownHtml.indexOf("ask-send") - 60, ownHtml.indexOf("ask-send") + 40),
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log("\nAll ask-user card checks passed")
process.exit(0)
