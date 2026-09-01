// Debug trace: simulate the exact filter logic
import { isForeignModelId, FOREIGN_PROVIDER_PREFIXES } from '../src/lib/provider-meta'

console.log('FOREIGN_PROVIDER_PREFIXES:', [...FOREIGN_PROVIDER_PREFIXES])

const p = { id: 'local' }

const testCases = [
  'opencode/big-pickle',
  'local/opencode/big-pickle', 
  'llama3',
  'openrouter/anthropic/claude-3.5-sonnet',
  'nvidia/foo',
  'meta-llama/llama-3.1-70b-instruct',
]

function bareModel(id: string, m: string): string {
  return m.startsWith(`${id}/`) ? m.slice(id.length + 1) : m
}

console.log('\n=== isForeignModelId traces (p.id="local") ===')
for (const m of testCases) {
  const b = bareModel(p.id, m)
  const foreign = isForeignModelId(p, b)
  console.log(`  m="${m}" → b="${b}" → foreign=${foreign}`)
}
