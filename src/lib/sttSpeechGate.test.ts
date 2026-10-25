// Test: music / steady noise must never be turned into text (STT input gate).
// Covers envelopeCv / isLikelySpeechEnvelope (src/lib/stt.ts) and
// isHallucinatedTranscript subtitle boilerplate (src/lib/localLive.ts).
// Run: npx esbuild src/lib/sttSpeechGate.test.ts --bundle --platform=node --format=esm --outfile=/tmp/x.mjs && node /tmp/x.mjs
import {
  envelopeCv,
  isLikelySpeechEnvelope,
  SPEECH_ENVELOPE_MIN_CV,
} from './stt'
import { isHallucinatedTranscript } from './localLive'

let failures = 0
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, extra === undefined ? '' : extra)
  if (!ok) failures++
}

const SR = 16000

function clip(gen: (t: number) => number, ms: number): Float32Array {
  const n = Math.floor((SR * ms) / 1000)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = gen(i / SR)
  return out
}

// A syllabic signal (energy rises and falls a few times a second, gaps between
// syllables) — the shape of speech.
const speech = clip((t) => {
  const syll = Math.max(0, Math.sin(2 * Math.PI * 4 * t))
  const gap = Math.sin(2 * Math.PI * 1.3 * t) > -0.6 ? 1 : 0.05
  return 0.08 * syll * gap * Math.sin(2 * Math.PI * 200 * t)
}, 1500)

// A held tone with a slow beat: what music looks like to a level meter.
const musicTone = clip(
  (t) => 0.1 * (0.7 + 0.3 * Math.sin(2 * Math.PI * 2 * t)) * Math.sin(2 * Math.PI * 220 * t),
  1500,
)
const musicChord = clip(
  (t) =>
    0.1 *
    0.5 *
    (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 330 * t)) *
    (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.5 * t)),
  1500,
)
// Fan / air-conditioner hum: steady, loud enough to pass a level gate.
const fanNoise = clip((t) => 0.03 * Math.sin(2 * Math.PI * 150 * t), 1500)
const quietRoom = clip((t) => 0.002 * Math.sin(t * 17000), 1500)

console.log('۱) speech vs music/noise separated by envelope shape:')
check('speech passes the gate', isLikelySpeechEnvelope(speech, SR), envelopeCv(speech, SR).toFixed(3))
check('held musical tone is rejected', !isLikelySpeechEnvelope(musicTone, SR), envelopeCv(musicTone, SR).toFixed(3))
check('sustained chord is rejected', !isLikelySpeechEnvelope(musicChord, SR), envelopeCv(musicChord, SR).toFixed(3))
check('fan hum is rejected', !isLikelySpeechEnvelope(fanNoise, SR), envelopeCv(fanNoise, SR).toFixed(3))
check('quiet room noise is rejected', !isLikelySpeechEnvelope(quietRoom, SR), envelopeCv(quietRoom, SR).toFixed(3))

console.log('۲) the gate stays well clear on both sides of the cut:')
// A margin either side matters: a threshold that sat ON a real recording's CV
// would flip its verdict as the user moves. Speech ≥ 2x the cut, noise ≤ 1/3.
const speechCv = envelopeCv(speech, SR)
const worstNoiseCv = Math.max(
  envelopeCv(musicTone, SR),
  envelopeCv(musicChord, SR),
  envelopeCv(fanNoise, SR),
  envelopeCv(quietRoom, SR),
)
check('speech CV has headroom above the cut', speechCv > SPEECH_ENVELOPE_MIN_CV * 1.5, speechCv.toFixed(3))
check('noise CV sits well below the cut', worstNoiseCv < SPEECH_ENVELOPE_MIN_CV / 2, worstNoiseCv.toFixed(3))

console.log('۳) the gate is level-independent (a soft word is not music):')
// The whole point of gating on shape: scaling speech down must not flip it.
const softSpeech = speech.map((v) => v * 0.1)
check('quiet speech still passes', isLikelySpeechEnvelope(softSpeech, SR), envelopeCv(softSpeech, SR).toFixed(3))
const loudMusic = musicTone.map((v) => v * 3)
check('loud music is still rejected', !isLikelySpeechEnvelope(loudMusic, SR), envelopeCv(loudMusic, SR).toFixed(3))

console.log('۴) empty and silent clips are never speech:')
check('empty clip', !isLikelySpeechEnvelope(new Float32Array(0), SR))
check('silent clip', !isLikelySpeechEnvelope(new Float32Array(SR), SR))
check('too short for two frames', !isLikelySpeechEnvelope(new Float32Array(100), SR))

console.log('۵) subtitle boilerplate from silence is dropped:')
check(
  'thank you for watching',
  isHallucinatedTranscript('Thank you for watching.'),
)
check('please subscribe', isHallucinatedTranscript('please subscribe to my channel'))
check('subtitles by', isHallucinatedTranscript('Subtitles by Amara.org'))
check('persian thanks-for-watching', isHallucinatedTranscript('شكرا على المشاهدة'))
check(
  'a real Persian sentence is kept',
  !isHallucinatedTranscript('سلام خوبی چه خبر'),
)
check('a real English sentence is kept', !isHallucinatedTranscript('open the settings panel'))
check(
  'word "subscribe" inside a real command is still a lie to drop? no — only boilerplate',
  !isHallucinatedTranscript('برو تو تنظیمات'),
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
if (failures > 0) process.exit(1)
