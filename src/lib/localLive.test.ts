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
  check('repeated word is a hallucination', isHallucinatedTranscript('خب خب خب خب'))
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
  priv['pcmFrames'] = [new Float32Array(8000).fill(0.1)]
  ;(session as unknown as { flushChunk: () => void }).flushChunk()
  await priv['chain']

  const overlap = Math.floor((16000 * LOCAL_LIVE_DEFAULTS.overlapMs) / 1000)
  check('one chunk was transcribed', calls.length === 1, { calls: calls.length })
  if (calls.length === 1) {
    check('chunk is a complete WAV file', calls[0].type === 'audio/wav')
    check('chunk size matches its sample count', calls[0].size === 44 + (8000 - overlap) * 2, {
      size: calls[0].size,
      expected: 44 + (8000 - overlap) * 2,
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
  priv['pcmFrames'] = [new Float32Array(8000).fill(0.1)]
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
  priv['pcmFrames'] = [new Float32Array(8000).fill(0.1)]
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
  const noise = makeSession('خب خب خب خب')
  noise.priv['hasSpeech'] = true
  noise.priv['pcmFrames'] = [new Float32Array(8000).fill(0.1)]
  await (noise.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  check('a repeated-word hallucination is dropped', noise.finals.length === 0, { finals: noise.finals })

  const junk = makeSession('<html><body>gateway error</body></html>')
  junk.priv['hasSpeech'] = true
  junk.priv['pcmFrames'] = [new Float32Array(8000).fill(0.1)]
  await (junk.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  check('an HTML error page is dropped', junk.finals.length === 0, { finals: junk.finals })
}

console.log('11) a failing provider surfaces an error without breaking the loop:')
{
  const failing = makeSession(() => {
    throw new Error('provider down')
  })
  failing.priv['hasSpeech'] = true
  failing.priv['pcmFrames'] = [new Float32Array(8000).fill(0.1)]
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
    failing.priv['pcmFrames'] = [new Float32Array(8000).fill(0.1)]
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
  // Queue several chunks without letting any of them resolve.
  for (let i = 0; i < 4; i++) {
    priv['pcmFrames'] = [new Float32Array(8000).fill(0.1)]
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
  priv['pcmFrames'] = [new Float32Array(8000).fill(0.1)]
  const started = Date.now()
  const done = (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  await Promise.race([
    done,
    new Promise((resolve) => setTimeout(resolve, LOCAL_LIVE_DEFAULTS.drainTimeoutMs + 2000)),
  ])
  const elapsed = Date.now() - started
  check(
    'the turn gives up instead of hanging',
    elapsed < LOCAL_LIVE_DEFAULTS.drainTimeoutMs + 1500,
    { elapsed, cap: LOCAL_LIVE_DEFAULTS.drainTimeoutMs },
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
  // Speaker bleed after echo cancellation is ~0.01-0.04 RMS: it must stay below
  // the gate, otherwise the agent cuts itself off mid-sentence.
  check('typical speaker bleed cannot open the gate', 0.04 < echoSafeThreshold(0.008, true), {
    bleed: 0.04,
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
    new Float32Array(16000).fill(0.1),
  )
  // The chunk cuts consumed the live buffer while the user was speaking; the
  // turn's own copy is what survives to be decoded at the end.
  priv['pcmFrames'] = []
  priv['turn'] = { token: priv['turnToken'] as number, text: 'پیش‌نمایش نادرست' }
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()

  check('exactly one request decodes the whole turn', calls.length === 1, { calls: calls.length })
  check('the request carries the whole utterance', calls[0]?.size === 44 + 16000 * 2, {
    size: calls[0]?.size,
    expected: 44 + 16000 * 2,
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
    new Float32Array(16000).fill(0.1),
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
  priv['turnAudio'] = [new Float32Array(16000).fill(0.1)]
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

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall live voice checks passed')
