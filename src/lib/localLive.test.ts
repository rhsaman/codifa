// Test for the live voice loop in src/lib/localLive.ts.
// Covers the VAD helpers, transcript sanitation, and the PCM chunk pipeline
// (buffering, chunk cuts, per-turn tokens, merge, delivery) without a mic,
// AudioContext or MediaRecorder.
// Run: npx esbuild src/lib/localLive.test.ts --bundle --platform=node --format=esm
//        --packages=external --external:electron --outfile=tests/.tmp-local-live.mjs
//      && node tests/.tmp-local-live.mjs

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
  computeRms,
  isSpeechLevel,
  shouldEndTurn,
  isLocalTranscriptJunk,
  sanitizeLocalTranscript,
  isHallucinatedTranscript,
  isSustainedSpeech,
  updateNoiseFloor,
  speechThreshold,
  NOISE_FLOOR_MIN,
  NOISE_FLOOR_CALIBRATION_FRAMES,
  LOCAL_LIVE_DEFAULTS,
  LIVE_SPEECH_ONSET_FRAMES,
  chooseCut,
  echoSafeThreshold,
  onsetFramesRequired,
  TTS_ECHO_GATE_MULT,
  TTS_ECHO_MIN_GATE,
  TTS_ONSET_FRAMES,
  LocalLiveSession,
} = await import('./localLive')

type Reply = string | ((blob: Blob, lang?: string, prompt?: string) => string | Promise<string>)

/** A session wired to fakes, with its private capture state ready to inject. */
function makeSession(reply: Reply = '') {
  const calls: Array<{ size: number; type: string; lang?: string; prompt?: string }> = []
  const partials: string[] = []
  const finals: string[] = []
  const errors: unknown[] = []
  const session = new LocalLiveSession({
    lang: 'fa',
    transcribe: async (blob, lang, prompt) => {
      calls.push({ size: blob.size, type: blob.type, lang, prompt })
      return typeof reply === 'function' ? await reply(blob, lang, prompt) : reply
    },
    onUserText: (text) => {
      finals.push(text)
    },
    onPartial: (text) => {
      partials.push(text)
    },
    onError: (err) => {
      errors.push(err)
    },
  })
  const priv = session as unknown as Record<string, unknown>
  // openMic() normally sets these; the tests drive the pipeline directly.
  priv['capturing'] = true
  priv['captureRate'] = 16000
  return { session, priv, calls, partials, finals, errors }
}

/** Total number of buffered samples. */
function buffered(priv: Record<string, unknown>): number {
  return (priv['pcmFrames'] as Float32Array[]).reduce((n, f) => n + f.length, 0)
}

/**
 * Synthetic SPEECH-like PCM: a ~4 Hz syllabic envelope over a carrier.
 *
 * A flat `Float32Array(n).fill(0.1)` has a steady energy envelope (CV 0), which
 * is exactly what music or fan hum looks like — and the live pipeline now
 * rejects it before the request (see isLikelySpeechEnvelope). Test audio must
 * therefore carry the envelope of real speech: syllables with gaps between
 * them, which is what these tests are meant to exercise.
 */
function speechPcm(samples: number, rate = 16000, amp = 0.1): Float32Array {
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    const t = i / rate
    // Deep syllable gaps (CV ≈ 1.5, matching measured speech) rather than a
    // shallow wobble: the envelope gate rejects anything as flat as music, so a
    // test signal must actually look like speech. The gaps are narrow enough
    // (≈3 Hz) that a 500 ms buffer still clears MIN_CHUNK_SPEECH_MS once the
    // silence gate has trimmed it.
    const syll = Math.max(0, Math.sin(2 * Math.PI * 3 * t))
    out[i] = amp * syll * syll * syll * Math.sin(2 * Math.PI * 180 * t)
  }
  return out
}

console.log('1) VAD helpers:')
{
  check('silence has zero level', computeRms(new Float32Array([0, 0, 0, 0])) === 0)
  check('loud frame counts as speech', isSpeechLevel(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.02))
  check('quiet frame is not speech', !isSpeechLevel(computeRms(new Float32Array([0.001, -0.001])), 0.02))
  check('default gate accepts close-mic speech', isSpeechLevel(0.05))
  // The gate must follow the room, not a guessed constant: a MacBook array
  // records ~0.006 while a studio mic idles near 0.03, and a fixed threshold
  // silently ignores whichever device falls on the wrong side of it.
  let quiet = 0
  for (let i = 0; i < NOISE_FLOOR_CALIBRATION_FRAMES; i++) {
    quiet = updateNoiseFloor(quiet, 0.006, i < NOISE_FLOOR_CALIBRATION_FRAMES)
  }
  check('quiet room floor is tracked', quiet > 0.004 && quiet < 0.01)
  check('speech over a quiet room is detected', isSpeechLevel(0.02, speechThreshold(quiet)))
  check('steady quiet-room noise never opens the gate', !isSpeechLevel(0.006, speechThreshold(quiet)))
  let loud = 0
  for (let i = 0; i < NOISE_FLOOR_CALIBRATION_FRAMES; i++) {
    loud = updateNoiseFloor(loud, 0.03, i < NOISE_FLOOR_CALIBRATION_FRAMES)
  }
  check('noisy room floor is tracked', loud > 0.02 && loud < 0.04)
  check('speech over a noisy room is detected', isSpeechLevel(0.09, speechThreshold(loud)))
  check('steady noisy-room hum never opens the gate', !isSpeechLevel(0.03, speechThreshold(loud)))
  check('a silent room keeps the absolute minimum gate', updateNoiseFloor(0, 0) === NOISE_FLOOR_MIN)
  check(
    'one loud frame cannot spike the floor and close the gate',
    updateNoiseFloor(0.006, 0.4) < 0.02,
  )
  // Regression (proved in a real browser graph): the calibration window used to
  // average the incoming frames, so a user who starts talking the instant live
  // voice connects taught the gate that their own voice was "the room". The
  // floor then sat at speech level, `floor * 2.5` sat above every frame they
  // could produce, no onset was ever detected and NOTHING happened — silently.
  // Calibration must latch onto the quietest frame, i.e. the real room.
  let talking = 0
  for (const level of [0.004, 0.12, 0.13, 0.11, 0.14]) {
    talking = updateNoiseFloor(talking, level, true)
  }
  check('calibration keeps the quietest frame, not the loudest', talking < 0.01, { talking })
  check(
    'speech after a poisoned calibration still opens the gate',
    isSpeechLevel(0.12, speechThreshold(talking, LOCAL_LIVE_DEFAULTS.levelThreshold, 0.14)),
    { gate: speechThreshold(talking, LOCAL_LIVE_DEFAULTS.levelThreshold, 0.14) },
  )
  // The safety valve itself: even a floor estimate that drifted above speech
  // level cannot hold the gate above the loudest level actually observed.
  const poisoned = 0.13
  check(
    'a runaway floor can never gate out the loudest real sound',
    speechThreshold(poisoned, LOCAL_LIVE_DEFAULTS.levelThreshold, 0.14) < 0.14,
    { gate: speechThreshold(poisoned, LOCAL_LIVE_DEFAULTS.levelThreshold, 0.14) },
  )
  check(
    'the valve only lowers the gate, never raises it',
    speechThreshold(0.001, LOCAL_LIVE_DEFAULTS.levelThreshold, 0.9) === LOCAL_LIVE_DEFAULTS.levelThreshold,
  )
  check('silence timeout ends the turn', shouldEndTurn(1000, 1000))
  check('short pause keeps the turn open', !shouldEndTurn(200, 1000))
  check('one loud frame is not an onset', !isSustainedSpeech(1))
  check('sustained energy is an onset', isSustainedSpeech(3))
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
  check('junk detector sees a bare doctype', isLocalTranscriptJunk('<!doctype html>'))
  check('junk detector clears real speech', !isLocalTranscriptJunk('سلام، خوبی؟'))
}

console.log('3) noise is filtered before it reaches the agent:')
{
  check('empty is a hallucination', isHallucinatedTranscript(''))
  check('single char is a hallucination', isHallucinatedTranscript('ه'))
  // Six floor: real users repeat words on purpose ("سلام سلام سلام") — only
  // Whisper's noise loops go this far.
  check('same word six times is a hallucination', isHallucinatedTranscript('خب خب خب خب خب خب'))
  check('a three-word verbal repeat is real speech', !isHallucinatedTranscript('سلام سلام سلام'))
  // Regression: the ping-pong loop «اینکه از اینکه از…» defeated the
  // same-word check (no word repeats CONSECUTIVELY) and, being LONGER than the
  // real text, then replaced it via fuller-wins. Words are now also compared
  // to the one two back: 5+ alternations of one bigram is a loop, not speech.
  const pingPong = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 'اینکه' : 'از')).join(' ')
  check('two-word ping-pong loop is a hallucination', isHallucinatedTranscript(pingPong))
  check('real speech with a repeated bigram passes', !isHallucinatedTranscript('که این کار رو که این بار کردم'))
  check('real speech passes', !isHallucinatedTranscript('سلام حال شما چطوره'))
}

console.log('4) outside a turn only the pre-roll is buffered:')
{
  const { priv, session } = makeSession()
  priv['hasSpeech'] = false
  // One second of audio while nobody is talking.
  ;(session as unknown as { pushPcm: (f: Float32Array) => void }).pushPcm(new Float32Array(16000).fill(0.01))
  const kept = buffered(priv)
  const expected = Math.floor((16000 * LOCAL_LIVE_DEFAULTS.preRollMs) / 1000)
  check('idle capture is trimmed to the pre-roll', kept === expected, { kept, expected })
}

console.log('4b) the pre-roll outlasts the onset detector, so word one survives:')
{
  // The VAD opens a turn only after LIVE_SPEECH_ONSET_FRAMES frames of voice
  // (LIVE_SPEECH_ONSET_FRAMES * frameMs). A pre-roll no longer than that
  // window re-buffers exactly the audio the streak just consumed, so the word
  // that STARTED the turn ("سلام", a quiet /s/ onset) was never captured —
  // the opening word went missing in live voice only.
  const onsetWindow = LIVE_SPEECH_ONSET_FRAMES * LOCAL_LIVE_DEFAULTS.frameMs
  const preRoll = LOCAL_LIVE_DEFAULTS.preRollMs
  check('pre-roll exceeds the onset window', preRoll > onsetWindow, { preRoll, onsetWindow })
  check('pre-roll leaves margin for a soft onset', preRoll >= onsetWindow * 2, { preRoll })
}

console.log('5) takePcm keeps an overlap tail for the next chunk:')
{
  const { priv, session } = makeSession()
  priv['pcmFrames'] = [new Float32Array(16000)]
  const taken = (session as unknown as { takePcm: (ms: number) => Float32Array }).takePcm(
    LOCAL_LIVE_DEFAULTS.overlapMs,
  )
  const overlap = Math.floor((16000 * LOCAL_LIVE_DEFAULTS.overlapMs) / 1000)
  check('everything but the overlap is taken', taken.length === 16000 - overlap, { len: taken.length })
  check('the overlap stays buffered', buffered(priv) === overlap, { kept: buffered(priv) })
}

console.log('6) chunks are cut while the user is still speaking:')
{
  const { priv, session, calls, partials } = makeSession('سلام')
  priv['hasSpeech'] = true
  // The turn in progress carries its own text on the turn object (a shared
  // string was cleared by the next turn and lost the utterance).
  priv['turn'] = { token: priv['turnToken'] as number, text: 'متن قبلی' }
  // 2 s of audio: a chunk cut leaves the overlap (220 ms) behind and the
  // silence gate trims the rest to syllables, so a short 500 ms buffer no
  // longer carries MIN_CHUNK_SPEECH_MS of speech — which a real 1.4 s chunk
  // always does. Test audio must be long enough to model that.
  priv['pcmFrames'] = [speechPcm(32000)]
  ;(session as unknown as { flushChunk: () => void }).flushChunk()
  await priv['chain']

  const overlap = Math.floor((16000 * LOCAL_LIVE_DEFAULTS.overlapMs) / 1000)
  check('one chunk was transcribed', calls.length === 1, { calls: calls.length })
  if (calls.length === 1) {
    check('chunk is a complete WAV file', calls[0].type === 'audio/wav')
    check('chunk carries the speech, not just the overlap', calls[0].size > 44 + 16000, {
      size: calls[0].size,
      overlap,
    })
    check('language hint is sent', calls[0].lang === 'fa')
    // Regression: the turn text so far used to be fed back as Whisper context.
    // The model then CONTINUED that text instead of transcribing the new audio,
    // so the composer looked frozen ("it types nothing") or repeated itself.
    // Only the user's own glossary may ever be sent as a prompt.
    check('the turn text is never fed back as a prompt', !(calls[0].prompt ?? '').includes('متن قبلی'), {
      prompt: calls[0].prompt,
    })
    check('no prompt at all when the user set no glossary', calls[0].prompt === '', { prompt: calls[0].prompt })
  }
  check('partial text is emitted for the composer', partials[0] === 'متن قبلی سلام', { partials })
  check('public partialText mirrors the turn', session.partialText === 'متن قبلی سلام', {
    partialText: session.partialText,
  })
}

console.log('7) fragments too short to be words are never sent:')
{
  const { priv, session, calls } = makeSession('x')
  priv['hasSpeech'] = true
  priv['pcmFrames'] = [new Float32Array(1000).fill(0.1)]
  ;(session as unknown as { flushChunk: () => void }).flushChunk()
  await priv['chain']
  check('a sub-200ms cut sends nothing', calls.length === 0, { calls: calls.length })
}

console.log('7b) chunks are cut on silence, never through the middle of a word:')
{
  // A clock-based cut lands inside a word about half the time. The provider
  // then transcribes each half separately — «میر» / «میروم» — and because the
  // halves are different tokens the overlap merge cannot rejoin them, so both
  // survive in the user's sentence.
  const rate = 16000
  const n = (ms: number) => Math.floor((rate * ms) / 1000)
  // Loud, then a genuine 120 ms gap centred on the target cut, then loud.
  const pcm = new Float32Array(n(1000))
  pcm.fill(0.2)
  const gapStart = n(500) - n(60)
  for (let i = gapStart; i < gapStart + n(120); i++) pcm[i] = 0

  const target = n(500)
  const cut = chooseCut(pcm, rate, target)
  check('the cut lands inside the quiet gap', cut >= gapStart && cut <= gapStart + n(120), {
    cut,
    gapStart,
    gapEnd: gapStart + n(120),
  })
  check('the cut moved away from the noisy target', cut !== target, { cut, target })

  // Continuous sound has nowhere quiet to cut: the target must win, otherwise
  // the cut would wander to an arbitrary place inside a sustained vowel.
  const loud = new Float32Array(n(1000)).fill(0.2)
  check('a fully loud buffer keeps the target cut', chooseCut(loud, rate, n(500)) === n(500))
  check('an empty buffer cuts at zero', chooseCut(new Float32Array(0), rate, 100) === 0)
}

console.log('8) a late chunk is kept for its own turn, never shown to the next:')
{
  const { priv, session, calls, partials } = makeSession('سلام')
  priv['hasSpeech'] = true
  priv['pcmFrames'] = [speechPcm(32000)]
  ;(session as unknown as { flushChunk: () => void }).flushChunk()
  const firstTurn = priv['turn'] as { token: number; text: string }
  // New turn starts before the previous chunk resolves.
  priv['turnToken'] = (priv['turnToken'] as number) + 1
  priv['turn'] = { token: priv['turnToken'] as number, text: '' }
  await priv['chain']
  // The chunk belongs to the turn that was capturing: its text is exactly what
  // that turn is about to deliver, so it must still be transcribed and merged
  // into ITS OWN turn object. Discarding it here was the "I speak and nothing
  // is typed" bug (beginTurn had already cleared the shared text).
  check('the late chunk is still transcribed', calls.length === 1, { calls: calls.length })
  check('it merges into its own turn', firstTurn.text === 'سلام', { text: firstTurn.text })
  check('the next turn stays empty', (priv['turn'] as { text: string }).text === '', {
    text: (priv['turn'] as { text: string }).text,
  })
  check('no partial is shown for the finished turn', partials.length === 0, { partials })
}

console.log('9) finishing a turn drains every chunk and delivers once:')
{
  const { priv, session, calls, partials, finals } = makeSession('سلام دنیا')
  priv['hasSpeech'] = true
  priv['pcmFrames'] = [speechPcm(32000)]
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()

  check('the tail was transcribed', calls.length === 1, { calls: calls.length })
  check('the progressive preview is cleared', partials[partials.length - 1] === '', { partials })
  check('the merged transcript is delivered once', finals.length === 1 && finals[0] === 'سلام دنیا', { finals })
  check('turn state resets', (priv['turn'] as { text: string }).text === '' && priv['hasSpeech'] === false && buffered(priv) === 0, {
    turnText: (priv['turn'] as { text: string }).text,
    hasSpeech: priv['hasSpeech'],
    buffered: buffered(priv),
  })
  // A second finishTurn with no speech must be a no-op, not an empty message.
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  check('no turn is finalized while idle', finals.length === 1, { finals })
}

console.log('10) hallucinations and error pages never become messages:')
{
  // Six floor (see isHallucinatedTranscript): fifty repeats is the Whisper
  // noise loop, three-to-five is a real verbal repeat.
  const noise = makeSession('خب خب خب خب خب خب')
  noise.priv['hasSpeech'] = true
  noise.priv['pcmFrames'] = [speechPcm(8000)]
  await (noise.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  check('a repeated-word hallucination is dropped', noise.finals.length === 0, { finals: noise.finals })

  const junk = makeSession('<html><body>gateway error</body></html>')
  junk.priv['hasSpeech'] = true
  junk.priv['pcmFrames'] = [speechPcm(8000)]
  await (junk.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  check('an HTML error page is dropped', junk.finals.length === 0, { finals: junk.finals })
}

console.log('11) a failing provider surfaces an error without breaking the loop:')
{
  const failing = makeSession(() => {
    throw new Error('provider down')
  })
  failing.priv['hasSpeech'] = true
  failing.priv['pcmFrames'] = [speechPcm(8000)]
  let threw = false
  try {
    await (failing.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  } catch {
    threw = true
  }
  check('finishTurn does not reject', !threw)
  check('the error is reported', failing.errors.length === 1, { errors: failing.errors })
  check('nothing is delivered', failing.finals.length === 0)
  check('the queue is drained', failing.priv['pending'] === 0, { pending: failing.priv['pending'] })
  check('the session can start a new turn', (await (async () => {
    failing.priv['hasSpeech'] = true
    failing.priv['pcmFrames'] = [speechPcm(8000)]
    await (failing.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
    return failing.errors.length === 2
  })()))
}

console.log('12) chunks are requested in parallel, not one round-trip at a time:')
{
  // Regression: the old chain awaited the previous chunk's round-trip before
  // even SENDING the next one, so the partial transcript fell seconds behind
  // the voice whenever the provider RTT exceeded the chunk interval.
  let inFlight = 0
  let peakInFlight = 0
  const releases: Array<() => void> = []
  const session = new LocalLiveSession({
    lang: 'fa',
    transcribe: async () => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise<void>((resolve) => releases.push(resolve))
      inFlight--
      return 'ok'
    },
    onUserText: () => {},
  })
  const priv = session as unknown as Record<string, unknown>
  priv['hasSpeech'] = true
  priv['capturing'] = true
  priv['captureRate'] = 16000
  // Queue several chunks without letting any of them resolve. The buffer must
  // be long enough that a cut still holds MIN_CHUNK_SPEECH_MS of speech.
  for (let i = 0; i < 4; i++) {
    priv['pcmFrames'] = [speechPcm(32000)]
    ;(session as unknown as { flushChunk: () => void }).flushChunk()
  }
  await new Promise((r) => setTimeout(r, 0))
  check('more than one request is in flight at once', peakInFlight > 1, { peakInFlight })
  check(
    'in-flight requests stay bounded by maxInflight',
    peakInFlight <= LOCAL_LIVE_DEFAULTS.maxInflight,
    { peakInFlight, max: LOCAL_LIVE_DEFAULTS.maxInflight },
  )
  // Release slots as new requests appear until the queue drains: a chunk that
  // was waiting for a free slot only starts its request after each release.
  for (let i = 0; i < 25 && (priv['pending'] as number) > 0; i++) {
    for (const release of releases.splice(0)) release()
    await new Promise((r) => setTimeout(r, 0))
  }
  await priv['chain']
  check('the queue drains completely', priv['pending'] === 0, { pending: priv['pending'] })
  check('no request is left in flight', priv['activeRequests'] === 0, {
    activeRequests: priv['activeRequests'],
  })
}

console.log('13) a hanging provider delays a turn, it never freezes live voice:')
{
  // Regression: finishTurn awaited the whole chain with no cap, so one stuck
  // request could hold the turn (and the mic handoff) forever.
  const session = new LocalLiveSession({
    lang: 'fa',
    transcribe: () => new Promise<string>(() => {}),
    onUserText: () => {},
  })
  const priv = session as unknown as Record<string, unknown>
  priv['capturing'] = true
  priv['captureRate'] = 16000
  priv['hasSpeech'] = true
  priv['pcmFrames'] = [speechPcm(8000)]
  const started = Date.now()
  const done = (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  await Promise.race([
    done,
    new Promise((resolve) => setTimeout(resolve, LOCAL_LIVE_DEFAULTS.turnDeliverBudgetMs + 2000)),
  ])
  const elapsed = Date.now() - started
  check(
    'the turn gives up instead of hanging',
    elapsed < LOCAL_LIVE_DEFAULTS.turnDeliverBudgetMs + 1500,
    { elapsed, cap: LOCAL_LIVE_DEFAULTS.turnDeliverBudgetMs },
  )
  check('the session is usable again', priv['transcribing'] === false, {
    transcribing: priv['transcribing'],
  })
}

console.log('14) delivering a turn does not block the next one:')
{
  // Regression: finishTurn AWAITED onUserText, which runs the whole agent turn
  // (model, streaming, TTS). `transcribing` therefore stayed true for the
  // entire answer, and every later utterance hit the guard at the top of
  // finishTurn and was silently dropped: the first turn worked, then live voice
  // never produced text again.
  const delivered: string[] = []
  let release: (() => void) | null = null
  const session = new LocalLiveSession({
    lang: 'fa',
    transcribe: async () => 'سلام',
    onUserText: (text) => {
      delivered.push(text)
      // A long-running agent turn: never resolves until the test releases it.
      return new Promise<void>((resolve) => {
        release = resolve
      })
    },
  })
  const priv = session as unknown as Record<string, unknown>
  priv['capturing'] = true
  priv['captureRate'] = 16000
  priv['hasSpeech'] = true
  priv['turn'] = { token: priv['turnToken'], text: 'سلام' }
  const first = (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  await new Promise((r) => setTimeout(r, 20))
  check('the turn was delivered', delivered.length === 1, { delivered })
  check('finishTurn returns without waiting for the agent', priv['transcribing'] === false, {
    transcribing: priv['transcribing'],
  })

  // Second turn while the first answer is still running.
  priv['hasSpeech'] = true
  priv['turn'] = { token: priv['turnToken'], text: 'دنیا' }
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  await new Promise((r) => setTimeout(r, 20))
  check('a later utterance is still delivered', delivered.length === 2, { delivered })
  if (release) (release as () => void)()
  await first
}

console.log('15) a turn ending during a drain is retried, not lost:')
{
  // Regression: when finishTurn ran while another turn was still draining it
  // returned early WITHOUT clearing hasSpeech, so nothing was ever scheduled to
  // close that turn and the speech was lost.
  let calls = 0
  const session = new LocalLiveSession({
    lang: 'fa',
    transcribe: async () => {
      calls++
      return 'سلام'
    },
    onUserText: () => {},
  })
  const priv = session as unknown as Record<string, unknown>
  priv['capturing'] = true
  priv['captureRate'] = 16000
  priv['hasSpeech'] = true
  priv['transcribing'] = true
  priv['turn'] = { token: priv['turnToken'], text: 'سلام' }
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  check('a busy session does not clear the pending speech', priv['hasSpeech'] === true)
  check('a retry was scheduled', priv['finishTimer'] !== null, { timer: priv['finishTimer'] })
  // Clear the guard and let the retry run.
  priv['transcribing'] = false
  await new Promise((r) => setTimeout(r, 300))
  check('the deferred turn is finally closed', priv['hasSpeech'] === false, { hasSpeech: priv['hasSpeech'] })
  check('no chunk request was needed to close it', calls === 0, { calls })
}

console.log('16) the agent\'s own voice cannot interrupt it:')
{
  // Regression: the mic stays open during TTS, so the agent's own playback
  // bleed crossed the normal gate, fired onSpeechStart and stopped playback —
  // the answer cut off mid-sentence.
  check('the gate is raised while the agent speaks', echoSafeThreshold(0.01, true) >= TTS_ECHO_MIN_GATE, {
    raised: echoSafeThreshold(0.01, true),
  })
  check('the gate is unchanged when it is quiet', echoSafeThreshold(0.01, false) === 0.01)
  // Speaker bleed after echo cancellation sits up to ~0.02 RMS: it must stay
  // below the gate, otherwise the agent cuts itself off mid-sentence.
  check('typical speaker bleed cannot open the gate', 0.02 < echoSafeThreshold(0.008, true), {
    bleed: 0.02,
    gate: echoSafeThreshold(0.008, true),
  })
  // Regression: the floor used to sit at 0.06, ABOVE ordinary speech on a quiet
  // laptop mic (~0.03), so while the agent was working the mic was deaf and the
  // user's sentence only became text after the turn had ended.
  check('quiet speech opens the gate while the agent speaks', 0.03 >= echoSafeThreshold(0.008, true), {
    speech: 0.03,
    gate: echoSafeThreshold(0.008, true),
  })
  check('onset needs a longer streak while speaking', onsetFramesRequired(true) === TTS_ONSET_FRAMES)
  check(
    'onset is unchanged when the agent is silent',
    onsetFramesRequired(false) < TTS_ONSET_FRAMES,
    { frames: onsetFramesRequired(false) },
  )
  // A realistic loud barge-in must still get through the raised gate.
  check('a person talking over the agent still starts a turn', 0.25 >= echoSafeThreshold(0.008, true), {
    gate: echoSafeThreshold(0.008, true),
  })
}

console.log('17) the delivered text comes from ONE full-clip decode, like dictation:')
{
  // Regression: the chunk preview was delivered as the turn. Whisper had only
  // ~1.4 s of Persian per chunk and guessed, so the same voice transcribed
  // correctly in dictate (one long clip) and wrongly in live. The finished
  // utterance is now re-decoded as a single clip and THAT text is delivered.
  const { priv, session, calls, finals } = makeSession('سلام دنیا')
  priv['hasSpeech'] = true
  ;(session as unknown as { pushPcm: (f: Float32Array) => void }).pushPcm(
    speechPcm(16000),
  )
  // The chunk cuts consumed the live buffer while the user was speaking; the
  // turn's own copy is what survives to be decoded at the end.
  priv['pcmFrames'] = []
  priv['turn'] = { token: priv['turnToken'] as number, text: 'پیش‌نمایش نادرست' }
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()

  check('exactly one request decodes the whole turn', calls.length === 1, { calls: calls.length })
  // The whole clip is sent, not a chunk: the silence trim only pads/trims the
  // edges, so allow the head/tail pad around the 1 s utterance instead of
  // pinning the byte count to the raw input length.
  const wholeSamples = ((calls[0]?.size ?? 0) - 44) / 2
  check('the request carries the whole utterance', wholeSamples >= 15000, {
    samples: wholeSamples,
  })
  check('the delivered text is the full-clip result', finals[0] === 'سلام دنیا', { finals })
  check(
    'the chunk preview is not delivered as the turn',
    !(finals[0] ?? '').includes('پیش‌نمایش'),
    { finals },
  )
  check('the turn audio buffer is released', priv['turnAudioLen'] === 0, {
    turnAudioLen: priv['turnAudioLen'],
  })
}

console.log('18) a failed full-clip decode still delivers the preview:')
{
  // The single-clip request is best-effort: a provider error must not turn the
  // utterance into nothing when the chunk preview already has the words.
  const failing = makeSession(() => {
    throw new Error('provider down')
  })
  failing.priv['hasSpeech'] = true
  ;(failing.session as unknown as { pushPcm: (f: Float32Array) => void }).pushPcm(
    speechPcm(16000),
  )
  failing.priv['pcmFrames'] = []
  failing.priv['turn'] = { token: failing.priv['turnToken'] as number, text: 'پیش‌نمایش' }
  await (failing.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()

  check('the preview is delivered when the full decode fails', failing.finals[0] === 'پیش‌نمایش', {
    finals: failing.finals,
  })
  check('the failure is surfaced', failing.errors.length >= 1, { errors: failing.errors.length })
}

console.log('19) a turn too long for one ASR window keeps the chunk transcript:')
{
  // Past the model's single-window length the buffered audio is incomplete, so
  // decoding it would silently drop the last words. The chunk merge wins.
  const { priv, session, calls, finals } = makeSession('نتیجه تکه‌ها')
  priv['hasSpeech'] = true
  priv['turnAudio'] = [speechPcm(16000)]
  priv['turnAudioLen'] = 16000
  priv['turnAudioTruncated'] = true
  priv['turn'] = { token: priv['turnToken'] as number, text: 'نتیجه تکه‌ها' }
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()

  check('no full-clip request is sent for a truncated turn', calls.length === 0, {
    calls: calls.length,
  })
  check('the chunk transcript is delivered', finals[0] === 'نتیجه تکه‌ها', { finals })
  check('the stale audio is discarded', priv['turnAudioLen'] === 0, {
    turnAudioLen: priv['turnAudioLen'],
  })
}

console.log('20) dictate mode: only an explicit stop ends the turn:')
{
  // Regression: in dictate mode the 800 ms silence timeout of live voice must
  // NOT close the turn — a natural pause while dictating would have finalized
  // and sent half a sentence. Only tickChunks' dictate branch keeps cutting
  // through it, and only finishDictation (mic button / Space) delivers.
  const finals: string[] = []
  const partials: string[] = []
  const calls: { size: number }[] = []
  const session = new LocalLiveSession({
    lang: 'fa',
    dictate: true,
    transcribe: async (blob) => {
      calls.push({ size: blob.size })
      return 'متن دیکته'
    },
    onUserText: (t) => {
      finals.push(t)
    },
    onPartial: (t) => {
      partials.push(t)
    },
  })
  const priv = session as unknown as Record<string, unknown>
  priv['capturing'] = true
  priv['captureRate'] = 16000
  priv['hasSpeech'] = true
  // As in test 12: a 2 s buffer — a short one would be dropped by the
  // silence-trim gate (MIN_CHUNK_SPEECH_MS) before any request is queued.
  priv['pcmFrames'] = [speechPcm(32000)]
  // Simulate speech that started long ago: past maxChunkMs the live engine
  // would force-close the turn; dictate must keep it open instead.
  priv['speechStartAt'] = Date.now() - LOCAL_LIVE_DEFAULTS.maxChunkMs - 5000
  priv['lastFlushAt'] = Date.now() - LOCAL_LIVE_DEFAULTS.chunkMs - 5
  const ticks = session as unknown as {
    tickChunks: (now: number, chunkMs: number, maxChunkMs: number) => void
  }
  ticks.tickChunks(Date.now(), LOCAL_LIVE_DEFAULTS.chunkMs, LOCAL_LIVE_DEFAULTS.maxChunkMs)
  // The chunk request starts on the next microtask (inflight semaphore).
  await new Promise((r) => setTimeout(r, 0))
  check('a long pause never closes a dictate turn', finals.length === 0, {
    finals: finals.length,
  })
  check('chunks keep cutting through the pause', calls.length === 1, {
    calls: calls.length,
  })
  check('the streamed preview reaches the composer', partials[partials.length - 1] === 'متن دیکته', {
    partials,
  })

  // Mic button pressed: flush the tail, drain, deliver, tear down.
  await (session as unknown as { finishDictation: () => Promise<void> }).finishDictation()
  check('an explicit stop delivers the final text',
    finals.length === 1 && finals[0] === 'متن دیکته',
    { finals },
  )
  check('the preview is cleared on stop', partials[partials.length - 1] === '', {
    partials,
  })
  check('the engine is torn down after delivery', priv['stopped'] === true, {})

  // A second press (or Space) must be a no-op, not a duplicate message.
  await (session as unknown as { finishDictation: () => Promise<void> }).finishDictation()
  check('a repeated stop does not duplicate the text', finals.length === 1, {
    finals: finals.length,
  })
}

console.log('21) multi-chunk dictate accumulates (the "only the first chunk" regression):')
{
  // The composer showed ONLY the first chunk's words while the server returned
  // full text for every chunk. The engine contract this pins: chunks 2+ must
  // APPEND to the turn (mergeTranscripts) — the turn and the preview may never
  // reset to an earlier chunk's words, and no chunk may be dropped silently.
  let call = 0
  const perChunk = ['سلام خوبی', 'این تکه دوم است و اضافه میشود', 'و تکه سوم پایانی']
  const calls: { size: number }[] = []
  const partials: string[] = []
  const finals: string[] = []
  const session = new LocalLiveSession({
    lang: 'fa',
    dictate: true,
    transcribe: async (blob) => {
      calls.push({ size: blob.size })
      return perChunk[Math.min(call++, perChunk.length - 1)]
    },
    onUserText: (t) => {
      finals.push(t)
    },
    onPartial: (t) => {
      partials.push(t)
    },
  })
  const priv = session as unknown as Record<string, unknown>
  priv['capturing'] = true
  priv['captureRate'] = 16000
  // An open turn is required, or finishDictation (+ finishTurn) returns early.
  priv['hasSpeech'] = true
  priv['turn'] = { token: priv['turnToken'] as number, text: '' }
  // Three 1 s speech buffers cut back-to-back, exactly what the monitor does
  // while the user keeps talking past chunkMs. Overlap is deliberately NOT
  // simulated: appending on a no-overlap match is the weaker guarantee — if
  // the merge can lose words here, it can lose them anywhere.
  for (let i = 0; i < 3; i++) {
    priv['pcmFrames'] = [speechPcm(16000)]
    ;(session as unknown as { flushChunk: () => void }).flushChunk()
    // The request resolves on the next microtask chain link.
    await new Promise((r) => setTimeout(r, 0))
  }
  await new Promise((r) => setTimeout(r, 30))
  check('at least the three chunks left for the transcriber', calls.length >= 3, {
    calls: calls.length,
  })
  const last = partials[partials.length - 1] ?? ''
  check(
    'the preview holds chunk 1, 2 AND 3',
    last.includes('سلام خوبی') && last.includes('تکه دوم') && last.includes('پایانی'),
    { last, partials },
  )
  // finishDictation must be AWAITED: delivery happens after the drain (macro-
  // tasks), exactly like the existing dictate test above.
  await (session as unknown as { finishDictation: () => Promise<void> }).finishDictation()
  const delivered = finals[finals.length - 1] ?? ''
  check(
    'the delivered final keeps every chunk',
    delivered.includes('سلام خوبی') && delivered.includes('پایانی'),
    { finals },
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall live voice checks passed')


