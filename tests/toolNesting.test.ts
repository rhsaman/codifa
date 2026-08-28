// Nesting of sub-agent tool events under their branch task card.
// Run: npx esbuild test/toolNesting.test.ts --bundle --platform=node --format=esm --packages=external --external:electron --outfile=test/.tmp-tn.mjs && node test/.tmp-tn.mjs
import type { SidecarEvent, ToolActivity } from '../src/types.ts'
import { applyToolEvent, resolveToolResult } from '../src/lib/toolActivity.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const toolEvent = (over: Partial<SidecarEvent>): SidecarEvent =>
  ({ kind: 'tool', ...over } as SidecarEvent)
const resultEvent = (over: Partial<SidecarEvent>): SidecarEvent =>
  ({ kind: 'tool_result', ...over } as SidecarEvent)

// 1) A sub tool call nests INSIDE its branch task card even when that card is
//    already "done" (late sub-event after resolve). This was the dropped-event
//    bug: the explore card showed nothing but "N chars".
{
  let acts: ToolActivity[] = []
  acts = applyToolEvent(acts, toolEvent({ tool: 'task', branch: 0, call_id: 1 }))
  acts = resolveToolResult(acts, resultEvent({ tool: 'task', branch: 0, call_id: 1, status: 'done' }))
  check('task card resolved to done', acts[0]?.status === 'done', acts[0]?.status)
  acts = applyToolEvent(acts, toolEvent({ tool: 'grep', branch: 0, sub: true, call_id: 2 }))
  check('late sub tool nests under done branch card',
    acts[0]?.children?.length === 1 && acts[0].children![0].tool === 'grep',
    acts[0]?.children)
}

// 2) A sub result resolves its nested child by call_id even when the parent
//    branch card is already done.
{
  let acts: ToolActivity[] = []
  acts = applyToolEvent(acts, toolEvent({ tool: 'task', branch: 0, call_id: 1 }))
  acts = resolveToolResult(acts, resultEvent({ tool: 'task', branch: 0, call_id: 1, status: 'done' }))
  acts = applyToolEvent(acts, toolEvent({ tool: 'grep', branch: 0, sub: true, call_id: 2 }))
  acts = resolveToolResult(acts, resultEvent({ sub: true, branch: 0, call_id: 2, status: 'done' }))
  check('sub result resolves nested child by call_id (parent done)',
    acts[0]?.children?.[0]?.status === 'done', acts[0]?.children?.[0]?.status)
}

// 3) Sub result with ONLY branch (no call_id) resolves the nested child by
//    branch even when the parent is done. This is the core fix: branchMatch no
//    longer requires act.tool === "task", so grep/glob/read children resolve.
{
  let acts: ToolActivity[] = []
  acts = applyToolEvent(acts, toolEvent({ tool: 'task', branch: 0, call_id: 1 }))
  acts = resolveToolResult(acts, resultEvent({ tool: 'task', branch: 0, call_id: 1, status: 'done' }))
  acts = applyToolEvent(acts, toolEvent({ tool: 'grep', branch: 0, sub: true }))
  check('sub grep child stays running before result',
    acts[0]?.children?.[0]?.status === 'running', acts[0]?.children?.[0]?.status)
  acts = resolveToolResult(acts, resultEvent({ sub: true, branch: 0, status: 'done' }))
  check('sub result (branch only) resolves nested grep child',
    acts[0]?.children?.[0]?.status === 'done', acts[0]?.children?.[0])
}

// 4) Parallel fan-out: each branch's sub-events nest under ITS OWN task card.
{
  let acts: ToolActivity[] = []
  acts = applyToolEvent(acts, toolEvent({ tool: 'task', branch: 0, call_id: 1 }))
  acts = applyToolEvent(acts, toolEvent({ tool: 'task', branch: 1, call_id: 2 }))
  acts = applyToolEvent(acts, toolEvent({ tool: 'grep', branch: 0, sub: true, call_id: 3 }))
  acts = applyToolEvent(acts, toolEvent({ tool: 'grep', branch: 1, sub: true, call_id: 4 }))
  check('branch 0 sub nests under branch 0 card',
    acts[0]?.children?.length === 1 && acts[0].children![0].callId === 3, acts[0]?.children)
  check('branch 1 sub nests under branch 1 card',
    acts[1]?.children?.length === 1 && acts[1].children![0].callId === 4, acts[1]?.children)
  check('branch 0 does not leak into branch 1', acts[0]?.children![0].callId !== 4)
}

// 5) A sub result must NOT flip a still-running branch card to done on its
//    first sub-search (the "parallel explores freeze / only one comes" bug).
{
  let acts: ToolActivity[] = []
  acts = applyToolEvent(acts, toolEvent({ tool: 'task', branch: 0, call_id: 1 })) // running
  acts = resolveToolResult(acts, resultEvent({ sub: true, branch: 0, status: 'done' }))
  check('sub result does not prematurely mark running branch card done',
    acts[0]?.status === 'running', acts[0]?.status)
}

// 6) Regression: top-level (non-sub) results still resolve by call_id, and a
//    result for an already-done top-level card is not re-matched/errored.
{
  let acts: ToolActivity[] = []
  acts = applyToolEvent(acts, toolEvent({ tool: 'read', call_id: 5 }))
  acts = resolveToolResult(acts, resultEvent({ tool: 'read', call_id: 5, status: 'done' }))
  check('top-level result resolves by call_id', acts[0]?.status === 'done', acts[0]?.status)
  const before = acts[0]
  acts = resolveToolResult(acts, resultEvent({ tool: 'read', call_id: 5, status: 'done' }))
  check('re-applied result leaves done card intact',
    acts[0]?.status === 'done' && acts[0] === before, acts[0]?.status)
}

if (failed > 0) {
  console.error(`\n${failed} toolNesting check(s) FAILED`)
  process.exit(1)
}
console.log('\n✅ toolNesting: all checks passed')
