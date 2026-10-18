/**
 * Core server generations: first boot, sequential hold-and-swap handoff with
 * rollback, and crash restart with backoff.
 *
 * Phase 1 never runs two generations against the Station home at once. A
 * trial generation parks before touching the home; only after the active
 * generation has exited is it promoted. Listening handles stay open in the
 * supervisor throughout, so connections queue in the kernel backlog instead
 * of being refused.
 *
 * Process creation and time are injected so the algorithm can be tested
 * in-process with a fake clock.
 */
import { isRecord } from './ndjson.ts';
import {
  type GenerationState,
  type GenerationStatus,
  HANDOFF_DEFAULTS,
  type HandoffOutcome,
  type HandoffPhase,
  type HandoffTimings,
  type ListenerStatus,
  RESTART_DEFAULTS,
  type RestartPolicy,
  type SupervisorEvent,
  type SupervisorState,
  type SupervisorToCoreMessage,
} from './protocol.ts';

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

/** A listening handle held by the supervisor. Node's raw TCP and Pipe wraps satisfy this. */
export interface ListenerHandle {
  close(): void;
}

export interface GenerationProcess {
  readonly pid: number | null;
  send(message: SupervisorToCoreMessage, handle?: ListenerHandle): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  onMessage(listener: (message: unknown, handle: unknown) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
}

export interface GenerationLauncher {
  launch(options: { entry: string; generation: number }): GenerationProcess;
}

export interface HandoffOptions {
  entry?: string;
  readinessTimeoutMs?: number;
  drainDeadlineMs?: number;
}

export interface HandoffOutcomeResult {
  outcome: HandoffOutcome;
  reason?: string;
  generation?: number;
  bootId?: string;
}

export interface GenerationManagerOptions {
  entry: string;
  launcher: GenerationLauncher;
  clock?: Clock;
  handoff?: Partial<HandoffTimings>;
  restart?: Partial<RestartPolicy>;
  log?: (message: string) => void;
  onEvent?: (event: SupervisorEvent) => void;
  /** Called once when crash restarts exceed the failure budget. */
  onGiveUp?: (failures: number) => void;
  /** Validates a requested handoff entry; returns a refusal reason or null. */
  validateEntry?: (entry: string) => string | null;
}

interface Generation {
  id: number;
  entry: string;
  proc: GenerationProcess;
  state: GenerationState;
  bootId: string | null;
  port: number | null;
  voiceSessions: number;
  /** Set once the supervisor itself asked the generation to drain or die. */
  expectingExit: boolean;
  notify: Set<() => void>;
  exited: Promise<void>;
}

type WaitResult = 'ok' | 'exit' | 'timeout';

function hasExited(gen: Generation): boolean {
  return gen.state === 'exited';
}

function isListenerHandle(value: unknown): value is ListenerHandle {
  return isRecord(value) && typeof value.close === 'function';
}

export class GenerationManager {
  private readonly clock: Clock;
  private readonly handoffConfig: HandoffTimings;
  private readonly restartConfig: RestartPolicy;
  private readonly log: (message: string) => void;
  private entry: string;
  private nextId = 1;
  private state: SupervisorState = 'starting';
  private active: Generation | null = null;
  private trial: Generation | null = null;
  private readonly listeners = new Map<
    string,
    { port: number; handle: ListenerHandle }
  >();
  private failures: number[] = [];
  private consecutiveFailures = 0;
  private lastBackoffMs: number | null = null;
  private stableTimer: unknown = null;
  private stopping = false;
  private gaveUp = false;
  private cancelSleep: (() => void) | null = null;
  private stopped: Promise<void> | null = null;

  private readonly options: GenerationManagerOptions;

  constructor(options: GenerationManagerOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.handoffConfig = { ...HANDOFF_DEFAULTS, ...options.handoff };
    this.restartConfig = { ...RESTART_DEFAULTS, ...options.restart };
    this.log = options.log ?? (() => {});
    this.entry = options.entry;
  }

  /** Boots the first generation, retrying with backoff. */
  start(): Promise<void> {
    return this.bringUp('starting');
  }

  status(): {
    state: SupervisorState;
    active: GenerationStatus | null;
    trial: GenerationStatus | null;
    listeners: ListenerStatus[];
    restarts: { consecutiveFailures: number; lastBackoffMs: number | null };
  } {
    return {
      state: this.state,
      active: this.active ? this.describe(this.active) : null,
      trial: this.trial ? this.describe(this.trial) : null,
      listeners: [...this.listeners].map(([name, { port }]) => ({
        name,
        port,
      })),
      restarts: {
        consecutiveFailures: this.consecutiveFailures,
        lastBackoffMs: this.lastBackoffMs,
      },
    };
  }

  heldListenerCount(): number {
    return this.listeners.size;
  }

  async handoff(
    request: HandoffOptions,
    onProgress: (phase: HandoffPhase, generation: number) => void = () => {},
  ): Promise<HandoffOutcomeResult> {
    if (this.stopping) return { outcome: 'refused', reason: 'stopping' };
    if (this.state === 'handoff') return { outcome: 'refused', reason: 'busy' };
    const previous = this.active;
    if (this.state !== 'serving' || !previous || previous.state !== 'serving') {
      return { outcome: 'refused', reason: 'not-serving' };
    }
    const entry = request.entry ?? previous.entry;
    const invalid = this.options.validateEntry?.(entry) ?? null;
    if (invalid) return { outcome: 'refused', reason: invalid };
    const readinessTimeoutMs =
      request.readinessTimeoutMs ?? this.handoffConfig.readinessTimeoutMs;
    const drainDeadlineMs =
      request.drainDeadlineMs ?? this.handoffConfig.drainDeadlineMs;
    const previousEntry = previous.entry;

    this.setState('handoff');
    const progress = (phase: HandoffPhase, generation: number) => {
      onProgress(phase, generation);
      this.emit({ type: 'handoff', phase, generation });
    };
    const trial = this.launch(entry);
    this.trial = trial;
    progress('trial-started', trial.id);

    const parked = await this.waitForState(
      trial,
      ['parked'],
      this.handoffConfig.parkTimeoutMs,
    );
    if (parked !== 'ok' || this.stopping) {
      await this.terminate(trial);
      this.trial = null;
      const reason = this.stopping
        ? 'stopping'
        : parked === 'exit'
          ? 'trial-exited-before-parked'
          : 'trial-park-timeout';
      return this.finishRollback(previous, previousEntry, reason, progress);
    }
    progress('trial-parked', trial.id);

    // Re-read: the previous generation may have exited while the trial parked.
    if (!hasExited(previous)) {
      progress('draining', previous.id);
      await this.drain(previous, drainDeadlineMs);
    }
    progress('drained', previous.id);
    if (this.active === previous) this.active = null;

    if (this.stopping || hasExited(trial)) {
      await this.terminate(trial);
      this.trial = null;
      return this.finishRollback(
        null,
        previousEntry,
        this.stopping ? 'stopping' : 'trial-exited-while-draining',
        progress,
      );
    }

    this.promote(trial);
    progress('promoted', trial.id);
    const ready = await this.waitForState(
      trial,
      ['serving'],
      readinessTimeoutMs,
    );
    if (ready !== 'ok' || this.stopping) {
      await this.terminate(trial);
      this.trial = null;
      const reason = this.stopping
        ? 'stopping'
        : ready === 'exit'
          ? 'trial-exited-after-promote'
          : 'trial-readiness-timeout';
      return this.finishRollback(null, previousEntry, reason, progress);
    }

    this.trial = null;
    this.entry = trial.entry;
    this.commitActive(trial);
    this.emit({ type: 'handoff', phase: 'committed', generation: trial.id });
    return {
      outcome: 'committed',
      generation: trial.id,
      bootId: trial.bootId ?? undefined,
    };
  }

  /** Drains every generation and resolves once none is running. Idempotent. */
  stop(
    drainDeadlineMs: number = this.handoffConfig.drainDeadlineMs,
  ): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    this.setState('stopping');
    this.emit({ type: 'stopping' });
    this.cancelSleep?.();
    this.clearStableTimer();
    this.stopped = (async () => {
      const work: Promise<void>[] = [];
      if (this.trial) work.push(this.terminate(this.trial));
      if (this.active) work.push(this.drain(this.active, drainDeadlineMs));
      await Promise.all(work);
      // A handoff or restart in flight may have launched a generation while
      // the above ran; it sees `stopping` and terminates it, but wait for it.
      while (this.trial || (this.active && this.active.state !== 'exited')) {
        const pending = [this.trial, this.active].filter(
          (gen): gen is Generation => gen !== null && gen.state !== 'exited',
        );
        if (pending.length === 0) break;
        await Promise.all(pending.map((gen) => this.terminate(gen)));
        if (this.trial?.state === 'exited') this.trial = null;
      }
      this.closeListeners();
    })();
    return this.stopped;
  }

  closeListeners(): void {
    for (const { handle } of this.listeners.values()) {
      try {
        handle.close();
      } catch {
        // Already closed.
      }
    }
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------

  private describe(gen: Generation): GenerationStatus {
    return {
      generation: gen.id,
      pid: gen.proc.pid,
      entry: gen.entry,
      state: gen.state,
      bootId: gen.bootId,
      port: gen.port,
    };
  }

  private emit(event: SupervisorEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch (error) {
      this.log(`event listener failed: ${String(error)}`);
    }
  }

  private setState(state: SupervisorState): void {
    this.state = state;
  }

  private setGenerationState(gen: Generation, state: GenerationState): void {
    if (gen.state === 'exited') return;
    gen.state = state;
    this.emit({ type: 'generation', generation: this.describe(gen) });
    for (const listener of [...gen.notify]) listener();
  }

  private launch(entry: string): Generation {
    const id = this.nextId++;
    const proc = this.options.launcher.launch({ entry, generation: id });
    let resolveExited: () => void = () => {};
    const gen: Generation = {
      id,
      entry,
      proc,
      state: 'starting',
      bootId: null,
      port: null,
      voiceSessions: 0,
      expectingExit: false,
      notify: new Set(),
      exited: new Promise<void>((resolve) => {
        resolveExited = resolve;
      }),
    };
    this.log(
      `generation ${id} started (pid ${proc.pid ?? 'unknown'}) entry=${entry}`,
    );
    proc.onMessage((message, handle) =>
      this.onGenerationMessage(gen, message, handle),
    );
    proc.onExit((code, signal) => {
      this.log(`generation ${id} exited code=${code} signal=${signal}`);
      this.setGenerationState(gen, 'exited');
      resolveExited();
      this.onGenerationExit(gen);
    });
    this.emit({ type: 'generation', generation: this.describe(gen) });
    return gen;
  }

  private onGenerationMessage(
    gen: Generation,
    message: unknown,
    handle: unknown,
  ): void {
    if (!isRecord(message) || typeof message.type !== 'string') {
      if (isListenerHandle(handle)) handle.close();
      return;
    }
    switch (message.type) {
      case 'listener.bound': {
        const { name, port } = message;
        const acceptable =
          typeof name === 'string' &&
          name.length > 0 &&
          typeof port === 'number' &&
          isListenerHandle(handle) &&
          (gen.state === 'promoted' || gen.state === 'serving') &&
          !this.listeners.has(name);
        if (acceptable) {
          this.listeners.set(name, { port, handle });
          this.log(
            `holding listener ${name} on port ${port} from generation ${gen.id}`,
          );
        } else {
          if (isListenerHandle(handle)) handle.close();
          this.log(`ignored listener.bound from generation ${gen.id}`);
        }
        return;
      }
      case 'parked':
        if (gen.state === 'starting') this.setGenerationState(gen, 'parked');
        return;
      case 'ready':
        if (
          gen.state === 'promoted' &&
          typeof message.bootId === 'string' &&
          typeof message.port === 'number'
        ) {
          gen.bootId = message.bootId;
          gen.port = message.port;
          this.setGenerationState(gen, 'serving');
        }
        return;
      case 'drain.progress':
        if (
          typeof message.voiceSessions === 'number' &&
          message.voiceSessions >= 0
        ) {
          gen.voiceSessions = message.voiceSessions;
        }
        return;
      case 'drained':
        return;
      case 'handoff.request': {
        const requestId =
          typeof message.requestId === 'string' ? message.requestId : '';
        const refuse = (reason: string) =>
          gen.proc.send({ type: 'handoff.refused', requestId, reason });
        if (gen !== this.active) {
          refuse('not-active');
          return;
        }
        const options: HandoffOptions = {};
        if (typeof message.entry === 'string') options.entry = message.entry;
        if (typeof message.readinessTimeoutMs === 'number') {
          options.readinessTimeoutMs = message.readinessTimeoutMs;
        }
        if (typeof message.drainDeadlineMs === 'number') {
          options.drainDeadlineMs = message.drainDeadlineMs;
        }
        void this.handoff(options).then((result) => {
          if (result.outcome === 'refused' && gen.state !== 'exited') {
            refuse(result.reason ?? 'refused');
          }
        });
        return;
      }
      default:
        // Minor versions may add messages; ignore what this version does not know.
        if (isListenerHandle(handle)) handle.close();
    }
  }

  private onGenerationExit(gen: Generation): void {
    if (gen !== this.active || gen.expectingExit) return;
    if (this.state !== 'serving') return; // A handoff or restart owns this generation.
    this.clearStableTimer();
    this.active = null;
    void this.bringUp('restarting', true);
  }

  private promote(gen: Generation): void {
    const names = [...this.listeners.keys()];
    gen.proc.send({ type: 'promote', listeners: names });
    for (const [name, { handle }] of this.listeners) {
      gen.proc.send({ type: 'listener.adopt', name }, handle);
    }
    this.setGenerationState(gen, 'promoted');
  }

  private commitActive(gen: Generation): void {
    this.active = gen;
    this.setState('serving');
    this.clearStableTimer();
    this.stableTimer = this.clock.setTimeout(() => {
      this.stableTimer = null;
      if (this.active === gen && gen.state === 'serving') {
        this.consecutiveFailures = 0;
        this.lastBackoffMs = null;
      }
    }, this.restartConfig.stableAfterMs);
    // It may have died between `ready` and this commit.
    if (gen.state === 'exited') this.onGenerationExit(gen);
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      this.clock.clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  /** Launches one generation and brings it to `serving`; false on failure. */
  private async launchActive(entry: string): Promise<Generation | null> {
    const gen = this.launch(entry);
    this.trial = gen;
    const parked = await this.waitForState(
      gen,
      ['parked'],
      this.handoffConfig.parkTimeoutMs,
    );
    if (parked === 'ok' && !this.stopping) {
      this.promote(gen);
      const ready = await this.waitForState(
        gen,
        ['serving'],
        this.handoffConfig.readinessTimeoutMs,
      );
      if (ready === 'ok' && !this.stopping) {
        this.trial = null;
        return gen;
      }
    }
    await this.terminate(gen);
    this.trial = null;
    return null;
  }

  /**
   * Starts generations from the current entry until one serves, with
   * exponential backoff between failures. `crashed` records the failure that
   * caused this restart before the first attempt.
   */
  private async bringUp(
    state: SupervisorState,
    crashed = false,
  ): Promise<void> {
    this.setState(state);
    if (crashed && !(await this.recordFailureAndWait())) return;
    for (;;) {
      if (this.stopping) return;
      const gen = await this.launchActive(this.entry);
      if (gen) {
        this.commitActive(gen);
        return;
      }
      if (this.stopping) return;
      if (!(await this.recordFailureAndWait())) return;
    }
  }

  /** Counts a failure; waits out the backoff. False when giving up or stopping. */
  private async recordFailureAndWait(): Promise<boolean> {
    const now = this.clock.now();
    this.failures = this.failures.filter(
      (at) => now - at < this.restartConfig.failureWindowMs,
    );
    this.failures.push(now);
    this.consecutiveFailures += 1;
    if (this.failures.length >= this.restartConfig.maxFailures) {
      this.giveUp();
      return false;
    }
    const backoff = Math.min(
      this.restartConfig.initialBackoffMs * 2 ** (this.consecutiveFailures - 1),
      this.restartConfig.maxBackoffMs,
    );
    this.lastBackoffMs = backoff;
    this.setState('restarting');
    this.emit({ type: 'restart', generation: this.nextId, backoffMs: backoff });
    this.log(
      `restarting in ${backoff}ms (failure ${this.consecutiveFailures})`,
    );
    await this.sleep(backoff);
    return !this.stopping;
  }

  private giveUp(): void {
    if (this.gaveUp) return;
    this.gaveUp = true;
    const failures = this.failures.length;
    this.log(`giving up after ${failures} failures`);
    this.emit({ type: 'gave-up', failures });
    this.options.onGiveUp?.(failures);
  }

  private async finishRollback(
    survivor: Generation | null,
    previousEntry: string,
    reason: string,
    progress: (phase: HandoffPhase, generation: number) => void,
  ): Promise<HandoffOutcomeResult> {
    // The previous generation was never asked to drain: it is still serving.
    if (survivor && survivor.state === 'serving' && this.active === survivor) {
      if (this.stopping) return { outcome: 'rolled-back', reason };
      this.setState('serving');
      this.emit({
        type: 'handoff',
        phase: 'rolled-back',
        generation: survivor.id,
      });
      return { outcome: 'rolled-back', reason, generation: survivor.id };
    }
    if (this.stopping) return { outcome: 'rolled-back', reason };
    progress('rolling-back', this.nextId);
    this.entry = previousEntry;
    this.active = null;
    const gen = await this.launchActive(previousEntry);
    if (gen) {
      this.commitActive(gen);
      this.emit({ type: 'handoff', phase: 'rolled-back', generation: gen.id });
      return {
        outcome: 'rolled-back',
        reason,
        generation: gen.id,
        bootId: gen.bootId ?? undefined,
      };
    }
    if (!this.stopping) void this.bringUp('restarting', true);
    return {
      outcome: 'rolled-back',
      reason: `${reason}; previous entry failed to start, restarting`,
    };
  }

  private async drain(gen: Generation, deadlineMs: number): Promise<void> {
    if (gen.state === 'exited') return;
    gen.expectingExit = true;
    this.setGenerationState(gen, 'draining');
    gen.proc.send({ type: 'drain', deadlineMs });
    const started = this.clock.now();
    let budget = deadlineMs;
    for (;;) {
      if (await this.waitForExit(gen, budget)) return;
      const elapsed = this.clock.now() - started;
      if (
        gen.voiceSessions > 0 &&
        elapsed < this.handoffConfig.voiceDrainCapMs
      ) {
        budget = Math.min(1_000, this.handoffConfig.voiceDrainCapMs - elapsed);
        continue;
      }
      break;
    }
    this.log(`generation ${gen.id} missed its drain deadline`);
    await this.terminate(gen);
  }

  /** SIGTERM, then SIGKILL after the grace period; resolves once exited. */
  private async terminate(gen: Generation): Promise<void> {
    if (gen.state === 'exited') return;
    gen.expectingExit = true;
    gen.proc.kill('SIGTERM');
    if (await this.waitForExit(gen, this.handoffConfig.killGraceMs)) return;
    gen.proc.kill('SIGKILL');
    await gen.exited;
  }

  private waitForExit(gen: Generation, timeoutMs: number): Promise<boolean> {
    return this.waitForState(gen, ['exited'], timeoutMs).then(
      (result) => result !== 'timeout',
    );
  }

  private waitForState(
    gen: Generation,
    targets: GenerationState[],
    timeoutMs: number,
  ): Promise<WaitResult> {
    return new Promise((resolve) => {
      let timer: unknown = null;
      const finish = (result: WaitResult) => {
        gen.notify.delete(check);
        if (timer !== null) this.clock.clearTimeout(timer);
        resolve(result);
      };
      const check = () => {
        if (targets.includes(gen.state)) finish('ok');
        else if (gen.state === 'exited') finish('exit');
      };
      gen.notify.add(check);
      timer = this.clock.setTimeout(() => {
        timer = null;
        finish('timeout');
      }, timeoutMs);
      check();
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.cancelSleep = null;
        resolve();
      }, ms);
      this.cancelSleep = () => {
        this.clock.clearTimeout(timer);
        this.cancelSleep = null;
        resolve();
      };
    });
  }
}
