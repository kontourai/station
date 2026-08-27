import {
  createVoiceSession,
  fetchVoicePort,
  ListenerManager,
  telemetry,
} from '@kontourai/station-sdk';
import {
  type VoiceSessionAdapter,
  VoiceSessionError,
  type VoiceSessionLifecycleState,
  type VoiceSessionOperationResult,
  type VoiceSessionSnapshot,
  type VoiceSessionStartInput,
} from '@kontourai/station-sdk/voice';
import {
  base64ToInt16,
  downsample,
  float32ToInt16,
  int16ToBase64,
  int16ToFloat32,
} from '../../hooks/voiceSessionAudio';
import { deriveVoiceWsUrl } from '../../hooks/voiceWsUrl';
import {
  BrowserWebSocketAuthGate,
  isRemoteEndpoint,
  type WebSocketCredentialResolver,
  websocketCloseError,
} from '../../utils/browserWebSocketAuth';

/** Current server-normalized states plus aliases still emitted by older Nova. */
type VoiceWireState = VoiceSessionLifecycleState | 'idle' | 'processing';
type LifecycleReason =
  | 'explicit'
  | 'barge_in'
  | 'socket_close'
  | 'socket_error'
  | 'auth_failed'
  | 'microphone_failed'
  | 'provider_failed';

interface VoiceWireMessage {
  type: string;
  data?: string;
  text?: string;
  role?: 'user' | 'assistant';
  state?: VoiceWireState;
  message?: string;
  inputAudioFormat?: { sampleRateHertz?: number };
  outputAudioFormat?: { sampleRateHertz?: number };
}

type AuthGate = Pick<BrowserWebSocketAuthGate, 'open' | 'consume'>;

export interface NovaVoiceSessionAdapterDependencies {
  readonly apiBase: string;
  readonly credentialProvider: WebSocketCredentialResolver;
  readonly pageHref: () => string;
  readonly createSocket: (url: string) => WebSocket;
  readonly createAudioContext: () => AudioContext;
  readonly getUserMedia: () => Promise<MediaStream>;
  readonly fetchVoicePort: (apiBase?: string) => Promise<number>;
  readonly createVoiceSession: (
    apiBase?: string,
  ) => Promise<{ sessionId?: string }>;
  readonly deriveVoiceWsUrl: (
    apiBase: string,
    pageHref: string,
    voicePort: number,
  ) => string;
  readonly isRemoteEndpoint: (apiBase: string, pageHref: string) => boolean;
  readonly createAuthGate: (
    remote: boolean,
    credentials: WebSocketCredentialResolver,
    onAuthenticated: () => void,
    onError: (message: string) => void,
  ) => AuthGate;
  readonly track: (
    event: string,
    attributes: Record<string, string | number>,
  ) => void;
}

export function createNovaVoiceSessionAdapterDependencies(
  apiBase: string,
  credentialProvider: WebSocketCredentialResolver,
): NovaVoiceSessionAdapterDependencies {
  return {
    apiBase,
    credentialProvider,
    pageHref: () => window.location.href,
    createSocket: (url) => new WebSocket(url),
    createAudioContext: () => new AudioContext(),
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    fetchVoicePort,
    createVoiceSession,
    deriveVoiceWsUrl,
    isRemoteEndpoint,
    createAuthGate: (remote, credentials, onAuthenticated, onError) =>
      new BrowserWebSocketAuthGate(
        remote,
        credentials,
        onAuthenticated,
        onError,
      ),
    track: telemetry.track,
  };
}

/**
 * Browser resource owner for Nova's dedicated authenticated voice socket.
 * React consumes its immutable snapshots but owns none of the socket/audio
 * resources, which makes every terminal path converge on the same cleanup.
 */
export class NovaVoiceSessionAdapter
  extends ListenerManager
  implements VoiceSessionAdapter
{
  readonly descriptor = Object.freeze({
    id: 'nova-s2s',
    name: 'Nova Sonic',
    description: 'Station Nova speech-to-speech session',
  });

  readonly capabilities = Object.freeze({ interrupt: true });

  private snapshot: VoiceSessionSnapshot = Object.freeze<VoiceSessionSnapshot>({
    state: 'disconnected',
    revision: 0,
    transcript: '',
    muted: false,
    inputAudioLevel: 0,
  });
  private socket: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private microphoneSource: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private readonly playbackQueue: AudioBuffer[] = [];
  private playing = false;
  private inputSampleRate = 16000;
  private outputSampleRate = 24000;
  private generation = 0;
  private startInFlight: Promise<VoiceSessionOperationResult> | undefined;
  private stopInFlight: Promise<VoiceSessionOperationResult> | undefined;
  private pendingStart:
    | {
        generation: number;
        resolve: (result: VoiceSessionOperationResult) => void;
      }
    | undefined;
  private cleanupInFlight: Promise<void> | undefined;

  constructor(
    private readonly dependencies: NovaVoiceSessionAdapterDependencies,
  ) {
    super();
  }

  getSnapshot(): VoiceSessionSnapshot {
    return this.snapshot;
  }

  async start(
    _input?: VoiceSessionStartInput,
  ): Promise<VoiceSessionOperationResult> {
    if (this.startInFlight) return this.startInFlight;
    if (this.socket) return this.success(this.snapshot);

    const generation = ++this.generation;
    this.publish({ state: 'connecting', error: undefined });
    const operation = this.beginStart(generation);
    this.startInFlight = operation;
    void operation.finally(() => {
      if (this.startInFlight === operation) this.startInFlight = undefined;
    });
    return operation;
  }

  stop(): Promise<VoiceSessionOperationResult> {
    if (this.stopInFlight) return this.stopInFlight;
    const operation = this.stopInternal();
    this.stopInFlight = operation;
    void operation.finally(() => {
      if (this.stopInFlight === operation) this.stopInFlight = undefined;
    });
    return operation;
  }

  private async stopInternal(): Promise<VoiceSessionOperationResult> {
    if (
      !this.startInFlight &&
      !this.socket &&
      !this.audioContext &&
      this.snapshot.state === 'disconnected'
    ) {
      return this.success(this.snapshot);
    }
    const staleGeneration = this.generation;
    ++this.generation;
    this.settleStart(staleGeneration, this.unavailable('start'));
    await this.cleanup();
    this.publish({ state: 'disconnected', error: undefined });
    this.track('stop', 'success', 'explicit');
    return this.success(this.snapshot);
  }

  async interrupt(): Promise<VoiceSessionOperationResult> {
    this.stopPlayback();
    this.track('interrupt', 'success', 'barge_in');
    return this.success(this.snapshot);
  }

  /** Explicitly retained outside the SDK lifecycle contract for the UI control. */
  toggleMuted(): void {
    this.setMuted(!this.snapshot.muted);
  }

  setMuted(muted: boolean): void {
    this.publish({ muted });
  }

  /** Alias used by hook unmount cleanup; safe to call more than once. */
  destroy(): Promise<VoiceSessionOperationResult> {
    return this.stop();
  }

  private async beginStart(
    generation: number,
  ): Promise<VoiceSessionOperationResult> {
    try {
      const voicePort = await this.dependencies.fetchVoicePort(
        this.dependencies.apiBase,
      );
      if (!this.isCurrent(generation)) return this.unavailable('start');

      const pageHref = this.dependencies.pageHref();
      const socket = this.dependencies.createSocket(
        this.dependencies.deriveVoiceWsUrl(
          this.dependencies.apiBase,
          pageHref,
          voicePort,
        ),
      );
      if (!this.isCurrent(generation)) {
        socket.close();
        return this.unavailable('start');
      }
      this.socket = socket;
      const authGate = this.dependencies.createAuthGate(
        this.dependencies.isRemoteEndpoint(this.dependencies.apiBase, pageHref),
        this.dependencies.credentialProvider,
        () => void this.completeAuthentication(generation),
        () =>
          void this.fail(generation, 'Authentication failed', 'auth_failed'),
      );

      socket.onopen = () => authGate.open(socket);
      socket.onmessage = (event) =>
        this.receiveMessage(generation, authGate, event);
      socket.onerror = () =>
        void this.fail(generation, 'WebSocket error', 'socket_error');
      socket.onclose = (event) => {
        if (!this.isCurrent(generation)) return;
        if (event.code === 1000) {
          void this.closeNormally(generation);
          return;
        }
        void this.fail(
          generation,
          websocketCloseError(event.code),
          'socket_close',
        );
      };

      return await new Promise<VoiceSessionOperationResult>((resolve) => {
        this.pendingStart = { generation, resolve };
      });
    } catch {
      return this.fail(generation, 'Connection failed', 'provider_failed');
    }
  }

  private async completeAuthentication(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    try {
      this.audioContext = this.dependencies.createAudioContext();
      const session = await this.dependencies.createVoiceSession(
        this.dependencies.apiBase,
      );
      if (!this.isCurrent(generation)) return;
      this.publish({ controlSessionId: session.sessionId });
    } catch {
      await this.fail(generation, 'Session creation failed', 'provider_failed');
    }
  }

  private receiveMessage(
    generation: number,
    authGate: AuthGate,
    event: MessageEvent,
  ): void {
    if (!this.isCurrent(generation)) return;
    const raw = typeof event.data === 'string' ? event.data : '';
    if (authGate.consume(raw)) return;
    let message: VoiceWireMessage;
    try {
      message = JSON.parse(raw) as VoiceWireMessage;
    } catch {
      void this.fail(generation, 'Invalid voice response', 'provider_failed');
      return;
    }

    switch (message.type) {
      case 'session_ready':
        this.receiveSessionReady(generation, message);
        return;
      case 'audio_out':
        if (message.data) this.enqueueAudio(message.data);
        return;
      case 'transcript':
        this.publish({
          transcript: message.text ?? '',
          transcriptRole: message.role,
        });
        return;
      case 'state':
        this.receiveState(message.state);
        return;
      case 'error':
        void this.fail(generation, 'Voice provider error', 'provider_failed');
        return;
      default:
        return;
    }
  }

  private receiveSessionReady(
    generation: number,
    message: VoiceWireMessage,
  ): void {
    if (message.inputAudioFormat?.sampleRateHertz) {
      this.inputSampleRate = message.inputAudioFormat.sampleRateHertz;
    }
    if (message.outputAudioFormat?.sampleRateHertz) {
      this.outputSampleRate = message.outputAudioFormat.sampleRateHertz;
    }
    void this.startMicrophone(generation);
  }

  private async startMicrophone(generation: number): Promise<void> {
    try {
      const context = this.audioContext;
      if (!context || !this.isCurrent(generation)) return;
      const stream = await this.dependencies.getUserMedia();
      if (!this.isCurrent(generation)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.microphoneSource = context.createMediaStreamSource(stream);
      await context.audioWorklet.addModule('/voice-processor.js');
      if (!this.isCurrent(generation)) return;
      const processor = new AudioWorkletNode(context, 'voice-processor');
      processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
        this.handleMicrophoneFrame(generation, event.data);
      };
      this.microphoneSource.connect(processor);
      processor.connect(context.destination);
      this.processor = processor;
      this.track('start', 'success', 'explicit');
      this.settleStart(generation, this.success(this.snapshot));
    } catch {
      await this.fail(generation, 'Mic access denied', 'microphone_failed');
    }
  }

  private handleMicrophoneFrame(
    generation: number,
    samples: Float32Array,
  ): void {
    if (!this.isCurrent(generation)) return;
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      sum += samples[index] * samples[index];
    }
    const inputAudioLevel = samples.length
      ? Math.min(1, Math.sqrt(sum / samples.length) * 5)
      : 0;
    this.publish({ inputAudioLevel });
    const socket = this.socket;
    if (
      this.snapshot.muted ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const context = this.audioContext;
    if (!context) return;
    const resampled = downsample(
      samples,
      context.sampleRate,
      this.inputSampleRate,
    );
    socket.send(
      JSON.stringify({
        type: 'audio_in',
        data: int16ToBase64(float32ToInt16(resampled)),
      }),
    );
  }

  private receiveState(state: VoiceWireState | undefined): void {
    const normalized =
      state === 'idle'
        ? 'connected-idle'
        : state === 'processing'
          ? 'thinking'
          : state;
    if (!normalized) return;
    if (normalized === 'listening' && this.snapshot.state === 'speaking') {
      this.stopPlayback();
      this.track('interrupt', 'success', 'barge_in');
    }
    this.publish({ state: normalized });
  }

  private enqueueAudio(encoded: string): void {
    const context = this.audioContext;
    if (!context) return;
    try {
      const samples = int16ToFloat32(base64ToInt16(encoded));
      const buffer = context.createBuffer(
        1,
        samples.length,
        this.outputSampleRate,
      );
      buffer.copyToChannel(new Float32Array(samples), 0);
      this.playbackQueue.push(buffer);
      if (!this.playing) this.playNext();
    } catch {
      void this.fail(
        this.generation,
        'Invalid audio response',
        'provider_failed',
      );
    }
  }

  private playNext(): void {
    const context = this.audioContext;
    const buffer = this.playbackQueue.shift();
    if (!context || !buffer) {
      this.playing = false;
      this.currentSource = null;
      return;
    }
    this.playing = true;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (this.currentSource === source) {
        this.currentSource = null;
        this.playNext();
      }
    };
    this.currentSource = source;
    source.start();
  }

  private stopPlayback(): void {
    this.playbackQueue.length = 0;
    this.playing = false;
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // An already-ended source is still fully released below.
      }
      this.currentSource.disconnect();
      this.currentSource = null;
    }
    if (this.snapshot.inputAudioLevel !== 0)
      this.publish({ inputAudioLevel: 0 });
  }

  private async fail(
    generation: number,
    message: string,
    reason: Exclude<LifecycleReason, 'explicit' | 'barge_in'>,
  ): Promise<VoiceSessionOperationResult> {
    if (!this.isCurrent(generation)) return this.unavailable('start');
    ++this.generation;
    const error = new VoiceSessionError('operation-failed', message, 'start');
    this.publish({ state: 'error', error });
    this.track('error', 'failure', reason);
    await this.cleanup();
    this.publish({ state: 'disconnected' });
    this.settleStart(generation, { ok: false, error });
    return { ok: false, error };
  }

  private async closeNormally(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const pendingStart = this.pendingStart?.generation === generation;
    ++this.generation;
    await this.cleanup();
    this.publish({ state: 'disconnected', error: undefined });
    this.track('stop', 'success', 'socket_close');
    this.settleStart(
      generation,
      pendingStart ? this.unavailable('start') : this.success(this.snapshot),
    );
  }

  private cleanup(): Promise<void> {
    if (this.cleanupInFlight) return this.cleanupInFlight;
    const operation = (async () => {
      const socket = this.socket;
      const context = this.audioContext;
      this.socket = null;
      this.audioContext = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          // Closing a broken socket must not prevent the remaining teardown.
        }
      }
      this.processor?.disconnect();
      this.processor = null;
      this.microphoneSource?.disconnect();
      this.microphoneSource = null;
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.stopPlayback();
      if (context) {
        try {
          await context.close();
        } catch {
          // Browser audio close is best effort after a prior context failure.
        }
      }
    })();
    this.cleanupInFlight = operation;
    void operation.finally(() => {
      if (this.cleanupInFlight === operation) this.cleanupInFlight = undefined;
    });
    return operation;
  }

  private publish(next: Partial<VoiceSessionSnapshot>): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...next,
      revision: this.snapshot.revision + 1,
    } as VoiceSessionSnapshot);
    this._notify();
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private settleStart(
    generation: number,
    result: VoiceSessionOperationResult,
  ): void {
    if (this.pendingStart?.generation !== generation) return;
    const pending = this.pendingStart;
    this.pendingStart = undefined;
    pending.resolve(result);
  }

  private success(snapshot: VoiceSessionSnapshot): VoiceSessionOperationResult {
    return { ok: true, snapshot };
  }

  private unavailable(operation: 'start' | 'stop' | 'interrupt') {
    return {
      ok: false as const,
      error: new VoiceSessionError(
        'unavailable',
        'Voice session is no longer active.',
        operation,
      ),
    };
  }

  private track(
    operation: 'start' | 'stop' | 'error' | 'interrupt',
    outcome: 'success' | 'failure',
    reason: LifecycleReason,
  ): void {
    this.dependencies.track('station.voice.session.lifecycle', {
      layer: 'browser',
      adapter: 'nova-s2s',
      operation,
      outcome,
      reason,
    });
  }
}
