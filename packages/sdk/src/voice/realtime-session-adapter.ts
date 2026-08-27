import { ListenerManager } from '../core/ListenerManager.js';
import { immutableContext } from './composition-utils.js';
import type {
  VoiceRealtimeConnection,
  VoiceRealtimeEvent,
  VoiceRealtimeProvider,
  VoiceRealtimeReadiness,
  VoiceRealtimeUsage,
} from './realtime-types.js';
import {
  type VoiceSessionAdapter,
  type VoiceSessionAudioInput,
  type VoiceSessionContextUpdate,
  VoiceSessionError,
  type VoiceSessionOperation,
  type VoiceSessionOperationResult,
  type VoiceSessionSnapshot,
  type VoiceSessionStartInput,
  type VoiceSessionTextTurn,
} from './session-types.js';

export interface RealtimeVoiceSessionAdapterOptions {
  /** Receives current-generation provider audio for host-owned playback. */
  readonly onSpeech?: (audio: Uint8Array) => void;
  /** Receives content-free current-generation provider usage. */
  readonly onUsage?: (usage: Readonly<VoiceRealtimeUsage>) => void;
}

/**
 * Generic, browser-safe lifecycle owner for a provider pack. Authorization
 * never leaves the provider's opaque lease closure.
 */
export class RealtimeVoiceSessionAdapter
  extends ListenerManager
  implements VoiceSessionAdapter
{
  readonly descriptor;
  readonly capabilities;
  private snapshot: VoiceSessionSnapshot = Object.freeze({
    state: 'disconnected',
    revision: 0,
  });
  private tail: Promise<void> = Promise.resolve();
  private startInFlight: Promise<VoiceSessionOperationResult> | undefined;
  private reconnectInFlight: Promise<VoiceSessionOperationResult> | undefined;
  private stopInFlight: Promise<VoiceSessionOperationResult> | undefined;
  private connection: VoiceRealtimeConnection | undefined;
  private unsubscribeConnection: (() => void) | undefined;
  private closeInFlight:
    | {
        readonly connection: VoiceRealtimeConnection;
        readonly operation: Promise<void>;
      }
    | undefined;
  private intentGeneration = 0;
  private connectionGeneration = 0;
  private activeAbortController: AbortController | undefined;
  private startInput: VoiceSessionStartInput | undefined;
  private immutableContext: Readonly<Record<string, unknown>> | undefined;

  constructor(
    private readonly provider: VoiceRealtimeProvider,
    private readonly options: RealtimeVoiceSessionAdapterOptions = {},
  ) {
    super();
    this.descriptor = Object.freeze({ ...provider.descriptor });
    this.capabilities = Object.freeze({
      interrupt: provider.capabilities.interrupt,
      reconnect: true,
      updateContext: provider.capabilities.updateContext,
      textTurn: provider.capabilities.textTurn,
      audioInput: provider.capabilities.audioInput,
    });
  }

  getSnapshot(): VoiceSessionSnapshot {
    return this.snapshot;
  }

  start(input?: VoiceSessionStartInput): Promise<VoiceSessionOperationResult> {
    if (this.stopInFlight) {
      const pendingStop = this.stopInFlight;
      const operation = pendingStop.then(() => this.beginStart(input));
      return this.trackStart(operation);
    }
    if (this.startInFlight) return this.startInFlight;
    if (this.reconnectInFlight) return this.reconnectInFlight;
    if (this.connection) {
      const pendingClose = this.closeInFlight;
      if (
        this.snapshot.state === 'disconnected' &&
        pendingClose?.connection === this.connection
      ) {
        return this.trackStart(
          pendingClose.operation.then(
            () => this.beginStart(input),
            () => this.failure('start', 'unavailable'),
          ),
        );
      }
      // A retained connection after a failed close is cleanup-only ownership,
      // not a usable live session. Its listener is detached and callers must
      // retry stop before another start can succeed.
      return Promise.resolve(
        this.snapshot.state === 'connected-idle'
          ? this.success()
          : this.failure('start', 'unavailable'),
      );
    }
    return this.trackStart(this.beginStart(input));
  }

  private beginStart(
    input: VoiceSessionStartInput | undefined,
  ): Promise<VoiceSessionOperationResult> {
    if (input) {
      this.startInput = Object.freeze({
        ...(input.controlSessionId
          ? { controlSessionId: input.controlSessionId }
          : {}),
        ...(input.conversationSessionId
          ? { conversationSessionId: input.conversationSessionId }
          : {}),
      });
      this.immutableContext = immutableContext(input.context);
    }
    const intent = ++this.intentGeneration;
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.publish({ ...this.snapshot, state: 'connecting', error: undefined });
    return this.enqueue(() => this.open(intent, controller));
  }

  private trackStart(
    operation: Promise<VoiceSessionOperationResult>,
  ): Promise<VoiceSessionOperationResult> {
    this.startInFlight = operation;
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

  reconnect(): Promise<VoiceSessionOperationResult> {
    if (this.stopInFlight || this.snapshot.state === 'stopping') {
      return Promise.resolve(this.failure('reconnect', 'unavailable'));
    }
    if (this.reconnectInFlight) return this.reconnectInFlight;
    if (this.startInFlight) return this.startInFlight;
    const intent = ++this.intentGeneration;
    this.activeAbortController?.abort();
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.publish({ ...this.snapshot, state: 'connecting', error: undefined });
    const operation = this.enqueue(async () => {
      try {
        await this.closeCurrent();
        return this.open(intent, controller, 'reconnect');
      } catch {
        if (this.activeAbortController === controller)
          this.activeAbortController = undefined;
        const result = this.failure('reconnect', 'unavailable');
        if (this.isCurrentIntent(intent)) {
          this.publish({
            ...this.snapshot,
            state: 'error',
            error: result.error,
          });
        }
        return result;
      }
    });
    this.reconnectInFlight = operation;
    void operation.then(
      () => {
        if (this.reconnectInFlight === operation)
          this.reconnectInFlight = undefined;
      },
      () => {
        if (this.reconnectInFlight === operation)
          this.reconnectInFlight = undefined;
      },
    );
    return operation;
  }

  stop(): Promise<VoiceSessionOperationResult> {
    if (this.stopInFlight) return this.stopInFlight;
    this.activeAbortController?.abort();
    ++this.intentGeneration;
    ++this.connectionGeneration;
    this.publish({ ...this.snapshot, state: 'stopping', error: undefined });
    // A stopped provider can ignore AbortSignal indefinitely. Resetting the
    // queue lets the lifecycle become disconnected promptly; stale opens are
    // generation-gated and close themselves if they later settle.
    this.tail = Promise.resolve();
    const stopIntent = this.intentGeneration;
    const operation = (async (): Promise<VoiceSessionOperationResult> => {
      try {
        await this.closeCurrent();
        if (this.isCurrentIntent(stopIntent)) {
          this.publish({
            ...this.snapshot,
            state: 'disconnected',
            error: undefined,
          });
        }
        return this.success();
      } catch {
        const result = this.failure('stop', 'unavailable');
        if (this.isCurrentIntent(stopIntent)) {
          this.publish({
            ...this.snapshot,
            state: 'error',
            error: result.error,
          });
        }
        return result;
      }
    })();
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

  async interrupt(): Promise<VoiceSessionOperationResult> {
    return this.runConnectionOperation(
      'interrupt',
      (connection) => connection.interrupt !== undefined,
      (connection) => connection.interrupt!(),
    );
  }

  async updateContext(
    input: VoiceSessionContextUpdate,
  ): Promise<VoiceSessionOperationResult> {
    return this.runConnectionOperation(
      'update-context',
      (connection) => connection.updateContext !== undefined,
      (connection) => connection.updateContext!(input),
    );
  }

  async sendText(
    input: VoiceSessionTextTurn,
  ): Promise<VoiceSessionOperationResult> {
    return this.runConnectionOperation(
      'send-text',
      (connection) => connection.sendText !== undefined,
      (connection) => connection.sendText!(input),
    );
  }

  async sendAudio(
    input: VoiceSessionAudioInput,
  ): Promise<VoiceSessionOperationResult> {
    return this.runConnectionOperation(
      'send-audio',
      (connection) => connection.sendAudio !== undefined,
      (connection) => connection.sendAudio!(input.audio),
    );
  }

  private async open(
    intent: number,
    controller: AbortController,
    operation: Extract<VoiceSessionOperation, 'start' | 'reconnect'> = 'start',
  ): Promise<VoiceSessionOperationResult> {
    if (!this.isCurrentIntent(intent))
      return this.failure(operation, 'unavailable');
    try {
      const readiness = await this.provider.readiness(controller.signal);
      if (readiness.status !== 'ready')
        return this.readinessFailure(operation, readiness);
      const lease = await this.provider.mint({
        signal: controller.signal,
        context: this.immutableContext,
      });
      const connection = await lease.open(controller.signal);
      if (!this.isCurrentIntent(intent)) {
        try {
          await this.closeUnattachedConnection(connection);
        } catch {
          // Retained cleanup ownership is retried by stop; provider detail is
          // never allowed to escape this stale-open path.
        }
        return this.failure(operation, 'unavailable');
      }
      const generation = ++this.connectionGeneration;
      this.connection = connection;
      let unsubscribe: () => void;
      try {
        unsubscribe = connection.subscribe((event) =>
          this.receiveEvent(generation, event),
        );
      } catch {
        await this.abandonConnection(connection, generation);
        throw new Error('Realtime connection subscription failed.');
      }
      if (
        this.connection !== connection ||
        generation !== this.connectionGeneration
      ) {
        this.notifyHost(unsubscribe);
        await this.abandonConnection(connection, generation);
        return this.failure(operation, 'unavailable');
      }
      this.unsubscribeConnection = unsubscribe;
      this.publish({
        ...this.snapshot,
        state: 'connected-idle',
        error: undefined,
      });
      return this.success();
    } catch {
      if (!this.isCurrentIntent(intent))
        return this.failure(operation, 'unavailable');
      const result = this.failure(operation, 'unavailable');
      this.publish({ ...this.snapshot, state: 'error', error: result.error });
      return result;
    } finally {
      if (this.activeAbortController === controller)
        this.activeAbortController = undefined;
    }
  }

  private async runConnectionOperation(
    operation: Extract<
      VoiceSessionOperation,
      'interrupt' | 'update-context' | 'send-text' | 'send-audio'
    >,
    isSupported: (connection: VoiceRealtimeConnection) => boolean,
    invoke: (connection: VoiceRealtimeConnection) => Promise<void>,
  ): Promise<VoiceSessionOperationResult> {
    if (this.stopInFlight || this.snapshot.state === 'stopping') {
      return this.failure(operation, 'unavailable');
    }
    const connection = this.connection;
    if (!connection) return this.failure(operation, 'unavailable');
    if (!isSupported(connection)) return this.failure(operation, 'unsupported');
    const expectedGeneration = this.connectionGeneration;
    return this.enqueue(async () => {
      if (
        this.connection !== connection ||
        expectedGeneration !== this.connectionGeneration
      ) {
        return this.failure(operation, 'unavailable');
      }
      if (!isSupported(connection))
        return this.failure(operation, 'unsupported');
      await invoke(connection);
      return this.success();
    }).catch(() => this.failure(operation, 'unavailable'));
  }

  private receiveEvent(generation: number, event: VoiceRealtimeEvent): void {
    if (generation !== this.connectionGeneration) return;
    switch (event.type) {
      case 'state':
        this.publish({ ...this.snapshot, state: event.state });
        break;
      case 'transcript':
        this.publish({
          ...this.snapshot,
          transcript: event.text,
          transcriptRole: event.role,
        });
        break;
      case 'disconnect':
        {
          const connection = this.connection;
          const unsubscribe = this.unsubscribeConnection;
          this.unsubscribeConnection = undefined;
          if (unsubscribe) this.notifyHost(unsubscribe);
          ++this.connectionGeneration;
          this.publish({ ...this.snapshot, state: 'disconnected' });
          if (connection) {
            const closing = this.closeConnection(connection);
            void closing.then(
              () => {
                if (this.connection === connection) this.connection = undefined;
              },
              () => {
                // Retain ownership so a later stop can retry provider cleanup.
              },
            );
          }
        }
        break;
      case 'error': {
        const result = this.failure(undefined, event.code ?? 'unavailable');
        this.publish({ ...this.snapshot, state: 'error', error: result.error });
        break;
      }
      case 'speech':
        this.notifyHost(() =>
          this.options.onSpeech?.(new Uint8Array(event.audio)),
        );
        break;
      case 'usage':
        this.notifyHost(() =>
          this.options.onUsage?.(
            Object.freeze({
              ...(event.inputAudioMs === undefined
                ? {}
                : { inputAudioMs: event.inputAudioMs }),
              ...(event.outputAudioMs === undefined
                ? {}
                : { outputAudioMs: event.outputAudioMs }),
            }),
          ),
        );
        break;
    }
  }

  private notifyHost(notify: () => void): void {
    try {
      notify();
    } catch {
      // Host presentation/telemetry sinks cannot corrupt provider lifecycle.
    }
  }

  private async closeCurrent(): Promise<void> {
    const connection = this.connection;
    // Ignore late provider events immediately, but retain the connection until
    // close succeeds so a failed stop still owns cleanup and can be retried.
    const unsubscribe = this.unsubscribeConnection;
    this.unsubscribeConnection = undefined;
    if (unsubscribe) this.notifyHost(unsubscribe);
    if (!connection) return;
    await this.closeConnection(connection);
    if (this.connection === connection) this.connection = undefined;
  }

  private async abandonConnection(
    connection: VoiceRealtimeConnection,
    generation: number,
  ): Promise<void> {
    if (this.connectionGeneration === generation) ++this.connectionGeneration;
    await this.closeUnattachedConnection(connection);
    if (this.connection === connection) this.connection = undefined;
  }

  private async closeUnattachedConnection(
    connection: VoiceRealtimeConnection,
  ): Promise<void> {
    try {
      await this.closeConnection(connection);
    } catch {
      if (!this.connection) this.connection = connection;
      throw new Error('Realtime connection cleanup failed.');
    }
  }

  private closeConnection(connection: VoiceRealtimeConnection): Promise<void> {
    const current = this.closeInFlight;
    if (current?.connection === connection) return current.operation;
    const operation = Promise.resolve().then(() => connection.close());
    this.closeInFlight = { connection, operation };
    void operation.then(
      () => {
        if (this.closeInFlight?.operation === operation)
          this.closeInFlight = undefined;
      },
      () => {
        if (this.closeInFlight?.operation === operation)
          this.closeInFlight = undefined;
      },
    );
    return operation;
  }

  private isCurrentIntent(intent: number): boolean {
    return intent === this.intentGeneration;
  }

  private readinessFailure(
    operation: VoiceSessionOperation,
    readiness: Exclude<VoiceRealtimeReadiness, { status: 'ready' }>,
  ): VoiceSessionOperationResult {
    const result = this.failure(operation, readiness.status);
    this.publish({ ...this.snapshot, state: 'error', error: result.error });
    return result;
  }

  private failure(
    operation: VoiceSessionOperation | undefined,
    code: 'unavailable' | 'unsupported' | 'unconfigured' | 'rate-limited',
  ): Extract<VoiceSessionOperationResult, { ok: false }> {
    const messages = {
      unavailable: 'The realtime voice provider is unavailable.',
      unsupported:
        'The realtime voice provider does not support this operation.',
      unconfigured: 'The realtime voice provider is not configured.',
      'rate-limited': 'The realtime voice provider is rate limited.',
    } as const;
    return {
      ok: false,
      error: new VoiceSessionError(code, messages[code], operation),
    };
  }

  private success(): Extract<VoiceSessionOperationResult, { ok: true }> {
    return { ok: true, snapshot: this.snapshot };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.tail.then(operation, operation);
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private publish(
    next: Omit<VoiceSessionSnapshot, 'revision'> & { revision?: number },
  ): void {
    this.snapshot = Object.freeze({
      ...next,
      ...(this.startInput?.controlSessionId
        ? { controlSessionId: this.startInput.controlSessionId }
        : {}),
      ...(this.startInput?.conversationSessionId
        ? { conversationSessionId: this.startInput.conversationSessionId }
        : {}),
      revision: this.snapshot.revision + 1,
    });
    this._notify();
  }
}
