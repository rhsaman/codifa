// Live full-duplex voice session over a persistent bidirectional WebSocket.
// Capture: AudioContext PCM16 chunks (default) or MediaRecorder fallback.
// Playback: WebAudio scheduled PCM16 chunks with automatic barge-in
// (interruption) when the user starts speaking (server-side VAD events).
// Sentence-final detection is done server-side via silence/VAD; this client
// only reacts to the server's speech_started/stopped + transcript events.

export type LiveVoiceState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'speaking'
  | 'closed'
  | 'error';

export interface LiveTranscriptEvent {
  role: 'user' | 'assistant';
  text: string;
  isFinal: boolean;
}

export type LiveCaptureMode = 'pcm16' | 'recorder';

export interface LiveVoiceOptions {
  // WebSocket endpoint. When it contains "{token}", the ephemeral token is
  // substituted there; otherwise it is appended as "?token=...".
  url: string;
  // Ephemeral token value or async provider. Sent as query param on connect.
  token?: string;
  getToken?: () => string | Promise<string>;
  // Mic capture sample rate for PCM16 mode. Default 24000.
  sampleRate?: number;
  // Model audio sample rate for playback decoding. Default 24000.
  playbackSampleRate?: number;
  // Capture pipeline. Default 'pcm16'.
  captureMode?: LiveCaptureMode;
  // Preferred microphone device id. When set, getUserMedia requests this device.
  deviceId?: string;
  // Start the microphone automatically after connect(). Default true.
  autoStartMic?: boolean;
  onStateChange?: (state: LiveVoiceState) => void;
  onTranscript?: (event: LiveTranscriptEvent) => void;
  onError?: (err: unknown) => void;
}

interface ServerMessage {
  type?: string;
  [key: string]: unknown;
}

const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_PLAYBACK_RATE = 24000;
const RECORDER_TIMESLICE_MS = 250;

// AudioWorklet processor for mic capture: downmix is already mono (single
// channel source), forwards Float32 frames to the main thread for PCM16
// encoding. Inline via Blob URL so no extra asset file is needed.
const CAPTURE_WORKLET_NAME = 'live-voice-capture';
const CAPTURE_WORKLET_CODE = `
class LiveVoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}
registerProcessor('live-voice-capture', LiveVoiceCapture);
`;

function encodeInt16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBase64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new Int16Array(bytes.buffer);
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i++) out[i] = view[i] / 32768;
  return out;
}

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

function pickString(msg: ServerMessage, keys: string[]): string {
  for (const k of keys) {
    const v = msg[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/** True when a transcript payload is an HTML error page, not speech. */
export function sanitizeTranscriptText(text: string): string {
  const s = (text ?? '').trim();
  if (!s) return '';
  if (isHtmlTranscriptJunk(s)) return '';
  // Strip any embedded HTML tag (e.g. gateway error page fragment
  // like <link rel="preload" ... href="/_next/st) that slipped through.
  // Keep only clean speech text; never let markup reach the composer.
  const stripped = s.replace(/<[^<>]*>?/g, ' ').replace(/&lt;|&gt;|&amp;/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped !== s && (s.includes('<') || s.includes('&lt;') || s.includes('/_next/'))) return stripped ? '' : '';
  return s;
}

/** True when a transcript payload is an HTML error page, not speech. */
export function isHtmlTranscriptJunk(text: string): boolean {
  const s = (text ?? '').trim();
  if (!s) return false;
  const low = s.toLowerCase();
  if (low.includes('doctype')) return true;
  // Any Next.js chunk reference is always a gateway HTML page, even when
  // embedded inside otherwise normal-looking text (screenshot case:
  // "Write a <link rel=preload ... href=/_next/st").
  if (low.includes('/_next/')) return true;
  // Next.js / gateway HTML error pages (often truncated mid-attribute with
  // no closing ">", e.g. a preload link cut off at "/_next/st") are never
  // real speech. Short math ("a < b") has none of these markers.
  if (
    low.includes('<link') ||
    low.includes('/_next/') ||
    low.includes('fetchpriority') ||
    low.includes('preload') ||
    low.includes('&lt;')
  )
    return true;
  if (
    low.includes('<html') ||
    low.includes('<head') ||
    low.includes('<meta') ||
    low.includes('<body') ||
    low.includes('<div') ||
    low.includes('<title') ||
    low.includes('charset') ||
    low.includes('viewport')
  )
    return true;
  // Truncated tag without a closing ">" is still junk.
  if (/<[a-z][^<>]*$/i.test(s)) return true;
  if (/<\/?[a-z!]/i.test(s) && /rel\s*=|href\s*=|src\s*=|as\s*=/i.test(s)) return true;
  // Any HTML-like tag (letter right after '<') is never real speech.
  // Short math ("a < b") has a space after '<' so it does not match.
  if (/<\/?[a-z][^>]*>/i.test(s)) return true;
  if (s.length > 60 && /<[a-z][^>]*[a-z]+\s*=\s*["'][^"']*["'][^>]*>/i.test(s)) return true;
  const tags = s.match(/<[a-z][^>]*>/gi);
  if (tags && tags.length >= 2 && s.length > 120) return true;
  if (s.length > 200 && /<[a-z][^>]*>/i.test(s) && !/\s/.test(s)) return true;
  return false;
}

/** Build the GA realtime session.update event so the model answers with voice. */
export function buildLiveSessionUpdate(_inputRate = 24000, _outputRate = 24000): Record<string, unknown> {
  void _inputRate;
  void _outputRate;
  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      // Without transcription the server never emits user transcript events,
      // so the composer would stay empty and the turn feels unanswered.
      input_audio_transcription: { model: 'whisper-1' },
      // server_vad is the widely supported turn detector; semantic_vad is
      // rejected by several gateways, which then never answers.
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        silence_duration_ms: 500,
        prefix_padding_ms: 300,
        create_response: true,
        interrupt_response: true,
      },
    },
  };
}

export class LiveVoiceSession {
  onStateChange?: (state: LiveVoiceState) => void;
  onTranscript?: (event: LiveTranscriptEvent) => void;
  onError?: (err: unknown) => void;

  private options: LiveVoiceOptions;
  private ws: WebSocket | null = null;
  private state: LiveVoiceState = 'idle';
  private manualClose = false;
  private microphoneDeviceId?: string;

  // Capture pipeline.
  private micStream: MediaStream | null = null;
  private captureCtx: AudioContext | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private recorder: MediaRecorder | null = null;

  // Playback pipeline.
  private outputCtx: AudioContext | null = null;
  private playQueue: Float32Array[] = [];
  private currentSource: AudioBufferSourceNode | null = null;
  private scheduling = false;

  constructor(options: LiveVoiceOptions) {
    this.options = options;
    this.microphoneDeviceId = options.deviceId;
    this.onStateChange = options.onStateChange;
    this.onTranscript = options.onTranscript;
    this.onError = options.onError;
  }

  get currentState(): LiveVoiceState {
    return this.state;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // Open the always-on bidirectional socket using an ephemeral token,
  // then optionally start the microphone.
  async connect(): Promise<void> {
    if (this.connected || this.state === 'connecting') return;
    this.manualClose = false;
    this.setState('connecting');
    try {
      const token = await this.resolveToken();
      const url = this.buildUrl(this.options.url, token);
      await this.openSocket(url, token);
      this.setState('live');
      if (this.options.autoStartMic !== false) {
        await this.startMicrophone();
      }
    } catch (err) {
      this.setState('error');
      this.fail(err);
      throw err;
    }
  }

  // Stop mic + playback and close the socket.
  disconnect(): void {
    this.manualClose = true;
    this.stopMicrophone();
    this.stopPlayback();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client disconnect');
      } catch {
        // Socket already gone; nothing to do.
      }
      this.ws = null;
    }
    this.setState('closed');
  }

  // Send a text turn over the open socket.
  sendText(text: string): void {
    const message = text.trim();
    if (!message || !this.connected) return;
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] } });
    this.send({ type: 'response.create' });
  }

  // Switch the microphone device. Stores the id and restarts the mic when active.
  async setMicrophoneDeviceId(deviceId: string): Promise<void> {
    this.microphoneDeviceId = deviceId;
    this.options.deviceId = deviceId;
    if (!this.micStream && !this.recorder) return;
    this.stopMicrophone();
    await this.startMicrophone();
  }

  // Begin streaming mic chunks to the server.
  async startMicrophone(): Promise<void> {
    if (this.micStream || this.recorder) return;
    const deviceId = this.microphoneDeviceId;
    let stream: MediaStream;
    if (!deviceId) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      } catch (err) {
        const name = err instanceof DOMException ? err.name : (err as { name?: unknown }).name;
        const constraint = (err as { constraint?: unknown }).constraint;
        const isOverconstrained =
          name === 'OverconstrainedError' || name === 'OverconstrainedConstraint' || constraint === 'deviceId';
        if (!isOverconstrained) throw err;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    }
    this.micStream = stream;
    if ((this.options.captureMode ?? 'pcm16') === 'recorder') {
      this.startRecorder(stream);
    } else {
      await this.startPcmCapture(stream);
    }
  }

  // Stop the mic tracks and tear down the capture graph.
  stopMicrophone(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        // Recorder already stopped; ignore.
      }
    }
    this.recorder = null;
    if (this.captureNode) {
      try {
        this.captureNode.port.onmessage = null;
        this.captureNode.disconnect();
      } catch {
        // Node already disconnected; ignore.
      }
    }
    this.captureNode = null;
    if (this.captureSource) {
      try {
        this.captureSource.disconnect();
      } catch {
        // Source already disconnected; ignore.
      }
    }
    this.captureSource = null;
    if (this.captureCtx) {
      void this.captureCtx.close().catch(() => undefined);
    }
    this.captureCtx = null;
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
    }
    this.micStream = null;
  }

  // Cut the model audio (barge-in) and tell the server we interrupted.
  interrupt(): void {
    this.stopPlayback();
    this.send({ type: 'response.cancel' });
    if (this.state === 'speaking') this.setState('live');
  }

  private async resolveToken(): Promise<string> {
    if (this.options.getToken) return this.options.getToken();
    return this.options.token ?? '';
  }

  private buildUrl(url: string, token: string): string {
    if (!token) return url;
    if (url.includes('{token}')) return url.replace('{token}', encodeURIComponent(token));
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  }

  private openSocket(url: string, token?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // OpenAI browser WebSocket auth uses subprotocols, not query params:
      // ["realtime", "openai-insecure-api-key.<ephemeral>", ...]. Query token
      // is kept for custom gateways only.
      const isOpenAiRealtime = url.includes('api.openai.com') && url.includes('/realtime');
      const cleanUrl = isOpenAiRealtime ? url.split('?token=')[0].split('&token=')[0] : url;
      const protocols = isOpenAiRealtime && token
        ? ['realtime', `openai-insecure-api-key.${token}`]
        : undefined;
      const ws = protocols ? new WebSocket(cleanUrl, protocols) : new WebSocket(cleanUrl);
      ws.binaryType = 'arraybuffer';
      const handleOpen = () => {
        this.ws = ws;
        ws.onmessage = (ev) => this.handleMessage(ev);
        // Configure the session for speech-to-speech (GA realtime format).
        // Voice/model were fixed server-side when minting the ephemeral token.
        this.send(buildLiveSessionUpdate(this.options.sampleRate ?? DEFAULT_SAMPLE_RATE, this.options.playbackSampleRate ?? DEFAULT_PLAYBACK_RATE));
        ws.onerror = () => this.fail(new Error('Live voice socket error'));
        ws.onclose = () => {
          if (this.ws === ws) this.ws = null;
          if (!this.manualClose && this.state !== 'error') this.setState('closed');
        };
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error('Failed to open live voice socket'));
      };
      const cleanup = () => {
        ws.removeEventListener('open', handleOpen);
        ws.removeEventListener('error', handleError);
      };
      ws.addEventListener('open', handleOpen);
      ws.addEventListener('error', handleError);
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.connected || !this.ws) return;
    this.ws.send(JSON.stringify(payload));
  }

  // AudioWorklet PCM16 path: stream mic float frames and send them as int16.
  private async startPcmCapture(stream: MediaStream): Promise<void> {
    const rate = this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const ctx = new AudioContext({ sampleRate: rate });
    this.captureCtx = ctx;
    const blob = new Blob([CAPTURE_WORKLET_CODE], { type: 'application/javascript' });
    const moduleUrl = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    const source = ctx.createMediaStreamSource(stream);
    this.captureSource = source;
    const node = new AudioWorkletNode(ctx, CAPTURE_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.captureNode = node;
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (!this.connected) return;
      const input = ev.data;
      if (!input || input.length === 0) return;
      const pcm = floatToPcm16(input);
      this.send({ type: 'input_audio_buffer.append', audio: encodeInt16ToBase64(pcm) });
    };
    source.connect(node);
    void ctx.resume().catch(() => undefined);
  }

  // MediaRecorder path: stream compressed chunks for servers that accept them.
  private startRecorder(stream: MediaStream): void {
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : undefined;
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    this.recorder = recorder;
    recorder.ondataavailable = (ev) => {
      if (!this.connected || ev.data.size === 0) return;
      void ev.data
        .arrayBuffer()
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          this.send({ type: 'input_audio_buffer.append', audio: btoa(binary) });
        })
        .catch((err: unknown) => this.fail(err));
    };
    recorder.onerror = () => this.fail(new Error('Microphone recorder error'));
    recorder.start(RECORDER_TIMESLICE_MS);
  }

  private handleMessage(ev: MessageEvent): void {
    if (ev.data instanceof ArrayBuffer) {
      this.enqueuePlayback(new Float32Array(ev.data));
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMessage;
    } catch {
      return;
    }
    const type = typeof msg.type === 'string' ? msg.type : '';

    // Server VAD: user started talking -> cut model playback immediately.
    if (
      type === 'input_audio_buffer.speech_started' ||
      type === 'vad.speech_started' ||
      type === 'speech_started' ||
      type === 'user_speech_started'
    ) {
      this.stopPlayback();
      if (this.state === 'speaking') this.setState('live');
      return;
    }

    // Model audio chunk (generic PCM16 base64 or GA realtime delta).
    const audioBase64 = pickString(msg, ['audio', 'delta', 'data']);
    if (
      type === 'audio' ||
      type === 'audio_chunk' ||
      type === 'response.audio.delta' ||
      type === 'audio.delta' ||
      type === 'response.output_audio.delta' ||
      type === 'session.output_audio.delta'
    ) {
      if (audioBase64) {
        this.enqueuePlayback(decodeBase64ToFloat32(audioBase64));
        if (this.state === 'live') this.setState('speaking');
      }
      return;
    }

    // Model turn finished -> back to listening.
    if (
      type === 'response.done' ||
      type === 'response.audio.done' ||
      type === 'response.output_audio.done' ||
      type === 'turn_done' ||
      type === 'speech_stopped'
    ) {
      if (this.state === 'speaking') this.setState('live');
      return;
    }

    // Transcripts (generic + GA realtime deltas). Partial deltas are never
    // written to the composer by this client; only completed transcripts are
    // forwarded, so a truncated HTML error page can never land in the input.
    if (
      type === 'transcript' ||
      type === 'response.audio_transcript.delta' ||
      type === 'response.output_audio_transcript.delta' ||
      type === 'response.output_text.delta' ||
      type === 'input_transcript' ||
      type === 'conversation.item.input_audio_transcription.delta' ||
      type === 'session.input_transcript.delta' ||
      type === 'session.output_transcript.delta'
    ) {
      const text = pickString(msg, ['text', 'delta', 'transcript']);
      if (text && !isHtmlTranscriptJunk(text) && this.onTranscript) {
        const role = msg.role === 'user' ? 'user' : 'assistant';
        this.onTranscript({ role, text, isFinal: false });
      }
      return;
    }
    if (
      type === 'transcript_done' ||
      type === 'response.audio_transcript.done' ||
      type === 'response.output_audio_transcript.done' ||
      type === 'response.output_text.done' ||
      type === 'conversation.item.input_audio_transcription.completed' ||
      type === 'session.input_transcript.done' ||
      type === 'session.output_transcript.done'
    ) {
      const text = pickString(msg, ['text', 'transcript', 'delta']);
      if (!text) return;
      // HTML error pages must surface in the error banner, never in the composer input.
      if (isHtmlTranscriptJunk(text) || /<\/?[a-z]/i.test(text) || text.includes('&lt;') || text.includes('/_next/') || /preload|fetchpriority/i.test(text)) {
        this.onError?.(new Error('Live transcript returned an error page — please try again.'));
        return;
      }
      if (this.onTranscript) {
        const role =
          type === 'conversation.item.input_audio_transcription.completed' ||
          type === 'session.input_transcript.done'
            ? 'user'
            : 'assistant';
        this.onTranscript({ role, text, isFinal: true });
      }
      return;
    }

    // GA session lifecycle: created/updated confirm the session is ready.
    if (type === 'session.created' || type === 'session.updated') {
      if (this.state === 'connecting') this.setState('live');
      return;
    }
    if (type === 'error' || type === 'invalid_request_error') {
      const message = pickString(msg, ['message', 'error']);
      const err = new Error(message || 'Live voice server error');
      this.setState('error');
      this.fail(err);
      return;
    }
  }

  private ensureOutputCtx(): AudioContext | null {
    if (this.outputCtx && this.outputCtx.state !== 'closed') return this.outputCtx;
    try {
      this.outputCtx = new AudioContext({
        sampleRate: this.options.playbackSampleRate ?? DEFAULT_PLAYBACK_RATE,
      });
    } catch {
      return null;
    }
    void this.outputCtx.resume().catch(() => undefined);
    return this.outputCtx;
  }

  private enqueuePlayback(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.playQueue.push(samples);
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.scheduling || this.currentSource) return;
    const ctx = this.ensureOutputCtx();
    const next = this.playQueue.shift();
    if (!ctx || !next) return;
    this.scheduling = true;
    try {
      const buffer = ctx.createBuffer(1, next.length, ctx.sampleRate);
      buffer.getChannelData(0).set(next);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      this.currentSource = source;
      source.onended = () => {
        this.currentSource = null;
        this.scheduling = false;
        if (this.playQueue.length > 0) {
          this.scheduleNext();
        } else if (this.state === 'speaking') {
          this.setState('live');
        }
      };
      source.start();
    } catch (err) {
      this.scheduling = false;
      this.currentSource = null;
      this.fail(err);
    }
  }

  private stopPlayback(): void {
    this.playQueue = [];
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
      } catch {
        // Source already stopped; ignore.
      }
      this.currentSource = null;
    }
    this.scheduling = false;
  }

  private setState(next: LiveVoiceState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }

  private fail(err: unknown): void {
    try {
      this.onError?.(err);
    } catch {
      // Never let an error callback break the session teardown.
    }
  }
}
