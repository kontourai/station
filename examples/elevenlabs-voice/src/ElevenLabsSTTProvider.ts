import type { STTOptions, STTProvider, STTState } from '@kontourai/station-sdk';
import { requestVoiceAuthorization } from './authorization';

const SAMPLE_RATE = 16_000;

export class ElevenLabsSTTProvider implements STTProvider {
  readonly id = 'elevenlabs';
  readonly name = 'ElevenLabs Scribe';

  private _state: STTState = 'idle';
  private _transcript = '';
  private _attempt: AbortController | null = null;
  private _ws: WebSocket | null = null;
  private _audioCtx: AudioContext | null = null;
  private _mediaStream: MediaStream | null = null;
  private _listeners = new Set<() => void>();

  constructor(private readonly apiBase: string) {}

  get isSupported(): boolean {
    return (
      typeof WebSocket !== 'undefined' &&
      typeof AudioContext !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices
    );
  }

  get state(): STTState {
    return this._state;
  }
  get transcript(): string {
    return this._transcript;
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  async startListening(_opts?: STTOptions): Promise<void> {
    this.stopListening();
    const attempt = new AbortController();
    this._attempt = attempt;
    this._transcript = '';
    this._setState('listening');
    const fail = () => {
      if (attempt.signal.aborted) return;
      this._dispose();
      this._setState('error');
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (attempt.signal.aborted) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this._mediaStream = stream;
      const url = await requestVoiceAuthorization(
        this.apiBase,
        'stt',
        attempt.signal,
      );
      if (attempt.signal.aborted) return;

      const audio = new AudioContext({ sampleRate: SAMPLE_RATE });
      this._audioCtx = audio;
      if (audio.sampleRate !== SAMPLE_RATE)
        throw new Error('Unsupported audio sample rate');
      const source = audio.createMediaStreamSource(stream);
      const processor = audio.createScriptProcessor(4096, 1, 1);
      const ws = new WebSocket(url);
      this._ws = ws;
      let ready = false;
      let committed = '';
      ws.onerror = fail;
      ws.onclose = fail;
      ws.onmessage = ({ data }) => {
        if (attempt.signal.aborted) return;
        try {
          const message = JSON.parse(data);
          if (typeof message?.message_type !== 'string' || 'error' in message) {
            fail();
            return;
          }
          if (message.message_type === 'session_started') ready = true;
          const final = message.message_type === 'committed_transcript';
          if (
            (final || message.message_type === 'partial_transcript') &&
            typeof message.text === 'string'
          ) {
            this._transcript = [committed, message.text.trim()]
              .filter(Boolean)
              .join(' ');
            if (final) committed = this._transcript;
            this._notify();
          }
        } catch {
          fail();
        }
      };
      processor.onaudioprocess = (event) => {
        if (
          attempt.signal.aborted ||
          !ready ||
          ws.readyState !== WebSocket.OPEN
        )
          return;
        const samples = event.inputBuffer.getChannelData(0);
        const pcm = new Uint8Array(samples.length * 2);
        const view = new DataView(pcm.buffer);
        for (let i = 0; i < samples.length; i++) {
          view.setInt16(
            i * 2,
            Math.max(-32768, Math.min(32767, samples[i] * 32768)),
            true,
          );
        }
        try {
          ws.send(
            JSON.stringify({
              message_type: 'input_audio_chunk',
              audio_base_64: btoa(String.fromCharCode(...pcm)),
              sample_rate: SAMPLE_RATE,
            }),
          );
        } catch {
          fail();
        }
      };
      source.connect(processor);
      processor.connect(audio.destination);
    } catch {
      fail();
    }
  }

  stopListening(): void {
    this._dispose();
    this._setState('idle');
  }

  private _dispose(): void {
    this._attempt?.abort();
    this._attempt = null;
    this._ws?.close();
    this._ws = null;
    for (const track of this._mediaStream?.getTracks() ?? []) track.stop();
    this._mediaStream = null;
    void this._audioCtx?.close().catch(() => {});
    this._audioCtx = null;
  }

  private _setState(next: STTState): void {
    if (this._state === next) return;
    this._state = next;
    this._notify();
  }

  private _notify(): void {
    for (const listener of this._listeners) listener();
  }
}
