// Test for the live voice loop in src/lib/localLive.ts.
// Covers the VAD helpers, transcript sanitation, and the PCM chunk pipeline
// (buffering, chunk cuts, per-turn tokens, merge, delivery) without a mic,
// AudioContext or MediaRecorder.
// Run: npx esbuild tests/localLive.test.ts --bundle --platform=node --format=esm
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
  isSpeechHangover,
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
  stripNonSpeech,
  stripEllipsis,
  TURN_LEVEL_HANGOVER_RATIO,
  selectPreRollStart,
  isSparseTranscript,
  TURN_LEVEL_DECAY,
  collapseRepeatedPhrases,
  voicedRunMs,
  echoSafeThreshold,
  onsetFramesRequired,
  TTS_ECHO_GATE_MULT,
  TTS_ECHO_MIN_GATE,
  TTS_BLEED_GATE_MULT,
  TTS_ECHO_GATE_MAX,
  TTS_ONSET_FRAMES,
  liveEditDelta,
  decayPeakRms,
  PEAK_RMS_DECAY,
  LocalLiveSession,
} = await import('../src/lib/localLive')

type Reply = string | ((blob: Blob, lang?: string) => string | Promise<string>)

/** A session wired to fakes, with its private capture state ready to inject. */
function makeSession(reply: Reply = '') {
  const calls: Array<{ size: number; type: string; lang?: string }> = []
  const partials: string[] = []
  const finals: string[] = []
  const errors: unknown[] = []
  const session = new LocalLiveSession({
    lang: 'fa',
    transcribe: async (blob, lang) => {
      calls.push({ size: blob.size, type: blob.type, lang })
      return typeof reply === 'function' ? await reply(blob, lang) : reply
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


type Priv = Record<string, unknown>
/** Call a private session method by name (the tests drive the pipeline directly). */
function call<T = unknown>(session: unknown, name: string, ...args: unknown[]): T {
  return (session as Record<string, (...a: unknown[]) => T>)[name](...args)
}
/** Put speech into the open turn the way capture does. */
function feed(session: unknown, priv: Priv, samples: Float32Array): void {
  priv['hasSpeech'] = true
  call(session, 'pushPcm', samples)
}
/** The preview decode currently in flight (null when idle). */
function previewInFlight(priv: Priv): Promise<void> | null {
  return (priv['preview'] as { current(): Promise<void> | null }).current()
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

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
  // Hysteresis: an OPEN turn must survive fricatives and word gaps whose RMS
  // sits between 0.5x and 1x the onset gate — the exact frames where the old
  // single-threshold VAD closed mid-word (the "پاک شدن متن بعد مکث" bug).
  const hystereisGate = 0.02
  check(
    'hangover keeps the turn open at half the gate',
    isSpeechHangover(0.011, hystereisGate) && !isSpeechLevel(0.011, hystereisGate),
  )
  check('hangover still yields to true silence', !isSpeechHangover(0.005, hystereisGate))
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
  // Three seconds of audio while nobody is talking (longer than the pre-roll).
  ;(session as unknown as { pushPcm: (f: Float32Array) => void }).pushPcm(new Float32Array(48000).fill(0.01))
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

console.log('5) a turn keeps its whole audio, the pre-roll buffer stays small:')
{
  const { priv, session } = makeSession()
  feed(session, priv, speechPcm(32000))
  check('the turn buffer holds everything said', (priv['turnAudioLen'] as number) === 32000, {
    len: priv['turnAudioLen'],
  })
  check('the live pre-roll buffer is not fed during a turn', buffered(priv) === 0, {
    kept: buffered(priv),
  })
}

console.log('6) the preview decodes the WHOLE turn so far and replaces the old text:')
{
  let n = 0
  const replies = ['سلام', 'سلام، من اینجام']
  const { priv, session, calls, partials } = makeSession(() => replies[Math.min(n++, 1)])
  priv['turn'] = { token: priv['turnToken'] as number, text: 'متن قبلی', delivered: false }
  feed(session, priv, speechPcm(32000))
  call(session, 'startPreview', Date.now())
  await previewInFlight(priv)

  check('one request was sent', calls.length === 1, { calls: calls.length })
  if (calls.length === 1) {
    check('it is a complete WAV file', calls[0].type === 'audio/wav')
    check('it carries the turn audio', calls[0].size > 44 + 16000, { size: calls[0].size })
    check('language hint is sent', calls[0].lang === 'fa')
  }
  // Never merged with the old text: the new decode saw the whole turn.
  check('the preview REPLACES the earlier text', partials[0] === 'سلام', { partials })
  check('public partialText mirrors the turn', session.partialText === 'سلام', {
    partialText: session.partialText,
  })

  // More speech, second preview: it covers MORE audio and re-hears the words.
  feed(session, priv, speechPcm(16000))
  call(session, 'startPreview', Date.now())
  await previewInFlight(priv)
  check('the second request carries more audio', calls.length === 2 && calls[1].size > calls[0].size, {
    sizes: calls.map((c) => c.size),
  })
  check('a re-worded preview replaces, it does not append', partials[1] === 'سلام، من اینجام', { partials })
}

console.log('7) fragments too short to be words are never sent:')
{
  const { priv, session, calls } = makeSession('x')
  feed(session, priv, new Float32Array(1000).fill(0.1))
  call(session, 'startPreview', Date.now())
  await previewInFlight(priv)
  check('a sub-200ms fragment sends nothing', calls.length === 0, { calls: calls.length })
}

console.log('7b) one decode at a time: the next one starts when the last has landed:')
{
  let n = 0
  let release!: (t: string) => void
  const gate = new Promise<string>((resolve) => {
    release = resolve
  })
  const { priv, session, calls, partials } = makeSession(() => (++n === 1 ? gate : 'متن دوم'))
  feed(session, priv, speechPcm(32000))
  const spacing = LOCAL_LIVE_DEFAULTS.chunkMs
  const maxTurn = LOCAL_LIVE_DEFAULTS.maxChunkMs
  priv['previewStartedAt'] = 0
  priv['lastSpeechAt'] = 5000
  call(session, 'tickPreview', 5000, spacing, maxTurn)
  await tick()
  check('the first tick starts a decode', calls.length === 1, { calls: calls.length })

  priv['lastSpeechAt'] = 9000
  call(session, 'tickPreview', 9000, spacing, maxTurn)
  await tick()
  check('a tick while one is running starts nothing', calls.length === 1, { calls: calls.length })

  release('متن اول')
  await previewInFlight(priv)
  priv['lastSpeechAt'] = 12000
  call(session, 'tickPreview', 12000, spacing, maxTurn)
  await previewInFlight(priv)
  check('the next tick after it landed starts the next decode', calls.length === 2, { calls: calls.length })
  check('the latest decode is what is shown', partials[partials.length - 1] === 'متن دوم', { partials })

  priv['speechStartAt'] = 4000
  call(session, 'tickPreview', 16000, spacing, maxTurn)
  await tick()
  check('no new speech since the last decode: no request', calls.length === 2, { calls: calls.length })
}

console.log('7c) hesitation sounds, keyboard and tags are not transcribed:')
{
  check('a hum token is dropped', stripNonSpeech('ممم') === '')
  check('persian hesitation with diacritics and dots', stripNonSpeech('اِممم...') === '')
  check('latin hesitation sounds', stripNonSpeech('emmmm') === '' && stripNonSpeech('Hmmm.') === '' && stripNonSpeech('uhh') === '')
  check('only hesitations in a row', stripNonSpeech('امم ممم اه') === '')
  check('hesitations inside a sentence are removed, words stay', stripNonSpeech('من فکر می‌کنم ممم که درسته') === 'من فکر می‌کنم که درسته', {
    got: stripNonSpeech('من فکر می‌کنم ممم که درسته'),
  })
  check('sound-effect tags are removed', stripNonSpeech('[موسیقی]') === '' && stripNonSpeech('(typing sounds) سلام') === 'سلام')
  check('real short words survive', stripNonSpeech('هم') === 'هم' && stripNonSpeech('ام') === 'ام' && stripNonSpeech('نه') === 'نه')
  check('code-like text survives', stripNonSpeech('تابع foo() رو صدا بزن') === 'تابع foo() رو صدا بزن')
  // Server-log regression: a drawn-out hum came back as «ایییم.» and was typed.
  check('elongated persian hum with a tail m', stripNonSpeech('ایییم.') === '' && stripNonSpeech('آییییم') === '' && stripNonSpeech('اییی') === '')
  check('words that merely start with ای survive', stripNonSpeech('ایم') === 'ایم' && stripNonSpeech('ایران') === 'ایران')
  check('whisper cut-off ellipsis is stripped', stripEllipsis('... کردم و نمایش بده') === 'کردم و نمایش بده' && stripEllipsis('وقتی من از...') === 'وقتی من از' && stripEllipsis('سلام…') === 'سلام', {
    a: stripEllipsis('... کردم و نمایش بده'),
    b: stripEllipsis('وقتی من از...'),
  })
  check('a normal sentence keeps its final period', stripEllipsis('سلام.') === 'سلام.')
  check('a repeated multi-word phrase is kept once', collapseRepeatedPhrases('و وقتی از اینها بیشتر می‌شه، از اینها بیشتر می‌شه.') === 'و وقتی از اینها بیشتر می‌شه.', {
    got: collapseRepeatedPhrases('و وقتی از اینها بیشتر می‌شه، از اینها بیشتر می‌شه.'),
  })
  check('a single repeated word is left alone', collapseRepeatedPhrases('سلام سلام خوبی چطوری') === 'سلام سلام خوبی چطوری')
  check('non-repeating text is untouched', collapseRepeatedPhrases('من میخوام این کار رو انجام بدم') === 'من میخوام این کار رو انجام بدم')
  check('sanitize drops the hum with ellipsis', sanitizeLocalTranscript('ایییم...') === '')
  check('sanitize drops a hum-only transcript', sanitizeLocalTranscript('ممم', 'fa') === '')
  check('sanitize keeps the words around a hum', sanitizeLocalTranscript('سلام امم خوبی', 'fa') === 'سلام خوبی', {
    got: sanitizeLocalTranscript('سلام امم خوبی', 'fa'),
  })

  // A held hum is voiced and loud, but its energy envelope is flat: it never
  // reaches the server at all.
  const hum = new Float32Array(48000)
  for (let i = 0; i < hum.length; i++) hum[i] = 0.1 * Math.sin((2 * Math.PI * 120 * i) / 16000)
  const h = makeSession('ممم')
  feed(h.session, h.priv, hum)
  call(h.session, 'startPreview', Date.now())
  await previewInFlight(h.priv)
  check('a flat hum is not sent for decoding', h.calls.length === 0, { calls: h.calls.length })

  check('a short word still has syllable-length sound', voicedRunMs(speechPcm(16000), 16000) >= 120)
  // A keyboard burst: a few sharp clicks, far shorter than a word.
  const keys = new Float32Array(32000)
  for (const at of [2000, 6000, 11000, 15000, 22000]) {
    for (let i = 0; i < 240; i++) keys[at + i] = 0.5 * Math.sin(i / 3) * (1 - i / 240)
  }
  const k = makeSession('تق تق')
  feed(k.session, k.priv, keys)
  call(k.session, 'startPreview', Date.now())
  await previewInFlight(k.priv)
  check('keyboard clicks are not sent for decoding', k.calls.length === 0, { calls: k.calls.length })
}

console.log('8) a late preview is kept for its own turn, never shown to the next:')
{
  let release!: (t: string) => void
  const gate = new Promise<string>((resolve) => {
    release = resolve
  })
  const { priv, session, calls, partials } = makeSession(() => gate)
  feed(session, priv, speechPcm(32000))
  call(session, 'startPreview', Date.now())
  const firstTurn = priv['turn'] as { token: number; text: string }
  await tick()
  // A new turn starts before the previous preview resolves.
  priv['turnToken'] = (priv['turnToken'] as number) + 1
  priv['turn'] = { token: priv['turnToken'] as number, text: '', delivered: false }
  release('سلام')
  await previewInFlight(priv)
  check('the late preview was still decoded', calls.length === 1, { calls: calls.length })
  check('it lands in its own turn', firstTurn.text === 'سلام', { text: firstTurn.text })
  check('the next turn stays empty', (priv['turn'] as { text: string }).text === '', {
    text: (priv['turn'] as { text: string }).text,
  })
  check('no partial is shown for the finished turn', partials.length === 0, { partials })
}

console.log('9) finishing a turn decodes it once and delivers once:')
{
  const { priv, session, calls, partials, finals } = makeSession('سلام دنیا')
  feed(session, priv, speechPcm(32000))
  await call<Promise<void>>(session, 'finishTurn')

  check('the whole turn was decoded in one request', calls.length === 1, { calls: calls.length })
  check('the progressive preview is cleared', partials[partials.length - 1] === '', { partials })
  check('the transcript is delivered once', finals.length === 1 && finals[0] === 'سلام دنیا', { finals })
  check('turn state resets', (priv['turn'] as { text: string }).text === '' && priv['hasSpeech'] === false && buffered(priv) === 0, {
    turnText: (priv['turn'] as { text: string }).text,
    hasSpeech: priv['hasSpeech'],
    buffered: buffered(priv),
  })
  await call<Promise<void>>(session, 'finishTurn')
  check('no turn is finalized while idle', finals.length === 1, { finals })
}

console.log('10) hallucinations and error pages never become messages:')
{
  // Six floor (see isHallucinatedTranscript): fifty repeats is the Whisper
  // noise loop, three-to-five is a real verbal repeat.
  const noise = makeSession('خب خب خب خب خب خب')
  feed(noise.session, noise.priv, speechPcm(16000))
  await (noise.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  check('a repeated-word hallucination is dropped', noise.finals.length === 0, { finals: noise.finals })

  const junk = makeSession('<html><body>gateway error</body></html>')
  feed(junk.session, junk.priv, speechPcm(16000))
  await (junk.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  check('an HTML error page is dropped', junk.finals.length === 0, { finals: junk.finals })
}

console.log('11) a failing provider surfaces an error without breaking the loop:')
{
  const failing = makeSession(() => {
    throw new Error('provider down')
  })
  feed(failing.session, failing.priv, speechPcm(16000))
  let threw = false
  try {
    await (failing.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
  } catch {
    threw = true
  }
  check('finishTurn does not reject', !threw)
  check('the error is reported', failing.errors.length === 1, { errors: failing.errors })
  check('nothing is delivered', failing.finals.length === 0)
  check('no request is left in flight', failing.priv['activeRequests'] === 0, {
    active: failing.priv['activeRequests'],
  })
  check('the session can start a new turn', (await (async () => {
    feed(failing.session, failing.priv, speechPcm(16000))
    await (failing.session as unknown as { finishTurn: () => Promise<void> }).finishTurn()
    return failing.errors.length === 2
  })()))
}

console.log('12) previews never overlap, however often the monitor ticks:')
{
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
  const priv = session as unknown as Priv
  priv['capturing'] = true
  priv['captureRate'] = 16000
  feed(session, priv, speechPcm(32000))
  for (let i = 0; i < 6; i++) call(session, 'startPreview', Date.now() + i)
  await tick()
  check('exactly one request is in flight', peakInFlight === 1 && releases.length === 1, {
    peakInFlight,
    releases: releases.length,
  })
  for (const release of releases.splice(0)) release()
  await previewInFlight(priv)
  check('the guard is free again after it landed', previewInFlight(priv) === null)
  check('no request is left in flight', priv['activeRequests'] === 0, { active: priv['activeRequests'] })
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
  feed(session, priv, speechPcm(16000))
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

console.log('16) the agent\'s own voice cannot interrupt it, but the user can:')
{
  // Regression: the mic stays open during TTS, so the agent's own playback
  // bleed crossed the normal gate, fired onSpeechStart and stopped playback —
  // the answer cut off mid-sentence.
  check('the gate is raised while the agent speaks', echoSafeThreshold(0.01, true) >= TTS_ECHO_MIN_GATE, {
    raised: echoSafeThreshold(0.01, true),
  })
  check('the gate is unchanged when it is quiet', echoSafeThreshold(0.01, false) === 0.01)
  // THE barge-in fix: the old FIXED 0.025 floor sat above a quiet mic's voice,
  // so the user could never interrupt the agent and had to wait for the whole
  // answer. The gate now anchors on the measured between-syllable residual:
  // well below speech when the AEC works, above the residual always.
  const quietBleedGate = echoSafeThreshold(0.008, true, 0.004)
  check('a quiet residual keeps the gate below ordinary speech', quietBleedGate <= 0.02, {
    gate: quietBleedGate,
  })
  check('the gate still sits above the measured residual', quietBleedGate >= 0.004 * TTS_BLEED_GATE_MULT)
  // A leaky AEC (loud residual) raises the gate instead of letting the agent
  // cut itself off — the fixed floor's job, now adaptive.
  const loudBleedGate = echoSafeThreshold(0.008, true, 0.012)
  check('a loud residual raises the gate above it', loudBleedGate >= 0.012 * TTS_BLEED_GATE_MULT, {
    gate: loudBleedGate,
  })
  check('the adaptive gate is capped so the mic stays reachable', loudBleedGate <= TTS_ECHO_GATE_MAX)
  // Transient bleed peaks are the streak's job: they last a frame or two,
  // never the four frames a real barge-in sustains.
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
  check('quiet speech barges in over a quiet residual', 0.03 >= quietBleedGate, {
    speech: 0.03,
    gate: quietBleedGate,
  })
}

console.log('16b) a barge-in turn does not inherit the agent\'s voice:')
{
  // The audio buffered before the onset is, during playback, mostly the agent's
  // own voice through the speakers. Keeping ALL of it transcribed the agent's
  // sentence INTO the user's interrupting message, but dropping all of it lost
  // the user's first syllables (the onset frames). Only the onset window is kept.
  const { priv, session } = makeSession()
  priv['ttsSpeaking'] = true
  priv['pcmFrames'] = Array.from({ length: 20 }, () => new Float32Array(1600).fill(0.02)) // 2 s of agent bleed
  ;(session as unknown as { beginTurn: (now: number) => void }).beginTurn(1000)
  check('only the onset window of the buffer is kept', (priv['turnAudioLen'] as number) > 0 && (priv['turnAudioLen'] as number) <= 11200, {
    turnAudioLen: priv['turnAudioLen'],
  })
  check('the older agent audio is dropped', buffered(priv) <= 11200, { kept: buffered(priv) })
  check('a barge-in turn is a fresh turn', priv['hasSpeech'] === true)

  // Normal (agent silent) turns keep the pre-roll: the first syllable survives.
  const normal = makeSession()
  normal.priv['ttsSpeaking'] = false
  normal.priv['pcmFrames'] = [speechPcm(8000)]
  ;(normal.session as unknown as { beginTurn: (now: number) => void }).beginTurn(1000)
  check('a normal turn still keeps the pre-roll', (normal.priv['turnAudioLen'] as number) > 0, {
    turnAudioLen: normal.priv['turnAudioLen'],
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

console.log('17b) an inflated chunk preview never outranks the full-clip decode:')
{
  // Regression, measured on the live engine: a 1.6 s chunk is far below
  // Whisper's 30 s training window, so every chunk pads its edges with a
  // plausible word that was NEVER SPOKEN (truth «یک کتاب» cut mid-word decoded
  // as «یکیتی», then «یکی»). The merged preview is therefore always LONGER
  // than the clean single-clip decode — 12/16/29 words against a truth of
  // 7/11/15 — and the old "fuller wins" rule delivered the invented half every
  // single time. The whole-clip decode must win even when it is shorter.
  const { priv, session, finals } = makeSession('سلام امروز هوا خوب است')
  priv['hasSpeech'] = true
  ;(session as unknown as { pushPcm: (f: Float32Array) => void }).pushPcm(
    speechPcm(16000),
  )
  priv['pcmFrames'] = []
  // A bloated preview: the clean decode is a strict SUBSET of it, exactly the
  // shape the hallucinating chunks produced.
  priv['turn'] = {
    token: priv['turnToken'] as number,
    text: 'سلامه، سلامه. سلام امروز هوا خوب است. امروز هوا خوب است.',
  }
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()

  check('the shorter, clean full-clip text is delivered', finals[0] === 'سلام امروز هوا خوب است', {
    finals,
  })
  check('no invented repetition reaches the user', !(finals[0] ?? '').includes('سلامه'), {
    finals,
  })
}

console.log('17c) a speculative snapshot from a mid-turn pause is never delivered as the turn:')
{
  // Regression: the snapshot fires ~350 ms into a pause and decodes the turn
  // buffer AS IT WAS THEN. When the user resumed speaking and the turn ended
  // later, finishTurn reused the matching-token snapshot and — under the
  // "single-clip decode always wins" rule — delivered the PRE-PAUSE fragment
  // as the whole utterance («کاربرها بتونن از طریق API به» — everything after
  // the thinking pause vanished, the message went out mid-sentence). The
  // monitor now drops the snapshot on the first resumed frame; the turn end
  // must then decode the FULL buffer instead.
  const { priv, session, finals, calls } = makeSession('متن کامل بعد از مکث')
  priv['hasSpeech'] = true
  ;(session as unknown as { pushPcm: (f: Float32Array) => void }).pushPcm(speechPcm(16000))
  priv['pcmFrames'] = []
  priv['turn'] = { token: priv['turnToken'] as number, text: 'پیش‌نمایش' }
  // The stale snapshot: text decoded from the pre-pause audio only, but still
  // carrying the current turn's token — exactly what the old code reused.
  priv['specWholeP'] = Promise.resolve('متن بریده در مکث')
  priv['specToken'] = priv['turnToken'] as number
  // Speech resumed: the monitor calls this on the first voiced frame.
  ;(session as unknown as { invalidateStaleSnapshot: () => void }).invalidateStaleSnapshot()
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()

  check('the stale snapshot is dropped', priv['specWholeP'] === null)
  check('the full turn audio is decoded instead', calls.length === 1, { calls: calls.length })
  check(
    'the delivered text covers the words after the pause',
    finals[0] === 'متن کامل بعد از مکث',
    { finals },
  )
}

console.log('17d) a still-valid speculative snapshot is still reused:')
{
  // The invalidation must not cost the latency optimization: a snapshot with
  // no speech after it (the turn really ended inside that pause) is consumed
  // by finishTurn as-is — no second decode is paid.
  const { priv, session, finals, calls } = makeSession('هر چیزی')
  priv['hasSpeech'] = true
  ;(session as unknown as { pushPcm: (f: Float32Array) => void }).pushPcm(speechPcm(16000))
  priv['pcmFrames'] = []
  priv['turn'] = { token: priv['turnToken'] as number, text: 'پیش‌نمایش' }
  priv['specWholeP'] = Promise.resolve('متن اسنپ‌شات کامل')
  priv['specToken'] = priv['turnToken'] as number
  await (session as unknown as { finishTurn: () => Promise<void> }).finishTurn()

  check('the snapshot text is delivered', finals[0] === 'متن اسنپ‌شات کامل', { finals })
  check('no extra decode was paid', calls.length === 0, { calls: calls.length })
  check(
    'turn-end silence tolerates mid-sentence pauses',
    LOCAL_LIVE_DEFAULTS.silenceMs >= 1200,
    { silenceMs: LOCAL_LIVE_DEFAULTS.silenceMs },
  )
}

console.log('17e) a late preview reply cannot ghost a second message after delivery:')
{
  // Regression: a preview decode started before the turn ended could resolve
  // AFTER the delivery. Its onPartial made the chat mirror — whose preview
  // bubble the delivery had just released — create a FRESH user message out of
  // it: the user's last words appeared twice, the second never sent. A
  // finalized turn must drop every reply that lands after its delivery.
  let replies = 0
  let release!: (t: string) => void
  const gate = new Promise<string>((resolve) => {
    release = resolve
  })
  const { priv, session, partials, finals } = makeSession(() => {
    replies++
    // Call 1 = the preview below: held back until the turn has delivered.
    // Call 2 = the turn-end single-clip decode: at once.
    return replies === 1 ? gate : 'متن کامل نهایی'
  })
  feed(session, priv, speechPcm(32000))
  call(session, 'startPreview', Date.now())
  await tick()
  await call<Promise<void>>(session, 'finishTurn')

  check('the turn delivered exactly once', finals.length === 1 && finals[0] === 'متن کامل نهایی', {
    finals,
  })
  check('the turn is marked delivered', (priv['turn'] as { delivered?: boolean }).delivered === true)

  release('۰۰ تومن میخوام.')
  await tick(10)

  check(
    'the late preview reply never reaches the transcript',
    !(partials as string[]).includes('۰۰ تومن میخوام.'),
    { partials },
  )
  check('no second delivery after the late reply', finals.length === 1, { finals })
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
  // Regression: in dictate mode the silence timeout of live voice must NOT close
  // the turn — a natural pause while dictating would have finalized and sent
  // half a sentence. Previews keep refreshing through it, and only
  // finishDictation (mic button / Space) delivers.
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
  const priv = session as unknown as Priv
  priv['capturing'] = true
  priv['captureRate'] = 16000
  feed(session, priv, speechPcm(32000))
  // Speech that started long ago: past maxChunkMs the live engine would
  // force-close the turn; dictate must keep it open instead.
  const now = Date.now()
  priv['speechStartAt'] = now - LOCAL_LIVE_DEFAULTS.maxChunkMs - 5000
  priv['previewStartedAt'] = now - LOCAL_LIVE_DEFAULTS.chunkMs - 5
  priv['lastSpeechAt'] = now
  call(session, 'tickPreview', now, LOCAL_LIVE_DEFAULTS.chunkMs, LOCAL_LIVE_DEFAULTS.maxChunkMs)
  await previewInFlight(priv)
  check('a long turn never closes in dictate', finals.length === 0, { finals: finals.length })
  check('the preview keeps refreshing', calls.length === 1, { calls: calls.length })
  check('the preview reaches the composer', partials[partials.length - 1] === 'متن دیکته', { partials })

  await call<Promise<void>>(session, 'finishDictation')
  check('an explicit stop delivers the final text', finals.length === 1 && finals[0] === 'متن دیکته', { finals })
  check('the preview is cleared on stop', partials[partials.length - 1] === '', { partials })
  check('the engine is torn down after delivery', priv['stopped'] === true, {})

  await call<Promise<void>>(session, 'finishDictation')
  check('a repeated stop does not duplicate the text', finals.length === 1, { finals: finals.length })
}

console.log('21) dictate past 30 s keeps the earlier windows (the "only the first part" regression):')
{
  // The composer once showed only the first part of a long dictation. The turn
  // buffer is recycled every 30 s (a checkpoint decodes the full window); the
  // preview and the final must still carry those earlier windows.
  let call_ = 0
  // A 30 s window holds real speech: a two-word reply for it would be dropped
  // by the hum guard (isSparseTranscript), exactly as it should be.
  const FIRST = 'پنجره اول که یه متن طولانی دیکته شده و چند جمله پشت هم داره تا کلیپ سی ثانیه‌ای واقعی باشه و فقط چند کلمه نباشه'
  const replies = [FIRST, 'ادامه متن']
  const calls: { size: number }[] = []
  const partials: string[] = []
  const finals: string[] = []
  const session = new LocalLiveSession({
    lang: 'fa',
    dictate: true,
    transcribe: async (blob) => {
      calls.push({ size: blob.size })
      return replies[Math.min(call_++, replies.length - 1)]
    },
    onUserText: (t) => {
      finals.push(t)
    },
    onPartial: (t) => {
      partials.push(t)
    },
  })
  const priv = session as unknown as Priv
  priv['capturing'] = true
  priv['captureRate'] = 16000
  priv['hasSpeech'] = true
  priv['turn'] = { token: priv['turnToken'] as number, text: '', delivered: false }
  // 31 s in one frame crosses the 30 s window: a checkpoint decodes it.
  call(session, 'pushPcm', speechPcm(16000 * 31))
  await (priv['checkpointP'] as Promise<void>)
  check('the checkpoint kept the first window', priv['dictateWholePrefix'] === FIRST, {
    prefix: priv['dictateWholePrefix'],
  })
  check('the turn buffer restarted empty', priv['turnAudioLen'] === 0, { len: priv['turnAudioLen'] })

  call(session, 'pushPcm', speechPcm(32000))
  call(session, 'startPreview', Date.now())
  await previewInFlight(priv)
  const last = partials[partials.length - 1] ?? ''
  check('the preview holds the earlier window AND the new speech', last === `${FIRST} ادامه متن`, {
    last,
    partials,
  })

  await call<Promise<void>>(session, 'finishDictation')
  check('the delivered final keeps both parts', finals[finals.length - 1] === `${FIRST} ادامه متن`, { finals })
}

console.log('22) a mid-dictation edit appends only the newly spoken words:')
{
  // Regression: the first keystroke during dictation muted the engine for the
  // REST of the session — the user corrected a word, kept talking, the server
  // transcribed every new chunk, and the composer never showed any of it.
  // Partials are cumulative over the whole turn and the merge only appends,
  // so the new words are exactly the suffix beyond the last reflected text.
  check('nothing new when the text is unchanged', liveEditDelta('سلام خوبی', 'سلام خوبی') === '')
  check(
    'the suffix after the reflected text is the delta',
    liveEditDelta('سلام خوبی', 'سلام خوبی امروز هوا چطوره') === 'امروز هوا چطوره',
  )
  check('an empty base means everything is new', liveEditDelta('', 'سلام خوبی') === 'سلام خوبی')
  check('an empty partial adds nothing', liveEditDelta('سلام', '') === '')
  // A re-worded seam (the provider re-transcribed the overlap into different
  // words) is not an extension: appending it would duplicate words, so it
  // contributes nothing this round.
  check(
    'a re-worded seam adds nothing rather than duplicating',
    liveEditDelta('سلام خوبی', 'سلام چطوری امروز') === '',
  )
  // A word-boundary extension that merely CONTINUES the last word («خوبی» ->
  // «خوبی‌تر») is still a string prefix: the delta glues onto the composer's
  // current text and reads correctly.
  check(
    'a same-word continuation is a plain suffix',
    liveEditDelta('سلام خوبی', 'سلام خوبی‌تر امروز') === '‌تر امروز',
  )
  check(
    'persian half-spaces survive inside the delta',
    liveEditDelta('میخوام', 'میخوام نیم‌فاصله') === 'نیم‌فاصله',
  )
}

console.log('23) one loud transient must not deafen the VAD for the session:')
{
  // Regression: peakRms was a hold-forever maximum feeding the gate's safety
  // cap (0.3× peak). A single click or desk bump pinned it far above speech
  // and the gate never opened again — no chunks, no requests, no error.
  let peak = 0
  peak = decayPeakRms(peak, 0.5) // the bang
  check('a transient sets the peak', peak === 0.5)
  // Silence frames: the peak must decay fast enough that normal speech
  // (≈0.03-0.1 RMS) crosses the 0.3× cap again within a few seconds —
  // 0.95 per 100 ms frame ≈ 1.4 s half-life, so ≈3.2 s after the bang.
  let frames = 0
  while (peak * 0.3 > 0.03 && frames < 100) {
    peak = decayPeakRms(peak, 0.001)
    frames++
  }
  check('silence decays the peak below the speech cap quickly', frames <= 35, {
    frames,
    peak,
  })
  // Real speech keeps re-raising the reference: the cap must never fall below
  // the level the user actually talks at.
  peak = 0.5
  for (let i = 0; i < 50; i++) peak = decayPeakRms(peak, 0.08)
  check('ongoing speech holds the peak at the speech level', Math.abs(peak - 0.08) < 0.005, {
    peak,
  })
  check('the decay is per-frame bounded', PEAK_RMS_DECAY > 0.9 && PEAK_RMS_DECAY < 1)
}

console.log('24) quieter voices do not hold an open turn open:')
{
  // Server-log regression: a turn that began with the user's «سلام چطوری؟»
  // stayed open for 30 s while people around the room kept talking, and every
  // word of it was transcribed. Background voices are several times quieter at
  // the mic than the user, so inside a turn the keep-alive bar follows the
  // user's own level.
  const userLevel = 0.06
  const roomVoice = 0.012
  check('a room voice is below the turn-relative bar', roomVoice < userLevel * TURN_LEVEL_HANGOVER_RATIO, {
    bar: userLevel * TURN_LEVEL_HANGOVER_RATIO,
  })
  check('the user soft syllable is still above it', 0.03 >= userLevel * TURN_LEVEL_HANGOVER_RATIO)
  // The reference decays, so a user who got quieter is not locked out forever.
  check('the reference decays', TURN_LEVEL_DECAY < 1 && userLevel * TURN_LEVEL_DECAY ** 30 < userLevel * 0.5)
}

console.log('25) the lead-in keeps a soft first word but not earlier room talk:')
{
  const rate = 16000
  const mk = (parts: Array<[number, number]>) => {
    const out: number[] = []
    for (const [ms, amp] of parts) for (let i = 0; i < (rate * ms) / 1000; i++) out.push(amp * (i % 2 ? 1 : -1))
    return new Float32Array(out)
  }
  // 400 ms room talk | 500 ms pause | 400 ms soft first word | 500 ms loud onset.
  const clip = mk([[400, 0.012], [500, 0.001], [400, 0.02], [500, 0.08]])
  const from = selectPreRollStart(clip, rate)
  check('the soft first word is kept', from <= rate * 0.9, { fromMs: (from / rate) * 1000 })
  check('room talk before the pause is dropped', from >= rate * 0.4, { fromMs: (from / rate) * 1000 })
  // No pause before the first word: everything up to the pre-roll limit stays.
  const all = mk([[900, 0.03], [500, 0.08]])
  check('a continuous lead-in is kept whole', selectPreRollStart(all, rate) === 0)
  check('a short buffer is untouched', selectPreRollStart(mk([[500, 0.05]]), rate) === 0)
}

console.log('26) a long hum that whisper turned into one word is dropped:')
{
  // Server-log regression: ~16 s of «ممممم» came back as «میدونم.» and was sent.
  check('one word for 16 s of sound is not speech', isSparseTranscript('میدونم.', 16000))
  check('two words for 10 s of sound is not speech', isSparseTranscript('بله میدونم', 10000))
  check('a short answer is never judged', !isSparseTranscript('میدونم.', 1500))
  check('a one-word answer in a short clip survives', !isSparseTranscript('نه', 2000))
  check('normal speech passes', !isSparseTranscript('بعدش کارات که تموم شد سایت دیجیکالا رو برام باز کنم', 5000))
  check('slow but real speech passes', !isSparseTranscript('من میخوام یه چیزی بگم', 8000))
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall live voice checks passed')


