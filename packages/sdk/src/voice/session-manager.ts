import { ListenerManager } from '../core/ListenerManager.js';
import { VoiceSessionAdapterRegistry } from './session-registry.js';
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

const INITIAL_SNAPSHOT: VoiceSessionSnapshot = Object.freeze({
  state: 'disconnected',
  revision: 0,
});

interface ActiveAdapter {
  readonly adapter: VoiceSessionAdapter;
  unsubscribe: () => void;
  readonly generation: number;
  phase: 'starting' | 'started' | 'stopping';
  startInvoked: boolean;
}

/**
 * A browser-safe manager for one selected voice-session adapter. Mutations use
 * one promise tail, while intent generations keep late provider completions
 * from projecting over a newer lifecycle request.
 */
export class VoiceSessionManager extends ListenerManager {
  private selectedAdapterId: string | undefined;
  private active: ActiveAdapter | undefined;
  private snapshot: VoiceSessionSnapshot = INITIAL_SNAPSHOT;
  private tail: Promise<void> = Promise.resolve();
  private intentGeneration = 0;
  private disposed = false;
  private disposalAdapter: VoiceSessionAdapter | undefined;
  private disposeInFlight: Promise<VoiceSessionOperationResult> | undefined;
  private disposeResult: VoiceSessionOperationResult | undefined;
  private startInFlight: Promise<VoiceSessionOperationResult> | undefined;
  private restartInFlight: Promise<VoiceSessionOperationResult> | undefined;
  private stopInFlight: Promise<VoiceSessionOperationResult> | undefined;

  constructor(private readonly registry: VoiceSessionAdapterRegistry) {
    super();
  }

  select(adapterId: string | undefined): void {
    this.selectedAdapterId = adapterId;
  }

  getSelectedAdapterId(): string | undefined {
    return this.selectedAdapterId;
  }

  getSnapshot(): VoiceSessionSnapshot {
    return this.snapshot;
  }

  start(input?: VoiceSessionStartInput): Promise<VoiceSessionOperationResult> {
    if (this.disposed) return Promise.resolve(this.unavailable('start'));

    // A queued restart remains the canonical start request while it moves
    // from waiting behind stop into its own asynchronous adapter.start().
    if (this.restartInFlight) return this.restartInFlight;

    if (this.active?.phase === 'stopping') {
      // This restart intentionally sits behind the already queued stop. It is
      // not a success placeholder: it resolves the then-current selection and
      // invokes that adapter's start only after the retained active session ends.
      const operation = this.enqueue(async () => {
        if (this.active) return this.unavailable('start');
        const active = this.prepareStart();
        if (!active) return this.unavailable('start');
        return this.runStart(active, input);
      });
      return this.trackRestart(operation);
    }

    if (this.startInFlight) return this.startInFlight;
    if (this.active) return Promise.resolve(this.success(this.snapshot));
    const active = this.prepareStart();
    if (!active) return Promise.resolve(this.unavailable('start'));
    return this.trackStart(this.enqueue(() => this.runStart(active, input)));
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

  private trackRestart(
    operation: Promise<VoiceSessionOperationResult>,
  ): Promise<VoiceSessionOperationResult> {
    this.restartInFlight = operation;
    void operation.then(
      () => {
        if (this.restartInFlight === operation) {
          this.restartInFlight = undefined;
        }
      },
      () => {
        if (this.restartInFlight === operation) {
          this.restartInFlight = undefined;
        }
      },
    );
    return operation;
  }

  toggle(input?: VoiceSessionStartInput): Promise<VoiceSessionOperationResult> {
    return this.active?.phase === 'stopping'
      ? this.start(input)
      : this.active
        ? this.stop()
        : this.start(input);
  }

  stop(): Promise<VoiceSessionOperationResult> {
    if (this.disposed) return this.dispose();
    if (this.stopInFlight) return this.stopInFlight;
    const active = this.active;
    if (!active) return Promise.resolve(this.success(this.snapshot));

    // A restart belongs to the specific stop intent it followed. Accepting a
    // new stop (for example, retrying a failed stop) makes any older doomed
    // restart non-canonical so a later start can queue behind this stop.
    this.restartInFlight = undefined;
    this.nextIntent();
    active.phase = 'stopping';
    this.publish({ ...this.snapshot, state: 'stopping' });
    const operation = this.enqueue(async () => {
      try {
        const result = active.startInvoked
          ? await active.adapter.stop()
          : this.success(
              Object.freeze({
                ...active.adapter.getSnapshot(),
                state: 'disconnected',
              }),
            );
        if (result.ok) {
          if (this.active === active) {
            // A later optional request must not suppress the terminal stop
            // projection. Restarts are queued after this operation.
            this.publish(result.snapshot);
            active.unsubscribe();
            this.active = undefined;
          }
        } else if (this.active === active) {
          this.publish(this.errorSnapshot(result.error));
        }
        return result;
      } catch (error) {
        const result = this.failed('stop', error);
        if (this.active === active) {
          this.publish(this.errorSnapshot(result.error));
        }
        return result;
      }
    });
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

  interrupt(): Promise<VoiceSessionOperationResult> {
    const active = this.active;
    if (!active) return Promise.resolve(this.unavailable('interrupt'));
    if (!active.adapter.capabilities.interrupt || !active.adapter.interrupt) {
      return Promise.resolve(this.unsupported('interrupt'));
    }
    return this.runOptional(active, 'interrupt', () =>
      active.adapter.interrupt!(),
    );
  }

  reconnect(): Promise<VoiceSessionOperationResult> {
    const active = this.active;
    if (!active) return Promise.resolve(this.unavailable('reconnect'));
    if (!active.adapter.capabilities.reconnect || !active.adapter.reconnect) {
      return Promise.resolve(this.unsupported('reconnect'));
    }
    return this.runOptional(active, 'reconnect', () =>
      active.adapter.reconnect!(),
    );
  }

  updateContext(
    input: VoiceSessionContextUpdate,
  ): Promise<VoiceSessionOperationResult> {
    const active = this.active;
    if (!active) return Promise.resolve(this.unavailable('update-context'));
    if (
      !active.adapter.capabilities.updateContext ||
      !active.adapter.updateContext
    ) {
      return Promise.resolve(this.unsupported('update-context'));
    }
    return this.runOptional(active, 'update-context', () =>
      active.adapter.updateContext!(input),
    );
  }

  sendText(input: VoiceSessionTextTurn): Promise<VoiceSessionOperationResult> {
    const active = this.active;
    if (!active) return Promise.resolve(this.unavailable('send-text'));
    if (!active.adapter.capabilities.textTurn || !active.adapter.sendText) {
      return Promise.resolve(this.unsupported('send-text'));
    }
    return this.runOptional(active, 'send-text', () =>
      active.adapter.sendText!(input),
    );
  }

  sendAudio(
    input: VoiceSessionAudioInput,
  ): Promise<VoiceSessionOperationResult> {
    const active = this.active;
    if (!active) return Promise.resolve(this.unavailable('send-audio'));
    if (!active.adapter.capabilities.audioInput || !active.adapter.sendAudio) {
      return Promise.resolve(this.unsupported('send-audio'));
    }
    return this.runOptional(active, 'send-audio', () =>
      active.adapter.sendAudio!(input),
    );
  }

  dispose(): Promise<VoiceSessionOperationResult> {
    if (this.disposeInFlight) return this.disposeInFlight;
    if (this.disposeResult) return Promise.resolve(this.disposeResult);

    let operation: Promise<VoiceSessionOperationResult>;
    if (!this.disposed) {
      this.disposed = true;
      this.restartInFlight = undefined;

      const active = this.active;
      const pendingStop = this.stopInFlight;
      if (!active) {
        this.publish({
          state: 'disconnected',
          revision: this.snapshot.revision,
        });
        this._clearListeners();
        this.disposeResult = this.success(this.snapshot);
        return Promise.resolve(this.disposeResult);
      }

      active.phase = 'stopping';
      active.unsubscribe();
      this.active = undefined;
      this.disposalAdapter = active.adapter;
      this.publish({ ...this.snapshot, state: 'stopping' });
      this._clearListeners();

      operation = pendingStop
        ? this.finishDisposal(active.adapter, active.startInvoked, pendingStop)
        : this.enqueue(() =>
            this.finishDisposal(active.adapter, active.startInvoked),
          );
    } else {
      const adapter = this.disposalAdapter;
      if (!adapter) {
        this.disposeResult = this.success(this.snapshot);
        return Promise.resolve(this.disposeResult);
      }
      this.publish({ ...this.snapshot, state: 'stopping' });
      operation = this.enqueue(() => this.finishDisposal(adapter, true));
    }

    this.disposeInFlight = operation;
    void operation.then(
      () => {
        if (this.disposeInFlight === operation) {
          this.disposeInFlight = undefined;
        }
      },
      () => {
        if (this.disposeInFlight === operation) {
          this.disposeInFlight = undefined;
        }
      },
    );
    return operation;
  }

  private runOptional(
    active: ActiveAdapter,
    operation: VoiceSessionOperation,
    invoke: () => Promise<VoiceSessionOperationResult>,
  ): Promise<VoiceSessionOperationResult> {
    if (active.phase === 'stopping') {
      // Keep the caller's request after stop in queue order without allowing
      // it to supersede that lifecycle transition.
      return this.enqueue(async () => this.unavailable(operation));
    }
    const generation = this.nextIntent();
    return this.enqueue(async () => {
      if (this.active !== active || active.phase !== 'started') {
        return this.unavailable(operation);
      }
      try {
        const result = await invoke();
        this.applyCompletion(active.adapter, generation, result);
        return result;
      } catch (error) {
        const result = this.failed(operation, error);
        this.applyCompletion(active.adapter, generation, result);
        return result;
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.tail.then(operation, operation);
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private nextIntent(): number {
    this.intentGeneration += 1;
    return this.intentGeneration;
  }

  private prepareStart(): ActiveAdapter | undefined {
    if (this.disposed || this.active) return undefined;
    const adapter = this.selectedAdapterId
      ? this.registry.get(this.selectedAdapterId)
      : undefined;
    if (!adapter) return undefined;

    const active: ActiveAdapter = {
      adapter,
      generation: this.nextIntent(),
      phase: 'starting',
      startInvoked: false,
      unsubscribe: () => {},
    };
    active.unsubscribe = adapter.subscribe(() => {
      this.receiveAdapterSnapshot(active);
    });
    this.active = active;
    this.publish({ ...adapter.getSnapshot(), state: 'connecting' });
    return active;
  }

  private async runStart(
    active: ActiveAdapter,
    input?: VoiceSessionStartInput,
  ): Promise<VoiceSessionOperationResult> {
    if (
      this.disposed ||
      this.active !== active ||
      active.phase !== 'starting'
    ) {
      return this.unavailable('start');
    }
    active.startInvoked = true;
    try {
      const result = await active.adapter.start(input);
      if (this.disposed) return this.unavailable('start');
      if (this.active === active && active.phase === 'starting') {
        if (result.ok) {
          active.phase = 'started';
          this.applyCompletion(active.adapter, active.generation, result);
        } else {
          active.unsubscribe();
          this.active = undefined;
          if (active.generation === this.intentGeneration) {
            this.publish(this.errorSnapshot(result.error));
          }
        }
      }
      return result;
    } catch (error) {
      const result = this.failed('start', error);
      if (this.active === active && active.phase === 'starting') {
        active.unsubscribe();
        this.active = undefined;
        if (active.generation === this.intentGeneration) {
          this.publish(this.errorSnapshot(result.error));
        }
      }
      return result;
    }
  }

  private async finishDisposal(
    adapter: VoiceSessionAdapter,
    shouldStop: boolean,
    pendingStop?: Promise<VoiceSessionOperationResult>,
  ): Promise<VoiceSessionOperationResult> {
    let result = pendingStop ? await pendingStop : undefined;
    if (result && !result.ok) shouldStop = true;

    if (!result?.ok && shouldStop) {
      try {
        result = await adapter.stop();
      } catch (error) {
        result = this.failed('stop', error);
      }
    }

    if (!result) {
      result = this.success(
        Object.freeze({
          ...adapter.getSnapshot(),
          state: 'disconnected',
        }),
      );
    }

    if (result.ok) {
      this.disposalAdapter = undefined;
      this.publish({ ...result.snapshot, state: 'disconnected' });
      this.disposeResult = this.success(this.snapshot);
      return this.disposeResult;
    }

    this.publish(this.errorSnapshot(result.error));
    return result;
  }

  private receiveAdapterSnapshot(active: ActiveAdapter): void {
    if (this.active !== active || active.phase === 'stopping') {
      return;
    }
    this.publish(active.adapter.getSnapshot());
  }

  private applyCompletion(
    adapter: VoiceSessionAdapter,
    generation: number,
    result: VoiceSessionOperationResult,
  ): void {
    if (
      this.active?.adapter !== adapter ||
      generation !== this.intentGeneration
    ) {
      return;
    }
    this.publish(
      result.ok ? result.snapshot : this.errorSnapshot(result.error),
    );
  }

  private publish(next: VoiceSessionSnapshot): void {
    const snapshot = Object.freeze({
      ...next,
      revision: this.snapshot.revision + 1,
    });
    this.snapshot = snapshot;
    this._notify();
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
        'No selected live voice-session adapter is available.',
        operation,
      ),
    };
  }

  private unsupported(
    operation: VoiceSessionOperation,
  ): VoiceSessionOperationResult {
    return {
      ok: false,
      error: new VoiceSessionError(
        'unsupported',
        `The selected voice-session adapter does not support ${operation}.`,
        operation,
      ),
    };
  }

  private failed(
    operation: VoiceSessionOperation,
    _cause: unknown,
  ): Extract<VoiceSessionOperationResult, { readonly ok: false }> {
    return {
      ok: false,
      error: new VoiceSessionError(
        'operation-failed',
        'Voice-session operation failed.',
        operation,
      ),
    };
  }

  private errorSnapshot(error: VoiceSessionError): VoiceSessionSnapshot {
    return { ...this.snapshot, state: 'error', error };
  }
}
