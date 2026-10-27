// Live voice loop: continuous mic capture as raw PCM, cut into overlapping
// chunks that are transcribed WHILE the user is still speaking.
//
// Why PCM and not MediaRecorder: a webm/opus container can only be decoded as
// a whole file — slicing it yields "could not process file" from strict
// providers. Raw samples can be cut at any boundary and wrapped in a complete
// 16 kHz WAV, which is what makes chunk-by-chunk transcription possible.
//
// Why chunk at all: Whisper's accuracy collapses on long utterances (it starts
// summarizing, drops words and repeats), and latency grows with clip length.
// Short overlapping chunks transcribed immediately give correct short-clip
// results AND a partial transcript on screen while the user is still talking.
//
// Flow per turn: VAD onset -> every `chunkMs` cut the audio since the last cut
// (+ a small overlap so no word is split) -> transcribe -> merge into the turn
// text -> onPartial. Silence ends the turn -> wait for the queue to drain ->
// onUserText. Barge-in: onSpeechStart fires on voice onset so the caller can
// stop TTS playback immediately.

import { claimLiveVoice, releaseLiveVoice } from './liveVoiceState';
import {
  STT_SAMPLE_RATE,
  buildSttPrompt,
  concatFloat32,
  downsampleFloat32,
  encodeWavPcm16,
  isLikelySpeechEnvelope,
  mergeTranscripts,
  normalizePeak,
  normalizeTranscript,
  stripSttPromptEcho,
  trimSilence,
  SILENCE_RMS,
} from './stt';

export type LocalLiveState = 'idle' | 'connecting' | 'live' | 'speaking' | 'closed' | 'error';

export interface LocalLiveOptions {
  deviceId?: string;
  /**
   * Chat this session runs for.
   *
   * Doubles as the microphone lease: every open chat mounts its own panel and
   * its own session object, so without it a second chat could open the same
   * device and turn one spoken sentence into a message in two chats.
   */
  chatId?: string | null;
  /** Language hint sent to the provider ('fa', 'en', …). */
  lang?: string;
  /** Extra vocabulary / prompt for the provider (user setting). */
  prompt?: string;
  /** Transcribe one complete WAV chunk. */
  transcribe: (blob: Blob, lang?: string, prompt?: string) => Promise<string>;
  /** A finished turn: the full merged transcript. */
  onUserText: (text: string) => void | Promise<void>;
  /** Progressive transcript for the turn in progress ('' clears it). */
  onPartial?: (text: string) => void;
  /**
   * Dictate mode: speech NEVER ends a turn — the mic tail runs while the
   * user talks, partials keep streaming into the composer, and only an
   * explicit stop ends the turn and delivers the final transcript.
   * Without this, the 800 ms pause that only should trigger auto-sending in
   * live would finalize the text mid-sentence and auto-send it.
   */
  dictate?: boolean;
  onSpeechStart?: () => void;
  onStateChange?: (s: LocalLiveState) => void;
  onError?: (err: unknown) => void;
  silenceMs?: number;
  minSpeechMs?: number;
  maxChunkMs?: number;
  levelThreshold?: number;
  /** How often a chunk is cut and sent while speaking. */
  chunkMs?: number;
}

// Turn-end tuning: the silence timeout must feel instant (user stops ->
// agent hears it ~1s later), while min-speech stays long enough to drop
// sub-word noise blips but short enough that quick Persian replies
// ("yes", "go on") are never swallowed. The level gate sits above
// typical ambient noise (fans, distant talk) so only close-mic voice
// starts a turn.
/** Word count of a transcript — the "which decode saw more speech" metric. */
function wordCount(s: string): number {
  return s ? s.split(/\s+/).filter(Boolean).length : 0;
}

export const LOCAL_LIVE_DEFAULTS = {
  // Turn end must feel immediate: 650 ms of silence is long enough that a
  // natural mid-sentence pause does not split a turn, short enough that the
  // handoff to STT does not feel like waiting.
  // A natural mid-sentence pause is 300-700 ms. Ending the turn there splits
  // one thought into two cold-start segments, and each segment has less
  // context to disambiguate similar Persian words. 800 ms costs nothing
  // perceptible on turn end and keeps whole sentences in one segment.
  silenceMs: 800,
  minSpeechMs: 400,
  maxChunkMs: 20000,
  // Linear RMS of the raw mic frame (no AGC, no dB conversion). Comfortable
  // speech on a laptop mic is ~0.05-0.15, but the built-in mics of MacBooks
  // record noticeably quieter and controllers with AGC can pull speech down to
  // ~0.01. The old 0.02 gate sat right at that edge: on a quiet mic the VAD
  // never opened, no chunk was ever cut, and live voice stayed completely
  // silent with no error (an empty transcript is not an exception). The gate
  // is deliberately low now — the 3-frame onset streak below is what keeps
  // clicks and background noise from starting turns.
  levelThreshold: 0.008,
  frameMs: 100,
  // Chunk cadence. Short clips are exactly where non-streaming ASR fails: at
  // 700 ms a Persian chunk is two or three words, and the model has to guess
  // word endings and the identity of any word whose beginning was cut off — so
  // live voice "transcribed wrong" while dictation (one long clip) was fine.
  // The per-request cost is NOT proportional to the clip: Whisper always runs
  // its 30 s mel window, so the local server (medium, CPU) pays a fixed
  // ~2.2 s encoder cost per request. At 1.4 s the CPU model spent more compute
  // than the speech produced (rtf ≈ 1.9, benchmarked) and the chunk queue fell
  // seconds behind instead of streaming; 2.8 s halves the per-second overhead
  // so partials keep up with speech. Remote providers run at rtf ≪ 1 anyway.
  chunkMs: 2800,
  /**
   * Audio kept before the detected onset so the first word is intact.
   *
   * This MUST exceed the onset window (LIVE_SPEECH_ONSET_FRAMES * frameMs =
   * 300 ms) that the VAD needs before it opens a turn: the detector only fires
   * after the voice has already been running for that long, so a 300 ms
   * pre-roll re-buffered exactly the frames the streak had just consumed —
   * nothing of the word that started the turn survived, and the opening word
   * ("سلام" — a low-energy /s/) was dropped in live voice while dictation of
   * the same sentence kept it. 3x the onset window covers a soft onset too.
   */
  preRollMs: 900,
  /** Audio re-sent at the head of the next chunk (merged away afterwards). */
  overlapMs: 220,
  /** Chunk requests allowed in flight at once. Pipelining without the
   *  unbounded growth of the old fully-serialized chain. Two, not three: the
   *  local CPU decode takes ~4 threads per call, so a third concurrent call
   *  oversubscribes the 8 cores and every request — including the remote
   *  ones sharing the client slots — lands slower. */
  maxInflight: 2,
  /** How long finishTurn waits for the queue before delivering what it has.
   *  A slow provider must delay a turn, never hang live voice forever. */
  // Cold-capable local STT (kind 'custom'): the bundled server unloads its
  // model after five idle minutes and needs ~14 s to wake. The budgets must
  // outlive ONE cold round-trip — with 4s/6s every chunk of the first
  // utterance was discarded ("dictation typed nothing" / "live kept only the
  // last sentence": turns 1..N-1 were cut cold, the last one found the server
  // warm).
  drainTimeoutMs: 16000,
  /** Total cap on the waits inside finishTurn, measured from its start. The
   *  single-clip decode runs in parallel with the chunk drain, so it gets the
   *  REMAINDER of this cap instead of a second full timeout — otherwise a
   *  provider stuck on both stages held the turn (and the mic handoff) for
   *  drain + decode, twice as long as either stage needs. */
  turnDeliverBudgetMs: 20000,
  /** Longest utterance that is re-decoded as ONE clip at turn end. Whisper's
   *  window is 30 s; past that it summarizes, so a longer turn keeps the chunk
   *  transcript instead. */
  wholeTurnMaxMs: 30000,
} as const;

/** Root-mean-square level of a mono float frame (0..1 approx). */
export function computeRms(frame: ArrayLike<number>): number {
  if (!frame || frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i];
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/** True when the frame level counts as speech. */
export function isSpeechLevel(rms: number, threshold: number = LOCAL_LIVE_DEFAULTS.levelThreshold): boolean {
  return rms >= threshold;
}

/**
 * Lowest noise floor we ever assume: below this, a mic is simply not picking
 * up anything and the gate must stay at its absolute minimum.
 */
export const NOISE_FLOOR_MIN = 0.0008;

/**
 * How far above the measured ambient floor a frame must sit to be voice.
 * Room noise is steady, speech is not: 2.5x the floor separates them without
 * needing a per-device calibration step.
 */
export const NOISE_FLOOR_MULT = 2.5;

/**
 * Hard ceiling on the tracked floor, as a fraction of the loudest frame the
 * mic has produced this session.
 *
 * The floor is only ever an ESTIMATE of the room, and it can be poisoned: if
 * the user starts talking the moment live voice connects, the calibration
 * frames are their own voice, the "ambient floor" becomes speech level, and
 * `floor * 2.5` then sits ABOVE every frame they will ever produce. Frames
 * arrive, the gate never opens, no chunk is cut, nothing is typed and — because
 * empty audio is not an exception — no error is raised. Capping the estimate
 * well below the loudest observed level guarantees the gate can always be
 * reached by real sound, whatever the floor drifted to.
 */
export const NOISE_FLOOR_PEAK_CAP = 0.3;

/**
 * Track the ambient noise floor from recent frames.
 *
 * A single fixed threshold cannot work for every microphone: a MacBook's
 * built-in array records far quieter than a USB interface, and controllers
 * with AGC change the level mid-session. Tracking the floor means the gate
 * follows the ROOM instead of guessing a number, so quiet speech is still
 * caught while steady ambient noise never opens a turn.
 *
 * The floor drops fast (so a finished utterance never drags the estimate up
 * and closes the gate) and creeps up slowly (so one loud frame cannot spike
 * it). While `calibrating` it converges quickly to the actual room level.
 */
export function updateNoiseFloor(prev: number, rms: number, calibrating = false): number {
  if (calibrating) {
    // Calibration must find the ROOM, and the QUIETEST frame of the window is
    // the best available estimate of it. Tracking a mean/EMA here instead let
    // a user who starts talking immediately teach the gate that their own
    // voice was the ambient level — after which nothing could ever be louder.
    const seeded = prev > 0 ? prev : rms;
    return Math.max(Math.min(seeded, rms), NOISE_FLOOR_MIN);
  }
  const floor = prev > 0 ? prev : NOISE_FLOOR_MIN;
  const rate = rms < floor ? 0.25 : 0.02;
  return Math.max(floor + (rms - floor) * rate, NOISE_FLOOR_MIN);
}

/** Frames used to sample the room level right after capture starts. */
export const NOISE_FLOOR_CALIBRATION_FRAMES = 5;

/** Effective speech gate for the given ambient floor. */
export function speechThreshold(
  noiseFloor: number,
  floor: number = LOCAL_LIVE_DEFAULTS.levelThreshold,
  peakRms = 0,
): number {
  const gate = Math.max(floor, noiseFloor * NOISE_FLOOR_MULT);
  // Safety valve: whatever the estimate drifted to, the gate must stay below
  // the loudest level the mic has actually produced, or the user is talking
  // into a permanently closed gate (frames arrive, nothing is ever typed).
  if (peakRms <= 0) return gate;
  return Math.min(gate, Math.max(floor, peakRms * NOISE_FLOOR_PEAK_CAP));
}

// Speech onset needs several consecutive loud frames (~300 ms at the
// 100 ms monitor cadence): a single loud frame is a click, cough or door
// slam, not voice. Gating onset on sustained energy keeps transient noise
// from starting turns (and becoming ghost text) while barely delaying
// real barge-in.
/** How much real speech a chunk must contain before it is worth a request. */
export const MIN_CHUNK_SPEECH_MS = 180;

/**
 * Move a chunk cut to the quietest point near it, so no word is sliced.
 *
 * A fixed-time cut lands inside a word about as often as between words. The
 * provider then transcribes the two halves of that word independently — chunk
 * N ends with «میر…» and chunk N+1 starts with «…میروم» — and because they are
 * different tokens the overlap merge cannot recognise them as the same word, so
 * the torn pieces both survive. That is one of the ways live voice "transcribed
 * wrong" while dictation of the same sentence was correct.
 *
 * Returns the cut index (samples to take). `targetCut` is honoured when the
 * whole search window is loud.
 */
export function chooseCut(
  pcm: Float32Array,
  sampleRate: number,
  targetCut: number,
  searchMs = 150,
  windowMs = 30,
): number {
  const total = pcm?.length ?? 0
  if (total === 0) return 0
  const target = Math.max(0, Math.min(total, Math.floor(targetCut)))
  const span = Math.max(1, Math.floor((sampleRate * searchMs) / 1000))
  const win = Math.max(1, Math.floor((sampleRate * windowMs) / 1000))
  let best = target
  let bestRms = Infinity
  for (let cut = Math.max(win, target - span); cut <= Math.min(total, target + span); cut += win) {
    const start = Math.max(0, cut - win)
    const end = Math.min(total, cut)
    let sum = 0
    for (let i = start; i < end; i++) sum += pcm[i] * pcm[i]
    const rms = Math.sqrt(sum / Math.max(1, end - start))
    if (rms < bestRms) {
      bestRms = rms
      best = cut
    }
  }
  // Only accept the moved cut when it is actually quiet; otherwise the target
  // wins, so a continuous vowel does not get cut in a random place.
  return bestRms <= SILENCE_RMS ? best : target
}

export const LIVE_SPEECH_ONSET_FRAMES = 3;

/**
 * How long the mic may deliver frames without any audible energy before the
 * session reports a dead input.
 *
 * "No frames" is caught by the capture watchdog, but the other silent failure
 * is worse: the graph runs, frames arrive, and every sample is flat because
 * the OS is feeding a muted or wrong device. Nothing else can detect that —
 * the VAD gate simply never opens and the user talks into a void.
 */
export const LIVE_MIC_SILENCE_MS = 6000;

/** Peak RMS under which a real microphone is certainly feeding silence. */
export const LIVE_MIC_DEAD_RMS = 0.0002;

/** True once speech has persisted long enough to count as voice onset. */
export function isSustainedSpeech(streak: number, required: number = LIVE_SPEECH_ONSET_FRAMES): boolean {
  return streak >= required;
}

/**
 * How much the speech gate is raised while the agent is speaking.
 *
 * The mic stays open during TTS playback (barge-in needs it), so the agent's
 * own voice — even after echo cancellation has attenuated it — can cross the
 * normal gate. That made the assistant cut itself off mid-sentence: VAD fired
 * on the leaked audio, the caller saw "user started talking" and stopped
 * playback. Raising the gate while speaking keeps real barge-in (a person
 * talking over the agent is much louder than the bleed) without self-interrupt.
 */
export const TTS_ECHO_GATE_MULT = 2;

/**
 * Absolute gate floor while the agent speaks.
 *
 * Speaker bleed after echo cancellation sits around 0.01-0.04 RMS, well above
 * the 0.008 gate that is right for a quiet room (the room really is that
 * quiet then — the agent's own audio is what is new). A relative multiplier
 * alone is not enough, because the ambient floor during playback is still the
 * room's, not the speaker's.
 *
 * The floor sits BELOW the loudest residual bleed on purpose: speech on a quiet
 * laptop mic starts around 0.03, so the old 0.06 floor made the mic deaf for
 * the whole answer — the user had to wait for the turn to end before STT heard
 * a word. Echo cancellation removes most bleed; the onset streak below is what
 * rejects the rest.
 */
export const TTS_ECHO_MIN_GATE = 0.025;

/**
 * Onset frames required while the agent speaks (bleed must not trip it).
 *
 * Four, not three: the floor above was lowered to 0.025, so the residual bleed
 * that now leans on this streak instead of the level gate needs the extra frame
 * to be rejected. The quiet-room streak stays at LIVE_SPEECH_ONSET_FRAMES, and
 * 400 ms of sustained voice is still an instant barge-in.
 */
export const TTS_ONSET_FRAMES = 4;

/** Effective gate, raised while the agent's own audio is playing. */
export function echoSafeThreshold(threshold: number, ttsSpeaking: boolean): number {
  if (!ttsSpeaking) return threshold;
  return Math.max(threshold * TTS_ECHO_GATE_MULT, TTS_ECHO_MIN_GATE);
}

/** Consecutive loud frames needed to start a turn in the current state. */
export function onsetFramesRequired(ttsSpeaking: boolean): number {
  return ttsSpeaking ? TTS_ONSET_FRAMES : LIVE_SPEECH_ONSET_FRAMES;
}

/** True when accumulated silence ends the turn. */
export function shouldEndTurn(silenceMs: number, thresholdMs: number): boolean {
  return silenceMs >= thresholdMs;
}

/** Reject HTML error pages misdelivered as transcripts. */
export function isLocalTranscriptJunk(s: string): boolean {
  if (!s) return false;
  const low = s.toLowerCase();
  if (low.includes('/_next/')) return true;
  if (low.includes('fetchpriority')) return true;
  if (low.includes('preload')) return true;
  if (s.includes('&lt;')) return true;
  if (/<link/i.test(s)) return true;
  if (/<!doctype/i.test(s)) return true;
  if (/<html/i.test(s)) return true;
  if (/<head/i.test(s)) return true;
  if (/<meta/i.test(s)) return true;
  if (/<\/?[a-z][^<>]*>/i.test(s)) return true;
  if (/<[a-z][^<>]*$/i.test(s)) return true;
  return false;
}

/**
 * Clean a transcript: drop junk entirely, otherwise return the text in Persian
 * spelling (see normalizeTranscript — the providers return Arabic look-alikes
 * for Persian yeh/kaf, which read as wrong words).
 */
export function sanitizeLocalTranscript(raw: string, lang?: string): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  if (isLocalTranscriptJunk(text)) return '';
  if (isHallucinatedTranscript(text, lang)) return '';
  return normalizeTranscript(text);
}

/** True when a transcript looks like a Whisper noise hallucination. */
export function isHallucinatedTranscript(text: string, lang?: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  if (t.length <= 1) return true;
  const words = t.split(/\s+/);
  // A Whisper noise loop repeats itself far more than a human ever does. Four
  // identical words used to be called a hallucination, but real users repeat
  // words on purpose ("سلام سلام سلام") — the loop floor is six.
  if (words.length >= 6 && new Set(words).size === 1) return true;
  let repeat = 1;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) {
      repeat++;
      if (repeat >= 6) return true;
    } else {
      repeat = 1;
    }
  }
  // A two-word PING-PONG (e.g. a whisper repetition loop that alternates two
  // tokens) defeats the same-word check above. Compare each word to the one
  // two back: 5+ alternations of the same bigram is a loop - real speech
  // never repeats a bigram that consistently.
  if (words.length >= 7) {
    let ping = 0;
    for (let i = 2; i < words.length; i++) {
      if (words[i] === words[i - 2]) {
        ping++;
        if (ping >= 5) return true;
      } else {
        ping = 0;
      }
    }
  }
  // A request for Persian that comes back in Latin letters is not a
  // transcription at all: an endpoint without a real ASR model (a chat model
  // behind a proxy) answers with something like «PYM JBZ» for «سلام». Only
  // short Latin runs count — a Persian sentence may legitimately cite English
  // identifiers, but a couple of bare Latin letters never are Persian speech.
  if (lang === 'fa' && !/[\u0600-\u06FF]/.test(t) && !LATIN_WORD_RE.test(t)) return true;
  if (lang === 'fa' && !/[\u0600-\u06FF]/.test(t) && t.split(/\s+/).length <= 3) return true;
  // Subtitle boilerplate Whisper emits when the audio is music or noise: it is
  // not a transcription of anything the user said, and keeping it types a stray
  // sentence into the composer after every silent stretch.
  const lower = t.toLowerCase();
  for (const junk of HALLUCINATION_PHRASES) {
    if (lower.includes(junk)) return true;
  }
  return false;
}

/** A real word (4+ letters) in Latin script — a cited identifier, not noise. */
const LATIN_WORD_RE = /[A-Za-z]{4,}/

/** Phrases Whisper invents over music, applause and room noise (lower-case). */
const HALLUCINATION_PHRASES = [
  'thank you for watching',
  'thanks for watching',
  'please subscribe',
  'subscribe to my channel',
  'like and subscribe',
  'subtitles by',
  'amara.org',
  'muito obrigado',
  'شكرا للمشاهدة',
  'شكرا على المشاهدة',
  'subscribe',
];

// AudioWorklet source: batches ~21 ms of mono samples before posting, so the
// main thread gets a few dozen messages per second instead of thousands.
const CAPTURE_WORKLET_NAME = 'codifa-live-capture';
const CAPTURE_WORKLET_CODE = `
class CodifaLiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs && inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('${CAPTURE_WORKLET_NAME}', CodifaLiveCapture);
`;

// How long a stopped session keeps its microphone and AudioContext alive so the
// next start is instant. Opening a device costs hundreds of ms in WKWebView and
// no frame is captured until it resolves — the user pressed the button, spoke,
// and the first word was already gone (the dictation bug, same cause here).
const LIVE_MIC_HOLD_MS = 4000;

/** Warm audio source kept between sessions: stream plus the context it belongs
 *  to. The pair must be cached TOGETHER — a Web Audio graph is bound to the
 *  context that created it, so reusing a stream on a closed context silences
 *  capture entirely. */
let heldMic: { stream: MediaStream; ctx: AudioContext } | null = null;
let heldMicTimer: ReturnType<typeof setTimeout> | null = null;

function dropHeldMic(): void {
  if (heldMicTimer !== null) {
    clearTimeout(heldMicTimer);
    heldMicTimer = null;
  }
  if (!heldMic) return;
  const held = heldMic;
  heldMic = null;
  try {
    held.stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Tracks already stopped.
  }
  try {
    void held.ctx.close();
  } catch {
    // Close is best-effort.
  }
}

/** Release the held microphone NOW (component teardown, not a quick restart). */
export function releaseWarmLiveMic(): void {
  dropHeldMic();
}

/** A held stream is only reusable while it is still live. */
function heldMicUsable(): { stream: MediaStream; ctx: AudioContext } | null {
  if (!heldMic) return null;
  if (heldMic.stream.getTracks().some((t) => t.readyState === 'ended')) {
    dropHeldMic();
    return null;
  }
  if (heldMic.ctx.state === 'closed') {
    dropHeldMic();
    return null;
  }
  if (heldMicTimer !== null) {
    clearTimeout(heldMicTimer);
    heldMicTimer = null;
  }
  return heldMic;
}

/** Keep a stopped session's device warm for a short while, then free it. */
function holdMic(stream: MediaStream, ctx: AudioContext): void {
  dropHeldMic();
  heldMic = { stream, ctx };
  heldMicTimer = setTimeout(() => {
    heldMicTimer = null;
    dropHeldMic();
  }, LIVE_MIC_HOLD_MS);
}

export class LocalLiveSession {
  private options: LocalLiveOptions;
  /** Chat that holds the microphone lease while this session is connected. */
  private leaseChatId: string | null = null;
  private state: LocalLiveState = 'idle';
  private stopped = false;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private captureRate = STT_SAMPLE_RATE;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private deviceId?: string;

  /** Audio captured since the last chunk cut (native capture rate, mono). */
  private pcmFrames: Float32Array[] = [];
  private capturing = false;
  /** Zero-gain node that keeps the mic graph connected to the destination. */
  private sink: GainNode | null = null;
  /** Which capture backend is running (used by the watchdog retry). */
  private captureKind: 'worklet' | 'processor' | null = null;
  /** Frames received this session — the watchdog's evidence that audio flows. */
  private pcmFrameCount = 0;
  /** Verifies that capture actually delivers audio after it starts. */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** Highest RMS seen this session: proves whether the mic is simply silent. */
  private peakRms = 0;
  /** Rolling ambient noise estimate, so the gate adapts to the room. */
  private noiseFloor = 0;
  /** Frames spent sampling the room right after capture starts. */
  private noiseCalibFrames = 0;
  /** Reports a mic that yields frames but only ever delivers silence. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the agent's TTS audio is playing through the speakers. */
  private ttsSpeaking = false;
  /** Retry timer for a turn whose delivery was deferred by a drain. */
  private finishTimer: ReturnType<typeof setTimeout> | null = null;

  private speechStartAt = 0;
  private lastSpeechAt = 0;
  private lastFlushAt = 0;
  private hasSpeech = false;
  /** True while a turn is being finalized (queue draining). */
  private transcribing = false;
  /** Chunks enqueued but not yet merged into the owning turn. */
  private pending = 0;
  /** Dictate mode: a pause never ends the turn (see LocalLiveOptions.dictate). */
  private dictate = false;
  /** The turn being captured: its token plus its merged transcript. Held as an
   *  OBJECT, not a shared string, so a turn that is still draining keeps its own
   *  text after beginTurn has already started the next one. A shared string was
   *  cleared by the next turn, and finishTurn then returned early on the token
   *  mismatch — silently dropping a whole utterance the user had spoken. */
  private turn: { token: number; text: string } = { token: 0, text: '' };
  /** Increments per turn so a late chunk result can never land in the next. */
  private turnToken = 0;
  /** Every sample of the turn in progress, kept so the finished utterance can
   *  be decoded ONCE at turn end — the way dictation does it. */
  private turnAudio: Float32Array[] = [];
  private turnAudioLen = 0;
  /** True once the turn outgrew one ASR window: its audio is incomplete, so the
   *  single-clip decode must not be used (it would drop the last words). */
  private turnAudioTruncated = false;
  /** Applies chunk results in order (merging is order-sensitive). */
  private chain: Promise<void> = Promise.resolve();
  /** Chunk requests actually running right now (bounded by maxInflight). */
  private activeRequests = 0;
  /** Resolvers for chunks waiting for a free request slot. */
  private slotWaiters: Array<() => void> = [];

  constructor(options: LocalLiveOptions) {
    this.options = options;
    this.deviceId = options.deviceId;
    // Without this the option existed but never took effect: every dictate
    // session ran as live voice, so an 800 ms pause auto-sent half a sentence.
    this.dictate = options.dictate === true;
  }

  get currentState(): LocalLiveState {
    return this.state;
  }

  /** Merged transcript of the turn in progress. */
  get partialText(): string {
    return this.turn.text;
  }

  private setState(s: LocalLiveState): void {
    this.state = s;
    try {
      this.options.onStateChange?.(s);
    } catch {
      // Listener must never break the loop.
    }
  }

  async connect(chatId?: string | null): Promise<void> {
    if (this.stopped) this.stopped = false;
    if (this.state === 'connecting' || this.state === 'live') return;
    // Owner chat: the live-voice caller passes it explicitly; dictate relies on
    // the option. With only the argument consulted, a dictate session claimed
    // as `null` and the mic was ALWAYS refused — and because the refusal
    // returned instead of throwing, the button showed recording while no
    // microphone was ever opened and no chunk was ever transcribed.
    const owner = chatId ?? this.options.chatId ?? null;
    // Hard gate: the previous session's audio was already handed over to this
    // object, so only the lease holder may actually open one microphone.
    if (!claimLiveVoice(owner)) {
      this.setState('closed');
      // Dictation must not present a dead session as recording: throw so the
      // caller drops to its classic record-then-transcribe pipeline. Live
      // voice keeps its silent close — its UI already reflects 'closed'.
      if (this.dictate) throw new Error('the microphone is in use by another chat');
      return;
    }
    this.leaseChatId = owner;
    this.setState('connecting');
    try {
      await this.openMic();
      this.setState('live');
      this.startMonitor();
    } catch (err) {
      this.setState('error');
      try {
        this.options.onError?.(err);
      } catch {
        // Ignore listener errors.
      }
      throw err;
    }
  }

  /**
   * Dictate mode: end the turn on an explicit stop (mic button / Space / new
   * session), deliver the final transcript, then tear the engine down. The
   * disconnect must wait for the delivery — requestChunk skips its round-trip
   * once `stopped` flips, so tearing down first would drop the final text.
   */
  async finishDictation(): Promise<void> {
    if (!this.dictate || this.stopped) {
      this.disconnect();
      return;
    }
    // The mic stops here, but the engine must stay ALIVE until the final text
    // delivers. disconnect() would kill the scheduleFinish retry timer (a turn
    // deferred behind a still-draining predecessor) and gate in-flight chunks
    // on `stopped` — the stop press then delivered nothing. Stop capture,
    // deliver, THEN tear down.
    this.stopMonitor();
    this.closeMic();
    // Deadline guard: the drain is bounded per finishTurn, but a pathological
    // provider must never spin this loop forever either.
    const deadline = Date.now() + LOCAL_LIVE_DEFAULTS.turnDeliverBudgetMs + 2_000;
    while (this.hasSpeech || this.transcribing) {
      if (Date.now() > deadline) break;
      await this.finishTurn();
      if (!this.hasSpeech && !this.transcribing) break;
      // A turn deferred behind a draining predecessor retries shortly; the
      // 150ms scheduleFinish timer disconnect() would have killed is this
      // loop instead.
      await new Promise((r) => setTimeout(r, 120));
    }
    this.disconnect();
  }

  disconnect(): void {
    this.stopped = true;
    this.stopMonitor();
    this.closeMic();
    releaseLiveVoice(this.leaseChatId);
    this.leaseChatId = null;
    this.setState('closed');
  }

  async setMicrophoneDeviceId(deviceId: string): Promise<void> {
    this.deviceId = deviceId || undefined;
    if (this.state !== 'live' && this.state !== 'speaking') return;
    // Reopen the mic on the new device without dropping the session state.
    this.stopMonitor();
    this.closeMic();
    await this.openMic();
    this.startMonitor();
  }

  /** Called by the owner when TTS playback starts/ends to reflect speaking. */
  notifySpeaking(speaking: boolean): void {
    if (this.stopped) return;
    // Remembered beyond the state machine: the VAD gate uses it to ignore the
    // agent's own voice leaking through the speakers.
    this.ttsSpeaking = speaking;
    if (speaking) {
      if (this.state === 'live') this.setState('speaking');
    } else {
      if (this.state === 'speaking') this.setState('live');
    }
  }

  /**
   * Microphone constraints for live capture.
   *
   * Echo cancellation is the one processing node that must stay on: the agent
   * talks through the speakers while the mic is open, and without AEC that
   * bleed is loud enough to look like voice. Noise suppression and AGC are
   * turned OFF — they are tuned for phone calls, not for ASR: suppression eats
   * the Persian fricatives (/s/ /ʃ/ /z/ /f/ /x/) the model needs, and AGC pumps
   * the gain mid-word. Level consistency is handled by normalizePeak per chunk
   * instead. Unsupported keys are ignored by the browser (none are `exact`).
   */
  private audioConstraints(): MediaTrackConstraints {
    return {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
    };
  }

  private async openMic(): Promise<void> {
    // A device opened moments ago is reused as-is: getUserMedia plus a fresh
    // AudioContext costs hundreds of ms in WKWebView, and every frame before
    // that resolves is a word the user already spoke into a dead microphone.
    const warm = heldMicUsable();
    if (warm && !this.deviceId) {
      this.micStream = warm.stream;
      this.audioCtx = warm.ctx;
      heldMic = null;
      if (this.audioCtx.state === 'suspended') {
        try {
          await this.audioCtx.resume();
        } catch {
          // Resume is best-effort; monitoring still works when running.
        }
      }
    } else {
      if (warm) dropHeldMic();
      // An exact deviceId can go stale (OverconstrainedError) while plain
      // audio:true still works, so fall back to it.
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
      } catch (err) {
        const name = err instanceof DOMException ? err.name : (err as { name?: unknown }).name;
        const constraint = (err as { constraint?: unknown }).constraint;
        const isDevice =
          name === 'OverconstrainedError' || name === 'OverconstrainedConstraint' || constraint === 'deviceId';
        // A stale device is retried with plain audio; any other rejection (the
        // user denied the mic) must surface instead of being retried blindly.
        if (this.deviceId && isDevice) {
          this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else if (name === 'NotSupportedError' || name === 'TypeError') {
          this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw err;
        }
      }
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio is not supported in this browser');
      this.audioCtx = new Ctx();
      if (this.audioCtx.state === 'suspended') {
        try {
          await this.audioCtx.resume();
        } catch {
          // Resume is best-effort; monitoring still works when running.
        }
      }
    }
    this.captureRate = this.audioCtx.sampleRate || STT_SAMPLE_RATE;
    this.source = this.audioCtx.createMediaStreamSource(this.micStream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    // Web Audio only renders nodes that reach the destination. The mic graph
    // used to stop at the analyser, which WebKit (the WKWebView this app runs
    // in on macOS) does NOT pull: the analyser never received samples, so the
    // VAD saw permanent silence, no chunk was ever cut and live voice did
    // nothing at all — silently, because "no audio" is not an error. A
    // zero-gain sink keeps the whole graph live without playing the mic back.
    this.sink = this.audioCtx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(this.audioCtx.destination);
    this.analyser.connect(this.sink);
    this.source.connect(this.analyser);
    await this.startPcmCapture();
    this.startCaptureWatchdog();
    this.startSilenceWatchdog();
  }

  /**
   * Report a microphone that is open but only ever delivers silence.
   *
   * Without this the worst case is indistinguishable from a broken feature:
   * frames flow, the VAD never fires, no chunk is transcribed, no error is
   * raised, and the UI happily shows "live".
   */
  private startSilenceWatchdog(): void {
    this.stopSilenceWatchdog();
    this.peakRms = 0;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.stopped) return;
      if (this.peakRms >= LIVE_MIC_DEAD_RMS) return;
      try {
        this.options.onError?.(
          new Error(
            'The microphone is delivering pure silence — pick another input device in Settings → Sound (or check the system input level and mute switch).',
          ),
        );
      } catch {
        // Listener errors must not break capture.
      }
    }, LIVE_MIC_SILENCE_MS);
  }

  private stopSilenceWatchdog(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /** Start streaming raw samples from the mic into `pcmFrames`. */
  private async startPcmCapture(): Promise<void> {
    const ctx = this.audioCtx;
    const source = this.source;
    if (!ctx || !source) return;
    this.pcmFrames = [];
    this.capturing = true;
    try {
      if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        const moduleUrl = URL.createObjectURL(
          new Blob([CAPTURE_WORKLET_CODE], { type: 'application/javascript' }),
        );
        try {
          await ctx.audioWorklet.addModule(moduleUrl);
        } finally {
          URL.revokeObjectURL(moduleUrl);
        }
        const node = new AudioWorkletNode(ctx, CAPTURE_WORKLET_NAME, {
          numberOfInputs: 1,
          // One output, connected to the zero-gain sink: a worklet with no
          // output is not guaranteed to be pulled by WebKit, and an unprocessed
          // worklet delivers no frames (the silent-dead-live-voice bug).
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
        });
        node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.pushPcm(ev.data);
        source.connect(node);
        if (this.sink) node.connect(this.sink);
        this.captureNode = node;
        this.captureKind = 'worklet';
        return;
      }
      // Fallback (older WebKit): ScriptProcessor still delivers the same data.
      const proc = ctx.createScriptProcessor(1024, 1, 1);
      proc.onaudioprocess = (ev) => {
        const ch = ev.inputBuffer.getChannelData(0);
        this.pushPcm(new Float32Array(ch));
      };
      source.connect(proc);
      if (this.sink) proc.connect(this.sink);
      this.captureNode = proc;
      this.captureKind = 'processor';
    } catch (err) {
      this.capturing = false;
      this.captureNode = null;
      throw err;
    }
  }

  private pushPcm(frame: Float32Array): void {
    if (!this.capturing || this.stopped) return;
    if (!frame || frame.length === 0) return;
    this.pcmFrameCount++;
    this.pcmFrames.push(frame);
    if (this.hasSpeech) {
      // Keep the whole utterance so the turn can be decoded once, like
      // dictation. Capped at the ASR's single-window length: past that the
      // model starts summarizing, so the chunk transcript is the only option
      // anyway and there is no point buffering more.
      const cap = Math.floor((this.captureRate * LOCAL_LIVE_DEFAULTS.wholeTurnMaxMs) / 1000);
      if (this.turnAudioLen < cap) {
        this.turnAudio.push(frame);
        this.turnAudioLen += frame.length;
        if (this.turnAudioLen > cap) this.turnAudioTruncated = true;
      } else {
        this.turnAudioTruncated = true;
      }
    }
    // Outside a turn only the pre-roll is kept: audio before the onset is
    // silence, and holding on to it would only grow the buffer forever.
    if (!this.hasSpeech) this.trimToMs(LOCAL_LIVE_DEFAULTS.preRollMs);
  }

  /**
   * Prove that capture really delivers audio, and say so loudly when it does
   * not.
   *
   * A silent capture graph is the worst failure live voice can have: the user
   * talks, nothing appears, no error is raised (empty audio is not an
   * exception), so it looks like the feature is simply dead. This watchdog
   * turns "no frames ever arrived" into an actionable error, and first tries
   * the ScriptProcessor fallback for WebKit builds where the AudioWorklet
   * silently produces nothing.
   */
  private startCaptureWatchdog(): void {
    this.stopCaptureWatchdog();
    this.pcmFrameCount = 0;
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.stopped || !this.capturing) return;
      if (this.pcmFrameCount > 0) return;
      // Worklet produced no frames: retry once with the ScriptProcessor path.
      if (this.captureKind === 'worklet') {
        void this.retryCaptureWithProcessor();
        return;
      }
      this.options.onError?.(
        new Error(
          'Microphone is open but no audio is reaching Codifa — check the input device in Settings → Sound, then restart live voice.',
        ),
      );
    }, 1500);
  }

  private stopCaptureWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** Fallback for WebKit builds where the AudioWorklet yields no samples. */
  private async retryCaptureWithProcessor(): Promise<void> {
    const ctx = this.audioCtx;
    const source = this.source;
    if (!ctx || !source || this.stopped) return;
    try {
      if (this.captureNode) {
        try {
          this.captureNode.disconnect();
        } catch {
          // Already disconnected.
        }
        this.captureNode = null;
      }
      const proc = ctx.createScriptProcessor(1024, 1, 1);
      proc.onaudioprocess = (ev) => {
        const ch = ev.inputBuffer.getChannelData(0);
        this.pushPcm(new Float32Array(ch));
      };
      source.connect(proc);
      if (this.sink) proc.connect(this.sink);
      this.captureNode = proc;
      this.captureKind = 'processor';
      this.pcmFrameCount = 0;
      this.startCaptureWatchdog();
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  private closeMic(): void {
    this.stopCaptureWatchdog();
    this.stopSilenceWatchdog();
    this.capturing = false;
    this.captureKind = null;
    this.pcmFrameCount = 0;
    this.pcmFrames = [];
    this.turnAudio = [];
    this.turnAudioLen = 0;
    this.turnAudioTruncated = false;
    if (this.captureNode) {
      try {
        if ('port' in this.captureNode) {
          (this.captureNode as AudioWorkletNode).port.onmessage = null;
        } else {
          (this.captureNode as ScriptProcessorNode).onaudioprocess = null;
        }
      } catch {
        // Detach is best-effort.
      }
      try {
        this.captureNode.disconnect();
      } catch {
        // Already disconnected.
      }
      this.captureNode = null;
    }
    try {
      this.source?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.source = null;
    this.analyser = null;
    if (this.sink) {
      try {
        this.sink.disconnect();
      } catch {
        // Already disconnected.
      }
      this.sink = null;
    }
    // The device is NOT closed here: a quick restart (toggle, device switch)
    // must not pay the open cost again. Only the graph is torn down; the stream
    // and context are handed to the module-level hold, which frees them after
    // LIVE_MIC_HOLD_MS. Dropping the whole pair is required — a new graph needs
    // the context the stream was opened on.
    const heldStream = this.micStream;
    const heldCtx = this.audioCtx;
    this.micStream = null;
    this.audioCtx = null;
    if (heldStream && heldCtx && heldCtx.state !== 'closed') {
      holdMic(heldStream, heldCtx);
    } else {
      if (heldStream) {
        try {
          heldStream.getTracks().forEach((t) => t.stop());
        } catch {
          // Tracks already stopped.
        }
      }
      if (heldCtx) {
        try {
          void heldCtx.close();
        } catch {
          // Close is best-effort.
        }
      }
    }
  }

  /** Keep only the last `ms` of buffered audio. */
  private trimToMs(ms: number): void {
    const keep = Math.max(0, Math.floor((this.captureRate * ms) / 1000));
    let total = 0;
    for (const f of this.pcmFrames) total += f.length;
    if (total <= keep) return;
    let drop = total - keep;
    const kept: Float32Array[] = [];
    for (const f of this.pcmFrames) {
      if (drop <= 0) {
        kept.push(f);
      } else if (f.length <= drop) {
        drop -= f.length;
      } else {
        kept.push(f.subarray(drop));
        drop = 0;
      }
    }
    this.pcmFrames = kept;
  }

  /**
   * Whether the previous chunk boundary landed on silence. Set by takePcm for
   * the NEXT chunk; read by queueChunk. A silent boundary means the next chunk
   * holds only audio never sent before, so a repeated word there is the user
   * repeating it — not the overlap echo coming back.
   */
  private boundarySilent = false;

  /**
   * Take everything captured so far, leaving `keepMs` at the tail of the
   * buffer so the next chunk overlaps the current one. Returns empty when the
   * buffer holds only the overlap (nothing new was captured).
   */
  private takePcm(keepMs: number, snapToSilence = false): Float32Array {
    const keep = Math.max(0, Math.floor((this.captureRate * keepMs) / 1000));
    let total = 0;
    for (const f of this.pcmFrames) total += f.length;
    if (total <= keep) return new Float32Array(0);
    const all = concatFloat32(this.pcmFrames);
    let cut = all.length - keep;
    if (snapToSilence) {
      cut = chooseCut(all, this.captureRate, cut);
    }
    const out = all.slice(0, cut);
    // Whatever was not taken stays buffered, including the silence we chose to
    // cut on, so the next chunk keeps its natural context.
    this.pcmFrames = cut < all.length ? [all.slice(cut)] : [];
    // Boundary signal for the transcript merge: when this cut ends in silence
    // (a snapped pause), the NEXT chunk starts on fresh audio only — a repeat
    // there is real speech. A cut through continuous speech leaves this
    // chunk's tail inside the next chunk's head, so the echo guard must stay
    // on. Same 30 ms window criterion chooseCut used to accept the snap.
    const win = Math.min(out.length, Math.max(1, Math.floor((this.captureRate * 30) / 1000)));
    this.boundarySilent =
      out.length === 0 || computeRms(out.subarray(out.length - win)) <= SILENCE_RMS;
    return out;
  }

  /**
   * Decode the ENTIRE turn as one clip, exactly like dictation does.
   *
   * This is the accuracy fix for live voice. The per-chunk requests above only
   * ever produce a PREVIEW: Whisper gets a ~1.4 s Persian clip with no sentence
   * context, so it guesses word endings and short words — the identical voice
   * transcribed correctly in dictate (one long clip) and wrongly in live. At
   * turn end the finished utterance is decoded in one request and THAT text is
   * delivered; the chunk transcript stays only as a fallback for a turn too
   * long for a single window, or for a failed request.
   */
  private async transcribeWholeTurn(token: number): Promise<string> {
    // A turn that outgrew the ASR window cannot be decoded in one request, and
    // the buffered audio would be missing its tail — take nothing and let the
    // chunk transcript stand.
    if (this.turnAudioTruncated) {
      this.takeTurnAudio();
      return '';
    }
    const samples = this.takeTurnAudio();
    if (samples.length === 0) return '';
    const wav = this.encodeTurnAudio(samples);
    if (!wav) return '';
    const lang = this.options.lang ?? 'fa';
    const prompt = buildSttPrompt(lang, this.options.prompt);
    const raw = await this.requestChunk(wav, lang, prompt, token, true);
    // Same cleanup as a chunk: an error page or a prompt echo must never be
    // delivered as the user's words.
    return stripSttPromptEcho(sanitizeLocalTranscript(raw, lang), prompt).trim();
  }

  /** Copy the turn's audio out and reset the buffer for the next turn. */
  private takeTurnAudio(): Float32Array {
    if (this.turnAudioLen === 0) return new Float32Array(0);
    const all = concatFloat32(this.turnAudio);
    this.turnAudio = [];
    this.turnAudioLen = 0;
    return all;
  }

  /** Turn audio → the same 16 kHz mono WAV dictate sends. Null when unusable. */
  private encodeTurnAudio(samples: Float32Array): Blob | null {
    const resampled = downsampleFloat32(samples, this.captureRate, STT_SAMPLE_RATE);
    const trimmed = trimSilence(resampled, STT_SAMPLE_RATE);
    if (trimmed.speechMs < MIN_CHUNK_SPEECH_MS) return null;
    const wav = encodeWavPcm16(normalizePeak(trimmed.pcm), STT_SAMPLE_RATE);
    if (wav.size <= 44) return null;
    return wav;
  }

  private startMonitor(): void {
    this.stopMonitor();
    // Fresh session, fresh room: re-sample the ambient floor.
    this.noiseFloor = 0;
    this.noiseCalibFrames = 0;
    const threshold = this.options.levelThreshold ?? LOCAL_LIVE_DEFAULTS.levelThreshold;
    const silenceMs = this.options.silenceMs ?? LOCAL_LIVE_DEFAULTS.silenceMs;
    const dictate = this.options.dictate === true;
    this.dictate = dictate;
    const maxChunkMs = this.options.maxChunkMs ?? LOCAL_LIVE_DEFAULTS.maxChunkMs;
    const chunkMs = this.options.chunkMs ?? LOCAL_LIVE_DEFAULTS.chunkMs;
    const frameMs = LOCAL_LIVE_DEFAULTS.frameMs;
    const buf = new Float32Array(new ArrayBuffer(2048 * 4));
    let speechStreak = 0;
    this.monitorTimer = setInterval(() => {
      if (this.stopped) return;
      if (!this.analyser) return;
      try {
        this.analyser.getFloatTimeDomainData(buf as unknown as Float32Array<ArrayBuffer>);
      } catch {
        return;
      }
      const rms = computeRms(buf);
      if (rms > this.peakRms) this.peakRms = rms;
      // Calibrate the room, then FREEZE the estimate while a turn is open: the
      // user's own voice must never raise the very gate that is trying to
      // detect it. Only genuine silence between turns may move the floor.
      const calibrating = this.noiseCalibFrames < NOISE_FLOOR_CALIBRATION_FRAMES;
      if (calibrating) {
        this.noiseCalibFrames++;
        this.noiseFloor = updateNoiseFloor(this.noiseFloor, rms, true);
      } else if (!this.hasSpeech && !this.ttsSpeaking) {
        // Freeze the floor while the agent speaks: its own audio would
        // otherwise train the gate to the speaker level, and the echo guard
        // (echoSafeThreshold) is what handles that case explicitly.
        this.noiseFloor = updateNoiseFloor(this.noiseFloor, rms, false);
      }
      const adaptive = echoSafeThreshold(
        speechThreshold(this.noiseFloor, threshold, this.peakRms),
        this.ttsSpeaking,
      );
      const now = Date.now();
      const speech = isSpeechLevel(rms, adaptive);
      if (!speech) {
        speechStreak = 0;
        if (!this.hasSpeech) return;
        // Dictate: a pause keeps dictating — only an explicit stop closes the
        // turn. Chunks keep cutting through the pause so the composer text
        // stays current; the final tail chunk is queued on stop.
        if (this.dictate) {
          this.tickChunks(now, chunkMs, maxChunkMs);
          return;
        }
        if (shouldEndTurn(now - this.lastSpeechAt, silenceMs)) {
          void this.finishTurn();
          return;
        }
        // A short pause keeps the turn open: keep cutting chunks so the tail
        // is already transcribed by the time the user really stops.
        this.tickChunks(now, chunkMs, maxChunkMs);
        return;
      }
      speechStreak++;
      if (!this.hasSpeech) {
        // Transient loud blips (clicks, coughs, door slams) light up one or
        // two frames: wait for sustained voice before starting a turn,
        // otherwise noise becomes ghost text. While the agent speaks the
        // streak must be longer, so speaker bleed cannot self-interrupt.
        if (!isSustainedSpeech(speechStreak, onsetFramesRequired(this.ttsSpeaking))) return;
        this.beginTurn(now);
        return;
      }
      this.lastSpeechAt = now;
      this.tickChunks(now, chunkMs, maxChunkMs);
    }, frameMs);
  }

  private stopMonitor(): void {
    if (this.monitorTimer !== null) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.finishTimer !== null) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
  }

  /** Retry a turn end that had to wait for a running drain to finish. */
  private scheduleFinish(): void {
    if (this.finishTimer !== null || this.stopped) return;
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null;
      if (this.stopped || !this.hasSpeech) return;
      void this.finishTurn();
    }, 150);
  }

  /**
   * Cut a chunk every `chunkMs` while a turn is open, and close very long
   * utterances so a single turn cannot grow without bound.
   */
  private tickChunks(now: number, chunkMs: number, maxChunkMs: number): void {
    if (now - this.lastFlushAt >= chunkMs) this.flushChunk();
    if (this.dictate) return; // long utterances are fine: the user stops manually
    if (now - this.speechStartAt >= maxChunkMs) void this.finishTurn();
  }

  /** VAD confirmed voice: reset the turn and keep only the pre-roll. */
  private beginTurn(now: number): void {
    this.hasSpeech = true;
    this.turnToken++;
    // A fresh owner object per turn. The previous turn's text is NOT cleared:
    // it may still be draining towards delivery, and its holder is what
    // finishTurn() reads.
    this.turn = { token: this.turnToken, text: '' };
    this.speechStartAt = now;
    this.lastSpeechAt = now;
    this.lastFlushAt = now;
    this.trimToMs(LOCAL_LIVE_DEFAULTS.preRollMs);
    // Seed the full-turn buffer with the pre-roll, so the first syllable is
    // part of the single-clip decode too (the chunk cuts already rely on it).
    this.turnAudio = this.pcmFrames.slice();
    this.turnAudioLen = 0;
    this.turnAudioTruncated = false;
    for (const f of this.turnAudio) this.turnAudioLen += f.length;
    try {
      this.options.onSpeechStart?.();
    } catch {
      // Listener errors must not break capture.
    }
  }

  /** Cut one chunk and hand it to the transcription queue. */
  private flushChunk(): void {
    // Cut on silence, not on the clock: a cut inside a word makes the provider
    // transcribe two different halves of it, and the merge cannot rejoin them.
    // Read the flag BEFORE takePcm: this call's cut decides the boundary the
    // NEXT chunk starts on; this chunk's boundary came from the previous one.
    const headSilent = this.boundarySilent;
    const samples = this.takePcm(LOCAL_LIVE_DEFAULTS.overlapMs, true);
    const minSamples = Math.floor((this.captureRate * 200) / 1000);
    if (samples.length < minSamples) return;
    this.lastFlushAt = Date.now();
    this.queueChunk(samples, headSilent);
  }

  private queueChunk(samples: Float32Array, headSilent = false): void {
    const resampled = downsampleFloat32(samples, this.captureRate, STT_SAMPLE_RATE);
    // Drop the dead air first: a chunk that is mostly pause makes a
    // non-streaming model hallucinate filler ("thank you for watching"),
    // which merges into the user's sentence and reads as a wrong dictation.
    const trimmed = trimSilence(resampled, STT_SAMPLE_RATE);
    if (trimmed.speechMs < MIN_CHUNK_SPEECH_MS) return;
    // Music, a held tone or fan/AC hum passes a level gate just as easily as a
    // voice, but its energy envelope is flat where speech is syllabic. Rejecting
    // it HERE — before the request — means the provider never gets the chance to
    // invent words for it. This is level-independent, so a softly spoken first
    // word is still accepted (see SPEECH_ENVELOPE_MIN_CV).
    if (!isLikelySpeechEnvelope(trimmed.pcm, STT_SAMPLE_RATE)) return;
    // Normalize AFTER trimming: the gain must be computed from the speech that
    // is actually sent, not from a quiet tail that would let the words clip.
    const wav = encodeWavPcm16(normalizePeak(trimmed.pcm), STT_SAMPLE_RATE);
    if (wav.size <= 44) return;
    const token = this.turnToken;
    const owner = this.turn;
    const lang = this.options.lang ?? 'fa';
    this.pending++;
    // ONLY the user's glossary is sent. Previously this passed `this.turnText`
    // as Whisper context, which made the model re-emit the text already on
    // screen instead of the new audio: the merged result was unchanged, so the
    // composer looked frozen and the turn often ended with the same words (or,
    // after merging, nothing at all). Chunk continuity is the audio overlap's
    // job (takePcm above), not the prompt's.
    const prompt = buildSttPrompt(lang, this.options.prompt);
    // Fire the request NOW, in parallel with the other in-flight chunks
    // (bounded by maxInflight). Awaiting the previous chunk's round-trip before
    // even sending the next one is what put the partial transcript seconds
    // behind the voice. Only the MERGE stays ordered, below.
    const request = this.requestChunk(wav, lang, prompt, owner.token);
    this.chain = this.chain
      .then(async () => {
        const raw = await request;
        if (this.stopped) return;
        // Strip any prompt echo BEFORE merging: providers that continue the
        // prompt instead of transcribing the clip would otherwise splice our
        // own context (or the previous chunk's tail) into the user's words.
        const clean = stripSttPromptEcho(sanitizeLocalTranscript(raw, lang), prompt);
        if (!clean || isHallucinatedTranscript(clean, lang)) return;
        // Merge into the turn that OWNS this chunk, even once a newer turn has
        // started: the owning turn may still be draining and its finishTurn()
        // delivers `owner.text`. Only the visible partial is gated on the
        // token, so the composer never shows the previous turn's words.
        // headSilent: the chunk starts on a silence boundary — no previous-
        // chunk audio is inside it, so an exact repeat is the user repeating
        // the word and must be appended, not deduped away.
        owner.text = mergeTranscripts(owner.text, clean, { headSilent });
        if (owner.token !== this.turnToken) return;
        try {
          this.options.onPartial?.(owner.text);
        } catch {
          // Listener errors must not break capture.
        }
      })
      // Chain links must never stay rejected: one bad link would skip every
      // later chunk of every later turn.
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
      });
  }

  /** Run one chunk request once a slot is free. Failures yield ''. */
  private async requestChunk(
    wav: Blob,
    lang: string,
    prompt: string,
    token: number,
    skipSlot = false,
  ): Promise<string> {
    // The full-clip decode is the request that produces the delivered text, so
    // it never waits behind the preview chunks: with every slot taken by slow
    // preview requests it would time out and the turn would fall back to the
    // less accurate preview.
    if (!skipSlot) await this.acquireSlot();
    try {
      // A chunk of a turn that is still draining must still be transcribed:
      // its text is what finishTurn() is about to deliver. Only a stopped
      // session needs no round-trip at all.
      if (this.stopped) return '';
      return await this.options.transcribe(wav, lang, prompt);
    } catch (err) {
      try {
        this.options.onError?.(err);
      } catch {
        // Ignore listener errors.
      }
      return '';
    } finally {
      if (!skipSlot) this.releaseSlot();
    }
  }

  /** Take a request slot, waiting when maxInflight requests are already out. */
  private acquireSlot(): Promise<void> {
    if (this.activeRequests < LOCAL_LIVE_DEFAULTS.maxInflight) {
      this.activeRequests++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.slotWaiters.push(() => {
        this.activeRequests++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.activeRequests--;
    const next = this.slotWaiters.shift();
    if (next) next();
  }

  /**
   * Wait for the queued chunks, but never longer than `timeoutMs`.
   *
   * A slow or hanging provider must only DELAY a turn: without this cap
   * `finishTurn` awaited the whole chain, so one stuck request could freeze
   * live voice for as long as the fetch timeout allowed.
   */
  private async waitForDrain(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([this.chain.catch(() => undefined), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** End the turn: flush the tail, drain the queue, deliver the transcript. */
  private async finishTurn(): Promise<void> {
    if (this.stopped) return;
    if (!this.hasSpeech) return;
    if (this.transcribing) {
      // A previous turn is draining. Retry shortly instead of dropping this
      // utterance: returning here left `hasSpeech` true with no pending end,
      // so the turn was never closed and later speech was never delivered.
      this.scheduleFinish();
      return;
    }
    const token = this.turnToken;
    const turn = this.turn;
    this.transcribing = true;
    this.hasSpeech = false;
    try {
      const startedAt = Date.now();
      // Fire the single-clip decode FIRST so it runs in parallel with the
      // chunk drain below: the turn then costs no extra latency compared with
      // delivering the preview, but its text is as accurate as dictation.
      const wholeP = this.transcribeWholeTurn(token);
      const headSilent = this.boundarySilent;
      const rest = this.takePcm(0);
      const minSamples = Math.floor((this.captureRate * 200) / 1000);
      if (rest.length >= minSamples) this.queueChunk(rest, headSilent);
      // Wait for every queued chunk, but with a hard cap: a slow provider must
      // only delay the turn, never hang live voice. Whatever arrived by then is
      // merged into the owning turn and delivered as the turn. The cap is the
      // budget REMAINING after the work already done above, so the whole
      // delivery stays inside one bound.
      const budgetLeft = () =>
        Math.max(0, LOCAL_LIVE_DEFAULTS.turnDeliverBudgetMs - (Date.now() - startedAt));
      await this.waitForDrain(
        Math.min(LOCAL_LIVE_DEFAULTS.drainTimeoutMs, budgetLeft()),
      );
      // Read from the turn we started with, NOT the shared current one. If the
      // user began speaking again during the drain a new turn already owns the
      // session, and gating delivery on the token here discarded the utterance
      // the user had just finished ("I speak and nothing is typed").
      // Prefer the full-clip decode; fall back to the preview when it failed,
      // timed out, or the utterance was too long for one window. The wait is
      // capped so a slow provider can never hang the turn.
      let whole = '';
      let wholeTimer: ReturnType<typeof setTimeout> | undefined;
      whole = await Promise.race([
        wholeP,
        new Promise<string>((resolve) => {
          wholeTimer = setTimeout(() => resolve(''), budgetLeft());
        }),
      ]);
      if (wholeTimer) clearTimeout(wholeTimer);
      // The FULLER text wins, not "whole blindly": the turn buffer is capped
      // at ONE ASR window (wholeTurnMaxMs) and a single-clip decode can come
      // back with only the tail of a long utterance — the chunk merge then
      // already holds every sentence the preview chunks recognized, so
      // delivering the whole-side fragment erased them ("live only typed the
      // LAST sentence"). Word count decides; a tie keeps the full-clip
      // result, which is the more accurate decode of the same words.
      const wholeText = whole.trim();
      const previewText = turn.text.trim();
      const text =
        wordCount(wholeText) >= wordCount(previewText) ? wholeText : previewText;
      if (token === this.turnToken) {
        turn.text = '';
        this.trimToMs(0);
        try {
          this.options.onPartial?.('');
        } catch {
          // Listener errors must not break capture.
        }
      }
      if (!text || isHallucinatedTranscript(text)) return;
      if (this.stopped) return;
      // Deliver WITHOUT awaiting. onUserText runs the whole agent turn (model,
      // streaming, TTS) — awaiting it held `transcribing` for the entire
      // answer, so every utterance spoken meanwhile hit the guard at the top of
      // this method and was silently dropped ("the first turn works, then
      // nothing is ever typed"). The session owns the transcript, not the
      // reaction to it.
      try {
        void Promise.resolve(this.options.onUserText(text)).catch((err: unknown) => {
          try {
            this.options.onError?.(err);
          } catch {
            // Ignore listener errors.
          }
        });
      } catch (err) {
        this.options.onError?.(err);
      }
    } catch (err) {
      try {
        this.options.onError?.(err);
      } catch {
        // Ignore listener errors.
      }
    } finally {
      this.transcribing = false;
    }
  }
}
