// Offline live voice loop: chunked mic capture with energy VAD,
// local STT via caller-provided transcribe(), no OpenAI realtime.
// Flow per turn: detect speech -> record -> silence -> transcribe ->
// onUserText -> (caller sends to chat + speaks answer via local TTS).
// Barge-in: onSpeechStart fires when the user starts talking, so the
// caller can stop TTS playback immediately.

export type LocalLiveState = 'idle' | 'connecting' | 'live' | 'speaking' | 'closed' | 'error';

export interface LocalLiveOptions {
  deviceId?: string;
  lang?: string;
  transcribe: (blob: Blob, lang?: string) => Promise<string>;
  onUserText: (text: string) => void | Promise<void>;
  onSpeechStart?: () => void;
  onStateChange?: (s: LocalLiveState) => void;
  onError?: (err: unknown) => void;
  silenceMs?: number;
  minSpeechMs?: number;
  maxChunkMs?: number;
  levelThreshold?: number;
}

// Turn-end tuning: the silence timeout must feel instant (user stops ->
// agent hears it ~1s later), while min-speech stays long enough to drop
// sub-word noise blips but short enough that quick Persian replies
// ("yes", "go on") are never swallowed. The level gate sits above
// typical ambient noise (fans, distant talk) so only close-mic voice
// starts a turn.
export const LOCAL_LIVE_DEFAULTS = {
  silenceMs: 1300,
  minSpeechMs: 500,
  maxChunkMs: 30000,
  levelThreshold: 0.015,
  frameMs: 100,
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

// Speech onset needs several consecutive loud frames (~300 ms at the
// 100 ms monitor cadence): a single loud frame is a click, cough or door
// slam, not voice. Gating onset on sustained energy keeps transient noise
// from starting turns (and becoming ghost text) while barely delaying
// real barge-in.
export const LIVE_SPEECH_ONSET_FRAMES = 3;

/** True once speech has persisted long enough to count as voice onset. */
export function isSustainedSpeech(streak: number, required: number = LIVE_SPEECH_ONSET_FRAMES): boolean {
  return streak >= required;
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

/** Clean a transcript: trim, drop junk entirely, otherwise return trimmed text. */
export function sanitizeLocalTranscript(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  if (isLocalTranscriptJunk(text)) return '';
  return text;
}

/** True when a transcript looks like a Whisper noise hallucination. */
export function isHallucinatedTranscript(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  if (t.length <= 1) return true;
  const words = t.split(/\s+/);
  if (words.length >= 4 && new Set(words).size === 1) return true;
  let repeat = 1;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) {
      repeat++;
      if (repeat >= 4) return true;
    } else {
      repeat = 1;
    }
  }
  return false;
}

export class LocalLiveSession {
  private options: LocalLiveOptions;
  private state: LocalLiveState = 'idle';
  private stopped = false;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private speechStartAt = 0;
  private lastSpeechAt = 0;
  private recording = false;
  private transcribing = false;
  private hasSpeech = false;
  private deviceId?: string;

  constructor(options: LocalLiveOptions) {
    this.options = options;
    this.deviceId = options.deviceId;
  }

  get currentState(): LocalLiveState {
    return this.state;
  }

  private setState(s: LocalLiveState): void {
    this.state = s;
    try {
      this.options.onStateChange?.(s);
    } catch {
      // Listener must never break the loop.
    }
  }

  async connect(): Promise<void> {
    if (this.stopped) this.stopped = false;
    if (this.state === 'connecting' || this.state === 'live') return;
    this.setState('connecting');
    try {
      await this.openMic();
      this.setState('live');
      this.startMonitor();
      // Start capturing immediately (like dictate mode) so a miscalibrated
      // VAD threshold can never leave the user talking into a dead mic.
      // Turn end is still VAD-driven; pure silence is discarded, never sent.
      this.startRecorder();
      this.speechStartAt = Date.now();
      this.lastSpeechAt = Date.now();
      this.hasSpeech = false;
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

  disconnect(): void {
    this.stopped = true;
    this.stopMonitor();
    this.stopRecorder();
    this.closeMic();
    this.setState('closed');
  }

  async setMicrophoneDeviceId(deviceId: string): Promise<void> {
    this.deviceId = deviceId || undefined;
    if (this.state !== 'live' && this.state !== 'speaking') return;
    // Reopen the mic on the new device without dropping the session state.
    this.stopMonitor();
    this.stopRecorder();
    this.closeMic();
    await this.openMic();
    this.startMonitor();
  }

  /** Called by the owner when TTS playback starts/ends to reflect speaking. */
  notifySpeaking(speaking: boolean): void {
    if (this.stopped) return;
    if (speaking) {
      if (this.state === 'live') this.setState('speaking');
    } else {
      if (this.state === 'speaking') this.setState('live');
    }
  }

  private async openMic(): Promise<void> {
    // Same constraints as dictate mode: plain audio:true works everywhere.
    // An exact deviceId can go stale (OverconstrainedError) while plain
    // audio:true still works, so fall back to it.
    if (!this.deviceId) {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } else {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: this.deviceId } },
        });
      } catch (err) {
        const name = err instanceof DOMException ? err.name : (err as { name?: unknown }).name;
        const constraint = (err as { constraint?: unknown }).constraint;
        const isOverconstrained =
          name === 'OverconstrainedError' || name === 'OverconstrainedConstraint' || constraint === 'deviceId';
        if (!isOverconstrained) throw err;
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is not supported in this browser');
    this.audioCtx = new Ctx();
    if (this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
      } catch {
        // Resume is best-effort; monitoring still works when running.
      }
    }
    this.source = this.audioCtx.createMediaStreamSource(this.micStream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);
  }

  private closeMic(): void {
    try {
      this.source?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.source = null;
    this.analyser = null;
    if (this.audioCtx) {
      try {
        void this.audioCtx.close();
      } catch {
        // Close is best-effort.
      }
      this.audioCtx = null;
    }
    if (this.micStream) {
      try {
        this.micStream.getTracks().forEach((t) => t.stop());
      } catch {
        // Tracks already stopped.
      }
      this.micStream = null;
    }
  }

  private startMonitor(): void {
    this.stopMonitor();
    const threshold = this.options.levelThreshold ?? LOCAL_LIVE_DEFAULTS.levelThreshold;
    const silenceMs = this.options.silenceMs ?? LOCAL_LIVE_DEFAULTS.silenceMs;
    const minSpeechMs = this.options.minSpeechMs ?? LOCAL_LIVE_DEFAULTS.minSpeechMs;
    const maxChunkMs = this.options.maxChunkMs ?? LOCAL_LIVE_DEFAULTS.maxChunkMs;
    const frameMs = LOCAL_LIVE_DEFAULTS.frameMs;
    const buf = new Float32Array(new ArrayBuffer(2048 * 4));
    let speechStreak = 0;
    this.monitorTimer = setInterval(() => {
      if (this.stopped) return;
      if (!this.analyser) return;
      // Never block monitoring on transcription: speech during STT or the
      // agent turn must still start the next recorder, otherwise words
      // spoken while the agent answers are lost. finishTurn guards itself
      // against overlap via transcribing.
      try {
        this.analyser.getFloatTimeDomainData(buf as unknown as Float32Array<ArrayBuffer>);
      } catch {
        return;
      }
      const rms = computeRms(buf);
      const now = Date.now();
      const speech = isSpeechLevel(rms, threshold);
      if (speech) {
        speechStreak++;
        if (speechStreak === 1) {
          // Possible onset: restart capture now to drop leading silence,
          // while the new recorder still catches the onset itself (frame
          // 2+). No barge-in and no hasSpeech yet — a lone click only
          // resets the buffer and never becomes text.
          if (this.recording) this.stopRecorder();
          if (!this.recording) {
            this.startRecorder();
            this.speechStartAt = now;
          }
          this.lastSpeechAt = now;
          return;
        }
        // Transient loud blips (clicks, coughs, door slams) light up one
        // or two frames: wait for sustained voice before confirming a
        // turn, otherwise noise becomes ghost text.
        if (!isSustainedSpeech(speechStreak)) {
          this.lastSpeechAt = now;
          return;
        }
        const firstSpeech = !this.hasSpeech;
        this.hasSpeech = true;
        if (!this.recording) {
          // The onset restart failed (no mic yet): retry now that voice
          // is confirmed, and barge-in so model audio stops immediately.
          try {
            this.options.onSpeechStart?.();
          } catch {
            // Listener errors must not break capture.
          }
          this.startRecorder();
          this.speechStartAt = now;
          this.lastSpeechAt = now;
        } else if (firstSpeech) {
          // Confirmed voice on the running recorder: barge-in now, never
          // on the first blip, so noise cannot kill playback. No restart
          // here — restarting would drop the ~300 ms onset the recorder
          // already captured and chop the first syllable into a wrong word.
          try {
            this.options.onSpeechStart?.();
          } catch {
            // Listener errors must not break capture.
          }
          this.lastSpeechAt = now;
        } else {
          this.lastSpeechAt = now;
          // Safety cap: very long utterances are transcribed anyway.
          if (now - this.speechStartAt >= maxChunkMs) {
            void this.finishTurn();
          }
        }
      } else if (this.recording) {
        speechStreak = 0;
        const silence = now - this.lastSpeechAt;
        const speechLen = this.lastSpeechAt - this.speechAtStart();
        if (shouldEndTurn(silence, silenceMs) && speechLen >= minSpeechMs && this.hasSpeech) {
          void this.finishTurn();
        } else if (silence >= silenceMs * 3 && this.hasSpeech && !this.transcribing) {
          // Short-turn escape: brief replies never reach minSpeechMs but are
          // real speech; end them after extended silence instead of hanging
          // until maxChunkMs (which felt like "sometimes never converts").
          void this.finishTurn();
        } else if (now - this.speechStartAt >= maxChunkMs) {
          // Long silence without speech: discard and restart so the blob
          // never grows unbounded while the user is quiet.
          if (this.hasSpeech) {
            void this.finishTurn();
          } else {
            this.stopRecorder();
            this.startRecorder();
            this.speechStartAt = now;
            this.lastSpeechAt = now;
          }
        }
      }
    }, frameMs);
  }

  private speechAtStart(): number {
    return this.speechStartAt;
  }

  private stopMonitor(): void {
    if (this.monitorTimer !== null) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  private pickMime(): string {
    try {
      if (typeof MediaRecorder === 'undefined') return '';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
      if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
      if (MediaRecorder.isTypeSupported('audio/wav')) return 'audio/wav';
    } catch {
      // isTypeSupported may throw on some browsers; fall back to default.
    }
    return '';
  }

  private startRecorder(): void {
    if (!this.micStream || this.recording) return;
    try {
      const mime = this.pickMime();
      const rec = new MediaRecorder(this.micStream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
      // Per-recorder chunk array: the old recorder's trailing dataavailable
      // fires asynchronously after stop(), so pushing into the shared
      // this.chunks would mix two independent webm streams into one blob
      // (an invalid container that strict remote STT decoders reject with
      // "could not process file" while lenient local Whisper still works).
      const chunks: Blob[] = [];
      this.chunks = chunks;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        // Transcription is driven explicitly by finishTurn, not here,
        // so a device-switch stop never double-transcribes.
      };
      // No timeslice: record one complete blob per turn exactly like dictate
      // mode (rec.start() with no args). Timesliced chunks concatenate into a
      // container that strict remote STT decoders reject ("could not process
      // file") while the single-blob dictate upload keeps working. Nothing
      // consumes incremental chunks here; the blob is only built at finishTurn.
      rec.start();
      this.recorder = rec;
      this.recording = true;
    } catch (err) {
      try {
        this.options.onError?.(err);
      } catch {
        // Ignore listener errors.
      }
    }
  }

  private stopRecorder(): void {
    const rec = this.recorder;
    this.recorder = null;
    this.recording = false;
    if (!rec) return;
    // Detach first: rec.stop() fires a final dataavailable asynchronously,
    // which must not land in the next recorder's chunk array (mixed streams
    // corrupt the webm container). finishTurn stops its recorder directly,
    // so discarding here only affects restart/device-switch paths.
    try {
      rec.ondataavailable = null;
    } catch {
      // Detach is best-effort.
    }
    try {
      rec.onstop = null;
    } catch {
      // Detach is best-effort.
    }
    if (rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        // Stop is best-effort.
      }
    }
  }

  private async finishTurn(): Promise<void> {
    if (!this.recording || this.transcribing || this.stopped) return;
    const rec = this.recorder;
    this.transcribing = true;
    // Keep this.chunks pointing at the captured array until the blob is
    // built: the final dataavailable fires after rec.stop() and pushes
    // into this.chunks. Resetting early drops the audio tail and yields
    // a truncated container that strict remote STT decoders reject
    // ("could not process file") while dictate (complete blob) works.
    const chunks = this.chunks;
    const done = new Promise<Blob>((resolve) => {
      const finish = () => {
        const type = chunks[0]?.type || rec?.mimeType || 'audio/webm';
        resolve(new Blob(chunks, { type }));
      };
      if (!rec || rec.state === 'inactive') {
        finish();
        return;
      }
      const prevStop = rec.onstop;
      rec.onstop = (e) => {
        try {
          if (typeof prevStop === 'function') prevStop.call(rec, e);
        } catch {
          // Ignore previous handler errors.
        }
        finish();
      };
      try {
        rec.stop();
      } catch {
        finish();
      }
    });
    this.recorder = null;
    this.recording = false;
    const hadSpeech = this.hasSpeech;
    this.hasSpeech = false;
    let clean = '';
    try {
      const blob = await done;
      if (this.stopped) return;
      if (!blob || blob.size === 0) return;
      // Pure silence (recorder was running but VAD never fired): drop it
      // silently instead of wasting an STT round-trip.
      if (!hadSpeech) return;
      // Accuracy floor: tiny fragments lack context and Whisper
      // hallucinates wrong words from them. ~0.5s of opus keeps short
      // Persian replies while dropping sub-word blips that mistranscribe.
      if (blob.size < 4500) return;
      const lang = this.options.lang ?? 'fa';
      let text = '';
      try {
        text = await this.options.transcribe(blob, lang);
      } catch (err) {
        try {
          this.options.onError?.(err);
        } catch {
          // Ignore listener errors.
        }
        return;
      }
      clean = sanitizeLocalTranscript(text);
      if (!clean) return;
      if (isHallucinatedTranscript(clean)) return;
      if (this.stopped) return;
    } finally {
      if (this.chunks === chunks) this.chunks = [];
      this.transcribing = false;
      // Resume capture BEFORE delivering the turn: the agent answer (send +
      // TTS) takes seconds, and speech during it must start the next
      // recorder immediately (barge-in continuity). Otherwise the monitor
      // stays deaf for the whole answer and words are lost.
      if (!this.stopped && !this.recording) {
        this.speechStartAt = Date.now();
        this.lastSpeechAt = Date.now();
        this.hasSpeech = false;
        try {
          this.startRecorder();
        } catch {
          // Restart is best-effort; the monitor retries on next speech.
        }
      }
    }
    if (!clean) return;
    if (this.stopped) return;
    try {
      await this.options.onUserText(clean);
    } catch (err) {
      try {
        this.options.onError?.(err);
      } catch {
        // Ignore listener errors.
      }
    }
  }
}
