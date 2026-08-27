import { ListenerManager } from '../core/ListenerManager.js';
import {
  type VoiceSessionAdapter,
  type VoiceSessionAdapterCapabilities,
  type VoiceSessionAdapterDescriptor,
  VoiceSessionError,
  type VoiceSessionOperation,
  type VoiceSessionOperationResult,
  type VoiceSessionSnapshot,
  type VoiceSessionStartInput,
} from './session-types.js';
import type { STTProvider, TTSProvider } from './types.js';

/**
 * Composes the established independent STT and TTS provider contracts into
 * one provider-neutral live-session adapter. It deliberately does not register
 * or wrap providers in the session registry: plugin authors keep their existing
 * direct `startListening`/`stopListening` and `speak`/`cancel` surfaces.
 */
export class ProviderVoiceSessionAdapter
  extends ListenerManager
  implements VoiceSessionAdapter
{
  readonly descriptor: VoiceSessionAdapterDescriptor = Object.freeze({
    id: 'provider-composed',
    name: 'Provider-composed voice session',
    description: 'Composes independent STT and TTS providers.',
  });

  readonly capabilities: VoiceSessionAdapterCapabilities = Object.freeze({
    interrupt: true,
    textTurn: false,
  });

  private snapshot: VoiceSessionSnapshot = Object.freeze({
    state: 'disconnected',
    revision: 0,
  });
  private controlSessionId: string | undefined;
  private conversationSessionId: string | undefined;
  private started = false;
  private stopping = false;
  private disposed = false;
  private disposePromise: Promise<VoiceSessionOperationResult> | undefined;
  private readonly unsubscribeSTT: () => void;
  private readonly unsubscribeTTS: () => void;

  constructor(
    private readonly stt: STTProvider,
    private readonly tts: TTSProvider,
  ) {
    super();
    this.unsubscribeSTT = stt.subscribe(() => this.refreshFromProviders());
    this.unsubscribeTTS = tts.subscribe(() => this.refreshFromProviders());
  }

  getSnapshot(): VoiceSessionSnapshot {
    return this.snapshot;
  }

  async start(
    input?: VoiceSessionStartInput,
  ): Promise<VoiceSessionOperationResult> {
    if (this.disposed) return this.unavailable('start');
    if (this.started) return this.success(this.snapshot);

    this.controlSessionId = input?.controlSessionId ?? this.controlSessionId;
    this.conversationSessionId =
      input?.conversationSessionId ?? this.conversationSessionId;
    this.publish('connecting');
    this.started = true;

    try {
      this.stt.startListening();
    } catch (cause) {
      this.started = false;
      this.cleanupAfterFailedStart();
      return this.failed('start', cause);
    }

    if (this.stt.state === 'error') {
      this.started = false;
      this.cleanupAfterFailedStart();
      return this.providerFailed('start');
    }

    return this.success(this.refreshFromProviders());
  }

  async stop(): Promise<VoiceSessionOperationResult> {
    if (this.disposed) return this.success(this.snapshot);
    return this.stopProviders();
  }

  private async stopProviders(): Promise<VoiceSessionOperationResult> {
    this.stopping = true;
    this.publish('stopping');
    let cause: unknown;

    try {
      this.stt.stopListening();
    } catch (error) {
      cause = error;
    }

    try {
      this.tts.cancel();
    } catch (error) {
      cause ??= error;
    }

    this.started = false;
    this.stopping = false;
    return cause === undefined
      ? this.success(this.publish('disconnected'))
      : this.failed('stop', cause);
  }

  async interrupt(): Promise<VoiceSessionOperationResult> {
    if (this.disposed) return this.unavailable('interrupt');

    try {
      this.tts.cancel();
      return this.success(this.refreshFromProviders());
    } catch (cause) {
      return this.failed('interrupt', cause);
    }
  }

  /** Stops the independent providers, unsubscribes from them, and releases listeners. */
  dispose(): Promise<VoiceSessionOperationResult> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = Promise.resolve()
      .then(() => this.stopProviders())
      .finally(() => {
        this.unsubscribeSTT();
        this.unsubscribeTTS();
        this._clearListeners();
      });
    return this.disposePromise;
  }

  private refreshFromProviders(): VoiceSessionSnapshot {
    if (this.stopping || this.disposed) return this.snapshot;
    if (!this.started) {
      const externallyActive = this.stt.state !== 'idle' || this.tts.speaking;
      if (!externallyActive) return this.snapshot;
      // Existing plugin consumers may keep invoking the unchanged provider
      // methods directly. Treat that activity as a live composed session so
      // the normalized adapter remains an honest projection during migration.
      this.started = true;
    }
    if (this.stt.state === 'error') {
      return this.publish('error', this.providerError('start'));
    }
    if (this.tts.speaking) return this.publish('speaking');
    if (this.stt.state === 'listening') return this.publish('listening');
    return this.publish('connected-idle');
  }

  private publish(
    state: VoiceSessionSnapshot['state'],
    error?: VoiceSessionError,
  ): VoiceSessionSnapshot {
    const transcript = this.stt.transcript;
    this.snapshot = Object.freeze({
      state,
      revision: this.snapshot.revision + 1,
      ...(this.controlSessionId !== undefined
        ? { controlSessionId: this.controlSessionId }
        : {}),
      ...(this.conversationSessionId !== undefined
        ? { conversationSessionId: this.conversationSessionId }
        : {}),
      ...(transcript ? { transcript, transcriptRole: 'user' as const } : {}),
      ...(error ? { error } : {}),
    });
    this._notify();
    return this.snapshot;
  }

  private success(snapshot: VoiceSessionSnapshot): VoiceSessionOperationResult {
    return { ok: true, snapshot };
  }

  private unavailable(
    operation: VoiceSessionOperation,
  ): VoiceSessionOperationResult {
    return {
      ok: false,
      error: new VoiceSessionError(
        'unavailable',
        'The provider voice-session adapter has been disposed.',
        operation,
      ),
    };
  }

  private providerFailed(
    operation: VoiceSessionOperation,
  ): VoiceSessionOperationResult {
    const error = this.providerError(operation);
    return { ok: false, error: this.publish('error', error).error! };
  }

  private providerError(operation: VoiceSessionOperation): VoiceSessionError {
    return new VoiceSessionError(
      'operation-failed',
      'The independent speech-to-text provider reported an error.',
      operation,
    );
  }

  private cleanupAfterFailedStart(): void {
    try {
      this.stt.stopListening();
    } catch {}
    try {
      this.tts.cancel();
    } catch {}
  }

  private failed(
    operation: VoiceSessionOperation,
    cause: unknown,
  ): VoiceSessionOperationResult {
    const message =
      cause instanceof Error
        ? cause.message
        : 'Provider voice-session operation failed.';
    const error = new VoiceSessionError(
      'operation-failed',
      message,
      operation,
      cause,
    );
    this.publish('error', error);
    return { ok: false, error };
  }
}

export function createProviderVoiceSessionAdapter(
  stt: STTProvider,
  tts: TTSProvider,
): ProviderVoiceSessionAdapter {
  return new ProviderVoiceSessionAdapter(stt, tts);
}
