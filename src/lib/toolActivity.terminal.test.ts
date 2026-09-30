// Terminal output mapping: run_terminal emits [{content}] rows (no file/path/url),
// so FileResultLinks renders nothing. terminalOutputText must extract content.
// Run: npx esbuild src/lib/toolActivity.terminal.test.ts --bundle --platform=node --format=esm --outfile=tests/.tmp-terminal.mjs && node tests/.tmp-terminal.mjs
import type { SidecarEvent, ToolActivity } from "../types"
import { applyToolEvent, resolveToolResult, terminalOutputText } from "./toolActivity"

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? "")
  }
}

console.log("terminal output mapping:")
{
  const ev1 = {
    kind: "tool",
    tool: "run_terminal",
    args: { command: "uv run ruff check backend/tools.py" },
    id: "toolu_term_1",
  } as unknown as SidecarEvent
  const out1 = applyToolEvent([], ev1)
  const ev2 = {
    kind: "tool_result",
    tool: "run_terminal",
    summary: "exit 2 · 82 chars",
    results: [{ content: "$ uv run ruff check backend/tools.py\nEXIT CODE: 2\nE501 line too long" }],
    id: "toolu_term_1",
  } as unknown as SidecarEvent
  const out2 = resolveToolResult(out1, ev2)
  const act: ToolActivity = out2[0]
  check("result resolves to done", act.status === "done", act.status)
  check("results mapped to items", (act.items?.length ?? 0) === 1, act.items)
  const text = terminalOutputText(act.items)
  check("terminal text extracted", text.includes("EXIT CODE: 2"), text)
}

{
  const text = terminalOutputText([{ content: "$ ls\n(no output, exit code 0)" }])
  check("empty-output row still renders", text.includes("no output"), text)
}

if (failed > 0) {
  console.error(`\n${failed} terminal check(s) FAILED`)
  process.exit(1)
}
console.log("\n✅ toolActivity.terminal: all checks passed")
