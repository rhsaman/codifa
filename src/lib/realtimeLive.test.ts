// Test for LiveVoiceSession.buildUrl in src/lib/realtimeLive.ts.
// Covers token substitution without opening a real WebSocket or AudioContext.
// Run: npx esbuild src/lib/realtimeLive.test.ts --bundle --platform=node --format=esm --packages=external --external:electron --outfile=tests/.tmp-live.mjs && node tests/.tmp-live.mjs

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok - ${name}`)
  else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

const { LiveVoiceSession, isHtmlTranscriptJunk, buildLiveSessionUpdate } = await import('./realtimeLive')

// buildUrl is private in TypeScript but a plain method at runtime.
function callBuildUrl(session: unknown, url: string, token: string): string {
  const fn = (session as { buildUrl: (u: string, t: string) => string }).buildUrl
  return fn.call(session, url, token)
}

console.log('1) buildUrl substitutes {token} or appends ?token=:')
{
  const session = new LiveVoiceSession({ url: 'wss://live.example/socket' })
  check(
    'appends ?token= when no query present',
    callBuildUrl(session, 'wss://live.example/socket', 'abc') === 'wss://live.example/socket?token=abc',
    callBuildUrl(session, 'wss://live.example/socket', 'abc'),
  )
  check(
    'appends &token= when query present',
    callBuildUrl(session, 'wss://live.example/socket?model=m', 'abc') ===
      'wss://live.example/socket?model=m&token=abc',
  )
  check(
    'substitutes {token} placeholder with encoding',
    callBuildUrl(session, 'wss://live.example/socket/{token}', 'a b') ===
      'wss://live.example/socket/a%20b',
  )
  check(
    'empty token returns url unchanged',
    callBuildUrl(session, 'wss://live.example/socket', '') === 'wss://live.example/socket',
  )
}

console.log('2) isHtmlTranscriptJunk rejects HTML error pages:')
{
  check(
    'rejects truncated doctype page',
    isHtmlTranscriptJunk('M!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>'),
  )
  check(
    'rejects full html page',
    isHtmlTranscriptJunk('<html><head><title>oops</title></head><body>nope</body></html>'),
  )
  check(
    'rejects tag soup with attributes',
    isHtmlTranscriptJunk('<div class="x">a</div><span id="y">b</span> trailing words here ok'),
  )
  check('keeps normal speech', !isHtmlTranscriptJunk('hello, how can I help you today?'))
  check('keeps short math with angle brackets', !isHtmlTranscriptJunk('a < b and c > d'))
  check('rejects single tag payload', isHtmlTranscriptJunk('hello <b>world'))
}

console.log('3) buildLiveSessionUpdate uses GA realtime format:')
{
  const ev = buildLiveSessionUpdate(24000, 24000) as {
    type: string
    session: { modalities: string[]; input_audio_format: string; output_audio_format: string; input_audio_transcription: { model: string }; turn_detection: { type: string; create_response: boolean; interrupt_response: boolean } }
  }
  check('type is session.update', ev.type === 'session.update')
  check('has text+audio modalities', Array.isArray(ev.session.modalities) && ev.session.modalities.includes('audio'))
  check('input audio is pcm16', ev.session.input_audio_format === 'pcm16')
  check('output audio is pcm16', ev.session.output_audio_format === 'pcm16')
  check('uses server_vad turn detection', ev.session.turn_detection.type === 'server_vad')
  check('transcribes user speech', ev.session.input_audio_transcription.model === 'whisper-1')
  check('auto-responds on turn end', ev.session.turn_detection.create_response === true)
  check('barge-in interrupts model', ev.session.turn_detection.interrupt_response === true)
}

console.log('4) truncated HTML error pages never reach the composer:')
{
  check(
    'rejects truncated Next.js preload link',
    isHtmlTranscriptJunk('<link rel="preload" as="script" fetchPriority="low" href="/_next/st'),
  )
  check('rejects truncated tag without closing bracket', isHtmlTranscriptJunk('hello <div class="x"'))
  check('keeps normal speech', !isHtmlTranscriptJunk('hello, how can I help you today?'))
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll live URL checks passed')
