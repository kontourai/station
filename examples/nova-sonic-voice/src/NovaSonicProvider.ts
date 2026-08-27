/**
 * NovaSonicProvider — preview ConversationalVoiceProvider shape for the local WS relay.
 *
 * The server relay is structural-only and unavailable for real voice until the
 * WS-to-Bedrock InvokeModelWithBidirectionalStream bridge is built.
 *
 * Preview shape:
 *  - Audio chunking (PCM 16kHz -> future relay -> Bedrock)
 *  - Turn-taking via Nova Sonic's event stream
 *  - Interruptions (client sends interrupt event)
 */
import type {
  ConversationalOptions,
  ConversationalSessionState,
  ConversationalVoiceProvider,
  STTOptions,
  STTState,
  TTSOptions,
} from '@kontourai/station-sdk';

export class NovaSonicProvider implements ConversationalVoiceProvider {
  readonly id = 'nova-sonic';
  readonly name = 'Nova Sonic';

  private _sttState: STTState = 'idle';
  private _speaking = false;
  private _sessionState: ConversationalSessionState = 'idle';
  private _transcript = '';
  private _ws: WebSocket | null = null;
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
    return this._sttState;
  }
  get transcript(): string {
    return this._transcript;
  }
  get speaking(): boolean {
    return this._speaking;
  }
  get sessionState(): ConversationalSessionState {
    return this._sessionState;
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  async startSession(_opts?: ConversationalOptions): Promise<void> {
    this.endSession();
    this._setSessionState('active');
    this._setSttState('listening');

    try {
      const wsUrl =
        this._apiBase.replace(/^http/, 'ws') +
        '/api/plugins/nova-sonic-voice/relay';
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.onopen = () => {
        this._startMic();
      };

      ws.onmessage = async (evt) => {
        try {
          const msg = JSON.parse(
            typeof evt.data === 'string' ? evt.data : await evt.data.text(),
          );
          if (msg.type === 'transcript') {
            this._transcript = msg.text ?? '';
            this._notify();
          } else if (msg.type === 'audio') {
            // Play TTS audio from Nova Sonic
            await this._playAudioChunk(msg.data);
          } else if (msg.type === 'turn_end') {
            this._speaking = false;
            this._notify();
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        this._stopMic();
        this._setSessionState('idle');
        this._setSttState('idle');
      };

      ws.onerror = () => {
        this._setSessionState('error');
        this._setSttState('error');
        setTimeout(() => {
          this._setSessionState('idle');
          this._setSttState('idle');
        }, 1500);
      };
    } catch {
      this._setSessionState('error');
      setTimeout(() => this._setSessionState('idle'), 1500);
    }
  }

  endSession(): void {
    this._stopMic();
    this._ws?.close();
    this._ws = null;
    this._audioCtx?.close();
    this._audioCtx = null;
    this._setSessionState('idle');
    this._setSttState('idle');
    if (this._speaking) {
      this._speaking = false;
      this._notify();
    }
  }

  // STTProvider passthrough (delegates to session)
  startListening(_opts?: STTOptions): void {
    this.startSession();
  }

  stopListening(): void {
    this.endSession();
  }

  // TTSProvider passthrough (the future Nova Sonic bridge handles TTS internally)
  speak(_text: string, _opts?: TTSOptions): void {
    // No-op: the future relay contract responds with audio automatically.
  }

  cancel(): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'interrupt' }));
    }
    this._speaking = false;
    this._notify();
  }

  private async _startMic(): Promise<void> {
    try {
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      this._audioCtx = new AudioContext({ sampleRate: 16_000 });
      const source = this._audioCtx.createMediaStreamSource(this._mediaStream);
      const processor = this._audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        const pcm = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, pcm[i] * 32768));
        }
        this._ws.send(
          JSON.stringify({ type: 'audio', data: Array.from(int16) }),
        );
      };
      source.connect(processor);
      processor.connect(this._audioCtx.destination);
    } catch {
      this._setSttState('error');
      setTimeout(() => this._setSttState('idle'), 1500);
    }
  }

  private _stopMic(): void {
    this._mediaStream?.getTracks().forEach((t) => t.stop());
    this._mediaStream = null;
  }

  private async _playAudioChunk(base64: string): Promise<void> {
    if (!this._audioCtx) return;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const audioBuffer = await this._audioCtx.decodeAudioData(bytes.buffer);
      const source = this._audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this._audioCtx.destination);
      this._speaking = true;
      this._notify();
      source.onended = () => {
        this._speaking = false;
        this._notify();
      };
      source.start();
    } catch {
      // ignore decode errors
    }
  }

  private _setSessionState(s: ConversationalSessionState): void {
    this._sessionState = s;
    this._notify();
  }

  private _setSttState(s: STTState): void {
    this._sttState = s;
    this._notify();
  }

  private _notify(): void {
    this._listeners.forEach((fn) => fn());
  }
}
