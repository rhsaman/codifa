// SSR sanity test for the per-turn usage helpers (src/lib/turnUsage.ts).
// Covers: turnStart (newest user message), turnUsage (attached skills vs skills
// the agent loaded mid-run, enabled connectors), and usagePlugins (skill owner +
// connector owner lookup). Pure functions, no rendering.

// The store/api modules touch `window.coder` at import time.
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

const { turnStart, turnUsage, usagePlugins, skillOwner } = await import(
  "../src/lib/turnUsage"
)
import type { ChatMessage } from "../src/types"

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

const user = (
  id: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({ id, role: "user", content: "hi", ...extra })
const assistant = (
  id: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({ id, role: "assistant", content: "", ...extra })

console.log("1) turnStart finds the newest user message:");
{
  check("no messages → -1", turnStart([]) === -1)
  check(
    "assistant-only trade still has no turn",
    turnStart([assistant("a1"), assistant("a2")]) === -1,
  )
  const msgs = [user("u1"), assistant("a1"), user("u2"), assistant("a2")]
  check("the LAST user message opens the current turn", turnStart(msgs) === 2)
}

console.log("2) turnUsage reports the CURRENT turn only:");
{
  const msgs = [
    user("u1", { skills: ["old-skill"], mcpServers: { old: {} } }),
    assistant("a1"),
    user("u2", { skills: ["Ponytail"], mcpServers: { github: {} } }),
    assistant("a2"),
  ]
  const u = turnUsage(msgs)
  check(
    "skills come from the newest user message",
    u.skills.length === 1 && u.skills[0].name === "Ponytail",
    u.skills,
  )
  check("a previous turn's skill is not carried over", !u.skills.some((s) => s.name === "old-skill"))
  check("connectors come from the same message", u.mcp.length === 1 && u.mcp[0] === "github", u.mcp)
  check("an attached-but-not-loaded skill is not marked used", u.skills[0].used === false)
}

console.log("3) load_skill marks a skill as used (case-insensitive):");
{
  const msgs = [
    user("u2", { skills: ["Ponytail"] }),
    assistant("a2", {
      toolActivity: [
        { tool: "load_skill", args: { name: "ponytail" }, status: "done" },
      ],
    }),
  ]
  const u = turnUsage(msgs)
  check("the attached skill is marked used", u.skills[0].used === true, u.skills)
  check("no duplicate row for the loaded name", u.skills.length === 1, u.skills)
}

console.log("3b) the foreign `skill` name counts as a load:");
{
  const msgs = [
    user("u2", { skills: ["Ponytail"] }),
    assistant("a2", {
      toolActivity: [{ tool: "skill", args: { name: "ponytail" }, status: "done" }],
    }),
  ]
  check("the `skill` alias marks the attached skill used", turnUsage(msgs).skills[0].used === true, turnUsage(msgs).skills)
}

console.log("4) a skill the agent loaded on its own is listed:");
{
  const msgs = [
    user("u2"),
    assistant("a2", {
      toolActivity: [
        { tool: "load_skill", args: { name: "movie-finder" }, status: "done" },
      ],
    }),
  ]
  const u = turnUsage(msgs)
  check("an unattached loaded skill still appears", u.skills.length === 1, u.skills)
  check("and it counts as used", u.skills[0].used === true)
  // Scope is the LAST turn. A turn that has a later turn after it is not
  // reported, so an old load never leaks into the current card.
  const superseded = turnUsage([
    user("u1"),
    assistant("a1", {
      toolActivity: [{ tool: "load_skill", args: { name: "old" }, status: "done" }],
    }),
    user("u2"),
    assistant("a2", {
      toolActivity: [{ tool: "load_skill", args: { name: "new" }, status: "done" }],
    }),
  ])
  check(
    "a superseded turn's calls are not reported",
    superseded.skills.length === 1 && superseded.skills[0].name === "new",
    superseded.skills,
  )
}

console.log("4b) trailing user messages do not empty the turn:");
{
  // The right panel said "runs without skills" whenever a queued steer or a
  // follow-up was typed BELOW the last answer: turnStart anchored on the LAST
  // user message, so the window after it held nothing while the transcript one
  // row above still showed the `Load Skill` card.
  const msgs = [
    user("u1", { skills: ["Test UI"] }),
    assistant("a1", {
      content: "done",
      toolActivity: [{ tool: "load_skill", args: { name: "Test UI" }, status: "done" }],
    }),
    user("u2"),
    user("u3"),
  ]
  check("the turn still opens at its own user message", turnStart(msgs) === 0, turnStart(msgs))
  const u = turnUsage(msgs)
  check(
    "the loaded skill is still reported as used",
    u.skills.length === 1 && u.skills[0].used === true,
    u.skills,
  )
  check("no phantom skill comes from the trailing rows", u.skills.length === 1, u.skills)
}

console.log("5) a load_skill call inside a sub-agent belongs to the turn:");
{
  const msgs = [
    user("u2"),
    assistant("a2", {
      toolActivity: [
        {
          tool: "explore",
          status: "done",
          children: [
            { tool: "load_skill", args: { name: "deep-research" }, status: "done" },
          ],
        },
      ],
    }),
  ]
  const u = turnUsage(msgs)
  check("child calls are walked", u.skills.some((s) => s.name === "deep-research"), u.skills)
}

console.log("6) skillOwner + usagePlugins map names back to plugins:");
{
  const catalog = [
    { name: "Ponytail", slug: "ponytail", description: "", path: "", content: "", plugin: "Dev Kit" },
    { name: "plain", slug: "plain", description: "", path: "", content: "" },
  ] as any
  const plugins = [
    { name: "Git Tools", slug: "git-tools", enabled: true, mcp: ["github"] },
  ] as any
  check("a store skill has no owner", skillOwner("plain", catalog) === "")
  check("a plugin skill resolves to its plugin", skillOwner("ponytail", catalog) === "Dev Kit")
  check("lookup is case-insensitive", skillOwner("PONYTAIL", catalog) === "Dev Kit")
  check("an unknown skill has no owner", skillOwner("nope", catalog) === "")

  const owners = usagePlugins(
    { skills: [{ name: "Ponytail", used: true }], mcp: ["github", "other"] },
    catalog,
    plugins,
  )
  check("skill owner is included", owners.includes("Dev Kit"), owners)
  check("connector owner is included", owners.includes("Git Tools"), owners)
  check("an unowned connector adds nothing", owners.length === 2, owners)
}

console.log("7) a re-spelled name is the same skill, not a second row:");
{
  // Models re-spell the name when they call the tool: the attached `Test UI`
  // comes back as `test-ui`. Keying on case alone listed the SAME skill twice —
  // one attached-but-unused row and one loaded row (seen live in the panel).
  for (const spelled of ["test-ui", "test_ui", "Test UI", "TESTUI"]) {
    const u = turnUsage([
      user("u1", { skills: ["Test UI"] }),
      assistant("a1", {
        toolActivity: [
          { tool: "load_skill", args: { name: spelled }, status: "done" },
        ],
      }),
    ])
    check(
      `\`${spelled}\` collapses into the attached row`,
      u.skills.length === 1 && u.skills[0].name === "Test UI" && u.skills[0].used,
      u.skills,
    )
  }
  const u = turnUsage([
    user("u1", { skills: ["plain"] }),
    assistant("a1", {
      toolActivity: [{ tool: "load_skill", args: { name: "other" }, status: "done" }],
    }),
  ])
  check("a different skill still gets its own row", u.skills.length === 2, u.skills)
}

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
