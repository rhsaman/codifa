// Tests for the live-voice session-mode helpers in src/lib/liveSession.ts.
// Covers the provider-agnostic realtime target builder, the mode resolution
// (realtime vs chunked fallback) and the transcript merging that lets the chat
// mirror read correctly no matter which gateway shape is behind the endpoint.
// Run: npx esbuild src/lib/liveSession.test.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/.tmp-live-session.mjs && node /tmp/.tmp-live-session.mjs

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok - ${name}`)
  else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

const {
  buildRealtimeTarget,
  resolveLiveMode,
  mergeLiveTranscript,
  finalizeLiveTranscript,
} = await import('./liveSession')

console.log('1) any provider can be a realtime target, not only OpenAI:')
{
  const openai = buildRealtimeTarget(
    { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
    ['sk-a', 'sk-b'],
    'gpt-realtime',
    'alloy',
  )
  check('a non-OpenAI provider builds a target', openai !== null)
  check('the provider kind is forwarded verbatim', openai?.kind === 'openrouter', openai)
  check('the base url is forwarded verbatim', openai?.baseUrl === 'https://openrouter.ai/api/v1', openai)
  check('every api key is passed through', openai?.apiKeys.length === 2, openai)
  check('model and voice are carried', openai?.model === 'gpt-realtime' && openai?.voice === 'alloy', openai)

  const selfHosted = buildRealtimeTarget(
    { kind: 'custom', baseUrl: 'http://127.0.0.1:8000/v1' },
    [],
    'local-realtime',
    '',
  )
  check('a keyless self-hosted gateway is still allowed', selfHosted !== null)
  check('a keyless target has no keys', selfHosted?.apiKeys.length === 0, selfHosted)
  check('an empty voice is allowed', selfHosted?.voice === '', selfHosted)
}

console.log('2) an unusable configuration falls back to the chunked pipeline:')
{
  check('no provider at all yields null', buildRealtimeTarget(undefined, [], 'm', 'v') === null)
  check(
    'a provider without a base url yields null',
    buildRealtimeTarget({ kind: 'openai', baseUrl: '' }, ['k'], 'm', 'v') === null,
  )
  check(
    'a missing model yields null (the mint rejects it)',
    buildRealtimeTarget({ kind: 'openai', baseUrl: 'https://x/v1' }, ['k'], '', 'v') === null,
  )
  check(
    'a whitespace model yields null',
    buildRealtimeTarget({ kind: 'openai', baseUrl: 'https://x/v1' }, ['k'], '   ', 'v') === null,
  )
  check(
    'blank api keys are filtered out',
    buildRealtimeTarget({ kind: 'openai', baseUrl: 'https://x/v1' }, ['', '  ', 'k'], 'm', '')?.apiKeys
      .length === 1,
  )
}

console.log('3) the live mode follows settings:')
{
  check('a configured provider selects realtime', resolveLiveMode('p1', true) === 'realtime')
  check('no provider id selects the chunked fallback', resolveLiveMode('', true) === 'chunked')
  check('an undefined id selects the chunked fallback', resolveLiveMode(undefined, true) === 'chunked')
  check('a whitespace id selects the chunked fallback', resolveLiveMode('   ', true) === 'chunked')
  // A stale id (provider deleted from settings) must not attempt a session.
  check('a deleted provider selects the chunked fallback', resolveLiveMode('gone', false) === 'chunked')
}

console.log('4) transcript merging handles every gateway shape:')
{
  // Cumulative payload: some servers resend the whole transcript each event.
  check(
    'a cumulative payload replaces the accumulation',
    mergeLiveTranscript('hello', 'hello world') === 'hello world',
  )
  // Delta payload: character/word granularity, concatenated verbatim.
  check('a delta is appended', mergeLiveTranscript('hel', 'lo') === 'hello')
  check('a word delta is appended verbatim', mergeLiveTranscript('سلام ', 'دنیا') === 'سلام دنیا')
  // Repeated tail: the delta we already applied must not duplicate.
  check('an already-applied delta is not duplicated', mergeLiveTranscript('hello world', 'world') === 'hello world')
  check('an empty delta keeps what we have', mergeLiveTranscript('hello', '') === 'hello')
  check('an empty accumulation adopts the new text', mergeLiveTranscript('', 'hi') === 'hi')
  // A delta must never inject a separator: gateways stream mid-word.
  check('no separator is injected mid-word', mergeLiveTranscript('trans', 'cript') === 'transcript')
}

console.log('5) a final event can never truncate the visible transcript:')
{
  check('a full final payload wins', finalizeLiveTranscript('hello wor', 'hello world') === 'hello world')
  check('an empty final payload keeps the accumulation', finalizeLiveTranscript('hello', '') === 'hello')
  check('an empty accumulation adopts the final payload', finalizeLiveTranscript('', 'hello') === 'hello')
  // Delta-only gateways send just the trailing fragment in the .done event.
  check(
    'a shorter final payload is merged, not substituted',
    finalizeLiveTranscript('hello world', 'world') === 'hello world',
  )
  check('whitespace is trimmed around the result', finalizeLiveTranscript('  hi  ', '  ') === 'hi')
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall live session checks passed')
