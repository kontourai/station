import {
  type VoiceSessionAdapter,
  VoiceSessionError,
  type VoiceSessionLifecycleState,
  type VoiceSessionOperationResult,
  type VoiceSessionSnapshot,
  type VoiceSessionStartInput,
} from '@kontourai/station-sdk/voice';
import type {
  IS2SProvider,
  S2SAudioFormat,
  S2SCorrelatedToolUseEvent,
  S2SCorrelatedTurn,
  S2SCorrelatedTurnEnd,
  S2SProviderState,
  S2SSessionConfig,
  S2SToolUseEvent,
  S2STranscript,
} from './s2s-types.js';
import { supportsS2SCorrelatedTurnsV1 } from './s2s-types.js';

export type VoiceLifecycleOperation = 'start' | 'stop' | 'error' | 'interrupt';
export type VoiceLifecycleOutcome = 'success' | 'failure';
export type VoiceLifecycleReason =
  | 'explicit'
  | 'barge_in'
  | 'socket_close'
  | 'socket_error'
  | 'provider_failed'
  | 'service_stop';

export interface VoiceLifecycleRecord {
  operation: VoiceLifecycleOperation;
  outcome: VoiceLifecycleOutcome;
  reason?: VoiceLifecycleReason;
}

export interface S2SSessionAdapterCallbacks {
  onAudio(chunk: Buffer): void;
  onTranscript(transcript: S2STranscript): void;
  onToolUse(event: S2SToolUseEvent): void | Promise<void>;
  onCorrelatedTurnStart?(turn: S2SCorrelatedTurn): void | Promise<void>;
  onCorrelatedTurnEnd?(turn: S2SCorrelatedTurnEnd): void | Promise<void>;
  onCorrelatedToolUse?(event: S2SCorrelatedToolUseEvent): void | Promise<void>;
  onError(error: Error): void;
  recordLifecycle?(record: VoiceLifecycleRecord): void;
}

function mapProviderState(state: S2SProviderState): VoiceSessionLifecycleState {
  switch (state) {
    case 'idle':
      return 'connected-idle';
    case 'processing':
      return 'thinking';
    default:
      return state;
  }
}

/**
 * Canonical Station Voice adapter for one server-side speech-to-speech
 * provider. Provider payloads stay on typed callbacks; snapshots expose only
 * provider-neutral lifecycle and identity.
 */
export class S2SSessionAdapter implements VoiceSessionAdapter {
  readonly descriptor = Object.freeze({
    id: 'nova-s2s',
    name: 'Nova speech-to-speech',
    description: 'Station server speech-to-speech session',
  });
  readonly capabilities = Object.freeze({
    interrupt: false,
    updateContext: false,
    textTurn: false,
  });

  private readonly listeners = new Set<() => void>();
  private snapshot: VoiceSessionSnapshot = Object.freeze({
    state: 'disconnected',
    revision: 0,
  });
  private startInFlight: Promise<VoiceSessionOperationResult> | undefined;
  private stopInFlight: Promise<VoiceSessionOperationResult> | undefined;
  private closed = false;
  private readonly stoppedDuringStart: Promise<void>;
  private resolveStoppedDuringStart!: () => void;
  private previousProviderState: S2SProviderState = 'disconnected';
  private connectedInputAudioFormat: S2SAudioFormat | undefined;

  private readonly onAudio = (chunk: Buffer) => {
    if (!this.closed) this.callbacks.onAudio(chunk);
  };
  private readonly onTranscript = (transcript: S2STranscript) => {
    if (!this.closed) this.callbacks.onTranscript(transcript);
  };
  private readonly onToolUse = (event: S2SToolUseEvent) => {
    if (!this.closed) void this.callbacks.onToolUse(event);
  };
  private readonly onCorrelatedTurnStart = (turn: S2SCorrelatedTurn) => {
    if (!this.closed) void this.callbacks.onCorrelatedTurnStart?.(turn);
  };
  private readonly onCorrelatedTurnEnd = (turn: S2SCorrelatedTurnEnd) => {
    if (!this.closed) void this.callbacks.onCorrelatedTurnEnd?.(turn);
  };
  private readonly onCorrelatedToolUse = (event: S2SCorrelatedToolUseEvent) => {
    if (!this.closed) void this.callbacks.onCorrelatedToolUse?.(event);
  };
  private recordLifecycle(record: VoiceLifecycleRecord): void {
    try {
      this.callbacks.recordLifecycle?.(record);
    } catch {
      // Lifecycle observers must never control provider cleanup or delivery.
    }
  }
  private readonly onStateChange = (state: S2SProviderState) => {
    if (this.closed) return;
    if (this.previousProviderState === 'speaking' && state === 'listening') {
      this.recordLifecycle({
        operation: 'interrupt',
        outcome: 'success',
        reason: 'barge_in',
      });
    }
    this.previousProviderState = state;
    this.publish({ ...this.snapshot, state: mapProviderState(state) });
  };
  private readonly onProviderError = (_error: Error) => {
    if (this.closed) return;
    const sessionError = new VoiceSessionError(
      'operation-failed',
      'The speech-to-speech provider failed.',
    );
    this.recordLifecycle({
      operation: 'error',
      outcome: 'failure',
      reason: 'provider_failed',
    });
    this.publish({ ...this.snapshot, state: 'error', error: sessionError });
    this.callbacks.onError(new Error('The speech-to-speech provider failed.'));
  };

  constructor(
    private readonly provider: IS2SProvider,
    private readonly config: S2SSessionConfig,
    private readonly callbacks: S2SSessionAdapterCallbacks,
  ) {
    this.stoppedDuringStart = new Promise((resolve) => {
      this.resolveStoppedDuringStart = resolve;
    });
    provider.on('audio', this.onAudio);
    provider.on('transcript', this.onTranscript);
    provider.on('toolUse', this.onToolUse);
    // The base S2S EventEmitter is source-compatible with older providers.
    // Do not let an unmarked implementation mint authoritative correlation by
    // merely emitting an event with a convenient name.
    if (supportsS2SCorrelatedTurnsV1(provider)) {
      provider.on('correlatedTurnStart', this.onCorrelatedTurnStart);
      provider.on('correlatedTurnEnd', this.onCorrelatedTurnEnd);
      provider.on('correlatedToolUse', this.onCorrelatedToolUse);
    }
    provider.on('stateChange', this.onStateChange);
    provider.on('error', this.onProviderError);
  }

  get outputAudioFormat(): S2SAudioFormat {
    return this.provider.outputAudioFormat;
  }

  get inputAudioFormat(): S2SAudioFormat | undefined {
    return this.connectedInputAudioFormat;
  }

  getSnapshot(): VoiceSessionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(input?: VoiceSessionStartInput): Promise<VoiceSessionOperationResult> {
    if (this.startInFlight) return this.startInFlight;
    if (this.closed) {
      return Promise.resolve(
        this.failure('start', 'The voice session has already stopped.'),
      );
    }
    // Reserve the operation before notifying subscribers. A synchronous
    // subscriber may stop (or call start again) while `connecting` publishes;
    // the deferred provider call then observes `closed` before it can activate.
    const operation = Promise.resolve().then(() => this.startProvider());
    this.startInFlight = operation;
    this.publish({
      state: 'connecting',
      revision: this.snapshot.revision,
      ...(input?.controlSessionId
        ? { controlSessionId: input.controlSessionId }
        : {}),
      ...(input?.conversationSessionId
        ? { conversationSessionId: input.conversationSessionId }
        : {}),
    });
    void operation.then(
      () => {
        if (this.startInFlight === operation) this.startInFlight = undefined;
      },
      () => {
        if (this.startInFlight === operation) this.startInFlight = undefined;
      },
    );
    return operation;
  }

  stop(): Promise<VoiceSessionOperationResult> {
    if (this.stopInFlight) return this.stopInFlight;
    if (this.closed && this.snapshot.state === 'disconnected') {
      return Promise.resolve({ ok: true, snapshot: this.snapshot });
    }
    this.closed = true;
    this.resolveStoppedDuringStart();
    this.publish({ ...this.snapshot, state: 'stopping' });
    const operation = this.stopProvider();
    this.stopInFlight = operation;
    void operation.then(
      () => {
        if (this.stopInFlight === operation) this.stopInFlight = undefined;
      },
      () => {
        if (this.stopInFlight === operation) this.stopInFlight = undefined;
      },
    );
    return operation;
  }

  private async startProvider(): Promise<VoiceSessionOperationResult> {
    if (this.closed) {
      return this.failure(
        'start',
        'The voice session stopped while connecting.',
      );
    }
    try {
      const connectResult = this.provider
        .connect(this.config)
        .then(
          (inputAudioFormat) =>
            ({ kind: 'connected', inputAudioFormat }) as const,
        );
      const result = await Promise.race([
        connectResult,
        this.stoppedDuringStart.then(() => ({ kind: 'stopped' }) as const),
      ]);
      if (result.kind === 'stopped' || this.closed) {
        return this.failure(
          'start',
          'The voice session stopped while connecting.',
        );
      }
      this.connectedInputAudioFormat = result.inputAudioFormat;
      this.recordLifecycle({
        operation: 'start',
        outcome: 'success',
      });
      if (this.snapshot.state === 'connecting') {
        this.publish({ ...this.snapshot, state: 'connected-idle' });
      }
      return { ok: true, snapshot: this.snapshot };
    } catch (_cause) {
      const result = this.failure(
        'start',
        'The speech-to-speech provider could not start.',
      );
      if (this.closed) return result;
      this.recordLifecycle({
        operation: 'start',
        outcome: 'failure',
        reason: 'provider_failed',
      });
      this.publish({ ...this.snapshot, state: 'error', error: result.error });
      return result;
    }
  }

  private async stopProvider(): Promise<VoiceSessionOperationResult> {
    try {
      await this.provider.disconnect();
      this.recordLifecycle({
        operation: 'stop',
        outcome: 'success',
      });
      this.publish({
        state: 'disconnected',
        revision: this.snapshot.revision,
        ...(this.snapshot.controlSessionId
          ? { controlSessionId: this.snapshot.controlSessionId }
          : {}),
        ...(this.snapshot.conversationSessionId
          ? { conversationSessionId: this.snapshot.conversationSessionId }
          : {}),
      });
      this.detachProviderListeners();
      return { ok: true, snapshot: this.snapshot };
    } catch (_cause) {
      const result = this.failure(
        'stop',
        'The speech-to-speech provider could not stop cleanly.',
      );
      this.recordLifecycle({
        operation: 'stop',
        outcome: 'failure',
        reason: 'provider_failed',
      });
      this.publish({ ...this.snapshot, state: 'error', error: result.error });
      return result;
    }
  }

  private detachProviderListeners(): void {
    this.provider.off('audio', this.onAudio);
    this.provider.off('transcript', this.onTranscript);
    this.provider.off('toolUse', this.onToolUse);
    if (supportsS2SCorrelatedTurnsV1(this.provider)) {
      this.provider.off('correlatedTurnStart', this.onCorrelatedTurnStart);
      this.provider.off('correlatedTurnEnd', this.onCorrelatedTurnEnd);
      this.provider.off('correlatedToolUse', this.onCorrelatedToolUse);
    }
    this.provider.off('stateChange', this.onStateChange);
    this.provider.off('error', this.onProviderError);
  }

  private publish(
    input: Omit<VoiceSessionSnapshot, 'revision'> & { revision?: number },
  ): VoiceSessionSnapshot {
    this.snapshot = Object.freeze({
      ...input,
      revision: this.snapshot.revision + 1,
    });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Snapshot observers cannot control provider lifecycle transitions.
      }
    }
    return this.snapshot;
  }

  private failure(
    operation: 'start' | 'stop',
    message: string,
  ): Extract<VoiceSessionOperationResult, { ok: false }> {
    return {
      ok: false,
      error: new VoiceSessionError('operation-failed', message, operation),
    };
  }
}

export { mapProviderState as mapS2SProviderState };
