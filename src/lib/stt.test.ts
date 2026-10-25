// Tests for the speech-to-text helpers in src/lib/stt.ts.
// Covers language/prompt resolution, the PCM/WAV encoder that makes chunked
// live transcription possible, and the transcript merge used to stitch chunks.
// Run: npx esbuild src/lib/stt.test.ts --bundle --platform=node --format=esm
//        --packages=external --external:electron --outfile=tests/.tmp-stt.mjs
//      && node tests/.tmp-stt.mjs

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
  STT_SAMPLE_RATE,
  STT_LANGUAGES,
  resolveSttLanguage,
  buildSttPrompt,
  concatFloat32,
  downsampleFloat32,
  encodeWavPcm16,
  mergeTranscripts,
  decimationKernel,
  trimSilence,
  normalizePeak,
  normalizeTranscript,
  sttDecodeFields,
  NORMALIZE_TARGET_PEAK,
  SILENCE_RMS,
} = await import('./stt')

console.log('1) language resolution:')
{
  check('explicit setting always wins', resolveSttLanguage('en', 'rtl', 'سلام') === 'en')
  check('setting is trimmed and lower-cased', resolveSttLanguage(' FA ', 'ltr', '') === 'fa')
  check('rtl UI implies Persian', resolveSttLanguage('', 'rtl', '') === 'fa')
  check('typed Persian script implies Persian', resolveSttLanguage('', 'ltr', 'سلام') === 'fa')
  check('ltr UI without Persian text sends no hint', resolveSttLanguage('', 'ltr', 'hello') === '')
  check('nothing known sends no hint', resolveSttLanguage(undefined, undefined, undefined) === '')
  check('auto option exists in the settings list', STT_LANGUAGES.some((l) => l.code === ''))
  check('Persian is offered in the settings list', STT_LANGUAGES.some((l) => l.code === 'fa'))
}

console.log('2) the prompt never fabricates speech for the model to continue:')
{
  // Regression: a built-in sentence per language ("سلام، این یک پیام صوتی
  // فارسی است. متن را … بنویس.") was sent as the prompt. Whisper treats the
  // prompt as preceding text and CONTINUES it, so «سلام چطوری» came back as the
  // instruction sentence itself. An absent prompt is always safer.
  check('no prompt is sent when nothing is configured', buildSttPrompt('fa') === '')
  check('unknown language also sends nothing', buildSttPrompt('xx') === '')
  check(
    'the old instruction sentence is gone for every language',
    ['fa', 'en', 'ar', 'de', 'fr', 'ru'].every((l) => buildSttPrompt(l) === ''),
  )

  const own = buildSttPrompt('fa', 'واژه‌های من')
  check('user glossary is sent verbatim', own === 'واژه‌های من', { own })
  check('no fabricated sentence is mixed in', !own.includes('پیام صوتی فارسی'), { own })

  const withTail = buildSttPrompt('fa', 'واژه‌های من', 'متن قبلی')
  check('an explicit real context tail still appends', withTail === 'واژه‌های من متن قبلی', { withTail })

  const tailOnly = buildSttPrompt('fa', '', 'متن قبلی')
  check('a tail alone is sent when there is no glossary', tailOnly === 'متن قبلی', { tailOnly })

  const longCustom = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ')
  const capped = buildSttPrompt('fa', longCustom)
  check('long prompts are capped for the provider token limit', capped.length <= 400, { len: capped.length })
  check('capped prompt keeps the newest words', capped.endsWith('w199'), { tail: capped.slice(-20) })
}

console.log('3) PCM helpers:')
{
  const a = new Float32Array([1, 2])
  const b = new Float32Array([3])
  const joined = concatFloat32([a, b])
  check('concat keeps order and length', joined.length === 3 && joined[0] === 1 && joined[2] === 3, { joined: Array.from(joined) })
  check('concat of nothing is empty', concatFloat32([]).length === 0)

  const speech48k = new Float32Array(4800).fill(0.5)
  const speech16k = downsampleFloat32(speech48k, 48000, 16000)
  check('48k downsamples to a third', speech16k.length === 1600, { len: speech16k.length })
  check('downsampled amplitude is preserved', Math.abs(speech16k[0] - 0.5) < 1e-6, { v: speech16k[0] })

  const same = downsampleFloat32(speech16k, 16000, STT_SAMPLE_RATE)
  check('same rate is a no-op', same.length === speech16k.length && same === speech16k)

  const low = new Float32Array(800).fill(0.25)
  check('never upsamples', downsampleFloat32(low, 8000, STT_SAMPLE_RATE).length === 800)

  const empty = downsampleFloat32(new Float32Array(0), 48000, 16000)
  check('empty input stays empty', empty.length === 0)
}

console.log('4) WAV encoder produces a complete, decodable file:')
{
  const samples = new Float32Array([0, 1, -1, 0.5])
  const blob = encodeWavPcm16(samples, 16000)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, len: number) => String.fromCharCode(...bytes.slice(at, at + len))
  const dataBytes = samples.length * 2

  check('declares audio/wav', blob.type === 'audio/wav', { type: blob.type })
  check('RIFF/WAVE container', ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE', { head: ascii(0, 12) })
  check('fmt and data chunks', ascii(12, 4) === 'fmt ' && ascii(36, 4) === 'data')
  check('total size is header plus samples', bytes.length === 44 + dataBytes, { len: bytes.length })
  check('RIFF size field', view.getUint32(4, true) === 36 + dataBytes)
  check('PCM, mono, 16-bit', view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 && view.getUint16(34, true) === 16)
  check('sample rate and byte rate', view.getUint32(24, true) === 16000 && view.getUint32(28, true) === 32000)
  check('block align', view.getUint16(32, true) === 2)
  check('data size field', view.getUint32(40, true) === dataBytes)
  check('zero sample stays zero', view.getInt16(44, true) === 0)
  check('full scale clamps to int16 range', view.getInt16(46, true) === 32767 && view.getInt16(48, true) === -32768, {
    pos: view.getInt16(46, true),
    neg: view.getInt16(48, true),
  })
  const half = view.getInt16(50, true)
  check('half amplitude is scaled', half > 16000 && half < 16600, { half })
}

console.log('5) peak normalization makes a quiet clip loud enough to transcribe:')
{
  const quiet = new Float32Array(1600)
  for (let i = 0; i < quiet.length; i++) quiet[i] = 0.15 * Math.sin(i / 8) + 0.05
  const loud = normalizePeak(quiet)
  let peak = 0
  for (let i = 0; i < loud.length; i++) peak = Math.max(peak, Math.abs(loud[i]))
  check('a quiet clip is scaled up to the target peak', Math.abs(peak - NORMALIZE_TARGET_PEAK) < 0.02, { peak })
  check('the DC offset is removed', Math.abs(loud.reduce((a, b) => a + b, 0) / loud.length) < 0.01)
  check('length is preserved', loud.length === quiet.length)

  const hot = new Float32Array(1600)
  for (let i = 0; i < hot.length; i++) hot[i] = i % 2 === 0 ? 0.99 : -0.99
  const quieter = normalizePeak(hot)
  const hotPeak = Math.max(...Array.from(quieter, Math.abs))
  check('an already loud clip is attenuated to the target', Math.abs(hotPeak - NORMALIZE_TARGET_PEAK) < 0.02, {
    hotPeak,
  })

  const dither = new Float32Array(1600).fill(0.001)
  const notBlownUp = normalizePeak(dither)
  check(
    'near-silence is not amplified into speech',
    Math.max(...Array.from(notBlownUp, Math.abs)) < SILENCE_RMS,
    { max: Math.max(...Array.from(notBlownUp, Math.abs)) },
  )
  check('an empty block stays empty', normalizePeak(new Float32Array(0)).length === 0)
}

console.log('6) transcript merge stitches overlapping chunks:')
{
  check('empty committed takes the chunk', mergeTranscripts('', 'hello') === 'hello')
  check('empty chunk keeps committed text', mergeTranscripts('hello', '') === 'hello')
  check('overlap is not duplicated', mergeTranscripts('سلام دنیا', 'دنیا خوبی') === 'سلام دنیا خوبی')
  check(
    'punctuation and case are ignored when matching',
    mergeTranscripts('این یک تست', 'تست، دوم') === 'این یک تست دوم',
  )
  check('no overlap appends', mergeTranscripts('a', 'b') === 'a b')
  check(
    'a chunk already covered adds nothing',
    mergeTranscripts('hello brave world', 'Hello, Brave World!') === 'hello brave world',
  )
  check(
    'a chunk inside the committed text adds nothing',
    mergeTranscripts('one two three four', 'two three') === 'one two three four',
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('6) the resampler low-passes before it decimates:')
{
  const inRate = 48000
  const outRate = STT_SAMPLE_RATE
  const tone = (freq: number, n = 48000) => {
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) a[i] = Math.sin((2 * Math.PI * freq * i) / inRate)
    return a
  }
  const rms = (a: Float32Array) => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i] * a[i]
    return Math.sqrt(s / Math.max(1, a.length))
  }
  // 12 kHz at 48 kHz input folds to 4 kHz once decimated to 16 kHz. Naive (or
  // box-filtered) decimation leaves that tone almost intact, and it lands right
  // on top of Persian sibilants (/s/, /ʃ/) — the model then hears a different
  // word. A real anti-alias filter must remove it BEFORE dropping samples.
  const aliased = downsampleFloat32(tone(12000), inRate, outRate)
  check('a tone above the output Nyquist is removed, not folded back', rms(aliased) < 0.1, {
    rms: rms(aliased),
  })
  const passband = downsampleFloat32(tone(1000), inRate, outRate)
  check('a speech-band tone survives untouched', rms(passband) > 0.6, { rms: rms(passband) })
  const kernel = decimationKernel(inRate / outRate)
  let sum = 0
  for (let i = 0; i < kernel.length; i++) sum += kernel[i]
  check('the filter has unity DC gain', Math.abs(sum - 1) < 1e-3, { sum })
  check(
    'a matching rate is passed through byte for byte',
    downsampleFloat32(tone(1000), outRate, outRate).length === 48000,
  )
}

console.log('7) dead air is trimmed so the model cannot hallucinate into it:')
{
  const mk = (loudMs: number, leadMs: number, tailMs: number) => {
    const n = (ms: number) => Math.floor((STT_SAMPLE_RATE * ms) / 1000)
    const a = new Float32Array(n(leadMs) + n(loudMs) + n(tailMs))
    for (let i = n(leadMs); i < n(leadMs) + n(loudMs); i++) a[i] = 0.3
    return a
  }
  const source = mk(500, 400, 400)
  const trimmed = trimSilence(source)
  check('speech duration is measured, not the clip length', trimmed.speechMs >= 400 && trimmed.speechMs <= 600, {
    speechMs: trimmed.speechMs,
  })
  check('the trimmed clip is shorter than the input', trimmed.pcm.length < source.length, {
    len: trimmed.pcm.length,
    source: source.length,
  })
  check(
    'padding is kept so a plosive is never clipped',
    trimmed.pcm.length > Math.floor((STT_SAMPLE_RATE * 500) / 1000),
    { len: trimmed.pcm.length },
  )
  const silent = trimSilence(new Float32Array(16000))
  check('a fully silent clip trims to nothing', silent.pcm.length === 0 && silent.speechMs === 0)
  check('the silence gate sits below quiet speech', SILENCE_RMS < 0.01)
}

console.log('8) the merge sees one Persian word through its spellings:')
{
  // Providers alternate between Arabic and Persian yeh, and between Arabic and
  // Persian kaf, and drop or keep the half-space. Without folding the overlap
  // is invisible, so both spellings survive and the word appears twice.
  check('Arabic yeh and Persian yeh are the same word', mergeTranscripts('ميروم', 'میروم خانه') === 'ميروم خانه', {
    got: mergeTranscripts('ميروم', 'میروم خانه'),
  })
  check('a half-space inside the overlap still matches', mergeTranscripts('میروم', 'میروم خانه') === 'میروم خانه', {
    got: mergeTranscripts('میروم', 'میروم خانه'),
  })
  check('Arabic kaf and Persian kaf are the same word', mergeTranscripts('این كتاب', 'کتاب خوب') === 'این كتاب خوب', {
    got: mergeTranscripts('این كتاب', 'کتاب خوب'),
  })
  check('harakat do not break the match', mergeTranscripts('این كَتاب', 'کتاب خوب') === 'این كَتاب خوب', {
    got: mergeTranscripts('این كَتاب', 'کتاب خوب'),
  })
}

console.log('9) a raw transcript is delivered in Persian spelling:')
{
  // Whisper returns Arabic look-alike letters for Persian yeh/kaf/heh. The word
  // is right, the spelling is not — and it never matches what the user types.
  check('Arabic yeh becomes Persian yeh', normalizeTranscript('ميروم') === 'میروم', {
    got: normalizeTranscript('ميروم'),
  })
  check('alef maqsura becomes Persian yeh', normalizeTranscript('على') === 'علی', {
    got: normalizeTranscript('على'),
  })
  check('Arabic kaf becomes Persian kaf', normalizeTranscript('كتاب') === 'کتاب', {
    got: normalizeTranscript('كتاب'),
  })
  check('ta-marbuta becomes heh', normalizeTranscript('مدرسة') === 'مدرسه', {
    got: normalizeTranscript('مدرسه'),
  })
  check(
    'a whole sentence is folded',
    normalizeTranscript('ميروم كتاب را بگيرم') === 'میروم کتاب را بگیرم',
    { got: normalizeTranscript('ميروم كتاب را بگيرم') },
  )
  // Reading-changing characters must survive: folding them would invent a word.
  check('hamza on alef is never folded away', normalizeTranscript('أمدم') === 'أمدم', {
    got: normalizeTranscript('أمدم'),
  })
  check('hamza on yeh is never folded away', normalizeTranscript('مسئله') === 'مسئله', {
    got: normalizeTranscript('مسئله'),
  })
  // A half-space is a real word boundary in Persian: dropping it glues words.
  check('ZWNJ is preserved', normalizeTranscript('نیم\u200cفاصله') === 'نیم\u200cفاصله', {
    got: normalizeTranscript('نیم\u200cفاصله'),
  })
  check('harakat are dropped', normalizeTranscript('كَتَبَ') === 'کتب', { got: normalizeTranscript('كَتَبَ') })
  check('tatweel is dropped', normalizeTranscript('كتـــاب') === 'کتاب', {
    got: normalizeTranscript('كتـــاب'),
  })
  // The invisible separators a model emits between words are word separators,
  // not something to delete — deleting them glues mixed-script text.
  check(
    'an invisible separator becomes a space, not a deletion',
    normalizeTranscript('سلام\u200bworld') === 'سلام world',
    { got: normalizeTranscript('سلام\u200bworld') },
  )
  check('bidi controls are stripped', normalizeTranscript('س\u2066لام') === 'سلام', {
    got: normalizeTranscript('س\u2066لام'),
  })
  check('whitespace is collapsed', normalizeTranscript('  سلام   خوبی  ') === 'سلام خوبی', {
    got: normalizeTranscript('  سلام   خوبی  '),
  })
  check('empty input stays empty', normalizeTranscript('') === '')
  check('Latin text is untouched', normalizeTranscript('hello world') === 'hello world')
  // The merge must see both spellings as one word, so folding happens BEFORE it.
  const folded = normalizeTranscript('ميروم')
  check('the folded text still merges on overlap', mergeTranscripts(folded, 'میروم خانه') === 'میروم خانه', {
    got: mergeTranscripts(folded, 'میروم خانه'),
  })
}

console.log('10) decoding is pinned so the same clip cannot flip a word:')
{
  check(
    'a whisper model gets greedy decoding',
    sttDecodeFields('whisper-1').temperature === '0',
    { got: sttDecodeFields('whisper-1') },
  )
  check(
    'a faster-whisper / large-v3 style name is still whisper',
    sttDecodeFields('Systran/faster-whisper-large-v3').temperature === '0',
  )
  check(
    'a missing model defaults to whisper on the server, so it is pinned too',
    sttDecodeFields(undefined).temperature === '0',
  )
  check(
    'a non-whisper model opts out instead of risking a 400',
    Object.keys(sttDecodeFields('gpt-4o-transcribe')).length === 0,
    { got: sttDecodeFields('gpt-4o-transcribe') },
  )
}

console.log('\nall stt checks passed')
