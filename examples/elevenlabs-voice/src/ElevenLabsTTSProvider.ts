/**
 * ElevenLabsTTSProvider — TTSProvider using ElevenLabs streaming TTS.
 *
 * Flow:
 *  1. Fetch single-use WS URL from local server
 *  2. Open WebSocket, send text in chunks
 *  3. Receive streamed MP3 chunks, play via Web Audio API
 *
 * Keepalive: send empty text flush every 20s.
 */
import type { TTSOptions, TTSProvider } from '@kontourai/station-sdk';

export class ElevenLabsTTSProvider implements TTSProvider {
  readonly id = 'elevenlabs';
  readonly name = 'ElevenLabs TTS';

  private _speaking = false;
  private _ws: WebSocket | null = null;
  private _audioCtx: AudioContext | null = null;
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private _listeners = new Set<() => void>();
  private _apiBase: string;
  private _mp3Chunks: Uint8Array[] = [];

  constructor(apiBase: string) {
    this._apiBase = apiBase;
  }

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
    this._speaking = true;
    this._notify();
    this._mp3Chunks = [];

    try {
      const res = await fetch(
        `${this._apiBase}/api/plugins/elevenlabs-voice/signed-url`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'tts',
            sessionId: crypto.randomUUID(),
          }),
        },
      );
      if (!res.ok) throw new Error('Failed to get TTS signed URL');
      const { url } = await res.json();

      const ws = new WebSocket(url);
      this._ws = ws;
      this._audioCtx = new AudioContext();

      ws.onopen = () => {
        // Send text to synthesize
        ws.send(
          JSON.stringify({
            text,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
            },
            xi_api_key: undefined, // using signed URL, no key needed in payload
          }),
        );

        // Flush signal
        ws.send(JSON.stringify({ text: '' }));

        this._keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ text: ' ' }));
        }, 20_000);
      };

      ws.onmessage = async (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.audio) {
            // Base64-encoded MP3 chunk
            const binary = atob(msg.audio);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++)
              bytes[i] = binary.charCodeAt(i);
            this._mp3Chunks.push(bytes);
          }
          if (msg.isFinal) {
            // Decode and play accumulated MP3
            const total = this._mp3Chunks.reduce((a, c) => a + c.length, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const chunk of this._mp3Chunks) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            const audioBuffer = await this._audioCtx!.decodeAudioData(
              merged.buffer,
            );
            const source = this._audioCtx!.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this._audioCtx!.destination);
            source.onended = () => {
              this._speaking = false;
              this._notify();
            };
            source.start();
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        this._clearKeepalive();
      };

      ws.onerror = () => {
        this._speaking = false;
        this._notify();
        this._clearKeepalive();
      };
    } catch {
      this._speaking = false;
      this._notify();
    }
  }

  cancel(): void {
    this._clearKeepalive();
    this._ws?.close();
    this._ws = null;
    this._audioCtx?.close();
    this._audioCtx = null;
    this._mp3Chunks = [];
    if (this._speaking) {
      this._speaking = false;
      this._notify();
    }
  }

  private _clearKeepalive(): void {
    if (this._keepaliveTimer !== null) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  private _notify(): void {
    this._listeners.forEach((fn) => fn());
  }
}
