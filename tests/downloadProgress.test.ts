// Live download-progress parsing for the running terminal card.
// Run (via tests/run-frontend.sh job `downloadProgress`):
//   esbuild tests/downloadProgress.test.ts --bundle --platform=node --format=esm \
//     --packages=external --external:electron --outfile=.tmp-dp.mjs && node .tmp-dp.mjs
import assert from 'node:assert/strict'
import { parseDownloadProgress } from '../src/lib/downloadProgress.ts'
import { applyToolOutputEvent, resolveToolResult } from '../src/lib/toolActivity.ts'
import type { SidecarEvent, ToolActivity } from '../src/types.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

// --- curl default meter (non-tty stderr): the real 1831M-download shape ----
{
  const tail = [
    '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current',
    '                                 Dload  Upload   Total   Spent    Left  Speed',
    '  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0',
    ' 12  1831M   12  224M    0     0  15.2M      0  0:02:00  0:00:14  0:01:46 15.2M',
  ].join('\n')
  const p = parseDownloadProgress(tail)
  check('curl meter: parsed', p !== null)
  check('curl meter: newest line wins', p?.percent === 12, p)
  check('curl meter: total', p?.total === '1831M', p)
  check('curl meter: received', p?.received === '224M', p)
  check('curl meter: speed', p?.speed === '15.2M', p)
  check('curl meter: eta', p?.eta === '0:01:46', p)
}

// --- curl --progress-bar ----------------------------------------------------
{
  const p = parseDownloadProgress('############                              31.5%')
  check('curl bar: parsed', p?.percent === 31.5, p)
  const p2 = parseDownloadProgress('######################################################################## 100.0%')
  check('curl bar: 100%', p2?.percent === 100, p2)
}

// --- wget bar ---------------------------------------------------------------
{
  const p = parseDownloadProgress(' 45% [=======>                   ] 5,146,123  1.05M/s  eta 8s')
  check('wget: parsed', p?.percent === 45, p)
  check('wget: eta', p?.eta === '8s', p)
  check('wget: speed', p?.speed === '1.05M/s', p)
}

// --- non-progress output must not match -------------------------------------
{
  check('plain text: no match', parseDownloadProgress('total 12% of files changed: 0:02:00 done') === null)
  check('empty tail: no match', parseDownloadProgress('') === null)
  check('code with %: no match', parseDownloadProgress('const x = (a % b) + 3 12 1831M 0:00:01') === null)
}

// --- newest refresh wins when several lines stream in ------------------------
{
  const tail = [
    '  3  1831M    3  55M     0     0  14.9M      0  0:02:03  0:00:03  0:02:00 14.9M',
    '  9  1831M    9  170M    0     0  15.1M      0  0:02:01  0:00:11  0:01:50 15.1M',
  ].join('\n')
  check('several refreshes: last wins', parseDownloadProgress(tail)?.percent === 9)
}

// --- folding a tool_output event into the running card ----------------------
{
  const start: SidecarEvent = {
    kind: 'tool',
    id: 'call_1',
    tool: 'run_terminal',
    args: { command: 'curl -L -o big.onnx https://example/big.onnx' },
  } as SidecarEvent
  let acts: ToolActivity[] = [{ tool: 'run_terminal', status: 'running', startedAt: Date.now(), callId: 'call_1' }]
  acts = applyToolOutputEvent(acts, 'call_1', ' 12  1831M   12  224M    0     0  15.2M      0  0:02:00  0:00:14  0:01:46 15.2M')
  check('tool_output: tail lands on the running card', acts[0].liveTail?.includes('224M') === true)

  // Unknown id / resolved card: no change.
  const untouched = applyToolOutputEvent(acts, 'call_other', 'xx')
  check('tool_output: unknown id is a no-op', untouched === acts)
  const resolved = resolveToolResult(acts, { kind: 'tool_result', id: 'call_1', result: 'done', status: 'done' } as SidecarEvent)
  check('tool_output: resolve clears the stale tail', resolved[0].liveTail === undefined && resolved[0].status === 'done')
  const done = applyToolOutputEvent(resolved, 'call_1', 'late tail')
  check('tool_output: resolved card does not take a tail', done === resolved)
}

console.log(failed === 0 ? '\nAll downloadProgress tests passed' : `\nFAILED: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
