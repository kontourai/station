import type { TTSOptions, TTSProvider } from '@kontourai/station-sdk';
import { requestVoiceAuthorization } from './authorization';

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export class ElevenLabsTTSProvider implements TTSProvider {
  readonly id = 'elevenlabs';
  readonly name = 'ElevenLabs TTS';

  private _speaking = false;
  private _attempt: AbortController | null = null;
  private _ws: WebSocket | null = null;
  private _audioCtx: AudioContext | null = null;
  private _listeners = new Set<() => void>();

  constructor(private readonly apiBase: string) {}

  get isSupported(): boolean {
    return (
      typeof WebSocket !== 'undefined' && typeof AudioContext !== 'undefined'
    );
  }

  get speaking(): boolean {
    return this._speaking;
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  async speak(text: string, _opts?: TTSOptions): Promise<void> {
    this.cancel();
    if (!text.trim()) return;
    const attempt = new AbortController();
    this._attempt = attempt;
    this._setSpeaking(true);
    const finish = () => {
      if (!attempt.signal.aborted) this.cancel();
    };
    try {
      const url = await requestVoiceAuthorization(
        this.apiBase,
        'tts',
        attempt.signal,
      );
      if (attempt.signal.aborted) return;
      const audio = new AudioContext();
      this._audioCtx = audio;
      const ws = new WebSocket(url);
      this._ws = ws;
      const chunks: Uint8Array[] = [];
      let size = 0;
      let final = false;
      ws.onopen = () => {
        if (attempt.signal.aborted) return;
        try {
          ws.send(JSON.stringify({ text: ' ' }));
          ws.send(JSON.stringify({ text: `${text.trim()} ` }));
          ws.send(JSON.stringify({ text: '' }));
        } catch {
          finish();
        }
      };
      ws.onerror = finish;
      ws.onclose = () => {
        if (!final) finish();
      };
      ws.onmessage = async ({ data }) => {
        if (attempt.signal.aborted || final) return;
        try {
          const message = JSON.parse(data);
          if (!message || typeof message !== 'object' || 'error' in message) {
            finish();
            return;
          }
          if (typeof message.audio === 'string') {
            const bytes = Uint8Array.from(atob(message.audio), (char) =>
              char.charCodeAt(0),
            );
            size += bytes.length;
            if (size > MAX_AUDIO_BYTES) {
              finish();
              return;
            }
            chunks.push(bytes);
          }
          if (message.isFinal !== true && message.is_final !== true) return;
          final = true;
          ws.close();
          if (size === 0) {
            finish();
            return;
          }
          const merged = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          const buffer = await audio.decodeAudioData(merged.buffer);
          if (attempt.signal.aborted) return;
          const source = audio.createBufferSource();
          source.buffer = buffer;
          source.connect(audio.destination);
          source.onended = finish;
          source.start();
        } catch {
          finish();
        }
      };
    } catch {
      finish();
    }
  }

  cancel(): void {
    this._attempt?.abort();
    this._attempt = null;
    this._ws?.close();
    this._ws = null;
    void this._audioCtx?.close().catch(() => {});
    this._audioCtx = null;
    this._setSpeaking(false);
  }

  private _setSpeaking(next: boolean): void {
    if (this._speaking === next) return;
    this._speaking = next;
    for (const listener of this._listeners) listener();
  }
}
