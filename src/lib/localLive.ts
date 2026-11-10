// Live voice loop: continuous mic capture as raw PCM, decoded WHILE the user
// is still speaking so a preview is on screen before they finish.
//
// Why PCM and not MediaRecorder: a webm/opus container can only be decoded as
// a whole file — slicing it yields "could not process file" from strict
// providers. Raw samples can be wrapped in a complete 16 kHz WAV at any moment,
// which is what makes decoding the turn-so-far possible.
//
// Why the preview re-decodes the WHOLE turn instead of cutting chunks: a 2-3 s
// chunk is decoded without its neighbours, and fast speech has no pause to cut
// on, so cuts land inside words («آیکون» | «ها هستن») and the model guesses the
// torn halves into wrong words and repetition loops. Whisper's encoder always
// processes a fixed 30 s window, so decoding the turn so far costs about the
// same as one chunk (measured on this server: 21-29 s clips decode in 2.3-3.6 s,
// 3 s chunks in ~2 s) — and every word is decoded with its context.
//
// Flow per turn: VAD onset -> at most ONE preview decode in flight over
// everything captured so far, restarted as soon as it finishes (spaced by
// `chunkMs`) -> its text REPLACES the preview -> onPartial. Silence ends the
// turn -> one last full decode -> onUserText. Dictate recycles the buffer every
// 30 s (checkpoints). Barge-in: onSpeechStart fires on voice onset so the
// caller can stop TTS playback immediately.

import { claimLiveVoice, releaseLiveVoice } from './liveVoiceState';
import {
  STT_SAMPLE_RATE,
  concatFloat32,
  downsampleFloat32,
  encodeWavPcm16,
  isLikelySpeechEnvelope,
  mergeTranscripts,
  normalizePeak,
  normalizeTranscript,
  trimSilence,
} from './stt';
import { singleFlight } from './singleFlight';

export type LocalLiveState = 'idle' | 'connecting' | 'live' | 'speaking' | 'closed' | 'error';

/** Fire the full-clip decode this long after the last voiced frame: the turn is
 *  then PROBABLY over, so its server round-trip overlaps the remaining pause.
 *  If speech returns, the snapshot is dropped (invalidateStaleSnapshot) and a
 *  fresh one is taken at the next pause — a snapshot must never survive the
 *  speech that came after it, or the turn would deliver the pre-pause text. */
const SPECULATIVE_DECODE_MS = 300;

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
  /** Transcribe one complete WAV chunk. */
  transcribe: (blob: Blob, lang?: string) => Promise<string>;
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
  /** Minimum spacing between preview decodes while speaking. */
  chunkMs?: number;
}

// Turn-end tuning: the silence timeout must feel instant (user stops ->
// agent hears it ~1s later), while min-speech stays long enough to drop
// sub-word noise blips but short enough that quick Persian replies
// ("yes", "go on") are never swallowed. The level gate sits above
// typical ambient noise (fans, distant talk) so only close-mic voice
// starts a turn.

export const LOCAL_LIVE_DEFAULTS = {
  // Turn end must feel immediate, but not so eager it fires mid-thought.
  // The old 800 ms ended the turn on every thinking pause: Persian speech
  // routinely pauses 1 s+ between clauses («کاربرها بتونن از طریق API به» …
  // «مدل‌هایی که میخوان متصل بشن») and each pause shipped the half sentence
  // as its own message. 1200 ms still feels like a handoff (the speculative
  // decode below has been running since 350 ms into the pause, so the text
  // is usually already decoding) while real mid-sentence pauses stay inside
  // one turn.
  silenceMs: 1200,
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
  // Preview cadence: the minimum time between the START of two preview decodes.
  // Each preview decodes the whole turn so far, one at a time (see the header),
  // so in practice a new one starts as soon as the previous finishes; this only
  // stops a fast server from being hammered. The delivered text still comes
  // from the single-clip decode at turn end (see transcribeWholeTurn).
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
  preRollMs: 1500,
  /** Decode requests (previews, checkpoints) allowed in flight at once. Two,
   *  not three: the
   *  local CPU decode takes ~4 threads per call, so a third concurrent call
   *  oversubscribes the 8 cores and every request — including the remote
   *  ones sharing the client slots — lands slower. */
  maxInflight: 2,
  /** How long finishTurn waits for an in-flight preview before delivering what
   *  it has. A slow provider must delay a turn, never hang live voice forever. */
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
 * Open-turn hangover: whether an OPEN turn should STAY open on this frame.
 * Uses a LOWER bar than the onset gate (hysteresis) so Persian fricatives
 * (س، ش، ف) and soft word gaps — low-energy but still voiced — pre-roll the
 * turn across short pauses instead of closing mid-word and orphaning the
 * sentence tail. Noise floor tracking still dominates true silence, and the
 * 800 ms `silenceMs` timer is what actually ends the turn.
 */
export const SPEECH_HANGOVER_RATIO = 0.5;
export function isSpeechHangover(rms: number, threshold: number): boolean {
  return rms >= threshold * SPEECH_HANGOVER_RATIO;
}

/**
 * Per-frame decay of the open turn's own loudness reference (half-life ~2 s at
 * the 100 ms monitor cadence).
 */
export const TURN_LEVEL_DECAY = 0.97;
/**
 * Inside an open turn a frame only keeps the turn alive when it is at least
 * this fraction of the turn's OWN speech level.
 *
 * The user talks near the mic; people around the room are several times
 * quieter at it. A fixed hangover bar (half the onset gate) let that background
 * chatter hold a turn open for 30 s and every word of it was transcribed. The
 * bar now follows the user's own loudness, so quieter voices end the turn.
 */
export const TURN_LEVEL_HANGOVER_RATIO = 0.3;

/** Window used to measure the loudness of the buffered pre-roll. */
const PRE_ROLL_WINDOW_MS = 20;
/** Audio always kept before the turn start: the onset frames plus margin. */
const PRE_ROLL_MIN_KEEP_MS = 600;
/** A pre-roll window counts as the user's own voice from this fraction of the onset level. */
const PRE_ROLL_VOICE_FRACTION = 0.25;
/** A quiet stretch this long ends the user's lead-in (a pause, not a dip). */
const PRE_ROLL_GAP_MS = 240;
/** Extra audio kept ahead of the first voiced window (soft consonants). */
const PRE_ROLL_PAD_MS = 140;

/**
 * Where in the buffered pre-roll the user's lead-in starts.
 *
 * The VAD opens a turn only after the voice crossed the gate for a few frames,
 * so a soft first word («تو», «خب», a quiet /s/) is already behind the onset by
 * the time the turn starts. A long buffer finds it, but a long buffer also holds
 * whatever was said in the room before. This walks back from the onset while the
 * audio is still a fair fraction of the user's OWN onset loudness, and stops at a
 * real pause — the first word is kept, earlier background talk (quieter at the
 * mic) is not. Always keeps at least PRE_ROLL_MIN_KEEP_MS.
 *
 * Returns the sample index to cut at (0 = keep everything).
 */
export function selectPreRollStart(pcm: Float32Array, sampleRate: number): number {
  const win = Math.max(1, Math.round((sampleRate * PRE_ROLL_WINDOW_MS) / 1000));
  const n = Math.floor(pcm.length / win);
  const minKeep = Math.ceil(PRE_ROLL_MIN_KEEP_MS / PRE_ROLL_WINDOW_MS);
  if (n <= minKeep) return 0;
  const rms = new Array<number>(n);
  for (let w = 0; w < n; w++) {
    let sum = 0;
    for (let i = w * win; i < (w + 1) * win; i++) sum += pcm[i] * pcm[i];
    rms[w] = Math.sqrt(sum / win);
  }
  const onsetWins = Math.min(n, Math.ceil(300 / PRE_ROLL_WINDOW_MS));
  let level = 0;
  for (let w = n - onsetWins; w < n; w++) if (rms[w] > level) level = rms[w];
  if (level <= 0) return 0;
  const bar = level * PRE_ROLL_VOICE_FRACTION;
  const gapWins = Math.ceil(PRE_ROLL_GAP_MS / PRE_ROLL_WINDOW_MS);
  let lastVoiced = n - minKeep;
  let quiet = 0;
  for (let w = n - minKeep - 1; w >= 0; w--) {
    if (rms[w] >= bar) {
      lastVoiced = w;
      quiet = 0;
    } else if (++quiet >= gapWins) {
      break;
    }
  }
  const begin = Math.max(0, lastVoiced - Math.ceil(PRE_ROLL_PAD_MS / PRE_ROLL_WINDOW_MS));
  return begin * win;
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

/** How much of the loudest-RMS reference survives one quiet monitor frame.
 *
 * `peakRms` feeds the gate's safety cap (`NOISE_FLOOR_PEAK_CAP` sits at 0.3×
 * the peak), and the peak used to be a hold-forever maximum: ONE loud
 * transient — a click, a cough, a desk bump, a notification chime — pinned it
 * far above speech level, the cap then sat above everything the user said
 * after it, and the VAD stayed deaf for the rest of the session with no
 * chunk ever cut and no request ever sent ("sometimes it works, sometimes
 * not a single request leaves"). Real speech re-raises the peak on every
 * voiced frame, so a decay only ever forgets transients, never the level the
 * user actually talks at. 0.95 per 100 ms frame ≈ 1.4 s half-life: a bang
 * costs a couple of seconds of deafness at worst, not the whole session. */
export const PEAK_RMS_DECAY = 0.95;

/** One monitor step of the peak-RMS reference (see PEAK_RMS_DECAY). */
export function decayPeakRms(prev: number, rms: number): number {
  return Math.max(rms, prev * PEAK_RMS_DECAY);
}

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
/** How much real speech a clip must contain before it is worth a request. */
export const MIN_CHUNK_SPEECH_MS = 180;

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
 * Speaker bleed after echo cancellation sits well below speech on most macs,
 * but the floor still has to reject the burst-y residual peaks of a loud
 * speaker for the single frames the onset streak cannot catch. It is the
 * FLOOR now, not the gate itself: the adaptive term (see echoSafeThreshold)
 * anchors on the measured residual, which is what let a quiet mic barge in.
 */
export const TTS_ECHO_MIN_GATE = 0.011;

/**
 * Onset frames required while the agent speaks (bleed must not trip it).
 *
 * Four, not three: the residual speaker bleed is speech-SHAPED (it IS the
 * agent's voice), so its syllable peaks can cross a level gate for a frame or
 * two. Four sustained frames (~400 ms) is what a human barge-in produces and
 * what scattered bleed peaks never do — the valleys between the agent's own
 * syllables reset the streak before it accumulates.
 */
export const TTS_ONSET_FRAMES = 4;

/**
 * How much of the between-syllable bleed residual survives one playback frame.
 *
 * While the agent speaks, the session tracks the QUIETEST mic frame (the
 * residual the echo canceller leaves between the agent's syllables) and the
 * barge-in gate anchors on it. The release term lets the estimate creep back
 * up when the agent's audio gets louder overall, so one loud answer does not
 * pin a stale low floor forever.
 */
export const TTS_BLEED_RELEASE = 1.04;

/**
 * The barge-in gate sits at this multiple of the tracked bleed residual.
 *
 * This is the fix for "I have to wait for the agent to finish": the old gate
 * was a FIXED 0.025 RMS floor while the agent spoke, and on a quiet mic the
 * user's own voice never crossed it — barge-in simply never fired. The
 * residual the AEC leaves between the agent's syllables is far lower (and
 * device-dependent), so anchoring on it lets a quiet voice interrupt while
 * still sitting a clear factor above the bleed the canceller actually leaves.
 */
export const TTS_BLEED_GATE_MULT = 2.5;

/** Hard ceiling for the playback-time gate, so a poisoned bleed estimate can
 *  never deafen the mic completely. */
export const TTS_ECHO_GATE_MAX = 0.04;

/** Effective gate, raised while the agent's own audio is playing.
 *
 * `bleedFloor` is the between-syllable residual tracked during playback (0 =
 * unknown — nothing played yet, or the module-level callers that predate the
 * adaptive term). The gate then:
 *  - never drops below `threshold * TTS_ECHO_GATE_MULT` and the absolute
 *    TTS_ECHO_MIN_GATE floor (bleed bursts must not trip it),
 *  - anchors on the measured residual × TTS_BLEED_GATE_MULT when that is
 *    higher,
 *  - and is capped at TTS_ECHO_GATE_MAX so the mic stays reachable. */
export function echoSafeThreshold(
  threshold: number,
  ttsSpeaking: boolean,
  bleedFloor = 0,
): number {
  if (!ttsSpeaking) return threshold;
  const bleedTerm = bleedFloor > 0 ? bleedFloor * TTS_BLEED_GATE_MULT : 0;
  return Math.min(
    Math.max(threshold * TTS_ECHO_GATE_MULT, TTS_ECHO_MIN_GATE, bleedTerm),
    TTS_ECHO_GATE_MAX,
  );
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
  // Hesitation sounds ("ممم", "امم", "emmm") and sound-effect tags ("[موسیقی]")
  // are not words: whisper writes them down, the user never meant them.
  const spoken = collapseRepeatedPhrases(stripEllipsis(stripNonSpeech(text)));
  if (!spoken || isHallucinatedTranscript(spoken, lang)) return '';
  return normalizeTranscript(spoken);
}

/**
 * Whisper marks a cut-off sentence with a leading or trailing "..." / "…".
 * That is the engine's own punctuation, not something the user said, and it
 * showed up in the composer ("... کردم و نمایش بده").
 */
export function stripEllipsis(text: string): string {
  return text
    .replace(/^[\s.…]+(?=\S)/, '')
    .replace(/(?<=\S)[\s.…]{2,}$|(?<=\S)…+$/, '')
    .trim();
}

/**
 * Collapse a phrase of 2-5 words that is immediately repeated.
 *
 * Whisper, fed a short clip that is mostly noise, repeats itself («از اینها
 * بیشتر می‌شه، از اینها بیشتر می‌شه») — words nobody said twice. People repeat
 * single words on purpose, never a whole multi-word phrase back to back, so a
 * repeated phrase is kept once. Single-word repeats are left alone.
 */
export function collapseRepeatedPhrases(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 4) return text;
  const norm = (w: string) => w.replace(/[\s.,،؛;:!?؟…"'«»()\-–—]+/g, '').toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    for (let n = 5; n >= 2 && !collapsed; n--) {
      if (i + 2 * n > words.length) continue;
      let same = true;
      for (let k = 0; k < n; k++) {
        if (norm(words[i + k]) === '' || norm(words[i + k]) !== norm(words[i + n + k])) {
          same = false;
          break;
        }
      }
      if (same) {
        for (let k = 0; k < n; k++) out.push(words[i + n + k]);
        i += 2 * n;
        collapsed = true;
      }
    }
    if (!collapsed) out.push(words[i++]);
  }
  return out.join(' ');
}

/** Words whisper uses to label a sound that is not speech (lower-case). */
const NON_SPEECH_LABELS =
  'موسیقی|تشویق|خنده|سکوت|نویز|صدای|صدا|کلیک|تایپ|کیبورد|music|applause|laughter|laughs?|silence|noise|typing|keyboard|clicks?|clicking|inaudible|blank_audio|sound|breathing|coughing|cough|sigh|sighs';
const NON_SPEECH_TAG_RE = new RegExp(
  `[\\[(*♪]\\s*(?:${NON_SPEECH_LABELS})[^\\])*♪]*[\\])*♪]?`,
  'gi',
);

/** Hum / hesitation tokens, diacritics and punctuation already removed. */
const FILLER_TOKEN_RE = new RegExp(
  '^(?:' +
    // Persian: امم، ممم، هومم، اوم، اه، آآآ، ایی
    '[اآ]?م{2,}|ه?و{1,}م{2,}|او+م+|[اآ]ه+|[اآ]{2,}|[اآ]ی{2,}م*|هم{3,}|' +
    // Latin: um, uh, hm, mm, em, eh, er, ah, mhm
    'u+m+|u+h+|h+m+|m{2,}|e+m+|e+h+|e+r+|a+h+|mh+m+' +
    ')$',
  'i',
);

function fillerCore(token: string): string {
  return token
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[\s.,،؛;:!?؟…"'«»()[\]{}\-–—*_~]+/g, '');
}

/** Frame used to measure how long a sound lasts. */
const VOICED_FRAME_MS = 10;
/** A sound must stay up this long to count as a syllable, not a click. */
const VOICED_RUN_MIN_MS = 60;
/** A turn needs at least this much syllable-length sound to be worth decoding. */
export const MIN_VOICED_RUN_MS = 120;

/**
 * Total duration of the sustained (>= 60 ms) loud stretches in `pcm`.
 *
 * A keystroke is a 5-30 ms transient: loud, but it never stays up the length of
 * a syllable, so a burst of typing totals ~0 here while even a one-word answer
 * ("نه") holds well over 100 ms. "Loud" is relative to the clip's own peak, so
 * it does not depend on the microphone gain.
 */
export function voicedRunMs(pcm: Float32Array, sampleRate: number): number {
  const win = Math.max(1, Math.floor((sampleRate * VOICED_FRAME_MS) / 1000));
  const frames = Math.floor(pcm.length / win);
  if (frames === 0) return 0;
  const rms = new Array<number>(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * win; i < (f + 1) * win; i++) sum += pcm[i] * pcm[i];
    rms[f] = Math.sqrt(sum / win);
    if (rms[f] > peak) peak = rms[f];
  }
  if (peak <= 0) return 0;
  const gate = peak * 0.1;
  const minRun = Math.ceil(VOICED_RUN_MIN_MS / VOICED_FRAME_MS);
  let total = 0;
  let run = 0;
  for (let f = 0; f <= frames; f++) {
    if (f < frames && rms[f] >= gate) {
      run++;
    } else {
      if (run >= minRun) total += run;
      run = 0;
    }
  }
  return total * VOICED_FRAME_MS;
}

/** Voiced audio shorter than this is never judged by its word rate. */
export const SPARSE_MIN_VOICED_MS = 2500;
/** Fewer words per second of voiced audio than this is not speech. */
export const SPARSE_MAX_WORDS_PER_SEC = 0.4;

/**
 * True when a transcript is far too short for the sound that produced it.
 *
 * A held, wavering hum («ممممم» while thinking) has a speech-like envelope, so
 * the audio gates let it through, and whisper then writes a plausible word for
 * it («میدونم.» for 16 s of humming — measured in the server log). Real speech
 * runs at 2-3 words per second of VOICED audio; a long stretch of sound that
 * yields a word or two is not words.
 */
export function isSparseTranscript(text: string, voicedMs: number): boolean {
  if (voicedMs < SPARSE_MIN_VOICED_MS) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  return words / (voicedMs / 1000) < SPARSE_MAX_WORDS_PER_SEC;
}

/** Drop sound-effect tags and hesitation tokens; keep every real word. */
export function stripNonSpeech(text: string): string {
  const noTags = text.replace(NON_SPEECH_TAG_RE, ' ');
  const kept = noTags
    .split(/\s+/)
    .filter((tok) => tok !== '' && !FILLER_TOKEN_RE.test(fillerCore(tok)) && fillerCore(tok) !== '');
  return kept.join(' ').trim();
}

/**
 * The words spoken AFTER a mid-dictation edit, given the engine's cumulative
 * turn transcript and the last engine text reflected into the composer.
 *
 * While the user corrects the transcript, the engine must not retype the
 * composer over their edit — but the words they speak AFTER the edit still
 * have to land. Partials are cumulative over the whole turn: each preview
 * re-decodes everything said so far, so when it only EXTENDS the last reflected
 * text the new words are exactly the suffix, and a prefix check is exact.
 *
 * Returns '' when nothing new was spoken, and also when the preview re-worded
 * earlier words (the model heard them differently with more context, so the
 * text is no longer an extension): appending it would duplicate words, and the
 * next preview that extends the reflected text lands its new words again.
 */
export function liveEditDelta(base: string, text: string): string {
  const t = (text ?? '').trim();
  const b = (base ?? '').trim();
  if (!t) return '';
  if (!b) return t;
  if (t === b) return '';
  return t.startsWith(b) ? t.slice(b.length).trim() : '';
}

/** True when a transcript looks like a Whisper noise hallucination. */export function isHallucinatedTranscript(text: string, lang?: string): boolean {
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
  /** Voiced milliseconds of each encoded clip, for isSparseTranscript. */
  private readonly blobSpeechMs = new WeakMap<Blob, number>();
  /** Decaying peak of the speech level inside the open turn (see
   *  TURN_LEVEL_HANGOVER_RATIO). 0 outside a turn. */
  private turnLevel = 0;
  /** Rolling ambient noise estimate, so the gate adapts to the room. */
  private noiseFloor = 0;
  /** Frames spent sampling the room right after capture starts. */
  private noiseCalibFrames = 0;
  /** Reports a mic that yields frames but only ever delivers silence. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the agent's TTS audio is playing through the speakers. */
  private ttsSpeaking = false;
  /** Quietest mic frame observed during the current playback: the residual the
   *  echo canceller leaves between the agent's syllables. Anchors the barge-in
   *  gate (see echoSafeThreshold); re-armed on every playback start/stop. */
  private ttsBleedFloor = 0;
  /** Retry timer for a turn whose delivery was deferred by a drain. */
  private finishTimer: ReturnType<typeof setTimeout> | null = null;

  private speechStartAt = 0;
  private lastSpeechAt = 0;
  /** When the last preview decode started (a turn start counts), so decodes
   *  are spaced by `chunkMs`. */
  private previewStartedAt = 0;
  private hasSpeech = false;
  /** True while a turn is being finalized. */
  private transcribing = false;
  /** Dictate mode: a pause never ends the turn (see LocalLiveOptions.dictate). */
  private dictate = false;
  /** The turn being captured: its token plus its latest preview transcript. Held as an
   *  OBJECT, not a shared string, so a turn that is still draining keeps its own
   *  text after beginTurn has already started the next one. A shared string was
   *  cleared by the next turn, and finishTurn then returned early on the token
   *  mismatch — silently dropping a whole utterance the user had spoken.
   *  `delivered` freezes the turn once its text went out: preview replies that
   *  land AFTER the delivery belong to audio the final decode already covered,
   *  and applying them again would fire onPartial with a resurrected preview —
   *  which the chat mirror renders as a SECOND user message («the last words
   *  are written twice, I said them once»). */
  private turn: { token: number; text: string; delivered: boolean } = {
    token: 0,
    text: '',
    delivered: false,
  };
  /** Increments per turn so a late preview result can never land in the next. */
  private turnToken = 0;
  /** Every sample of the turn in progress, kept so the finished utterance can
   *  be decoded ONCE at turn end — the way dictation does it. */
  private turnAudio: Float32Array[] = [];
  private turnAudioLen = 0;
  /** True once the turn outgrew one ASR window: its audio is incomplete, so the
   *  single-clip decode must not be used (it would drop the last words). */
  private turnAudioTruncated = false;
  /** Speculative full-clip decode started ~350 ms into a pause, so its
   *  server round-trip overlaps the rest of the silence gap. Consumed at
   *  finishTurn (same turn token only); a snapshot, so the buffer it read is
   *  NOT consumed and the 350→800 ms tail still reaches the chunk previews. */
  private specWholeP: Promise<string> | null = null;
  private specToken = -1;

  /**
   * Drop the speculative snapshot of the turn in progress.
   *
   * The snapshot decodes the turn buffer AS IT WAS at ~350 ms into a pause.
   * When the user resumes speaking inside the same turn, everything after
   * that pause is missing from it — and `finishTurn` reused it whenever the
   * token still matched, delivering the pre-pause fragment as the WHOLE
   * utterance (the message went out cut exactly at the first thinking pause).
   * The monitor calls this on the first voiced frame after the pause, so the
   * next pause re-snapshots with the resumed words and the turn end always
   * decodes audio that covers the entire utterance.
   */
  private invalidateStaleSnapshot(): void {
    if (this.specWholeP === null) return;
    this.specWholeP = null;
    this.specToken = -1;
  }
  /** DICTATE: transcripts of earlier full windows for utterances longer than
   *  one ASR window (see fireCheckpoint). Prependied to the final decode. */
  private dictateWholePrefix = '';
  /** SERIALises the checkpoint decodes and lets the final whole-clip decode
   *  wait for every pending checkpoint before reading the prefix. */
  private checkpointP: Promise<void> | null = null;
  /** At most ONE preview decode runs at a time: a newer decode always covers
   *  more audio, so queueing older ones only delays the text on screen. */
  private readonly preview = singleFlight();
  /** Decode requests actually running right now (bounded by maxInflight). */
  private activeRequests = 0;
  /** Resolvers for requests waiting for a free slot. */
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
    // Release only a lease THIS session holds: a session refused at connect()
    // (another chat owns the mic) never claimed one, and releasing "its" null
    // lease here cleared the REFUSED-to holder's lease out from under it.
    if (this.leaseChatId !== null) releaseLiveVoice(this.leaseChatId);
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
    // A new playback has a new residual: re-arm the bleed estimate either way,
    // so a floor tracked against the PREVIOUS clip never anchors this one.
    this.ttsBleedFloor = 0;
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
    // Pre-roll only: during a turn the audio lives in turnAudio below, so this
    // buffer cannot grow for the length of a long dictation.
    if (!this.hasSpeech) this.pcmFrames.push(frame);
    if (this.hasSpeech) {
      // Keep the whole utterance so the turn can be decoded as one clip, like
      // dictation. Capped at the ASR's single-window length: past that the
      // model starts summarizing, so live voice keeps its last preview and
      // there is no point buffering more.
      const cap = Math.floor((this.captureRate * LOCAL_LIVE_DEFAULTS.wholeTurnMaxMs) / 1000);
      if (this.turnAudioLen < cap) {
        this.turnAudio.push(frame);
        this.turnAudioLen += frame.length;
        if (this.turnAudioLen > cap) {
          // DICTATE: at the window boundary decode the buffered window as a
          // CHECKPOINT and let the buffer restart empty — a long dictation is
          // then fully covered (each 30 s window decoded in order) instead of
          // silently degrading to the last preview past 30 s.
          if (this.dictate) this.fireCheckpoint();
          else this.turnAudioTruncated = true;
        }
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
    this.specWholeP = null;
    this.specToken = -1;
    this.dictateWholePrefix = '';
    this.checkpointP = null;
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
   * Decode the ENTIRE turn as one clip, exactly like dictation does.
   *
   * At turn end the finished utterance is decoded in one request and THAT
   * text is delivered: unlike the last preview it covers the tail audio that
   * arrived after the preview started. The last preview stays only as a
   * fallback for a turn too long for a single window, or for a failed request.
   */
  private async transcribeWholeTurn(): Promise<string> {
    // A turn that outgrew the ASR window cannot be decoded in one request, and
    // the buffered audio would be missing its tail — take nothing and let the
    // last preview stand. (DICTATE never truncates: fireCheckpoint recycles
    // the window, so only live voice lands here.)
    if (this.turnAudioTruncated) {
      this.takeTurnAudio();
      return '';
    }
    // Checkpoints of earlier windows decode out of band; their text is part of
    // the delivery, so wait for them before reading the prefix.
    if (this.checkpointP) {
      try {
        await this.checkpointP;
      } catch {
        // The checkpoint chain never rejects; keep going with what landed.
      }
    }
    const samples = this.takeTurnAudio();
    if (samples.length === 0) return '';
    const wav = this.encodeSamples(samples);
    if (!wav) return '';
    const lang = this.options.lang ?? 'fa';
    const raw = await this.requestChunk(wav, lang, true);
    // Same cleanup as a preview: an error page must never be delivered as the
    // user's words.
    const clean = this.cleanFor(wav, raw, lang);
    // Prepend the earlier windows' checkpoint text: the final window decode
    // never saw that audio.
    const base = this.dictateWholePrefix.trim();
    return base && clean ? `${base} ${clean}` : base || clean;
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
  private encodeSamples(samples: Float32Array): Blob | null {
    const resampled = downsampleFloat32(samples, this.captureRate, STT_SAMPLE_RATE);
    const trimmed = trimSilence(resampled, STT_SAMPLE_RATE);
    if (trimmed.speechMs < MIN_CHUNK_SPEECH_MS) return null;
    // A held hum ("mmmm"), a fan or a steady tone is loud enough to open a turn
    // but its energy envelope is flat; speech is syllabic. Keyboard clicks are
    // too short to reach MIN_CHUNK_SPEECH_MS above.
    if (!isLikelySpeechEnvelope(trimmed.pcm, STT_SAMPLE_RATE)) return null;
    // Keystrokes: loud but never as long as a syllable.
    if (voicedRunMs(trimmed.pcm, STT_SAMPLE_RATE) < MIN_VOICED_RUN_MS) return null;
    const wav = encodeWavPcm16(normalizePeak(trimmed.pcm), STT_SAMPLE_RATE);
    if (wav.size <= 44) return null;
    this.blobSpeechMs.set(wav, trimmed.speechMs);
    return wav;
  }

  /** sanitizeLocalTranscript plus the hum guard: a clip with lots of sound and
   *  almost no words is dropped (see isSparseTranscript). */
  private cleanFor(wav: Blob, raw: string, lang: string): string {
    const clean = sanitizeLocalTranscript(raw, lang).trim();
    if (clean && isSparseTranscript(clean, this.blobSpeechMs.get(wav) ?? 0)) return '';
    return clean;
  }

  /**
   * DICTATE: decode one full window and accumulate it into `dictateWholePrefix`.
   * Fired the moment the turn buffer reaches the ASR window cap, from the
   * capture callback; runs detached and serialized through `checkpointP` so the
   * final decode (transcribeWholeTurn) can await every pending checkpoint.
   */
  private fireCheckpoint(): void {
    const samples = this.takeTurnAudio();
    if (samples.length === 0) return;
    const lang = this.options.lang ?? 'fa';
    const run = async (): Promise<void> => {
      try {
        if (this.stopped) return;
        const wav = this.encodeSamples(samples);
        if (!wav) return;
        const raw = await this.requestChunk(wav, lang);
        const clean = this.cleanFor(wav, raw, lang);
        if (clean && !isHallucinatedTranscript(clean, lang)) {
          this.dictateWholePrefix = mergeTranscripts(this.dictateWholePrefix, clean, { headSilent: true });
        }
      } catch {
        // A failed checkpoint drops that window from the final text;
        // it must never break capture.
      }
    };
    this.checkpointP = (this.checkpointP ?? Promise.resolve()).then(run, run);
  }

  /**
   * NON-DESTRUCTIVE full-clip decode of the current turn buffer: the
   * speculative decode at a pause (skipSlot) and every preview (takes a slot,
   * so it never starves the turn-end decode). Same cleanup as
   * transcribeWholeTurn; never consumes `turnAudio`, so speech that returns
   * after the fire keeps buffering normally.
   */
  private async transcribeSnapshot(skipSlot = true): Promise<string> {
    if (this.turnAudioTruncated || this.turnAudioLen === 0) return '';
    const samples = concatFloat32(this.turnAudio);
    const wav = this.encodeSamples(samples);
    if (!wav) return '';
    const lang = this.options.lang ?? 'fa';
    const raw = await this.requestChunk(wav, lang, skipSlot);
    return this.cleanFor(wav, raw, lang);
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
    const maxTurnMs = this.options.maxChunkMs ?? LOCAL_LIVE_DEFAULTS.maxChunkMs;
    const previewMs = this.options.chunkMs ?? LOCAL_LIVE_DEFAULTS.chunkMs;
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
      // Decay-hold, not hold-forever: see PEAK_RMS_DECAY.
      this.peakRms = decayPeakRms(this.peakRms, rms);
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
      // While the agent speaks, track the between-syllable residual: the
      // quietest frame is what the echo canceller actually leaves, and the
      // barge-in gate anchors on it (see echoSafeThreshold) — a FIXED gate
      // was what made barge-in impossible on quiet mics.
      if (this.ttsSpeaking) {
        this.ttsBleedFloor =
          this.ttsBleedFloor <= 0
            ? rms
            : Math.min(this.ttsBleedFloor * TTS_BLEED_RELEASE, rms);
      }
      const adaptive = echoSafeThreshold(
        speechThreshold(this.noiseFloor, threshold, this.peakRms),
        this.ttsSpeaking,
        this.ttsBleedFloor,
      );
      const now = Date.now();
      // Hysteresis: once a turn is OPEN the frame bar drops to 0.5x, so
      // fricatives and word gaps keep the turn alive — see isSpeechHangover.
      const speech =
        this.hasSpeech && !this.dictate
          ? isSpeechHangover(rms, adaptive) && rms >= this.turnLevel * TURN_LEVEL_HANGOVER_RATIO
          : isSpeechLevel(rms, adaptive);
      if (this.hasSpeech && !this.dictate) {
        this.turnLevel = speech ? Math.max(this.turnLevel * TURN_LEVEL_DECAY, rms) : this.turnLevel * TURN_LEVEL_DECAY;
      }
      if (!speech) {
        // While the agent speaks, a quiet user's syllables dip under the raised
        // gate between loud frames: a hard reset made consecutive loud frames
        // nearly impossible ("it never hears me while it talks"). Decay the
        // streak instead, so loud-loud-quiet-loud-loud still opens the turn,
        // while speaker bleed (loud, quiet, loud, quiet) never accumulates.
        speechStreak = this.ttsSpeaking && !this.hasSpeech ? Math.max(0, speechStreak - 1) : 0;
        if (!this.hasSpeech) return;
        // Dictate: a pause keeps dictating — only an explicit stop closes the
        // turn. Previews keep refreshing through the pause so the composer
        // text stays current; the final decode runs on stop.
        if (this.dictate) {
          this.tickPreview(now, previewMs, maxTurnMs);
          return;
        }
        if (shouldEndTurn(now - this.lastSpeechAt, silenceMs)) {
          void this.finishTurn();
          return;
        }
        // Speculative decode: ~350 ms into a pause the turn is PROBABLY over —
        // fire the full-clip request now so its round-trip overlaps the rest of
        // the silence gap and finishTurn finds the text already arriving. The
        // snapshot is non-destructive: if speech returns the turn keeps
        // buffering, the stale result is discarded (fuller-wins at delivery),
        // and the tail audio still reaches the next preview.
        if (
          this.specWholeP === null &&
          !this.transcribing &&
          now - this.lastSpeechAt >= SPECULATIVE_DECODE_MS
        ) {
          this.specToken = this.turnToken;
          this.specWholeP = this.transcribeSnapshot();
        }
        // A short pause keeps the turn open: keep refreshing the preview so
        // the tail is already on screen by the time the user really stops.
        this.tickPreview(now, previewMs, maxTurnMs);
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
      // The user resumed speaking inside the open turn: any speculative
      // snapshot taken at the pause we just left is missing every word from
      // here on. Drop it (see invalidateStaleSnapshot) or finishTurn would
      // deliver the pre-pause fragment as the whole utterance.
      this.invalidateStaleSnapshot();
      this.tickPreview(now, previewMs, maxTurnMs);
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
   * Refresh the preview while a turn is open, and close very long utterances
   * so a single turn cannot grow without bound.
   *
   * A decode starts only when there is speech newer than the previous one:
   * re-decoding identical audio through a pause would cost a request for the
   * same text.
   */
  private tickPreview(now: number, previewMs: number, maxTurnMs: number): void {
    if (now - this.previewStartedAt >= previewMs && this.lastSpeechAt > this.previewStartedAt) {
      this.startPreview(now);
    }
    if (this.dictate) return; // long utterances are fine: the user stops manually
    if (now - this.speechStartAt >= maxTurnMs) void this.finishTurn();
  }

  /**
   * Start one preview decode of the whole turn so far, unless the previous one
   * is still running (the monitor retries on its next frame, so a new decode
   * starts the moment the old one lands).
   */
  private startPreview(now: number): void {
    if (this.preview.current()) return;
    this.previewStartedAt = now;
    const owner = this.turn;
    void this.preview.run(async () => {
      const text = await this.previewText();
      // A turn that already delivered (or was finalized empty) has moved on:
      // applying this late reply would fire onPartial with a preview of audio
      // the final decode already covered — after delivery the mirror creates a
      // FRESH user bubble for it, and the user sees their last words twice as a
      // second "message" that was never sent. Drop it.
      if (this.stopped || owner.delivered || !text) return;
      // REPLACE, never merge: this decode saw the whole turn with its context,
      // so it supersedes every earlier preview — including words it re-heard.
      owner.text = text;
      // Only the visible partial is gated on the token, so the composer never
      // shows the previous turn's words.
      if (owner.token !== this.turnToken) return;
      try {
        this.options.onPartial?.(owner.text);
      } catch {
        // Listener errors must not break capture.
      }
    });
  }

  /** The turn so far as one decoded text (DICTATE: after the earlier windows). */
  private async previewText(): Promise<string> {
    // Checkpoints of earlier 30 s windows decode out of band and own the text
    // before the current window: wait so the preview never drops them.
    if (this.checkpointP) {
      try {
        await this.checkpointP;
      } catch {
        // The checkpoint chain never rejects; keep going with what landed.
      }
    }
    const base = this.dictateWholePrefix.trim();
    const clean = await this.transcribeSnapshot(false);
    return base && clean ? `${base} ${clean}` : base || clean;
  }

  /** VAD confirmed voice: reset the turn and keep only the pre-roll. */
  private beginTurn(now: number): void {
    this.hasSpeech = true;
    this.turnToken++;
    // A fresh owner object per turn. The previous turn's text is NOT cleared:
    // it may still be draining towards delivery, and its holder is what
    // finishTurn() reads.
    this.turn = { token: this.turnToken, text: '', delivered: false };
    // A new turn invalidates any speculative decode of the previous one: drop
    // it (the request may still be in flight — its result is simply discarded).
    this.specWholeP = null;
    this.specToken = -1;
    this.dictateWholePrefix = '';
    this.speechStartAt = now;
    this.lastSpeechAt = now;
    this.previewStartedAt = now;
    this.turnLevel = 0;
    // Barge-in: everything buffered before the onset is the agent's own voice
    // bleeding through the speakers — keeping it would transcribe the agent's
    // words INTO the user's interrupting message. The onset streak has already
    // consumed part of the user's first syllable either way; a clean transcript
    // beats a complete clip here.
    if (this.ttsSpeaking) {
      // Keep just the onset itself (the frames that tripped the gate): the
      // user's first syllables are in it, the agent's earlier words are not.
      this.trimToMs(TTS_ONSET_FRAMES * LOCAL_LIVE_DEFAULTS.frameMs + 200);
      this.turnAudio = this.pcmFrames.slice();
      this.turnAudioLen = 0;
      for (const f of this.turnAudio) this.turnAudioLen += f.length;
    } else {
      this.trimToMs(LOCAL_LIVE_DEFAULTS.preRollMs);
      // Keep only the user's own lead-in (see selectPreRollStart): a soft first
      // word survives, earlier room talk does not.
      if (this.pcmFrames.length > 0) {
        const all = concatFloat32(this.pcmFrames);
        const from = selectPreRollStart(all, this.captureRate);
        if (from > 0) this.pcmFrames = [all.slice(from)];
      }
      // Seed the full-turn buffer with the pre-roll, so the first syllable is
      // part of every decode of the turn.
      this.turnAudio = this.pcmFrames.slice();
      this.turnAudioLen = 0;
      for (const f of this.turnAudio) this.turnAudioLen += f.length;
    }
    this.turnAudioTruncated = false;
    try {
      this.options.onSpeechStart?.();
    } catch {
      // Listener errors must not break capture.
    }
  }

  /** Run one decode request once a slot is free. Failures yield '' — the
   *  turn text decides between whole-clip and preview; never throws. */
  private async requestChunk(
    wav: Blob,
    lang: string,
    skipSlot = false,
  ): Promise<string> {
    // The full-clip decode is the request that produces the delivered text, so
    // it never waits behind a preview: with every slot taken by slow preview
    // requests it would time out and the turn would fall back to the
    // possibly older preview.
    if (!skipSlot) await this.acquireSlot();
    try {
      // A chunk of a turn that is still draining must still be transcribed:
      // its text is what finishTurn() is about to deliver. Only a stopped
      // session needs no round-trip at all.
      if (this.stopped) return '';
      return await this.options.transcribe(wav, lang);
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
   * Wait for the preview decode in flight, but never longer than `timeoutMs`.
   *
   * A slow or hanging provider must only DELAY a turn: without this cap a stuck
   * request could freeze live voice for as long as the fetch timeout allowed.
   */
  private async waitForPreview(timeoutMs: number): Promise<void> {
    const inflight = this.preview.current();
    if (!inflight) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([inflight, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** End the turn: decode it once more as a whole, deliver the transcript. */
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
      // Fire the single-clip decode FIRST so it runs in parallel with any
      // preview still in flight: the turn then costs no extra latency compared
      // with delivering the preview, and its text covers the whole utterance.
      // Read BEFORE the call: transcribeWholeTurn consumes the turn buffer.
      const wholeUsable = !this.turnAudioTruncated && this.turnAudioLen > 0;
      // Reuse the speculative decode fired ~350 ms into the pause when it is
      // still valid: same turn AND no speech after it (the monitor invalidates
      // the snapshot on the first resumed frame, so a surviving snapshot always
      // covers the whole utterance). Its round-trip already started, so the
      // turn lands without paying upload+encode again. Otherwise decode the
      // buffered clip now — the destructive path that also consumes the tail.
      let wholeP: Promise<string>;
      if (this.specWholeP && this.specToken === token) {
        wholeP = this.specWholeP;
      } else {
        wholeP = this.transcribeWholeTurn();
      }
      this.specWholeP = null;
      this.specToken = -1;
      // Hard cap on every wait below: a slow provider must only delay the turn,
      // never hang live voice. Whatever arrived by then is delivered as the
      // turn. The cap is the budget REMAINING after the work already done
      // above, so the whole delivery stays inside one bound.
      const budgetLeft = () =>
        Math.max(0, LOCAL_LIVE_DEFAULTS.turnDeliverBudgetMs - (Date.now() - startedAt));
      let whole = '';
      let wholeTimer: ReturnType<typeof setTimeout> | undefined;
      if (wholeUsable) {
        // The full-clip decode is what gets delivered, so wait for IT first:
        // waiting for the preview in flight first delayed the turn whenever the
        // provider was slow.
        whole = await Promise.race([
          wholeP,
          new Promise<string>((resolve) => {
            wholeTimer = setTimeout(() => resolve(''), budgetLeft());
          }),
        ]);
        if (wholeTimer) clearTimeout(wholeTimer);
      }
      // Let the preview in flight land only when it can still matter: no usable
      // full decode (too long / failed / empty) — then the last preview IS the
      // text.
      if (!whole.trim()) {
        await this.waitForPreview(
          Math.min(LOCAL_LIVE_DEFAULTS.drainTimeoutMs, budgetLeft()),
        );
      }
      // Read from the turn we started with, NOT the shared current one. If the
      // user began speaking again during the drain a new turn already owns the
      // session, and gating delivery on the token here discarded the utterance
      // the user had just finished ("I speak and nothing is typed").
      // Prefer the full-clip decode; fall back to the preview when it failed,
      // timed out, or the utterance was too long for one window. The wait is
      // capped so a slow provider can never hang the turn.
      if (!wholeUsable) {
        whole = await Promise.race([
          wholeP,
          new Promise<string>((resolve) => {
            wholeTimer = setTimeout(() => resolve(''), budgetLeft());
          }),
        ]);
        if (wholeTimer) clearTimeout(wholeTimer);
      }
      // A SUCCESSFUL single-clip decode ALWAYS wins. It is the only text decoded
      // from the whole utterance, so it sees the words in context the way the
      // model was trained (30 s windows).
      //
      // This used to be "fuller wins" by word count, and that rule shipped the
      // exact opposite of its intent: a 1.6 s chunk is far below Whisper's
      // training window, so every chunk pads its edges with a plausible word
      // that was NEVER SPOKEN ("یک کتاب" cut mid-word -> "یکیتی", then "یکی"),
      // and the merged preview was therefore always LONGER than the clean
      // decode. Measured on three Persian clips: truth 7/11/15 words, clean
      // whole-clip decode 7/11/15, merged preview 12/16/29 — the invented half
      // was delivered every time. The old comment's worry (a long turn whose
      // whole decode covers only the tail) is handled where it belongs: past
      // `wholeTurnMaxMs` the buffer is truncated, `wholeUsable` is false, and
      // the preview is used on its own below — never blended by word count.
      const wholeText = whole.trim();
      const previewText = turn.text.trim();
      const text = wholeText || previewText;
      // The turn is finalized as of HERE — delivered, filtered-empty or not.
      // Every preview reply that resolves after this line describes audio the
      // delivered decode already covered; applying it would only resurrect the
      // preview after the fact (the duplicate-message bug this flag closes).
      turn.delivered = true;
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
