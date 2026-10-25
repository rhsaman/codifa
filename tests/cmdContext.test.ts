// Unit tests for the `update` context fragments (src/lib/cmdContext.ts).
//
// Why it matters: `/mcp update` and `/artifact update` hand the edit to the
// model. Neither record can be READ back by any tool it has — `create_mcp`
// replaces the whole connector config and `read` refuses paths outside the
// project root (connectors live in the app's data folder), while the artifact
// tool has no read action at all. So the prompt used to say "read its current
// config first", which was unimplementable: an edited connector lost its
// env/args and an edited artifact was regenerated from memory. These fragments
// are the fix, so they must carry the real values COMPLETE.

import { artifactContext, connectorContext } from '../src/lib/cmdContext.ts'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`, extra ?? '')
  }
}

const CONNECTORS = {
  playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: { DEBUG: 'pw:*' } },
  remote: { url: 'https://mcp.example.com/sse' },
}

console.log('1) a connector update states the saved record verbatim:')
{
  const out = connectorContext('playwright', CONNECTORS)
  check('the command is included', out.includes('npx'), out)
  check('args survive', out.includes('@playwright/mcp@latest'), out)
  check('env survives (the field that was silently dropped)', out.includes('DEBUG'), out)
  check('it warns that the record is REPLACED', /REPLACES the whole record/.test(out), out)
  check('it tells the model to send every field back', /EVERY field/.test(out), out)
}

console.log('2) an HTTP connector carries its url, not a command:')
{
  const out = connectorContext('remote', CONNECTORS)
  check('the url is included', out.includes('https://mcp.example.com/sse'), out)
}

console.log('3) the match is case-insensitive, like the tools:')
{
  const out = connectorContext('PLAYWRIGHT', CONNECTORS)
  check('an upper-case name still finds the record', out.includes('npx'), out)
  check('and the JSON is valid on its own', (() => {
    const m = out.match(/```json\n([\s\S]*?)\n```/)
    if (!m) return false
    try {
      const parsed = JSON.parse(m[1])
      return parsed.command === 'npx'
    } catch {
      return false
    }
  })(), out)
}

console.log('4) an unknown name says so instead of inventing a config:')
{
  const out = connectorContext('nope', CONNECTORS)
  check('it reports the name is not saved', /No connector named "nope" is saved/.test(out), out)
  check('it points at listing or creating', /create_mcp/.test(out), out)
  check('it does NOT emit a JSON block', !out.includes('```json'), out)
}

console.log('5) an artifact update carries the WHOLE saved body:')
{
  const body = '<h1>Title</h1>\n<p>' + 'x'.repeat(5000) + '</p>'
  const out = artifactContext({ title: 'Report', kind: 'html', version: 3, content: body })
  check('the body is not truncated', out.includes(body), out.length)
  check('the kind and version are named', out.includes('kind html') && out.includes('v3'), out)
  check('the title is named', out.includes('title "Report"'), out)
  check('it demands a COMPLETE document back', /complete edited/.test(out), out)
  check('it forbids a fragment', /never a fragment/.test(out), out)
}

console.log('6) an unreadable artifact reports the failure:')
{
  const out = artifactContext({ error: 'artifact not found: ghost' })
  check('the backend error is surfaced', out.includes('artifact not found: ghost'), out)
  check('it points at finding the id', /artifact list/.test(out), out)
  check('it does NOT claim to have a body', !out.includes('CURRENT saved body'), out)
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
}
console.log('\nAll tests passed. ✅')
