// Test for the offline live voice loop in src/lib/localLive.ts.
// Covers VAD helpers + transcript sanitation without mic/AudioContext.
// Run: npx esbuild src/lib/localLive.test.ts --bundle --platform=node --format=esm --packages=external --external:electron --outfile=tests/.tmp-local-live.mjs && node tests/.tmp-local-live.mjs

export {}

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok - ${name}`)
  else {
    failed++
    console.error(`  FAIL - ${name}`, extra ?? '')
  }
}

const { computeRms, isSpeechLevel, shouldEndTurn, sanitizeLocalTranscript, isHallucinatedTranscript, isSustainedSpeech, LocalLiveSession } = await import('./localLive')

console.log('1) VAD helpers:')
{
  check('silence has zero level', computeRms(new Float32Array([0, 0, 0, 0])) === 0)
  check('loud frame counts as speech', isSpeechLevel(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.02))
  check('quiet frame is not speech', !isSpeechLevel(computeRms(new Float32Array([0.001, -0.001])), 0.02))
  check('silence timeout ends the turn', shouldEndTurn(900, 900))
  check('short pause keeps the turn open', !shouldEndTurn(200, 900))
  check('default level gate rejects faint ambient noise', !isSpeechLevel(0.01))
  check('default level gate accepts close-mic speech', isSpeechLevel(0.05))
}

console.log('2) transcripts never carry HTML error pages:')
{
  check('keeps normal speech', sanitizeLocalTranscript('hello, how can I help?') === 'hello, how can I help?')
  check(
    'drops truncated Next.js preload link',
    sanitizeLocalTranscript('Write a <link rel="preload" as="script" fetchPriority="low" href="/_next/st') === '',
  )
  check('drops full html page', sanitizeLocalTranscript('<html><body>oops</body></html>') === '')
  check('drops truncated tag', sanitizeLocalTranscript('hello <div class="x"') === '')
}

console.log('3) finishTurn keeps audio tail pushed after stop():')
{
  // Regression: the final dataavailable fires after rec.stop() and pushes
  // into the live chunks array. Resetting the array before the blob is
  // built drops the tail and yields a truncated container that strict
  // remote STT decoders reject ("could not process file") while dictate
  // (complete blob) keeps working.
  const head = new Blob([new Uint8Array(5000)], { type: 'audio/webm' })
  const tail = new Blob([new Uint8Array(5000)], { type: 'audio/webm' })
  let seenSize = 0
  let heard = ''
  const session = new LocalLiveSession({
    transcribe: async (blob) => {
      seenSize = blob.size
      return 'hello'
    },
    onUserText: (text) => {
      heard = text
    },
  })
  const priv = session as unknown as Record<string, unknown>
  priv['recording'] = true
  priv['transcribing'] = false
  priv['stopped'] = false
  priv['hasSpeech'] = true
  priv['chunks'] = [head]
  const fakeRec: { state: string; mimeType: string; onstop: ((e: unknown) => void) | null; stop: () => void } = {
    state: 'recording',
    mimeType: 'audio/webm',
    onstop: null,
    stop: () => {
      ;(priv['chunks'] as Blob[]).push(tail)
      try {
        fakeRec.onstop?.({})
      } catch {
        // Ignore listener errors.
      }
    },
  }
  priv['recorder'] = fakeRec
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  check('tail chunk pushed after stop() reaches STT', seenSize === head.size + tail.size, { seenSize, expected: head.size + tail.size })
  check('transcribed text reaches onUserText', heard === 'hello', { heard })
}

console.log('4) stopRecorder detaches trailing handlers:')
{
  // Regression: the old recorder's trailing dataavailable fires async after
  // stop() and must not land in the next recorder's chunk array (mixed webm
  // streams corrupt the container -> "could not process file" on strict
  // remote STT while lenient local Whisper still works, unlike dictate).
  const session = new LocalLiveSession({
    transcribe: async () => '',
    onUserText: () => {},
  })
  const priv = session as unknown as Record<string, unknown>
  let stopped: boolean = false
  const fakeRec: { state: string; ondataavailable: ((e: unknown) => void) | null; onstop: ((e: unknown) => void) | null; stop: () => void } = {
    state: 'recording',
    ondataavailable: () => {},
    onstop: () => {},
    stop: () => {
      stopped = true
    },
  }
  priv['recorder'] = fakeRec
  priv['recording'] = true
  ;(session as unknown as { stopRecorder: () => void }).stopRecorder()
  check('stopRecorder detaches ondataavailable', fakeRec.ondataavailable === null, { ondataavailable: fakeRec.ondataavailable })
  check('stopRecorder detaches onstop', fakeRec.onstop === null, { onstop: fakeRec.onstop })
  check('stopRecorder stops the recorder', stopped, { stopped })
  check('session recorder cleared', priv['recorder'] === null, { recorder: priv['recorder'] })
}

console.log('5) live recorder matches dictate (single blob, no timeslice):')
{
  // Regression: timesliced MediaRecorder chunks concatenate into a container
  // that strict remote STT decoders reject ("could not process file") while
  // dictate (single blob via rec.start()) keeps working.
  const starts: unknown[][] = []
  class FakeRecorder {
    ondataavailable: ((e: unknown) => void) | null = null
    onstop: ((e: unknown) => void) | null = null
    state = 'recording'
    constructor(
      public stream: unknown,
      public opts?: unknown,
    ) {}
    start(...args: unknown[]) {
      starts.push(args)
    }
    stop() {}
  }
  const g = globalThis as unknown as Record<string, unknown>
  const prevRecorder = g['MediaRecorder']
  g['MediaRecorder'] = FakeRecorder
  try {
    const session = new LocalLiveSession({
      transcribe: async () => '',
      onUserText: () => {},
    })
    const priv = session as unknown as Record<string, unknown>
    priv['micStream'] = {}
    ;(session as unknown as { startRecorder: () => void }).startRecorder()
    check('recorder started without timeslice args', starts.length === 1 && Array.isArray(starts[0]) && starts[0].length === 0, { starts })
  } finally {
    if (prevRecorder === undefined) delete g['MediaRecorder']
    else g['MediaRecorder'] = prevRecorder
  }
}

console.log('6) finishTurn resumes capture before agent answer:')
{
  // Regression: transcribing stayed true during the whole agent answer
  // (send + TTS), so the monitor was deaf and speech during the answer
  // was lost ("sometimes never converts"). Capture must resume before
  // onUserText runs, and short-but-real blobs must reach STT.
  const small = new Blob([new Uint8Array(5000)], { type: 'audio/webm' })
  let heard = ''
  let sawTranscribing: unknown = null
  let sawRecording: unknown = null
  class FakeRec2 {
    state = 'recording'
    mimeType = 'audio/webm'
    ondataavailable: ((e: unknown) => void) | null = null
    onstop: ((e: unknown) => void) | null = null
    start() {}
    stop() {
      try {
        this.onstop?.({})
      } catch {
        // Ignore listener errors.
      }
    }
  }
  const g2 = globalThis as unknown as Record<string, unknown>
  const prevRecorder2 = g2['MediaRecorder']
  g2['MediaRecorder'] = FakeRec2
  try {
    const session = new LocalLiveSession({
      transcribe: async () => 'yes',
      onUserText: () => {
        heard = 'yes'
        const p2 = session as unknown as Record<string, unknown>
        sawTranscribing = p2['transcribing']
        sawRecording = p2['recording']
      },
    })
    const priv = session as unknown as Record<string, unknown>
    priv['micStream'] = {}
    priv['recording'] = true
    priv['transcribing'] = false
    priv['stopped'] = false
    priv['hasSpeech'] = true
    priv['chunks'] = [small]
    priv['recorder'] = new FakeRec2()
    await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
    check('short blob reaches onUserText', heard === 'yes', { heard })
    check('monitor released before agent answer', sawTranscribing === false, { sawTranscribing })
    check('capture resumed before agent answer', sawRecording === true, { sawRecording })
  } finally {
    if (prevRecorder2 === undefined) delete g2['MediaRecorder']
    else g2['MediaRecorder'] = prevRecorder2
  }
}

console.log('7) hallucinated transcripts never reach the agent:')
{
  check('keeps normal speech', !isHallucinatedTranscript('hello, how can I help?'))
  check('keeps short reply', !isHallucinatedTranscript('yes'))
  check('drops single char ghost', isHallucinatedTranscript('x'))
  check('drops repeated loop', isHallucinatedTranscript('test test test test'))
  check('drops empty', isHallucinatedTranscript(''))
}

console.log('8) speech onset needs sustained energy (noise never starts a turn):')
{
  check('single loud frame is not onset', !isSustainedSpeech(1))
  check('two frames are not onset yet', !isSustainedSpeech(2))
  check('three consecutive frames confirm voice', isSustainedSpeech(3))
  check('longer streak stays confirmed', isSustainedSpeech(10))
  check('default gate still rejects faint noise', !isSpeechLevel(0.01))
  check('default gate accepts clear speech', isSpeechLevel(0.02))
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll local live checks passed')
