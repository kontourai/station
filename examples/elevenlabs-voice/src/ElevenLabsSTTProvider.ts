/**
 * ElevenLabsSTTProvider — STTProvider using ElevenLabs Scribe v2 Realtime.
 *
 * Flow:
 *  1. Fetch single-use WS URL from local server (POST /signed-url)
 *  2. Open WebSocket to ElevenLabs
 *  3. Stream microphone audio via AudioWorklet
 *  4. Receive transcript events; emit onTranscript callbacks
 *
 * Keepalive: send " " (space) every 20s; max session 180s.
 */
import type { STTOptions, STTProvider, STTState } from '@kontourai/station-sdk';

export class ElevenLabsSTTProvider implements STTProvider {
  readonly id = 'elevenlabs';
  readonly name = 'ElevenLabs Scribe';

  private _state: STTState = 'idle';
  private _transcript = '';
  private _ws: WebSocket | null = null;
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private _audioCtx: AudioContext | null = null;
  private _mediaStream: MediaStream | null = null;
  private _listeners = new Set<() => void>();
  private _apiBase: string;

  constructor(apiBase: string) {
    this._apiBase = apiBase;
  }

  get isSupported(): boolean {
    return (
      typeof WebSocket !== 'undefined' &&
      typeof navigator.mediaDevices !== 'undefined'
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
    this._setState('listening');

    try {
      // Get signed URL from local server
      const res = await fetch(
        `${this._apiBase}/api/plugins/elevenlabs-voice/signed-url`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'stt',
            sessionId: crypto.randomUUID(),
          }),
        },
      );
      if (!res.ok) throw new Error('Failed to get signed URL');
      const { url } = await res.json();

      // Open WebSocket
      const ws = new WebSocket(url);
      this._ws = ws;

      ws.onopen = () => {
        // Keepalive every 20s
        this._keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ text: ' ' }));
        }, 20_000);
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'transcript' && msg.text) {
            this._transcript = msg.text;
            this._notify();
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        this._clearKeepalive();
        if (this._state === 'listening') this._setState('idle');
      };

      ws.onerror = () => {
        this._setState('error');
        setTimeout(() => this._setState('idle'), 1500);
      };

      // Open microphone and stream PCM to WebSocket
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      this._audioCtx = new AudioContext({ sampleRate: 16_000 });
      const source = this._audioCtx.createMediaStreamSource(this._mediaStream);

      // ScriptProcessor as fallback (AudioWorklet requires a separate file)
      const processor = this._audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const pcm = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, pcm[i] * 32768));
        }
        ws.send(int16.buffer);
      };

      source.connect(processor);
      processor.connect(this._audioCtx.destination);
    } catch {
      this._setState('error');
      setTimeout(() => this._setState('idle'), 1500);
    }
  }

  stopListening(): void {
    this._clearKeepalive();
    this._ws?.close();
    this._ws = null;
    this._mediaStream?.getTracks().forEach((t) => t.stop());
    this._mediaStream = null;
    this._audioCtx?.close();
    this._audioCtx = null;
    if (this._state === 'listening') this._setState('idle');
  }

  private _clearKeepalive(): void {
    if (this._keepaliveTimer !== null) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  private _setState(s: STTState): void {
    this._state = s;
    this._notify();
  }

  private _notify(): void {
    this._listeners.forEach((fn) => fn());
  }
}
