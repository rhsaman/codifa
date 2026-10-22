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
  check("nothing before the turn counts: old calls are ignored", (() => {
    const late = turnUsage([
      user("u1"),
      assistant("a1", {
        toolActivity: [{ tool: "load_skill", args: { name: "old" }, status: "done" }],
      }),
      user("u2"),
      assistant("a2"),
    ])
    return late.skills.length === 0
  })())
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

if (failed > 0) {
  console.error(`\n${failed} تست شکست خورد ❌`)
  process.exit(1)
}
console.log("\nهمه تست‌ها پاس شدند ✅")
process.exit(0)
