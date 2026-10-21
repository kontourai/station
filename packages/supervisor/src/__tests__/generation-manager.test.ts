/**
 * The generation algorithm in-process, with fake generations and fake timers:
 * backoff schedule, stability reset, give-up, the sequential handoff order,
 * voice drain extension, and rollback.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Clock,
  FAILED_TRIAL_TERM_GRACE_MS,
  type GenerationLauncher,
  GenerationManager,
  type GenerationManagerOptions,
  type GenerationProcess,
  type HeldConnection,
  type ListenerHandle,
} from '../generation-manager.ts';
import type { SupervisorToCoreMessage } from '../protocol.ts';

type CatcherFactory = NonNullable<
  GenerationManagerOptions['catchConnections']
>['createCatcher'];
/** The manager's catching timings (not exported). */
const SPARE_ANSWER_TIMEOUT_MS = 2_000;
const CATCH_QUIET_MS = 50;
const CATCH_QUIET_CAP_MS = 1_000;
const HOLD_LIMIT_PER_LISTENER = 511;
const HOLD_DEADLINE_MS = 60_000;

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

type Behavior = {
  /** Report `parked` on launch. Default true. */
  park?: boolean;
  /** Report `ready` after promote. Default true. */
  ready?: boolean;
  /** Exit when drained. Default true. */
  exitOnDrain?: boolean;
  /** Exit this long after `drain` instead (a live call keeping it). */
  exitAfterDrainMs?: number;
  /** Ignore SIGTERM (only SIGKILL ends it). */
  ignoreTerm?: boolean;
  voiceSessions?: number;
  /** Exit, after reporting ready: 0 in the same tick, otherwise after this many ms. */
  exitAfterReadyMs?: number;
  /** The listener.bound handle to send on a first boot. */
  boundHandle?: () => unknown;
  /** Park saying it speaks connection catching (protocol 1.1). Default false. */
  adoptsConnections?: boolean;
  /** As a 1.1 core, answer listener.spares. Default true. */
  answerSpares?: boolean;
  /** The handle to send with each listener.spare. */
  spareHandle?: () => unknown;
  /** As a 1.1 core, report each adopted listener listening. Default true. */
  reportsListening?: boolean;
  /** On promote, report its listeners listening but never `ready`. */
  listenWithoutReady?: boolean;
  /** With listenWithoutReady: exit(1) this long after reporting listening. */
  exitAfterListeningMs?: number;
};

class FakeGeneration implements GenerationProcess {
  readonly pid: number;
  readonly sent: Array<{
    message: SupervisorToCoreMessage;
    handle?: ListenerHandle | HeldConnection;
  }> = [];
  readonly signals: string[] = [];
  exited = false;
  private messageListeners: Array<(message: unknown, handle: unknown) => void> =
    [];
  private exitListeners: Array<
    (code: number | null, signal: string | null) => void
  > = [];

  readonly generation: number;
  readonly entry: string;
  private readonly behavior: Behavior;
  private readonly log: string[];

  constructor(
    generation: number,
    entry: string,
    behavior: Behavior,
    log: string[],
  ) {
    this.generation = generation;
    this.entry = entry;
    this.behavior = behavior;
    this.log = log;
    this.pid = 1000 + generation;
    if (behavior.park !== false)
      queueMicrotask(() =>
        this.emit(
          behavior.adoptsConnections
            ? { type: 'parked', adoptsConnections: true }
            : { type: 'parked' },
        ),
      );
  }

  send(
    message: SupervisorToCoreMessage,
    handle?: ListenerHandle | HeldConnection,
  ): void {
    this.sent.push({ message, handle });
    this.log.push(`${this.generation}<-${message.type}`);
    if (
      message.type === 'listener.spares' &&
      this.behavior.adoptsConnections &&
      this.behavior.answerSpares !== false
    ) {
      queueMicrotask(() => {
        for (let i = 0; i < message.count; i += 1) {
          this.emit(
            { type: 'listener.spare', name: message.name },
            (this.behavior.spareHandle ?? fakeHandle)(),
          );
        }
      });
    }
    const reportsListening =
      this.behavior.adoptsConnections &&
      this.behavior.reportsListening !== false;
    if (message.type === 'promote' && this.behavior.listenWithoutReady) {
      queueMicrotask(() => {
        for (const name of message.listeners) {
          this.emit({ type: 'listener.listening', name });
        }
        const after = this.behavior.exitAfterListeningMs;
        if (after !== undefined) setTimeout(() => this.exit(1, null), after);
      });
    }
    if (message.type === 'promote' && this.behavior.ready !== false) {
      queueMicrotask(() => {
        if (reportsListening) {
          for (const name of message.listeners) {
            this.emit({ type: 'listener.listening', name });
          }
        }
        if (message.listeners.length === 0) {
          this.emit(
            { type: 'listener.bound', name: 'api', port: 45_000 },
            (this.behavior.boundHandle ?? fakeHandle)(),
          );
        }
        this.emit({
          type: 'ready',
          bootId: `boot-${this.generation}`,
          port: 45_000,
        });
        const after = this.behavior.exitAfterReadyMs;
        if (after === 0) this.exit(1, null);
        else if (after !== undefined)
          setTimeout(() => this.exit(1, null), after);
      });
    }
    if (message.type === 'drain') {
      queueMicrotask(() => {
        this.emit({
          type: 'drain.progress',
          voiceSessions: this.behavior.voiceSessions ?? 0,
        });
        const after = this.behavior.exitAfterDrainMs;
        if (after !== undefined) setTimeout(() => this.exit(0, null), after);
        else if (this.behavior.exitOnDrain !== false) this.exit(0, null);
      });
    }
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal);
    this.log.push(`${this.generation}<-${signal}`);
    if (signal === 'SIGKILL' || !this.behavior.ignoreTerm) {
      queueMicrotask(() => this.exit(null, signal));
    }
  }

  onMessage(listener: (message: unknown, handle: unknown) => void): void {
    this.messageListeners.push(listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  emit(message: unknown, handle?: unknown): void {
    if (this.exited) return;
    for (const listener of this.messageListeners) listener(message, handle);
  }

  exit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.log.push(`${this.generation} exited`);
    for (const listener of this.exitListeners) listener(code, signal);
  }
}

/** Shaped like Node's raw TCP wrap: not an EventEmitter, class named TCP. */
class TCP implements ListenerHandle {
  closed = false;
  /** Node returns ENOTCONN (non-zero) for a listening wrap, 0 for a connected one. */
  connected = false;
  close(): void {
    this.closed = true;
  }
  getpeername(): number {
    return this.connected ? 0 : -57;
  }
}

function fakeHandle(): TCP {
  return new TCP();
}

/** What Node hands the receiver when a core sends its net.Server. */
class Server extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

function setup(
  behaviorFor: (generation: number, entry: string) => Behavior = () => ({}),
  extra: Partial<GenerationManagerOptions> = {},
) {
  const log: string[] = [];
  const generations: FakeGeneration[] = [];
  const launcher: GenerationLauncher = {
    launch({ entry, generation }) {
      log.push(`launch ${generation}`);
      const gen = new FakeGeneration(
        generation,
        entry,
        behaviorFor(generation, entry),
        log,
      );
      generations.push(gen);
      return gen;
    },
  };
  const giveUps: number[] = [];
  const manager = new GenerationManager({
    entry: '/core/a.js',
    launcher,
    clock,
    onGiveUp: (failures) => giveUps.push(failures),
    ...extra,
  });
  const launchTimes: number[] = [];
  const origLaunch = launcher.launch.bind(launcher);
  launcher.launch = (options) => {
    launchTimes.push(Date.now());
    return origLaunch(options);
  };
  return { manager, generations, log, giveUps, launchTimes };
}

/** Advances fake time until `promise` settles (a handoff waits out the commit grace). */
async function settle<T>(promise: Promise<T>, limitMs = 60_000): Promise<T> {
  let done = false;
  void promise.finally(() => {
    done = true;
  });
  for (let elapsed = 0; !done && elapsed < limitMs; elapsed += 100) {
    await vi.advanceTimersByTimeAsync(100);
  }
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GenerationManager', () => {
  it('boots the first generation by asking it to bind, then holds its listener', async () => {
    const { manager, generations } = setup();
    await manager.start();
    expect(generations[0]?.sent.map(({ message }) => message)).toEqual([
      { type: 'promote', listeners: [] },
    ]);
    expect(manager.status()).toMatchObject({
      state: 'serving',
      active: { generation: 1, bootId: 'boot-1', state: 'serving' },
      listeners: [{ name: 'api', port: 45_000 }],
    });
  });

  it('hands off sequentially: park, drain, exit, promote with adopted handles, ready', async () => {
    const { manager, log, generations } = setup();
    await manager.start();
    log.length = 0;
    const phases: string[] = [];
    const result = await settle(
      manager.handoff({ entry: '/core/b.js' }, (phase) => phases.push(phase)),
    );
    expect(result).toEqual({
      outcome: 'committed',
      generation: 2,
      bootId: 'boot-2',
    });
    expect(log).toEqual([
      'launch 2',
      '1<-drain',
      '1 exited',
      '2<-promote',
      '2<-listener.adopt',
    ]);
    expect(phases).toEqual([
      'trial-started',
      'trial-parked',
      'draining',
      'drained',
      'promoted',
    ]);
    const adopt = generations[1]?.sent[1];
    expect(adopt?.message).toEqual({ type: 'listener.adopt', name: 'api' });
    expect(adopt?.handle).toBeDefined();
    expect(generations[1]?.sent[0]?.message).toEqual({
      type: 'promote',
      listeners: ['api'],
    });
    expect(manager.status().active).toMatchObject({
      generation: 2,
      entry: '/core/b.js',
    });
  });

  it('refuses a handoff while another runs and before anything serves', async () => {
    const { manager } = setup();
    expect(await manager.handoff({})).toEqual({
      outcome: 'refused',
      reason: 'not-serving',
    });
    await manager.start();
    const first = manager.handoff({});
    expect(await manager.handoff({})).toEqual({
      outcome: 'refused',
      reason: 'busy',
    });
    expect(await settle(first)).toMatchObject({ outcome: 'committed' });
  });

  it('restarts a crashed generation with doubling backoff and gives up after five failures', async () => {
    const { manager, generations, giveUps, launchTimes } = setup(
      (generation) => (generation === 1 ? {} : { park: false }),
    );
    await manager.start();
    generations[0]?.exit(1, null); // failure 1 at t=0
    // Each later generation never parks and is killed at the 30s park timeout.
    await vi.advanceTimersByTimeAsync(999);
    expect(launchTimes).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(launchTimes).toEqual([0, 1_000]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Failures 2..4 each wait 30s (park timeout) plus backoff 2s, 4s, 8s.
    const parkTimeout = 30_000;
    expect(launchTimes).toEqual([
      0,
      1_000,
      1_000 + parkTimeout + 2_000,
      1_000 + 2 * parkTimeout + 2_000 + 4_000,
      1_000 + 3 * parkTimeout + 2_000 + 4_000 + 8_000,
    ]);
    expect(giveUps).toEqual([5]);
    expect(manager.status().active).toBeNull();
  });

  it('caps the backoff at 30s', async () => {
    const log: string[] = [];
    const manager = new GenerationManager({
      entry: '/core/a.js',
      clock,
      restart: { maxFailures: 100, failureWindowMs: 1 },
      launcher: {
        launch: ({ generation, entry }) => {
          const gen = new FakeGeneration(
            generation,
            entry,
            { park: false },
            log,
          );
          queueMicrotask(() => gen.exit(1, null));
          return gen;
        },
      },
    });
    void manager.start();
    await vi.advanceTimersByTimeAsync(0);
    const backoffs = [manager.status().restarts.lastBackoffMs];
    for (let i = 0; i < 7; i += 1) {
      // Each wait elapses exactly the current backoff; the next launch fails at once.
      await vi.advanceTimersByTimeAsync(backoffs.at(-1) ?? 0);
      backoffs.push(manager.status().restarts.lastBackoffMs);
    }
    expect(backoffs).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    await manager.stop();
  });

  it('resets the backoff after 60s of stable serving', async () => {
    const { manager, generations } = setup();
    await manager.start();
    generations[0]?.exit(1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.status()).toMatchObject({
      state: 'serving',
      restarts: { consecutiveFailures: 1, lastBackoffMs: 1_000 },
    });
    // Crash again before stability: the backoff doubles.
    await vi.advanceTimersByTimeAsync(59_000);
    generations[1]?.exit(1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.status().restarts).toEqual({
      consecutiveFailures: 2,
      lastBackoffMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    // Stable for 60s: the next crash starts from 1s again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.status().restarts).toEqual({
      consecutiveFailures: 0,
      lastBackoffMs: null,
    });
    generations[2]?.exit(1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.status().restarts).toEqual({
      consecutiveFailures: 1,
      lastBackoffMs: 1_000,
    });
  });

  it('lets live voice sessions extend the drain up to the cap', async () => {
    const { manager, generations } = setup((generation) =>
      generation === 1 ? { exitOnDrain: false, voiceSessions: 1 } : {},
    );
    await manager.start();
    const handoff = manager.handoff({ drainDeadlineMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generations[0]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 10_000 - 1);
    expect(generations[0]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(generations[0]?.signals).toEqual(['SIGTERM']);
    expect(await settle(handoff)).toMatchObject({
      outcome: 'committed',
      generation: 2,
    });
  });

  it('escalates SIGTERM to SIGKILL at the drain deadline without voice sessions', async () => {
    const { manager, generations } = setup((generation) =>
      generation === 1 ? { exitOnDrain: false, ignoreTerm: true } : {},
    );
    await manager.start();
    const handoff = manager.handoff({ drainDeadlineMs: 10_000 });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(generations[0]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(generations[0]?.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(generations[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await settle(handoff)).toMatchObject({ outcome: 'committed' });
  });

  it('rolls back to the previous entry when the trial never becomes ready', async () => {
    const { manager, generations } = setup((_generation, entry) =>
      entry === '/core/bad.js' ? { ready: false } : {},
    );
    await manager.start();
    const handoff = manager.handoff({
      entry: '/core/bad.js',
      readinessTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await handoff).toEqual({
      outcome: 'rolled-back',
      reason: 'trial-readiness-timeout',
      generation: 3,
      bootId: 'boot-3',
    });
    // Promoted, it may already serve the held listeners: drained, not signalled.
    expect(generations[1]?.sent.map(({ message }) => message.type)).toContain(
      'drain',
    );
    expect(generations[1]?.signals).toEqual([]);
    expect(generations[2]?.entry).toBe('/core/a.js');
    expect(manager.status()).toMatchObject({
      state: 'serving',
      active: { generation: 3, entry: '/core/a.js' },
    });
  });

  it('drains a frozen failed trial for no longer than the kill grace', async () => {
    const { manager, generations } = setup((_generation, entry) =>
      entry === '/core/bad.js' ? { ready: false, exitOnDrain: false } : {},
    );
    await manager.start();
    // The default 10s drain deadline; the default kill grace is 5s.
    const handoff = manager.handoff({
      entry: '/core/bad.js',
      readinessTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(generations[1]?.sent.at(-1)?.message).toEqual({
      type: 'drain',
      deadlineMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(generations[1]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // A short SIGTERM, which this trial obeys: no SIGKILL needed.
    expect(generations[1]?.signals).toEqual(['SIGTERM']);
    expect(await settle(handoff)).toMatchObject({ outcome: 'rolled-back' });
    // The old generation of that handoff drained with the full deadline.
    expect(
      generations[0]?.sent.find(({ message }) => message.type === 'drain')
        ?.message,
    ).toEqual({ type: 'drain', deadlineMs: 10_000 });
  });

  it('signals a failed promoted trial only after it ignores the drain deadline', async () => {
    const { manager, generations } = setup((_generation, entry) =>
      entry === '/core/bad.js'
        ? { ready: false, exitOnDrain: false, ignoreTerm: true }
        : {},
    );
    await manager.start();
    const handoff = manager.handoff({
      entry: '/core/bad.js',
      readinessTimeoutMs: 5_000,
      drainDeadlineMs: 4_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(generations[1]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(generations[1]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(generations[1]?.signals).toEqual(['SIGTERM']);
    // Ignoring SIGTERM too: killed after the short grace, not the kill grace.
    await vi.advanceTimersByTimeAsync(FAILED_TRIAL_TERM_GRACE_MS - 1);
    expect(generations[1]?.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(FAILED_TRIAL_TERM_GRACE_MS).toBe(250);
    expect(generations[1]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await settle(handoff)).toMatchObject({
      outcome: 'rolled-back',
      reason: 'trial-readiness-timeout',
    });
  });

  it('answers core handoff requests: runs one from the active generation, refuses others', async () => {
    const { manager, generations } = setup((_generation, entry) =>
      entry === '/core/slow.js' ? { park: false } : {},
    );
    await manager.start();
    // A trial that never parks keeps a handoff running for the park timeout.
    const running = manager.handoff({ entry: '/core/slow.js' });
    await vi.advanceTimersByTimeAsync(0);
    generations[0]?.emit({ type: 'handoff.request', requestId: 'r1' });
    generations[1]?.emit({ type: 'handoff.request', requestId: 'r2' });
    await vi.advanceTimersByTimeAsync(0);
    expect(generations[0]?.sent.at(-1)?.message).toEqual({
      type: 'handoff.refused',
      requestId: 'r1',
      reason: 'busy',
    });
    expect(generations[1]?.sent.at(-1)?.message).toEqual({
      type: 'handoff.refused',
      requestId: 'r2',
      reason: 'not-active',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await running).toMatchObject({
      outcome: 'rolled-back',
      generation: 1,
    });

    // Once serving again, the active generation's request runs a handoff.
    generations[0]?.emit({ type: 'handoff.request', requestId: 'r3' });
    await vi.advanceTimersByTimeAsync(1_000); // the commit grace
    expect(manager.status().active?.generation).toBe(3);
  });

  it('refuses a requested entry the boundary rejects, from a client or the core, without launching', async () => {
    const log: string[] = [];
    let launches = 0;
    const manager = new GenerationManager({
      entry: '/root/a.js',
      clock,
      resolveEntry: (entry) =>
        entry.startsWith('/root/')
          ? { entry }
          : { refused: 'entry-outside-build-root' },
      launcher: {
        launch: ({ generation, entry }) => {
          launches += 1;
          return new FakeGeneration(generation, entry, {}, log);
        },
      },
    });
    await manager.start();
    expect(await manager.handoff({ entry: '/elsewhere/evil.js' })).toEqual({
      outcome: 'refused',
      reason: 'entry-outside-build-root',
    });
    expect(launches).toBe(1);
    expect(manager.status().state).toBe('serving');
    // No entry named: the committed entry is reused without re-checking.
    expect(await settle(manager.handoff({}))).toMatchObject({
      outcome: 'committed',
      generation: 2,
    });
    expect(launches).toBe(2);
  });

  it('refuses a listener.bound handle that is a net.Server, and fails that generation', async () => {
    const servers: Server[] = [];
    const { manager, launchTimes } = setup((generation) =>
      generation === 1
        ? {
            boundHandle: () => {
              const server = new Server();
              servers.push(server);
              return server;
            },
          }
        : {},
    );
    void manager.start();
    await vi.advanceTimersByTimeAsync(0);
    // Closed, never held, and the generation is not treated as ready.
    expect(servers[0]?.closed).toBe(true);
    expect(manager.heldListenerCount()).toBe(0);
    expect(manager.status().active).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(launchTimes).toEqual([0, 1_000]);
    expect(manager.status()).toMatchObject({
      state: 'serving',
      active: { generation: 2 },
      restarts: { consecutiveFailures: 1 },
      listeners: [{ name: 'api', port: 45_000 }],
    });
  });

  it('refuses a connected TCP wrap sent as a listener', async () => {
    const connected = new TCP();
    connected.connected = true;
    const { manager } = setup((generation) =>
      generation === 1 ? { boundHandle: () => connected } : {},
    );
    void manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connected.closed).toBe(true);
    expect(manager.heldListenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.status()).toMatchObject({
      state: 'serving',
      active: { generation: 2 },
    });
  });

  it('closes a handle sent with any message that does not take one', async () => {
    const { manager, generations } = setup();
    await manager.start();
    const gen = generations[0];
    const strays = [
      'ready',
      'drain.progress',
      'drained',
      'handoff.request',
      'parked',
      'no.such.type',
    ].map((type) => {
      const handle = fakeHandle();
      gen?.emit(
        { type, requestId: 'r', voiceSessions: 0, bootId: 'b', port: 1 },
        handle,
      );
      return [type, handle.closed] as const;
    });
    expect(strays).toEqual([
      ['ready', true],
      ['drain.progress', true],
      ['drained', true],
      ['handoff.request', true],
      ['parked', true],
      ['no.such.type', true],
    ]);
    await manager.stop();
  });

  it('restarts a generation that dies between ready and commit instead of wedging', async () => {
    const { manager, launchTimes } = setup((generation) =>
      generation === 1 ? { exitAfterReadyMs: 0 } : {},
    );
    await manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.status().restarts.consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(launchTimes).toEqual([0, 1_000]);
    expect(manager.status()).toMatchObject({
      state: 'serving',
      active: { generation: 2, state: 'serving' },
    });
  });

  it.each([
    { name: 'in the same tick as ready', exitAfterReadyMs: 0 },
    { name: 'shortly after ready', exitAfterReadyMs: 200 },
  ])(
    'rolls back, not commits, a trial that dies $name',
    async ({ exitAfterReadyMs }) => {
      const { manager } = setup((generation) =>
        generation === 2 ? { exitAfterReadyMs } : {},
      );
      await manager.start();
      const handoff = manager.handoff({});
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await handoff).toMatchObject({
        outcome: 'rolled-back',
        reason: 'trial-exited-at-commit',
        generation: 3,
      });
      expect(manager.status()).toMatchObject({
        state: 'serving',
        active: { generation: 3 },
      });
    },
  );

  it('restarts a stable generation that drained and exited on its own, without counting a failure', async () => {
    const { manager, generations } = setup();
    await manager.start();
    // Serving past the default 60s stability window.
    await vi.advanceTimersByTimeAsync(60_000);
    // An operator's SIGTERM to the core: it drains, says so, and exits 0.
    generations[0]?.emit({ type: 'drained' });
    generations[0]?.exit(0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(generations).toHaveLength(2);
    expect(manager.status()).toMatchObject({
      state: 'serving',
      active: { generation: 2 },
      restarts: { consecutiveFailures: 0, lastBackoffMs: null },
    });
    // Without `drained`, the same clean exit code is still a crash.
    generations[1]?.exit(0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.status().restarts.consecutiveFailures).toBe(1);
  });

  it('counts a clean drained exit before the generation is stable, so drains cannot loop', async () => {
    const { manager, generations } = setup();
    await manager.start();
    // Drains and exits cleanly right after serving, again and again.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = generations.at(-1);
      current?.emit({ type: 'drained' });
      current?.exit(0, null);
      await vi.advanceTimersByTimeAsync(31_000);
    }
    // Each counted: the failure budget ends the loop.
    expect(
      manager.status().restarts.consecutiveFailures,
    ).toBeGreaterThanOrEqual(4);
    expect(generations.length).toBeLessThanOrEqual(5);
  });

  it('counts a crash of the active generation during a handoff as a failure', async () => {
    const { manager, generations } = setup((generation) =>
      generation === 2 ? { park: false } : {},
    );
    await manager.start();
    const handoff = manager.handoff({});
    await vi.advanceTimersByTimeAsync(0);
    generations[0]?.exit(1, null); // the serving generation crashes mid-handoff
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await handoff).toMatchObject({ outcome: 'rolled-back' });
    expect(manager.status().restarts.consecutiveFailures).toBe(1);
  });

  it('caps the stop drain, voice sessions included, at 30s by default', async () => {
    const { manager, generations } = setup(() => ({
      exitOnDrain: false,
      voiceSessions: 1,
    }));
    await manager.start();
    const stopped = manager.stop(10_000);
    await vi.advanceTimersByTimeAsync(30_000 - 1);
    expect(generations[0]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(generations[0]?.signals).toEqual(['SIGTERM']);
    await stopped;
  });

  it('drains everything and closes its listeners on stop', async () => {
    const { manager, generations } = setup();
    await manager.start();
    await manager.stop();
    expect(generations[0]?.sent.at(-1)?.message).toEqual({
      type: 'drain',
      deadlineMs: 10_000,
    });
    expect(manager.status().state).toBe('stopping');
    expect(manager.heldListenerCount()).toBe(0);
    expect(await manager.handoff({})).toEqual({
      outcome: 'refused',
      reason: 'stopping',
    });
  });

  describe('catching connections during a handoff (Windows)', () => {
    class FakeConnection implements HeldConnection {
      destroyed = false;
      destroy(): void {
        this.destroyed = true;
      }
    }
    interface FakeCatcher {
      name: string;
      handle: ListenerHandle;
      held: FakeConnection[];
      closed: boolean;
      stopped: boolean;
      lastCaughtAt: number;
      /** Accepts one more connection, as a real catcher would. */
      catchOne(): void;
    }
    /**
     * Each catcher holds one connection; `log` records when one listens.
     * With `caughtAt`, each starts as if it had just accepted then.
     */
    function catching(log: () => string[], caughtAt?: () => number) {
      const catchers: FakeCatcher[] = [];
      const createCatcher: CatcherFactory = (name, handle, now, onCatch) => {
        const entry: FakeCatcher = {
          name,
          handle,
          held: [new FakeConnection()],
          closed: false,
          stopped: false,
          lastCaughtAt: caughtAt?.() ?? 0,
          catchOne() {
            entry.held.push(new FakeConnection());
            entry.lastCaughtAt = now();
            onCatch();
          },
        };
        catchers.push(entry);
        log().push(`catcher ${name}`);
        return {
          name,
          get lastCaughtAt() {
            return entry.lastCaughtAt;
          },
          get heldCount() {
            return entry.held.filter((c) => !c.destroyed).length;
          },
          stop: () => {
            entry.stopped = true;
          },
          close: () => {
            entry.stopped = true;
            entry.closed = true;
            log().push(`catcher ${name} closed`);
            return entry.held;
          },
        };
      };
      return {
        catchers,
        extra: { catchConnections: { spares: 2, createCatcher } },
      };
    }
    function setupCatching(
      behaviorFor: (generation: number, entry: string) => Behavior = () => ({}),
      catchConnections = true,
      caughtAt?: () => number,
    ) {
      let logRef: string[] = [];
      /** What the manager logs. */
      const lines: string[] = [];
      const { catchers, extra } = catching(() => logRef, caughtAt);
      const harness = setup(
        (generation, entry) => ({
          adoptsConnections: true,
          ...behaviorFor(generation, entry),
        }),
        {
          ...(catchConnections ? extra : {}),
          log: (line) => lines.push(line),
        },
      );
      logRef = harness.log;
      return { ...harness, catchers, lines };
    }
    const adopted = (gen: FakeGeneration | undefined) =>
      (gen?.sent ?? [])
        .filter(({ message }) => message.type === 'connection.adopt')
        .map(({ message, handle }) => ({ message, handle }));
    const heldConnections = (catchers: FakeCatcher[]) =>
      catchers.flatMap(({ held }) => held);

    it('listens on spares before draining, then passes what it held to the generation that listens', async () => {
      const { manager, log, generations, catchers } = setupCatching();
      await manager.start();
      log.length = 0;
      const result = await settle(manager.handoff({ entry: '/core/b.js' }));
      expect(result).toMatchObject({ outcome: 'committed', generation: 2 });
      expect(log).toEqual([
        'launch 2',
        '1<-listener.spares',
        'catcher api',
        'catcher api',
        '1<-drain',
        '1 exited',
        '2<-promote',
        '2<-listener.adopt',
        'catcher api closed',
        '2<-connection.adopt',
        'catcher api closed',
        '2<-connection.adopt',
      ]);
      expect(
        generations[0]?.sent.find(
          ({ message }) => message.type === 'listener.spares',
        )?.message,
      ).toEqual({ type: 'listener.spares', name: 'api', count: 2 });
      expect(adopted(generations[1])).toEqual(
        heldConnections(catchers).map((handle) => ({
          message: { type: 'connection.adopt', name: 'api' },
          handle,
        })),
      );
      expect(heldConnections(catchers).every((c) => !c.destroyed)).toBe(true);
      // The next handoff catches again, from generation 2.
      log.length = 0;
      expect(
        await settle(manager.handoff({ entry: '/core/c.js' })),
      ).toMatchObject({ outcome: 'committed', generation: 3 });
      expect(log.slice(0, 2)).toEqual(['launch 3', '2<-listener.spares']);
      expect(adopted(generations[2])).toHaveLength(2);
      await manager.stop();
    });

    it('passes what it held to the generation a rollback starts, not the failed trial', async () => {
      const { manager, generations, catchers } = setupCatching(
        (_generation, entry) =>
          entry === '/core/bad.js' ? { ready: false } : {},
      );
      await manager.start();
      const handoff = manager.handoff({
        entry: '/core/bad.js',
        readinessTimeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await settle(handoff)).toMatchObject({
        outcome: 'rolled-back',
        generation: 3,
      });
      expect(adopted(generations[1])).toEqual([]);
      expect(adopted(generations[2]).map(({ handle }) => handle)).toEqual(
        heldConnections(catchers),
      );
      expect(heldConnections(catchers).every((c) => !c.destroyed)).toBe(true);
      await manager.stop();
    });

    for (const [label, oldGeneration] of [
      ['serving generation', 1],
      ['trial', 2],
    ] as const) {
      it(`catches nothing, and drains at once, when the ${label} is a 1.0 core`, async () => {
        const { manager, log, generations, catchers } = setupCatching(
          (generation) =>
            generation === oldGeneration ? { adoptsConnections: false } : {},
        );
        await manager.start();
        log.length = 0;
        const handoff = manager.handoff({ entry: '/core/b.js' });
        // No wait for spares: the drain goes out in the same turn as parking.
        await vi.advanceTimersByTimeAsync(0);
        expect(log).toEqual([
          'launch 2',
          '1<-drain',
          '1 exited',
          '2<-promote',
          '2<-listener.adopt',
        ]);
        expect(await settle(handoff)).toMatchObject({
          outcome: 'committed',
          generation: 2,
        });
        expect(catchers).toEqual([]);
        expect(adopted(generations[1])).toEqual([]);
        await manager.stop();
      });
    }

    it('catches nothing when not asked to (POSIX), even between 1.1 cores', async () => {
      const { manager, log, catchers } = setupCatching(undefined, false);
      await manager.start();
      log.length = 0;
      expect(
        await settle(manager.handoff({ entry: '/core/b.js' })),
      ).toMatchObject({ outcome: 'committed', generation: 2 });
      expect(log).not.toContain('1<-listener.spares');
      expect(catchers).toEqual([]);
    });

    it('drains anyway when the serving generation never answers, and closes spares nobody asked for', async () => {
      const { manager, log, generations, catchers } = setupCatching(
        (generation) => (generation === 1 ? { answerSpares: false } : {}),
      );
      await manager.start();
      const stray = fakeHandle();
      generations[0]?.emit({ type: 'listener.spare', name: 'api' }, stray);
      expect(stray.closed).toBe(true);
      log.length = 0;
      const handoff = manager.handoff({ entry: '/core/b.js' });
      await vi.advanceTimersByTimeAsync(SPARE_ANSWER_TIMEOUT_MS - 1);
      expect(log).toEqual(['launch 2', '1<-listener.spares']);
      await vi.advanceTimersByTimeAsync(1);
      expect(log.slice(2, 3)).toEqual(['1<-drain']);
      expect(await settle(handoff)).toMatchObject({
        outcome: 'committed',
        generation: 2,
      });
      expect(catchers).toEqual([]);
      await manager.stop();
    });

    it('refuses a spare that is not a raw listening handle, or for a listener it does not hold', async () => {
      const server = new Server();
      const { manager, generations, catchers } = setupCatching((generation) =>
        generation === 1 ? { spareHandle: () => server } : {},
      );
      await manager.start();
      const handoff = manager.handoff({ entry: '/core/b.js' });
      await vi.advanceTimersByTimeAsync(0);
      expect(server.closed).toBe(true);
      const other = fakeHandle();
      generations[0]?.emit({ type: 'listener.spare', name: 'voice' }, other);
      expect(other.closed).toBe(true);
      expect(catchers).toEqual([]);
      expect(await settle(handoff)).toMatchObject({ outcome: 'committed' });
      await manager.stop();
    });

    it('closes what it holds when it stops before any generation is ready again', async () => {
      const { manager, generations, catchers } = setupCatching(
        (_generation, entry) =>
          entry === '/core/bad.js' ? { ready: false } : {},
      );
      await manager.start();
      const handoff = manager.handoff({
        entry: '/core/bad.js',
        readinessTimeoutMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(catchers).toHaveLength(2);
      expect(catchers.some(({ closed }) => closed)).toBe(false);
      await settle(manager.stop());
      await settle(handoff);
      expect(catchers.every(({ closed }) => closed)).toBe(true);
      expect(heldConnections(catchers).every((c) => c.destroyed)).toBe(true);
      expect(generations.flatMap((gen) => adopted(gen))).toEqual([]);
    });

    it('passes what it held to the first generation listening even if it never becomes ready, and catches again while that trial drains', async () => {
      const { manager, log, generations, catchers } = setupCatching(
        (_generation, entry) =>
          entry === '/core/bad.js'
            ? { ready: false, listenWithoutReady: true }
            : {},
      );
      await manager.start();
      log.length = 0;
      const handoff = manager.handoff({
        entry: '/core/bad.js',
        readinessTimeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await settle(handoff)).toMatchObject({
        outcome: 'rolled-back',
        generation: 3,
      });
      // As the backlog would have: the trial accepted them, and was drained.
      const [first, second] = [catchers.slice(0, 2), catchers.slice(2)];
      expect(adopted(generations[1]).map(({ handle }) => handle)).toEqual(
        heldConnections(first),
      );
      expect(generations[1]?.signals).toEqual([]);
      // Its drain was caught too, for the generation the rollback started.
      expect(log).toContain('2<-listener.spares');
      expect(log.indexOf('2<-listener.spares')).toBeLessThan(
        log.indexOf('2<-drain'),
      );
      expect(second).toHaveLength(2);
      expect(adopted(generations[2]).map(({ handle }) => handle)).toEqual(
        heldConnections(second),
      );
      await manager.stop();
    });

    it('passes what it held at ready to a generation that never reported the listener listening', async () => {
      const { manager, generations, catchers } = setupCatching((generation) =>
        generation === 2 ? { reportsListening: false } : {},
      );
      await manager.start();
      expect(
        await settle(manager.handoff({ entry: '/core/b.js' })),
      ).toMatchObject({ outcome: 'committed', generation: 2 });
      expect(adopted(generations[1]).map(({ handle }) => handle)).toEqual(
        heldConnections(catchers),
      );
      await manager.stop();
    });

    it('keeps catchers open until none has accepted for the quiet window, or until the cap', async () => {
      for (const busy of [false, true]) {
        const { manager, log, catchers } = setupCatching(undefined, true, () =>
          Date.now(),
        );
        await manager.start();
        log.length = 0;
        // When busy, the catchers keep accepting after generation 2 listens.
        const busyTimer = busy
          ? setInterval(() => {
              for (const catcher of catchers) catcher.lastCaughtAt = Date.now();
            }, 10)
          : null;
        const handoff = manager.handoff({ entry: '/core/b.js' });
        await vi.advanceTimersByTimeAsync(0);
        // Generation 1 drained into the spares and generation 2 listens.
        expect(catchers).toHaveLength(2);
        expect(log).toContain('2<-listener.adopt');
        expect(catchers.some(({ closed }) => closed)).toBe(false);
        const closesAt = busy ? CATCH_QUIET_CAP_MS : CATCH_QUIET_MS;
        await vi.advanceTimersByTimeAsync(closesAt - 1);
        expect(catchers.some(({ closed }) => closed)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(catchers.every(({ closed }) => closed)).toBe(true);
        if (busyTimer) clearInterval(busyTimer);
        await settle(handoff);
        await manager.stop();
      }
    });

    it('keeps holding for the rollback when the trial exits during the release quiet window', async () => {
      const { manager, generations, catchers } = setupCatching(
        (_generation, entry) =>
          entry === '/core/bad.js'
            ? {
                ready: false,
                listenWithoutReady: true,
                exitAfterListeningMs: 10,
              }
            : {},
        true,
        () => Date.now(),
      );
      await manager.start();
      const handoff = manager.handoff({
        entry: '/core/bad.js',
        readinessTimeoutMs: 5_000,
      });
      expect(await settle(handoff)).toMatchObject({
        outcome: 'rolled-back',
        generation: 3,
      });
      expect(generations[1]?.exited).toBe(true);
      expect(adopted(generations[1])).toEqual([]);
      expect(adopted(generations[2]).map(({ handle }) => handle)).toEqual(
        heldConnections(catchers),
      );
      expect(heldConnections(catchers).every((c) => !c.destroyed)).toBe(true);
      await manager.stop();
    });

    it('keeps holding for the rollback when the trial is being ended during the release quiet window', async () => {
      const { manager, generations, catchers } = setupCatching(
        (_generation, entry) =>
          entry === '/core/bad.js'
            ? { ready: false, listenWithoutReady: true, answerSpares: false }
            : {},
        true,
        () => Date.now(),
      );
      await manager.start();
      // The catchers keep accepting, so the release waits out its cap, and
      // the trial's readiness timeout passes inside that wait.
      const busy = setInterval(() => {
        for (const catcher of catchers) catcher.lastCaughtAt = Date.now();
      }, 10);
      const handoff = manager.handoff({
        entry: '/core/bad.js',
        readinessTimeoutMs: CATCH_QUIET_CAP_MS / 2,
      });
      await vi.advanceTimersByTimeAsync(CATCH_QUIET_CAP_MS * 2);
      clearInterval(busy);
      expect(await settle(handoff)).toMatchObject({
        outcome: 'rolled-back',
        generation: 3,
      });
      expect(adopted(generations[1])).toEqual([]);
      expect(adopted(generations[2]).map(({ handle }) => handle)).toEqual(
        heldConnections(catchers),
      );
      await manager.stop();
    });

    it('stops a listener catching once it holds the limit, leaving new connections to the backlog', async () => {
      const { manager, lines, catchers } = setupCatching(
        (_generation, entry) =>
          entry === '/core/bad.js' ? { ready: false } : {},
      );
      await manager.start();
      const handoff = manager.handoff({
        entry: '/core/bad.js',
        readinessTimeoutMs: 30_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(catchers).toHaveLength(2);
      // Each catcher starts holding one; bring the listener to one short.
      const [a, b] = catchers as [FakeCatcher, FakeCatcher];
      for (let held = 2; held < HOLD_LIMIT_PER_LISTENER - 1; held += 1) {
        (held % 2 ? a : b).catchOne();
      }
      expect(catchers.some(({ stopped }) => stopped)).toBe(false);
      a.catchOne();
      expect(catchers.every(({ stopped }) => stopped)).toBe(true);
      expect(catchers.some(({ closed }) => closed)).toBe(false);
      expect(lines.join('\n')).toContain(
        `holding ${HOLD_LIMIT_PER_LISTENER} connection(s) for api, the limit`,
      );
      // What it holds is still passed on, to the rollback generation.
      expect(await settle(handoff)).toMatchObject({ outcome: 'rolled-back' });
      expect(heldConnections(catchers)).toHaveLength(HOLD_LIMIT_PER_LISTENER);
      expect(heldConnections(catchers).every((c) => !c.destroyed)).toBe(true);
      await manager.stop();
    });

    it('holds through a drain a live call extends past the hold deadline, and delivers after promotion', async () => {
      const drainMs = HOLD_DEADLINE_MS + 30_000;
      const { manager, generations, catchers } = setupCatching((generation) =>
        generation === 1 ? { voiceSessions: 1, exitAfterDrainMs: drainMs } : {},
      );
      await manager.start();
      const handoff = manager.handoff({ entry: '/core/b.js' });
      await vi.advanceTimersByTimeAsync(0);
      expect(catchers).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(drainMs - 1);
      // Past the deadline, generation 1 still draining: nothing dropped.
      expect(generations[0]?.exited).toBe(false);
      expect(heldConnections(catchers).some((c) => c.destroyed)).toBe(false);
      expect(await settle(handoff)).toMatchObject({
        outcome: 'committed',
        generation: 2,
      });
      expect(adopted(generations[1]).map(({ handle }) => handle)).toEqual(
        heldConnections(catchers),
      );
      expect(heldConnections(catchers).some((c) => c.destroyed)).toBe(false);
      await manager.stop();
    });

    it('closes what it holds at the deadline once the handoff has ended with no generation to take it', async () => {
      // The trial fails, and so does every generation after it: the handoff
      // ends in crash restarts with the connections still held.
      const { manager, lines, catchers } = setupCatching((generation) =>
        generation >= 2 ? { ready: false } : {},
      );
      await manager.start();
      void manager.handoff({ entry: '/core/b.js', readinessTimeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(catchers).toHaveLength(2);
      // At the first deadline the rollback generation is still on its way.
      await vi.advanceTimersByTimeAsync(HOLD_DEADLINE_MS);
      expect(manager.status().state).toBe('handoff');
      expect(heldConnections(catchers).some((c) => c.destroyed)).toBe(false);
      // It fails its readiness (60 s): crash restarts, and the next deadline
      // closes what is held.
      await vi.advanceTimersByTimeAsync(HOLD_DEADLINE_MS - 1);
      expect(manager.status().state).toBe('restarting');
      expect(heldConnections(catchers).some((c) => c.destroyed)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(catchers.every(({ closed }) => closed)).toBe(true);
      expect(heldConnections(catchers).every((c) => c.destroyed)).toBe(true);
      expect(lines).toContain(
        `closed 2 connection(s) held longer than ${HOLD_DEADLINE_MS}ms with no generation to take them`,
      );
      await settle(manager.stop());
    });
  });
});
