// A `batch` card is labelled with the tools it ran. Traced (`mwbn4lhu`,
// `mwbmxr0r`): 6 of 114 and 23 of 123 batch rows rendered the bare fallback
// label "Tools" because `batchOpTools` could not read the ops. Two shapes
// caused it — a double-encoded `ops` string, and a refusal line whose arrow
// broke the result-text regex.
// Run: npx esbuild tests/toolBatchLabel.test.ts --bundle --platform=node --format=esm --outfile=tests/.tmp-batchlabel.mjs && node tests/.tmp-batchlabel.mjs
import type { ToolActivity } from "../src/types"
import { batchOpTools, isBatchTool } from "../src/components/toolcall/naming"

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

const activity = (over: Partial<ToolActivity>): ToolActivity =>
  ({ id: "t1", name: "batch", status: "ok", ...over }) as ToolActivity

console.log("batch card labelling:")
{
  // The tool was renamed to `batch_search` to say what it is (a SEARCH composer
  // — a write never rides it). Stored history still says `batch`, so both
  // spellings must be recognised as the wrapper and labelled by their ops; a
  // transcript replayed after the rename must not fall back to the raw name.
  check("the current name is a batch tool", isBatchTool("batch_search"))
  check("the pre-rename name is still a batch tool", isBatchTool("batch"))
  check("an ordinary tool is not", !isBatchTool("read"))
  const out = batchOpTools(
    activity({ name: "batch_search", args: { ops: [{ tool: "grep" }, { tool: "read" }] } }),
  )
  check("the renamed card is labelled by its ops", out.join(",") === "grep,read", out)
}
{
  // The normal shape: ops arrive as a real array.
  const out = batchOpTools(
    activity({ args: { ops: [{ tool: "grep" }, { tool: "read" }, { tool: "edit_file" }] } }),
  )
  check("an array of ops labels every tool", out.join(",") === "grep,read,edit_file", out)
}
{
  // Several providers double-encode nested JSON: the model means an array and
  // the wire carries a stringified one. The backend decodes it (`batch_ops`),
  // so the card must read the same shape instead of falling back to "Tools".
  const out = batchOpTools(
    activity({ args: { ops: JSON.stringify([{ tool: "grep" }, { tool: "lsp_symbols" }]) } }),
  )
  check("a stringified ops array is decoded", out.join(",") === "grep,lsp_symbols", out)
}
{
  // A foreign name still resolves to our label, inside a stringified array too.
  const out = batchOpTools(activity({ args: { ops: JSON.stringify([{ tool: "run_command" }]) } }))
  check("aliases resolve inside a stringified array", out.join(",") === "run_terminal", out)
}
{
  // An op the turn refused keeps an arrow in the result: `=== [1/2] read → REFUSED ===`.
  // The old `(\S+) ===` pattern dropped every one of these, so a batch whose
  // ops were all refused fell back to the bare "Tools" label.
  const out = batchOpTools(
    activity({
      args: {},
      resultText: "=== [1/2] read → REFUSED ===\nblocked\n\n=== [2/2] grep → REFUSED ===\nblocked\n",
    }),
  )
  check("refused ops still name their tool", out.join(",") === "read,grep", out)
}
{
  // The ordinary result shape keeps working.
  const out = batchOpTools(
    activity({
      args: {},
      resultText: "=== [1/3] grep ===\nhits\n\n=== [2/3] read ===\nbody\n",
    }),
  )
  check("a plain result names its ops", out.join(",") === "grep,read", out)
}
{
  // Nothing readable at all: the caller falls back to "Tools", which is fine.
  const out = batchOpTools(activity({ args: {}, resultText: "batch needs ops" }))
  check("unreadable args yield no tools", out.length === 0, out)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log("\nall batch label checks passed")
