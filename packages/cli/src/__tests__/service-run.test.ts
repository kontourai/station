import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readInstanceRegistry,
  upsertInstance,
} from '@kontourai/station-shared/instance-registry';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CollectedChildStatus } from '../commands/lifecycle.js';
import { superviseService } from '../commands/service-run.js';

const lifecycle = {
  baseDir: '/tmp/station-service',
  homeSource: '--base' as const,
  host: '127.0.0.1',
  instanceName: 'service-test',
  serverPort: 3242,
  uiPort: 5274,
};

const okChild = (pid: number): CollectedChildStatus => ({
  listening: true,
  pid,
  probe: 'ok',
  reachable: true,
});
// Alive and listening, but the HTTP probe missed its budget — the
// station#1846 busy-host shape. Must never cause a teardown on its own.
const slowChild = (pid: number): CollectedChildStatus => ({
  listening: true,
  pid,
  probe: 'unreachable',
  reachable: false,
});
const refusedChild = (pid: number): CollectedChildStatus => ({
  listening: false,
  pid,
  probe: 'unreachable',
  reachable: false,
});
const mismatchChild = (pid: number): CollectedChildStatus => ({
  listening: true,
  pid,
  probe: 'identity-mismatch',
  reachable: false,
});
const authRefusedChild = (pid: number): CollectedChildStatus => ({
  listening: true,
  pid,
  probe: 'http-auth-refused',
  reachable: false,
});

function instanceStatus(
  server: CollectedChildStatus,
  ui: CollectedChildStatus,
  bootId = 'boot-1',
) {
  return {
    bootId,
    found: true,
    healthy: server.reachable && ui.reachable,
    instanceId: 'service-test',
    server,
    sha: 'abc',
    ui,
  };
}

/**
 * Deterministic supervisor harness: timers are captured instead of scheduled,
 * and each released tick advances the injected clock by the requested delay,
 * so long probe-failure windows are simulated without wall-clock time.
 */
function makeSupervisor(options: {
  collect: ReturnType<typeof vi.fn>;
  clockAdvanceMs?: number;
  listListeningPids?: (port: number) => number[];
  needsBuildForInstance?: (instanceName: string) => boolean;
  processIsAlive?: (pid: number) => boolean;
}) {
  const exit = vi.fn();
  const stop = vi.fn();
  const start = vi.fn().mockResolvedValue(undefined);
  const ticks: Array<() => void> = [];
  let clock = 0;
  const setTimer = vi.fn((callback: () => void, delayMs: number) => {
    ticks.push(() => {
      clock += options.clockAdvanceMs ?? delayMs;
      callback();
    });
    return 1 as never;
  });
  const publishServiceLiveness = vi.fn();
  const supervision = superviseService(lifecycle, {
    collect: options.collect as never,
    exit,
    needsBuildForInstance: options.needsBuildForInstance,
    // Hermetic: the real publisher writes to `lifecycle.baseDir`, a shared
    // /tmp path here. Liveness publication has its own temp-home tests.
    publishServiceLiveness,
    // Hermetic by default: without this stub the production fallback runs
    // REAL lsof against the harness's fabricated ports, so whatever happens
    // to be listening on the host leaks into these tests (caught by the
    // full-regression corpus: a busy host made a fabricated port look
    // squatted, and 36 ticks of lsof spawns blew the test timeout). Empty
    // means "listener state unknown" — the conservative production branch.
    listListeningPids: options.listListeningPids ?? (() => []),
    now: () => clock,
    onSignal: vi.fn(),
    processIsAlive: options.processIsAlive ?? (() => true),
    setTimer,
    start,
    stop,
  });
  const runTick = async () => {
    const tick = ticks.shift();
    tick?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    exit,
    publishServiceLiveness,
    pendingTicks: () => ticks.length,
    runTick,
    setTimer,
    start,
    stop,
    supervision,
  };
}

describe('service supervisor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('waits for an in-flight start to publish before SIGTERM cleanup exits', async () => {
    let finishStart: (() => void) | undefined;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const stop = vi.fn();
    const exit = vi.fn();
    const signals = new Map<string, () => void>();

    const supervision = superviseService(lifecycle, {
      exit,
      onSignal: (signal, listener) => signals.set(signal, listener),
      publishServiceLiveness: vi.fn(),
      start,
      stop,
    });
    signals.get('SIGTERM')?.();
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    finishStart?.();
    await supervision;
    expect(stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('absorbs a repeated SIGTERM while shutdown is waiting for start publication', async () => {
    let finishStart: (() => void) | undefined;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const stop = vi.fn();
    const exit = vi.fn();
    const signals = new Map<string, () => void>();

    const supervision = superviseService(lifecycle, {
      exit,
      onSignal: (signal, listener) => signals.set(signal, listener),
      publishServiceLiveness: vi.fn(),
      start,
      stop,
    });
    signals.get('SIGTERM')?.();
    signals.get('SIGTERM')?.();
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    finishStart?.();
    await supervision;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('force-exits when shutdown cleanup does not settle by its deadline', async () => {
    const signals = new Map<string, () => void>();
    const timers = new Map<number, () => void>();
    const exit = vi.fn();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(okChild(10), okChild(11)));
    const setTimer = vi.fn((callback: () => void, delayMs: number) => {
      timers.set(delayMs, callback);
      return 1 as never;
    });

    await superviseService(lifecycle, {
      collect,
      exit,
      onSignal: (signal, listener) => signals.set(signal, listener),
      processIsAlive: () => true,
      publishServiceLiveness: vi.fn(),
      setTimer,
      start: vi.fn().mockResolvedValue(undefined),
      stop,
    });
    signals.get('SIGTERM')?.();
    await vi.waitFor(() =>
      expect(stop).toHaveBeenCalledWith({ instanceName: 'service-test' }),
    );

    timers.get(60_000)?.();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('clears the shutdown deadline after ordinary cleanup', async () => {
    const signals = new Map<string, () => void>();
    const exit = vi.fn();
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(okChild(10), okChild(11)));
    const setTimer = vi.fn(() => 1 as never);

    await superviseService(lifecycle, {
      publishServiceLiveness: vi.fn(),
      collect,
      exit,
      onSignal: (signal, listener) => signals.set(signal, listener),
      processIsAlive: () => true,
      setTimer,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    });
    signals.get('SIGTERM')?.();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).not.toHaveBeenCalledWith(1);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  test('registers persistent signal listeners so repeat SIGTERM reaches idempotent shutdown', async () => {
    const signals = new Map<string, () => void>();
    const on = vi.spyOn(process, 'on').mockImplementation(((
      signal: string | symbol,
      listener: () => void,
    ) => {
      if (typeof signal === 'string') signals.set(signal, listener);
      return process;
    }) as never);
    const exit = vi.fn();
    const stop = vi.fn();
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(okChild(10), okChild(11)));

    await superviseService(lifecycle, {
      publishServiceLiveness: vi.fn(),
      collect,
      exit,
      processIsAlive: () => true,
      setTimer: vi.fn(() => 1 as never),
      start: vi.fn().mockResolvedValue(undefined),
      stop,
    });
    expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    signals.get('SIGTERM')?.();
    signals.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test('starts in-process and handles SIGTERM with a targeted stop', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn();
    const exit = vi.fn();
    const signals = new Map<string, () => void>();
    const setTimer = vi.fn(() => 1 as never);
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(okChild(10), okChild(11)));

    await superviseService(lifecycle, {
      publishServiceLiveness: vi.fn(),
      collect,
      exit,
      onSignal: (signal, listener) => signals.set(signal, listener),
      processIsAlive: () => true,
      setTimer,
      start,
      stop,
    });
    signals.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        force: true,
        instanceName: 'service-test',
        supervisorPid: process.pid,
      }),
    );
    // Persisted origins from the unit's --allowed-origin args must reach
    // start(), which merges them into ALLOWED_ORIGINS (#1672). This suite's
    // lifecycle has none, so the field is explicitly undefined, not dropped.
    expect(start.mock.calls[0][0]).toHaveProperty('allowedOrigins', undefined);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('threads lifecycle allowed origins into start (#1672)', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn();
    const exit = vi.fn();
    const signals = new Map<string, () => void>();
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(okChild(10), okChild(11)));

    await superviseService(
      { ...lifecycle, allowedOrigins: ['https://kontour.example.ts.net'] },
      {
        collect,
        exit,
        onSignal: (signal, listener) => signals.set(signal, listener),
        processIsAlive: () => true,
        setTimer: vi.fn(() => 1 as never),
        start,
        stop,
      },
    );
    signals.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedOrigins: ['https://kontour.example.ts.net'],
      }),
    );
  });

  test('backs off a failed start before exiting non-zero', async () => {
    const exit = vi.fn();
    const stop = vi.fn();
    const setTimer = vi.fn((callback: () => void, delayMs: number) => {
      if (delayMs === 5_000) callback();
      return 1 as never;
    });

    await superviseService(lifecycle, {
      publishServiceLiveness: vi.fn(),
      exit,
      onSignal: vi.fn(),
      setTimer,
      start: vi.fn().mockRejectedValue(new Error('build failed')),
      stop,
    });

    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('fails closed when start publishes no instance record', async () => {
    const exit = vi.fn();
    await superviseService(lifecycle, {
      publishServiceLiveness: vi.fn(),
      collect: vi.fn().mockResolvedValue({
        found: false,
        healthy: false,
        instanceId: 'service-test',
        server: {
          listening: false,
          pid: null,
          probe: 'unreachable',
          reachable: false,
        },
        ui: {
          listening: false,
          pid: null,
          probe: 'unreachable',
          reachable: false,
        },
      }),
      exit,
      onSignal: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  // station#1846 regression: an alive, listening server whose HTTP probe
  // misses its budget is SLOW, not dead. The old supervisor killed the whole
  // Station after three 3s misses (~9s of host load); 31 measured
  // self-inflicted restarts in one day.
  test('does not restart a server that is alive and listening but slow to answer probes (#1846)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const collect = vi.fn(
      async (_name: string, options?: { probeTimeoutMs?: number }) =>
        options?.probeTimeoutMs === 45_000
          ? instanceStatus(okChild(10), okChild(11))
          : instanceStatus(slowChild(10), slowChild(11)),
    );
    const harness = makeSupervisor({ collect });
    await harness.supervision;

    // 35 ticks x 5s = 175s of continuous probe failure: still inside the
    // 180s window, so no teardown AND no long-budget confirmation yet — the
    // window's lower bound is load-bearing (review round 1, MED 2).
    for (let index = 0; index < 35; index += 1) {
      await harness.runTick();
    }
    expect(harness.stop).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalledWith('service-test', {
      probeTimeoutMs: 45_000,
    });

    // Tick 36 crosses 180s: the escalation runs the long-budget confirmation
    // probe, which answers, and the supervisor keeps supervising.
    await harness.runTick();
    expect(harness.stop).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();
    // Steady-state probes carry the busy-host budget, not the old 3s default.
    expect(collect).toHaveBeenCalledWith('service-test', {
      probeTimeoutMs: 10_000,
    });
    // The escalation path ran a long-budget confirmation instead of a kill.
    expect(collect).toHaveBeenCalledWith('service-test', {
      probeTimeoutMs: 45_000,
    });
    // Supervision continues: the loop keeps scheduling ticks.
    expect(harness.pendingTicks()).toBeGreaterThan(0);
  });

  test('a failing UI probe does not tear down a healthy server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(okChild(10), slowChild(11)));
    const harness = makeSupervisor({ collect });
    await harness.supervision;

    for (let index = 0; index < 10; index += 1) {
      await harness.runTick();
    }

    expect(harness.stop).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();
    // The complaint names the UI, not the server.
    expect(
      warn.mock.calls.some(([message]) => String(message).includes('ui')),
    ).toBe(true);
    expect(
      warn.mock.calls.some(([message]) => String(message).includes('server')),
    ).toBe(false);
  });

  test('a genuinely dead child still triggers the supervisor', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(okChild(10), okChild(11)));
    const harness = makeSupervisor({
      collect,
      processIsAlive: (pid) => pid !== 11,
    });
    await harness.supervision;

    expect(harness.stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(
      error.mock.calls.some(([, reason]) =>
        String((reason as Error)?.message).includes(
          'Managed Station ui child process exited',
        ),
      ),
    ).toBe(true);
  });

  test('a changed boot identity in the instance record still triggers teardown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const collect = vi
      .fn()
      // First call captures `expected`; second is the initial check.
      .mockResolvedValueOnce(instanceStatus(okChild(10), okChild(11)))
      .mockResolvedValueOnce(instanceStatus(okChild(10), okChild(11)))
      .mockResolvedValue(instanceStatus(okChild(10), okChild(11), 'boot-2'));
    const harness = makeSupervisor({ collect });
    await harness.supervision;
    expect(harness.exit).not.toHaveBeenCalled();

    await harness.runTick();

    expect(harness.stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  test('a probe answering with a different identity tears down after three strikes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(mismatchChild(10), okChild(11)));
    const harness = makeSupervisor({ collect });
    await harness.supervision;
    // Strike one happened on the initial check.
    expect(harness.exit).not.toHaveBeenCalled();

    await harness.runTick();
    expect(harness.exit).not.toHaveBeenCalled();
    await harness.runTick();

    expect(harness.stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(
      error.mock.calls.some(([, reason]) =>
        String((reason as Error)?.message).includes(
          'reports a different Station',
        ),
      ),
    ).toBe(true);
  });

  test('escalates sustained definitive identity-endpoint auth refusal through the normal teardown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = makeSupervisor({
      clockAdvanceMs: 12_000,
      collect: vi
        .fn()
        .mockResolvedValue(instanceStatus(authRefusedChild(10), okChild(11))),
    });
    await harness.supervision;

    // The initial check is strike one at t=0. Five 12s intervals establish
    // six consecutive HTTP 401/403 observations over the 60s threshold.
    for (let index = 0; index < 5; index += 1) await harness.runTick();

    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(1));
    expect(harness.stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(
      error.mock.calls.some(([, reason]) =>
        String((reason as Error)?.message).includes(
          'supervisor authentication wedge',
        ),
      ),
    ).toBe(true);
  });

  test('a wedge that survived repeated restarts suspends escalation instead of looping (sol #2669 finding 1)', async () => {
    const ledgerDir = '/tmp/station-service/logs';
    mkdirSync(ledgerDir, { recursive: true });
    // Three prior escalations "recently" on the harness clock (which starts
    // at 0 and advances 12s per tick) — all within the 15m window.
    writeFileSync(
      join(ledgerDir, 'service-test.auth-escalations.json'),
      JSON.stringify([1, 2, 3]),
    );
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const harness = makeSupervisor({
        clockAdvanceMs: 12_000,
        collect: vi
          .fn()
          .mockResolvedValue(instanceStatus(authRefusedChild(10), okChild(11))),
      });
      await harness.supervision;
      for (let index = 0; index < 6; index += 1) await harness.runTick();

      // No teardown: the service stays up; the distinct suspension line names
      // the doctor.
      expect(harness.exit).not.toHaveBeenCalled();
      expect(harness.stop).not.toHaveBeenCalled();
      expect(
        error.mock.calls.some(([message]) =>
          String(message).includes('automatic recovery suspended'),
        ),
      ).toBe(true);
    } finally {
      rmSync(join(ledgerDir, 'service-test.auth-escalations.json'), {
        force: true,
      });
    }
  });

  test('interleaved auth refusals reset mismatch strikes — consecutiveness is per cause (sol #2669 finding 3)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const collect = vi.fn();
    // mismatch, mismatch, auth, mismatch — the third mismatch must NOT be
    // strike three.
    collect
      .mockResolvedValueOnce(instanceStatus(mismatchChild(10), okChild(11)))
      .mockResolvedValueOnce(instanceStatus(mismatchChild(10), okChild(11)))
      .mockResolvedValueOnce(instanceStatus(mismatchChild(10), okChild(11)))
      .mockResolvedValueOnce(instanceStatus(authRefusedChild(10), okChild(11)))
      .mockResolvedValue(instanceStatus(mismatchChild(10), okChild(11)));
    const harness = makeSupervisor({ collect });
    await harness.supervision;
    for (let index = 0; index < 3; index += 1) await harness.runTick();
    expect(harness.exit).not.toHaveBeenCalled();
  });

  test('an alive child whose port refuses connections is torn down after three strikes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(refusedChild(10), okChild(11)));
    const harness = makeSupervisor({ collect });
    await harness.supervision;
    expect(harness.exit).not.toHaveBeenCalled();

    await harness.runTick();
    expect(harness.exit).not.toHaveBeenCalled();
    await harness.runTick();

    expect(harness.stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(
      error.mock.calls.some(([, reason]) =>
        String((reason as Error)?.message).includes(
          'refused 3 consecutive connections',
        ),
      ),
    ).toBe(true);
  });

  // Review round 1 MED 1: a foreign process answering our port with a
  // different identity only intermittently (mismatch and unreachable
  // alternating) never accumulates 3 consecutive strikes of either kind.
  // The continuous-failure window must keep accumulating across both
  // observation kinds so the escalation backstop drains this state.
  test('an intermittent foreign responder (alternating mismatch/unreachable) is still torn down', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let steadyCalls = 0;
    const collect = vi.fn(
      async (_name: string, options?: { probeTimeoutMs?: number }) => {
        if (options?.probeTimeoutMs === 45_000) {
          // The confirmation also gets the foreign answer.
          return instanceStatus(mismatchChild(10), okChild(11));
        }
        steadyCalls += 1;
        return steadyCalls % 2 === 0
          ? instanceStatus(mismatchChild(10), okChild(11))
          : instanceStatus(slowChild(10), okChild(11));
      },
    );
    const harness = makeSupervisor({ collect });
    await harness.supervision;

    for (let index = 0; index < 38; index += 1) {
      await harness.runTick();
    }

    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(1));
    expect(harness.stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(
      error.mock.calls.some(([, reason]) =>
        String((reason as Error)?.message).includes('treating it as wedged'),
      ),
    ).toBe(true);
  });

  test('sustained unresponsiveness that also fails the confirmation probe is torn down as wedged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Slow at every budget, including the 45s confirmation: a wedged child.
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(slowChild(10), okChild(11)));
    const harness = makeSupervisor({ collect });
    await harness.supervision;

    // No teardown before the 180s window elapses (review round 1, MED 2).
    for (let index = 0; index < 35; index += 1) {
      await harness.runTick();
    }
    expect(harness.exit).not.toHaveBeenCalled();
    expect(harness.stop).not.toHaveBeenCalled();

    await harness.runTick();

    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(1));
    expect(harness.stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(
      error.mock.calls.some(([, reason]) =>
        String((reason as Error)?.message).includes('treating it as wedged'),
      ),
    ).toBe(true);
  });

  test('caps a chronic confirmation-probe recovery cycle at its fourth rescue', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const collect = vi.fn(
      async (_name: string, options?: { probeTimeoutMs?: number }) =>
        options?.probeTimeoutMs === 45_000
          ? instanceStatus(okChild(10), okChild(11))
          : instanceStatus(slowChild(10), okChild(11)),
    );
    const harness = makeSupervisor({
      clockAdvanceMs: 180_000,
      collect,
    });
    await harness.supervision;

    for (let recovery = 0; recovery < 3; recovery += 1) {
      await harness.runTick();
      await harness.runTick();
      expect(harness.exit).not.toHaveBeenCalled();
    }
    await harness.runTick();
    await harness.runTick();

    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(1));
    expect(harness.stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
  });

  test('does not cap four confirmation recoveries spread beyond the recovery window', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const collect = vi.fn(
      async (_name: string, options?: { probeTimeoutMs?: number }) =>
        options?.probeTimeoutMs === 45_000
          ? instanceStatus(okChild(10), okChild(11))
          : instanceStatus(slowChild(10), okChild(11)),
    );
    const harness = makeSupervisor({
      clockAdvanceMs: 31 * 60_000,
      collect,
    });
    await harness.supervision;

    // Every pair drives a real slow->long-budget-ok confirmation recovery.
    // At 31-minute increments, each newest recovery prunes the prior one.
    for (let recovery = 0; recovery < 4; recovery += 1) {
      await harness.runTick();
      await harness.runTick();
    }
    expect(harness.exit).not.toHaveBeenCalled();
    expect(harness.stop).not.toHaveBeenCalled();
    expect(
      collect.mock.calls.filter(
        ([, options]) => options?.probeTimeoutMs === 45_000,
      ),
    ).toHaveLength(4);
  });

  test('keeps confirmation-recovery history across an ordinary healthy tick', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const normalProbes = [
      slowChild(10),
      slowChild(10),
      slowChild(10),
      slowChild(10),
      slowChild(10),
      slowChild(10),
      okChild(10),
      slowChild(10),
      slowChild(10),
    ];
    const collect = vi.fn(
      async (_name: string, options?: { probeTimeoutMs?: number }) =>
        options?.probeTimeoutMs === 45_000
          ? instanceStatus(okChild(10), okChild(11))
          : instanceStatus(normalProbes.shift() ?? slowChild(10), okChild(11)),
    );
    const harness = makeSupervisor({
      clockAdvanceMs: 180_000,
      collect,
    });
    await harness.supervision;

    // Three confirmation recoveries, then a normal `probe === 'ok'` tick.
    for (let recovery = 0; recovery < 3; recovery += 1) {
      await harness.runTick();
      await harness.runTick();
    }
    await harness.runTick(); // ordinary `probe === 'ok'`
    await harness.runTick();
    await harness.runTick();
    await harness.runTick();

    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(1));
    expect(harness.stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
  });

  test('foreign listening PIDs turn unreachable probes into identity-mismatch teardown evidence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(slowChild(10), okChild(11)));
    const harness = makeSupervisor({
      collect,
      listListeningPids: (port) => (port === 3242 ? [999] : [11]),
    });
    await harness.supervision;
    await harness.runTick();
    await harness.runTick();

    expect(harness.stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(
      error.mock.calls.some(([, reason]) =>
        String((reason as Error)?.message).includes('foreign listener'),
      ),
    ).toBe(true);
  });

  // station#1869: a supervised service under KeepAlive cannot "warn and reuse
  // a stale build" — a stale build that crashes on boot loops forever. When
  // the build is stale the supervisor must BUILD, not warn.
  test('builds before start when the build is stale (station#1869)', async () => {
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(okChild(10), okChild(11)));
    const harness = makeSupervisor({
      collect,
      needsBuildForInstance: () => true,
    });
    await harness.supervision;

    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({ build: true, force: true }),
    );
  });

  test('does not build when the build is current (station#1869)', async () => {
    const collect = vi
      .fn()
      .mockResolvedValue(instanceStatus(okChild(10), okChild(11)));
    const harness = makeSupervisor({
      collect,
      needsBuildForInstance: () => false,
    });
    await harness.supervision;

    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({ build: false, force: true }),
    );
  });

  test('does not publish liveness until readiness is proven (station#3064)', async () => {
    // Ordering power: moving publishServiceLiveness(true) above the collect()
    // that proves readiness would otherwise leave the whole corpus green,
    // while advertising a service that never came up.
    const collect = vi.fn().mockResolvedValue({ found: false });
    const harness = makeSupervisor({ collect });
    await harness.supervision;

    expect(harness.publishServiceLiveness).not.toHaveBeenCalledWith(true);
  });
});

/**
 * station#3064 / #3065 — the supervisor as the liveness producer for its own
 * service entry. These drive the REAL publisher (no seam) against a real
 * temp home, because the defect being closed is precisely that no code path
 * ever wrote a live service record.
 */
describe('supervised service liveness (station#3064)', () => {
  const serviceLifecycle = (baseDir: string) => ({
    baseDir,
    homeSource: '--base' as const,
    host: '127.0.0.1',
    instanceName: 'service-test',
    serverPort: 3242,
    uiPort: 5274,
  });

  const readyCollect = () =>
    vi.fn().mockResolvedValue(instanceStatus(okChild(10), okChild(11)));

  test('publishes pid and birth onto its own service entry, preserving policy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-svc-live-'));
    // What `service install` writes: policy, no liveness.
    upsertInstance(
      'service-test',
      {
        port: 3242,
        type: 'service',
        env: { ALLOWED_ORIGINS: 'https://paired.example' },
      },
      home,
    );

    await superviseService(serviceLifecycle(home), {
      collect: readyCollect() as never,
      exit: vi.fn(),
      onSignal: vi.fn(),
      processIsAlive: () => true,
      setTimer: vi.fn(() => 1 as never),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    });

    const entry = readInstanceRegistry(home).instances['service-test'];
    // The signal Desktop's decide_home_ownership selects on: service-typed,
    // with a live pid. Before this change nothing produced one, so the
    // branch was unreachable and Desktop spawned a second writer.
    expect(entry.type).toBe('service');
    expect(entry.pid).toBe(process.pid);
    expect(entry.birth).toBe(lookupProcessBirthFingerprint(process.pid));
    expect(entry.status).toBe('running');
    // #1983: origin policy is the installer's, and every liveness write
    // must preserve it — an UPDATE, not a claim.
    expect(entry.env).toEqual({ ALLOWED_ORIGINS: 'https://paired.example' });
  });

  test('retracts liveness on shutdown without disturbing policy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-svc-live-'));
    upsertInstance(
      'service-test',
      {
        port: 3242,
        type: 'service',
        env: { ALLOWED_ORIGINS: 'https://paired.example' },
      },
      home,
    );
    const signals = new Map<string, () => void>();

    const supervision = superviseService(serviceLifecycle(home), {
      collect: readyCollect() as never,
      exit: vi.fn(),
      onSignal: (signal, listener) => signals.set(signal, listener),
      processIsAlive: () => true,
      setTimer: vi.fn(() => 1 as never),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    });
    await supervision;
    signals.get('SIGTERM')?.();
    await vi.waitFor(() => {
      const entry = readInstanceRegistry(home).instances['service-test'];
      expect(entry.pid).toBeUndefined();
    });

    const entry = readInstanceRegistry(home).instances['service-test'];
    expect(entry.birth).toBeUndefined();
    expect(entry.status).toBe('stopped');
    expect(entry.type).toBe('service');
    expect(entry.env).toEqual({ ALLOWED_ORIGINS: 'https://paired.example' });
  });

  test('overwrites a chimera pid inherited from a CLI process (station#3065)', async () => {
    // A pre-#3047 install merged over a live CLI entry, so this service
    // record carries a FOREIGN process's pid/birth — which Desktop reads as
    // a live service. Starting the unit heals it: the supervisor's own
    // identity replaces the inherited one. This is the reaping path for
    // records already in the wild.
    const home = mkdtempSync(join(tmpdir(), 'station-svc-live-'));
    upsertInstance(
      'service-test',
      {
        port: 3242,
        type: 'service',
        pid: process.ppid,
        birth: 'inherited-from-a-cli-process',
        checkout: '/some/checkout',
        env: { ALLOWED_ORIGINS: 'https://paired.example' },
      },
      home,
    );

    await superviseService(serviceLifecycle(home), {
      collect: readyCollect() as never,
      exit: vi.fn(),
      onSignal: vi.fn(),
      processIsAlive: () => true,
      setTimer: vi.fn(() => 1 as never),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    });

    const entry = readInstanceRegistry(home).instances['service-test'];
    expect(entry.pid).toBe(process.pid);
    expect(entry.birth).toBe(lookupProcessBirthFingerprint(process.pid));
    expect(entry.env).toEqual({ ALLOWED_ORIGINS: 'https://paired.example' });
  });

  test("a retiring generation never clears a NEWER supervisor's record (#3064 review MED-1)", async () => {
    // Reinstall-over-a-live-service is a path this change deliberately
    // unblocks, so generation A's exit can overlap generation B's boot. An
    // unguarded retract writes A's "stopped" over B's live record: the
    // registry then says no service owns the home while B is serving it,
    // Desktop reads SpawnSidecar, and launches a second writer onto a
    // service-owned home — the exact condition this signal prevents. It
    // cannot self-heal; B publishes only once, at readiness.
    const home = mkdtempSync(join(tmpdir(), 'station-svc-live-'));
    upsertInstance(
      'service-test',
      {
        port: 3242,
        type: 'service',
        env: { ALLOWED_ORIGINS: 'https://paired.example' },
      },
      home,
    );
    const signals = new Map<string, () => void>();
    const exit = vi.fn();
    const supervision = superviseService(serviceLifecycle(home), {
      collect: readyCollect() as never,
      exit,
      onSignal: (signal, listener) => signals.set(signal, listener),
      processIsAlive: () => true,
      setTimer: vi.fn(() => 1 as never),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    });
    await supervision;
    // Generation B takes the record while A is still resident.
    const newerPid = process.pid + 1;
    upsertInstance(
      'service-test',
      { port: 3242, type: 'service', pid: newerPid, birth: 'generation-b' },
      home,
    );

    signals.get('SIGTERM')?.();
    // Poll for the retract to have RUN (the supervisor exits), rather than
    // sleeping a fixed budget — the adjacent shutdown test's idiom, and this
    // host's load history is exactly why a wall-clock budget is a bad bet.
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    const entry = readInstanceRegistry(home).instances['service-test'];
    expect(entry.pid).toBe(newerPid);
    expect(entry.birth).toBe('generation-b');
    expect(entry.status).not.toBe('stopped');
  });

  test('a run with no installed service entry mints nothing', async () => {
    // Own-type-only by design: `service run` without an install must not
    // create the record `service install` owns (its absence of env would
    // otherwise suppress the manifest origin-migration bridge). Disclosed
    // limit: such a run stays invisible home-wide.
    const home = mkdtempSync(join(tmpdir(), 'station-svc-live-'));

    await superviseService(serviceLifecycle(home), {
      collect: readyCollect() as never,
      exit: vi.fn(),
      onSignal: vi.fn(),
      processIsAlive: () => true,
      setTimer: vi.fn(() => 1 as never),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    });

    expect(
      readInstanceRegistry(home).instances['service-test'],
    ).toBeUndefined();
  });

  test('never adopts a foreign-typed entry at the same id', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-svc-live-'));
    upsertInstance(
      'service-test',
      { port: 4000, type: 'worktree', pid: process.pid },
      home,
    );

    await superviseService(serviceLifecycle(home), {
      collect: readyCollect() as never,
      exit: vi.fn(),
      onSignal: vi.fn(),
      processIsAlive: () => true,
      setTimer: vi.fn(() => 1 as never),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    });

    const entry = readInstanceRegistry(home).instances['service-test'];
    expect(entry.type).toBe('worktree');
    expect(entry.port).toBe(4000);
  });
});
