import { ListenerManager } from '../core/ListenerManager.js';
import type {
  VoiceAgentTurnAdapter,
  VoiceAudioChunk,
  VoiceInputAdapter,
  VoiceInputEvent,
  VoicePlaybackAdapter,
  VoiceRoleComponents,
  VoiceSynthesisAdapter,
  VoiceTurnTelemetryEvent,
} from './component-types.js';
import {
  type AudioCollectionResult,
  bestEffortStop,
  type ComposedVoiceSessionAdapterOptions,
  collectAgentTokens,
  collectAudioChunks,
  composedVoiceDescriptor,
  createOperationError,
  createSecondaryTelemetry,
  deferred,
  type InputRecoveryAttempt,
  type InputStartAttempt,
  immutableContext,
  joinPendingOperations,
  normalizeComponents,
  projectSessionSnapshot,
  type StopAttempt,
  startInputWithSecondary,
  stopSession,
  uniqueComponents,
} from './composition-utils.js';
import {
  type VoiceSessionAdapter,
  type VoiceSessionAdapterCapabilities,
  type VoiceSessionAdapterDescriptor,
  type VoiceSessionOperation,
  type VoiceSessionOperationResult,
  type VoiceSessionSnapshot,
  type VoiceSessionStartInput,
  type VoiceSessionTextTurn,
} from './session-types.js';
import { chunkVoiceText } from './tts-chunker.js';

export type { ComposedVoiceSessionAdapterOptions } from './composition-utils.js';
/** Coordinates independently replaceable voice components behind the session contract. */
export class ComposedVoiceSessionAdapter
  extends ListenerManager
  implements VoiceSessionAdapter
{
  readonly descriptor: VoiceSessionAdapterDescriptor;
  readonly capabilities: VoiceSessionAdapterCapabilities = Object.freeze({
    interrupt: true,
    updateContext: true,
    textTurn: true,
  });
  private snapshot: VoiceSessionSnapshot = Object.freeze({
    state: 'disconnected',
    revision: 0,
  });
  private readonly input: VoiceRoleComponents<VoiceInputAdapter>;
  private readonly agent: VoiceRoleComponents<VoiceAgentTurnAdapter>;
  private readonly synthesis: VoiceRoleComponents<VoiceSynthesisAdapter>;
  private readonly playback: VoiceRoleComponents<VoicePlaybackAdapter>;
  private activeInput: VoiceInputAdapter;
  private activeSynthesis: VoiceSynthesisAdapter;
  private activePlayback: VoicePlaybackAdapter;
  private unsubscribeInput: () => void = () => undefined;
  private context: Readonly<Record<string, unknown>> = Object.freeze({});
  private controlSessionId: string | undefined;
  private conversationSessionId: string | undefined;
  private activeTurn: AbortController | undefined;
  private activeTurnStartedAt: number | undefined;
  private activeTurnTerminal = false;
  private inputController: AbortController | undefined;
  private activeStart: InputStartAttempt | undefined;
  private activeStop: StopAttempt | undefined;
  private inputRecovery: InputRecoveryAttempt | undefined;
  private recoveryCleanup: Promise<void> | undefined;
  private disposePromise: Promise<void> | undefined;
  private readonly speechEpochStarts = new Map<number, number>();
  private generation = 0;
  private lifecycle = 0;
  private started = false;
  private disposeRequested = false;
  private disposed = false;
  constructor(private readonly options: ComposedVoiceSessionAdapterOptions) {
    super();
    this.descriptor = composedVoiceDescriptor(options.descriptor);
    this.input = normalizeComponents(options.input);
    this.agent = normalizeComponents(options.agent);
    this.synthesis = normalizeComponents(options.synthesis);
    this.playback = normalizeComponents(options.playback);
    this.activeInput = this.input.primary;
    this.activeSynthesis = this.synthesis.primary;
    this.activePlayback = this.playback.primary;
    this.selectInput(this.activeInput);
  }
  getSnapshot(): VoiceSessionSnapshot {
    return this.snapshot;
  }
  start(input?: VoiceSessionStartInput): Promise<VoiceSessionOperationResult> {
    if (this.disposed || this.disposeRequested)
      return Promise.resolve(this.rejectedStart());
    if (this.started) return Promise.resolve(this.success(this.snapshot));
    if (this.activeStart) return this.activeStart.promise;
    return this.createStartAttempt(
      input,
      joinPendingOperations(this.activeStop?.promise, this.recoveryCleanup),
    );
  }
  private createStartAttempt(
    input: VoiceSessionStartInput | undefined,
    pendingOperation: Promise<unknown> | undefined,
  ): Promise<VoiceSessionOperationResult> {
    const deferredStart = deferred<VoiceSessionOperationResult>();
    const attempt: InputStartAttempt = {
      lifecycle: 0,
      controller: new AbortController(),
      promise: deferredStart.promise,
    };
    this.activeStart = attempt;
    void this.runStartAfterOperation(attempt, input, pendingOperation).then(
      deferredStart.resolve,
      deferredStart.reject,
    );
    return attempt.promise;
  }
  private async runStartAfterOperation(
    attempt: InputStartAttempt,
    input: VoiceSessionStartInput | undefined,
    pendingOperation: Promise<unknown> | undefined,
  ): Promise<VoiceSessionOperationResult> {
    if (pendingOperation) await pendingOperation;
    if (this.activeStart !== attempt || this.disposed)
      return this.success(this.snapshot);
    this.beginStartLifecycle(attempt);
    return this.runStart(attempt, input);
  }
  private async runStart(
    attempt: InputStartAttempt,
    input: VoiceSessionStartInput | undefined,
  ): Promise<VoiceSessionOperationResult> {
    this.controlSessionId = input?.controlSessionId;
    this.conversationSessionId = input?.conversationSessionId;
    this.context = immutableContext(input?.context);
    this.publish('connecting');
    try {
      this.options.endpoint.reset();
      this.activeSynthesis = this.synthesis.primary;
      this.activePlayback = this.playback.primary;
      this.inputController = attempt.controller;
      await this.startInput(attempt);
      if (!this.isCurrentStart(attempt)) return this.success(this.snapshot);
      this.started = true;
      this.activeStart = undefined;
      return this.success(this.publish('listening'));
    } catch (cause) {
      if (!this.isCurrentStart(attempt)) return this.success(this.snapshot);
      attempt.controller.abort();
      if (this.inputController === attempt.controller)
        this.inputController = undefined;
      this.activeStart = undefined;
      this.started = false;
      this.speechEpochStarts.clear();
      return this.failed('start', cause);
    }
  }
  stop(): Promise<VoiceSessionOperationResult> {
    if (this.disposeRequested || this.disposed)
      return (this.disposePromise ?? Promise.resolve()).then(() =>
        this.success(this.snapshot),
      );
    if (this.activeStop) return this.activeStop.promise;
    return this.createStopAttempt().promise;
  }
  private createStopAttempt(): StopAttempt {
    const pendingCleanup = this.recoveryCleanup;
    this.started = false;
    this.invalidateLifecycle();
    const deferredStop = deferred<VoiceSessionOperationResult>();
    const attempt: StopAttempt = {
      lifecycle: this.lifecycle,
      promise: deferredStop.promise,
    };
    this.activeStop = attempt;
    void this.runStop(attempt, pendingCleanup).then(
      deferredStop.resolve,
      deferredStop.reject,
    );
    return attempt;
  }
  private async runStop(
    attempt: StopAttempt,
    pendingCleanup: Promise<void> | undefined,
  ): Promise<VoiceSessionOperationResult> {
    this.interruptActiveTurn();
    this.publish('stopping');
    await pendingCleanup;
    const firstFailure = await stopSession(
      () => this.stopPlayback(),
      () =>
        pendingCleanup
          ? Promise.resolve()
          : this.activeInput.stop(new AbortController().signal),
    );
    this.activeTurn = undefined;
    this.activeTurnStartedAt = undefined;
    this.speechEpochStarts.clear();
    if (
      this.disposed ||
      this.activeStop !== attempt ||
      attempt.lifecycle !== this.lifecycle
    )
      return this.success(this.snapshot);
    this.activeStop = undefined;
    return firstFailure === undefined
      ? this.success(this.publish('disconnected'))
      : this.failed('stop', firstFailure);
  }
  async interrupt(): Promise<VoiceSessionOperationResult> {
    const lifecycle = this.lifecycle;
    try {
      await this.cancelActiveTurn();
      if (lifecycle !== this.lifecycle) return this.success(this.snapshot);
      return this.success(
        this.publish(this.started ? 'connected-idle' : 'disconnected'),
      );
    } catch (cause) {
      if (lifecycle !== this.lifecycle) return this.success(this.snapshot);
      return this.failed('interrupt', cause);
    }
  }
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposeRequested = true;
    const completion = deferred<void>();
    this.disposePromise = completion.promise;
    void this.runDispose().then(completion.resolve, completion.reject);
    return this.disposePromise;
  }
  private async runDispose(): Promise<void> {
    const stopping = this.activeStop ?? this.createStopAttempt();
    await stopping.promise;
    await this.recoveryCleanup;
    this.disposed = true;
    this.unsubscribeInput();
    this.unsubscribeInput = () => undefined;
    this.speechEpochStarts.clear();
    for (const input of uniqueComponents(this.input)) {
      try {
        await input.dispose?.();
      } catch {
        // One component must not prevent the remaining inputs from releasing.
      }
    }
    this._clearListeners();
  }
  async updateContext(
    input: Record<string, unknown>,
  ): Promise<VoiceSessionOperationResult> {
    this.context = immutableContext({ ...this.context, ...input });
    return this.success(this.snapshot);
  }
  async sendText(
    input: VoiceSessionTextTurn,
  ): Promise<VoiceSessionOperationResult> {
    if (!this.started)
      return this.failure(
        'send-text',
        new Error('The composed voice session is not started.'),
      );
    const generation = await this.beginTurn();
    return this.executeTurn(input.text, generation, 'text', this.now());
  }
  private async handleInput(
    source: VoiceInputAdapter,
    event: VoiceInputEvent,
  ): Promise<void> {
    if (!this.started || source !== this.activeInput) return;
    const recovery = this.inputRecovery;
    if (recovery?.candidate === source) {
      if (event.type === 'error') this.failInputRecovery(recovery, event.error);
      return;
    }
    if (event.type === 'error') {
      if (recovery) return;
      const attempt: InputRecoveryAttempt = {
        lifecycle: this.lifecycle,
        failedInput: source,
        candidate: undefined,
        controller: undefined,
      };
      this.inputRecovery = attempt;
      void this.recoverInput(attempt, event.error);
      return;
    }
    if (event.type === 'interim') {
      if (!this.speechEpochStarts.has(event.epoch)) {
        this.speechEpochStarts.clear();
        this.speechEpochStarts.set(event.epoch, this.now());
      }
      if (this.activeTurn) {
        try {
          await this.cancelActiveTurn();
        } catch (cause) {
          this.failed('interrupt', cause);
          return;
        }
      }
      this.publish('listening', event.transcript);
      return;
    }
    const utterance = this.options.endpoint.consume(event);
    if (!utterance) return;
    const speechStartedAt =
      this.speechEpochStarts.get(event.epoch) ?? this.now();
    this.speechEpochStarts.delete(event.epoch);
    const generation = await this.beginTurn();
    await this.executeTurn(
      utterance.transcript,
      generation,
      'speech',
      speechStartedAt,
    );
  }
  private async recoverInput(
    attempt: InputRecoveryAttempt,
    cause: Error,
  ): Promise<void> {
    const { failedInput } = attempt;
    const secondary = this.input.secondary;
    const canSecondary =
      secondary !== undefined &&
      failedInput === this.activeInput &&
      failedInput !== secondary;
    try {
      await this.cancelActiveTurn();
    } catch (error) {
      if (!canSecondary) {
        if (this.isCurrentRecovery(attempt)) {
          this.completeRecovery(attempt);
          this.failed('interrupt', error);
        }
        return;
      }
    }
    if (!this.isCurrentRecovery(attempt)) return;
    const failedController = this.inputController;
    failedController?.abort();
    if (this.inputController === failedController)
      this.inputController = undefined;
    this.speechEpochStarts.clear();
    try {
      await failedInput.stop(new AbortController().signal);
    } catch {
      // The provider-reported error still permits an explicitly selected secondary.
    }
    if (!this.isCurrentRecovery(attempt)) return;
    if (!canSecondary) {
      this.started = false;
      this.completeRecovery(attempt);
      this.failed('start', cause);
      return;
    }
    this.recordSecondarySelection(
      'input',
      failedInput.descriptor.id,
      secondary.descriptor.id,
      this.now(),
    );
    this.selectInput(secondary);
    const secondaryController = new AbortController();
    attempt.candidate = secondary;
    attempt.controller = secondaryController;
    this.inputController = secondaryController;
    try {
      await secondary.start(secondaryController.signal);
      if (!this.isCurrentRecovery(attempt)) return;
      this.completeRecovery(attempt);
      this.publish('listening');
    } catch (secondaryCause) {
      this.failInputRecovery(attempt, secondaryCause);
    }
  }
  private isCurrentStart(attempt: InputStartAttempt): boolean {
    return (
      !this.disposed &&
      this.activeStart === attempt &&
      attempt.lifecycle === this.lifecycle &&
      this.inputController === attempt.controller &&
      !attempt.controller.signal.aborted
    );
  }
  private isCurrentRecovery(
    attempt: InputRecoveryAttempt,
    allowStoppedController = false,
  ): boolean {
    return (
      this.started &&
      !this.disposed &&
      this.inputRecovery === attempt &&
      attempt.lifecycle === this.lifecycle &&
      (attempt.controller === undefined ||
        (this.inputController === attempt.controller &&
          (allowStoppedController || !attempt.controller.signal.aborted)))
    );
  }
  private failInputRecovery(
    attempt: InputRecoveryAttempt,
    cause: unknown,
  ): void {
    if (!this.isCurrentRecovery(attempt) || !attempt.candidate) return;
    const candidate = attempt.candidate;
    attempt.controller?.abort();
    if (this.inputController === attempt.controller)
      this.inputController = undefined;
    this.started = false;
    this.completeRecovery(attempt);
    const cleanup = bestEffortStop(candidate);
    this.recoveryCleanup = cleanup;
    void cleanup.finally(() => {
      if (this.recoveryCleanup === cleanup) this.recoveryCleanup = undefined;
    });
    this.failed('start', cause);
  }
  private completeRecovery(attempt: InputRecoveryAttempt): void {
    if (this.inputRecovery === attempt) this.inputRecovery = undefined;
  }
  private async beginTurn(): Promise<number> {
    await this.cancelActiveTurn();
    this.generation += 1;
    this.activeTurn = new AbortController();
    this.activeTurnStartedAt = undefined;
    this.activeTurnTerminal = false;
    return this.generation;
  }
  private async cancelActiveTurn(): Promise<void> {
    this.interruptActiveTurn();
    // Playback completion is the ordering boundary for barge-in acceptance.
    await this.stopPlayback();
  }
  private async executeTurn(
    text: string,
    generation: number,
    source: 'speech' | 'text',
    turnStartedAt: number,
  ): Promise<VoiceSessionOperationResult> {
    const controller = this.activeTurn;
    if (!controller || !this.isCurrent(generation, controller.signal))
      return this.success(this.snapshot);
    const finalizedAt = this.now();
    this.activeTurnStartedAt = turnStartedAt;
    this.publish('transcribing', text);
    this.emitTelemetry({
      type: 'transcript-final',
      durationMs: finalizedAt - turnStartedAt,
      attributes:
        source === 'speech'
          ? Object.freeze({
              inputSource: 'speech' as const,
              inputComponentId: this.activeInput.descriptor.id,
            })
          : Object.freeze({ inputSource: 'text' as const }),
    });
    try {
      this.publish('thinking');
      const response = await this.runAgent(
        text,
        controller.signal,
        finalizedAt,
      );
      if (!this.isCurrent(generation, controller.signal))
        return this.success(this.snapshot);
      this.publish('speaking', response, 'assistant');
      await this.runSynthesis(
        response,
        controller.signal,
        generation,
        finalizedAt,
      );
      if (!this.isCurrent(generation, controller.signal))
        return this.success(this.snapshot);
      this.completeTurn('completed', turnStartedAt, controller);
      return this.success(
        this.publish('connected-idle', response, 'assistant'),
      );
    } catch (cause) {
      if (!this.isCurrent(generation, controller.signal))
        return this.success(this.snapshot);
      this.completeTurn('failed', turnStartedAt, controller);
      return this.failed('send-text', cause);
    }
  }
  private async runAgent(
    text: string,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<string> {
    const input = Object.freeze({ text, context: this.context, signal });
    const tokens = await collectAgentTokens(
      this.agent.primary,
      input,
      signal,
      () =>
        this.emitTelemetry({
          type: 'first-token',
          durationMs: this.now() - startedAt,
          attributes: Object.freeze({
            agentComponentId: this.agent.primary.descriptor.id,
          }),
        }),
    );
    if (tokens !== undefined) return tokens;
    const secondary = this.agent.secondary;
    if (!secondary) throw new Error('The primary agent component failed.');
    this.recordSecondarySelection(
      'agent',
      this.agent.primary.descriptor.id,
      secondary.descriptor.id,
      startedAt,
    );
    return (
      (await collectAgentTokens(secondary, input, signal, () =>
        this.emitTelemetry({
          type: 'first-token',
          durationMs: this.now() - startedAt,
          attributes: Object.freeze({
            agentComponentId: secondary.descriptor.id,
          }),
        }),
      )) ??
      (() => {
        throw new Error('The secondary agent component failed.');
      })()
    );
  }
  private async runSynthesis(
    text: string,
    signal: AbortSignal,
    generation: number,
    startedAt: number,
  ): Promise<void> {
    let firstAudioEmitted = false;
    for (const chunk of chunkVoiceText(
      text,
      this.options.synthesisChunkLength ?? 240,
    )) {
      firstAudioEmitted = await this.synthesizeChunk(
        chunk,
        signal,
        generation,
        startedAt,
        firstAudioEmitted,
      );
    }
  }
  private async synthesizeChunk(
    text: string,
    signal: AbortSignal,
    generation: number,
    startedAt: number,
    firstAudioEmitted: boolean,
  ): Promise<boolean> {
    const primary = await this.collectAudio(
      this.activeSynthesis,
      text,
      signal,
      generation,
      startedAt,
      firstAudioEmitted,
    );
    if (primary.kind === 'ok') return primary.firstAudioEmitted;
    if (primary.audioAccepted)
      throw new Error(
        'Synthesis failed after audio was accepted; refusing to replay speech.',
      );
    const secondary = this.synthesis.secondary;
    if (!secondary || this.activeSynthesis === secondary)
      throw new Error('The active synthesis component failed.');
    this.recordSecondarySelection(
      'synthesis',
      this.activeSynthesis.descriptor.id,
      secondary.descriptor.id,
      startedAt,
    );
    this.activeSynthesis = secondary;
    const retried = await this.collectAudio(
      secondary,
      text,
      signal,
      generation,
      startedAt,
      firstAudioEmitted,
    );
    if (retried.kind === 'synthesis-failed')
      throw new Error('The secondary synthesis component failed.');
    return retried.firstAudioEmitted;
  }
  private async collectAudio(
    adapter: VoiceSynthesisAdapter,
    text: string,
    signal: AbortSignal,
    generation: number,
    startedAt: number,
    firstAudioEmitted: boolean,
  ): Promise<AudioCollectionResult> {
    return collectAudioChunks(
      adapter,
      text,
      signal,
      () => this.isCurrent(generation, signal),
      (chunk) => this.playAudio(chunk, signal, startedAt),
      (playback) =>
        this.emitTelemetry({
          type: 'first-audio',
          durationMs: this.now() - startedAt,
          attributes: Object.freeze({
            synthesisComponentId: adapter.descriptor.id,
            playbackComponentId: playback.descriptor.id,
          }),
        }),
      firstAudioEmitted,
    );
  }
  private async playAudio(
    chunk: VoiceAudioChunk,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<VoicePlaybackAdapter> {
    try {
      await this.activePlayback.play(chunk, signal);
      return this.activePlayback;
    } catch (error) {
      const secondary = this.playback.secondary;
      if (!secondary || signal.aborted || this.activePlayback === secondary)
        throw error;
      this.recordSecondarySelection(
        'playback',
        this.activePlayback.descriptor.id,
        secondary.descriptor.id,
        startedAt,
      );
      this.activePlayback = secondary;
      await secondary.play(chunk, signal);
      return secondary;
    }
  }
  private async startInput(attempt: InputStartAttempt): Promise<void> {
    await startInputWithSecondary(
      this.input.primary,
      this.input.secondary,
      attempt.controller.signal,
      (input) => this.selectInput(input),
      () => this.isCurrentStart(attempt),
      (primary, secondary) =>
        this.recordSecondarySelection(
          'input',
          primary.descriptor.id,
          secondary.descriptor.id,
          this.now(),
        ),
    );
  }
  private async stopPlayback(): Promise<void> {
    await this.activePlayback.stop(new AbortController().signal);
  }
  private selectInput(input: VoiceInputAdapter): void {
    this.unsubscribeInput();
    this.activeInput = input;
    this.unsubscribeInput = input.subscribe((event) => {
      void this.handleInput(input, event);
    });
  }
  private invalidateLifecycle(): void {
    this.lifecycle += 1;
    this.activeStart?.controller.abort();
    this.activeStart = undefined;
    this.inputRecovery?.controller?.abort();
    this.inputRecovery = undefined;
    this.inputController?.abort();
    this.inputController = undefined;
  }
  private beginStartLifecycle(attempt: InputStartAttempt): void {
    this.lifecycle += 1;
    this.inputRecovery?.controller?.abort();
    this.inputRecovery = undefined;
    this.inputController?.abort();
    this.inputController = undefined;
    attempt.lifecycle = this.lifecycle;
  }
  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return this.started && generation === this.generation && !signal.aborted;
  }
  private interruptActiveTurn(): void {
    const controller = this.activeTurn;
    if (!controller) return;
    this.generation += 1;
    controller.abort();
    if (this.activeTurnStartedAt !== undefined)
      this.completeTurn('interrupted', this.activeTurnStartedAt, controller);
    this.activeTurn = undefined;
    this.activeTurnStartedAt = undefined;
  }
  private completeTurn(
    outcome: 'completed' | 'failed' | 'interrupted',
    startedAt: number,
    controller: AbortController,
  ): void {
    if (this.activeTurn !== controller || this.activeTurnTerminal) return;
    this.activeTurnTerminal = true;
    this.emitTelemetry({
      type: 'turn-complete',
      durationMs: this.now() - startedAt,
      attributes: Object.freeze({ outcome }),
    });
    if (outcome === 'completed' || outcome === 'failed') {
      this.activeTurn = undefined;
      this.activeTurnStartedAt = undefined;
    }
  }
  private recordSecondarySelection(
    role: 'input' | 'agent' | 'synthesis' | 'playback',
    failedComponentId: string,
    secondaryComponentId: string,
    startedAt: number,
  ): void {
    this.emitTelemetry(
      createSecondaryTelemetry(
        role,
        failedComponentId,
        secondaryComponentId,
        startedAt,
        this.now(),
      ),
    );
  }
  private emitTelemetry(event: VoiceTurnTelemetryEvent): void {
    try {
      this.options.telemetry?.(Object.freeze(event));
    } catch {
      // Observability must not become a control-plane dependency.
    }
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private publish(
    state: VoiceSessionSnapshot['state'],
    transcript?: string,
    transcriptRole?: 'user' | 'assistant',
    error?: ReturnType<typeof createOperationError>,
  ): VoiceSessionSnapshot {
    this.snapshot = projectSessionSnapshot(
      this.snapshot,
      state,
      this.controlSessionId,
      this.conversationSessionId,
      transcript,
      transcriptRole,
      error,
    );
    this._notify();
    return this.snapshot;
  }
  private success(snapshot: VoiceSessionSnapshot): VoiceSessionOperationResult {
    return { ok: true, snapshot };
  }
  private failure(
    operation: VoiceSessionOperation,
    cause: unknown,
  ): VoiceSessionOperationResult {
    return this.failed(operation, cause);
  }
  private failed(
    operation: VoiceSessionOperation,
    cause: unknown,
  ): VoiceSessionOperationResult {
    const error = createOperationError(operation, cause);
    return {
      ok: false,
      error: this.publish('error', undefined, undefined, error).error!,
    };
  }
  private rejectedStart(): VoiceSessionOperationResult {
    return {
      ok: false,
      error: createOperationError(
        'start',
        new Error('The composed voice session is disposed.'),
      ),
    };
  }
}
