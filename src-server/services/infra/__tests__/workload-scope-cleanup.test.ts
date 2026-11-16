/**
 * Workload scope cleanup retries (#4993): backoff, abandonment, error
 * classes, shutdown reporting, warnings and metrics, against the real
 * launcher with a fake systemd manager.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import {
  closeChildWorkload,
  prepareChildWorkload,
  trackChildWorkload,
} from '@kontourai/station-shared/child-workload';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const log = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock('../../../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/logger.js')>()),
  createLogger: () => log,
}));
vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  workloadScopeCleanupAttempts: { add: vi.fn() },
  workloadScopeCleanupBacklog: { addCallback: vi.fn() },
}));

import {
  workloadScopeCleanupAttempts,
  workloadScopeCleanupBacklog,
} from '../../../telemetry/metrics.js';
import {
  __workloadTestHooks,
  classifyCleanupError,
  inspectWorkloadResources,
  stopWorkloadResources,
  workloadBudgetStatus,
} from '../workload-resources.js';

const makeTempDir = trackTempDirs();

/** What execFile rejects with when systemctl exits non-zero. */
function systemctlError(stderr: string) {
  return Object.assign(
    new Error(
      `Command failed: /usr/bin/systemctl --user --no-pager --no-ask-password show x.scope\n${stderr}\n`,
    ),
    { code: 1, killed: false, signal: null },
  );
}
const BUS_EPERM =
  'Failed to connect to user scope bus via local transport: Operation not permitted (consider using --machine=<user>@.host --user to connect to bus of other user)';
const UNIT_BUSY = 'Failed to stop x.scope: Unit x.scope is busy.';

const CAP_MS = 5 * 60_000;

/** A pid that named a process which has exited: the monitor sees it dead. */
async function deadPid(): Promise<number> {
  const exited = spawn(process.execPath, ['-e', ''], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await once(exited, 'exit');
  return exited.pid as number;
}

describe('workload scope cleanup retries (fake systemd manager)', () => {
  let now = 1_000_000;
  /** Unit -> error its cleanup's first `show` fails with; absent: succeeds. */
  const failing = new Map<string, () => Error>();
  /** `show` calls for a scope's cleanup, one per attempt. */
  const attemptsOn = (unit: string) =>
    calls.filter(
      (args) =>
        args[0] === 'show' &&
        args[1] === unit &&
        args[2]?.startsWith('--property=LoadState,'),
    ).length;
  let calls: string[][] = [];

  beforeEach(async () => {
    now = 1_000_000;
    calls = [];
    failing.clear();
    log.warn.mockClear();
    log.debug.mockClear();
    vi.mocked(workloadScopeCleanupAttempts.add).mockClear();
    vi.mocked(workloadScopeCleanupBacklog.addCallback).mockClear();
    const home = makeTempDir('workload-cleanup-');
    await __workloadTestHooks.start({
      homeDir: home,
      cgroupRoot: join(home, 'sys-fs-cgroup'),
      manualMonitor: true,
      run: async (args) => {
        calls.push(args);
        const fail = args[0] === 'show' ? failing.get(args[1]) : undefined;
        if (fail) throw fail();
        // A collected scope: nothing left to kill or stop.
        if (args[0] === 'show')
          return 'LoadState=not-found\nActiveState=inactive\n';
        return '';
      },
    });
    // Jitter at its top: each wait is exactly its ceiling.
    __workloadTestHooks.setClock({ now: () => now, random: () => 1 });
  });
  afterEach(() => {
    __workloadTestHooks.reset();
  });

  /** A launched scope whose leader has already exited. */
  async function orphanScope(): Promise<string> {
    const prepared = prepareChildWorkload('/usr/bin/true', [], {
      PATH: '/usr/bin',
    });
    if (!prepared) throw new Error('no launcher installed');
    const unit = prepared.args
      .find((arg) => arg.startsWith('--unit='))
      ?.slice('--unit='.length) as string;
    trackChildWorkload(prepared, await deadPid());
    return unit;
  }

  const warnings = (message: string) =>
    log.warn.mock.calls.filter(([text]) => String(text).startsWith(message));

  const metricCalls = () =>
    vi.mocked(workloadScopeCleanupAttempts.add).mock.calls.map(
      ([value, attributes]): Record<string, unknown> => ({
        value,
        ...attributes,
      }),
    );

  test('a repeated failure backs off exponentially instead of retrying every poll', async () => {
    const unit = await orphanScope();
    failing.set(unit, () => systemctlError(UNIT_BUSY));

    await __workloadTestHooks.monitorPass();
    expect(attemptsOn(unit)).toBe(1);
    // Many polls inside the first 2 s wait: no further attempt.
    for (let pass = 0; pass < 5; pass += 1)
      await __workloadTestHooks.monitorPass();
    expect(attemptsOn(unit)).toBe(1);

    // Each wait doubles: 2 s, 4 s, 8 s. Just short of it, nothing runs.
    for (const [attempt, wait] of [
      [2, 2_000],
      [3, 4_000],
      [4, 8_000],
    ] as const) {
      now += wait - 1;
      await __workloadTestHooks.monitorPass();
      expect(attemptsOn(unit)).toBe(attempt - 1);
      now += 1;
      await __workloadTestHooks.monitorPass();
      expect(attemptsOn(unit)).toBe(attempt);
    }
    const [pending] = (await inspectWorkloadResources()).cleanup.pending;
    expect(pending).toMatchObject({
      unit,
      attempts: 4,
      errorKind: 'command_failed',
      lastError: UNIT_BUSY,
      nextAttemptAt: new Date(now + 16_000).toISOString(),
    });
  });

  test('the wait is capped and jittered', async () => {
    const unit = await orphanScope();
    failing.set(unit, () => systemctlError(UNIT_BUSY));
    __workloadTestHooks.setClock({ now: () => now, random: () => 0 });
    await __workloadTestHooks.monitorPass();
    // Jitter at its floor: half of the 2 s ceiling.
    expect(
      Date.parse(
        (await inspectWorkloadResources()).cleanup.pending[0]
          ?.nextAttemptAt as string,
      ),
    ).toBe(now + 1_000);
    __workloadTestHooks.setClock({ now: () => now, random: () => 1 });
    for (let attempt = 2; attempt <= 9; attempt += 1) {
      now += CAP_MS;
      await __workloadTestHooks.monitorPass();
    }
    // 2 s * 2^8 would be 512 s; the cap holds it at 300 s.
    expect(
      Date.parse(
        (await inspectWorkloadResources()).cleanup.pending[0]
          ?.nextAttemptAt as string,
      ),
    ).toBe(now + CAP_MS);
  });

  test('after 10 failed attempts the scope is abandoned, with exactly one terminal warning', async () => {
    const unit = await orphanScope();
    failing.set(unit, () => systemctlError(UNIT_BUSY));
    for (let pass = 0; pass < 30; pass += 1) {
      await __workloadTestHooks.monitorPass();
      now += CAP_MS;
    }
    expect(attemptsOn(unit)).toBe(10);
    expect(warnings('Workload scope cleanup abandoned')).toEqual([
      [
        expect.any(String),
        {
          unit,
          attempts: 10,
          errorKind: 'command_failed',
          lastError: UNIT_BUSY,
        },
      ],
    ]);
    // The first failure warned; the eight between were debug lines.
    expect(warnings('Workload scope cleanup did not settle')).toHaveLength(1);
    expect(log.debug).toHaveBeenCalledTimes(8);

    const resources = await inspectWorkloadResources();
    expect(resources.active).toEqual([]);
    expect(resources.cleanup).toEqual({
      pending: [],
      abandoned: [
        expect.objectContaining({
          unit,
          attempts: 10,
          errorKind: 'command_failed',
          abandonedAt: expect.any(String),
        }),
      ],
      abandonedDropped: 0,
    });
    expect(workloadBudgetStatus()).toMatchObject({
      activeScopes: 0,
      cleanup: { abandoned: [expect.objectContaining({ unit })] },
    });
  });

  test('an unreachable user bus waits the full cap from the first failure and is abandoned after 3 attempts', async () => {
    expect(classifyCleanupError(systemctlError(BUS_EPERM))).toBe(
      'bus_unavailable',
    );
    expect(
      classifyCleanupError(
        systemctlError('Failed to connect to bus: No medium found'),
      ),
    ).toBe('bus_unavailable');
    expect(classifyCleanupError(systemctlError(UNIT_BUSY))).toBe(
      'command_failed',
    );
    expect(classifyCleanupError(new Error('spawn EAGAIN'))).toBe('other');

    const unit = await orphanScope();
    failing.set(unit, () => systemctlError(BUS_EPERM));
    await __workloadTestHooks.monitorPass();
    expect(warnings('Workload scope cleanup did not settle')).toEqual([
      [
        expect.any(String),
        expect.objectContaining({
          unit,
          attempts: 1,
          errorKind: 'bus_unavailable',
          retryInMs: CAP_MS,
        }),
      ],
    ]);
    // Not retried within the cap, however many polls run.
    now += CAP_MS - 1;
    await __workloadTestHooks.monitorPass();
    expect(attemptsOn(unit)).toBe(1);
    for (let pass = 0; pass < 5; pass += 1) {
      now += CAP_MS;
      await __workloadTestHooks.monitorPass();
    }
    expect(attemptsOn(unit)).toBe(3);
    expect(warnings('Workload scope cleanup abandoned')).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(
      (await inspectWorkloadResources()).cleanup.abandoned[0],
    ).toMatchObject({
      unit,
      errorKind: 'bus_unavailable',
      lastError: BUS_EPERM,
    });
  });

  test('a cleanup that fails once and then succeeds settles', async () => {
    const unit = await orphanScope();
    failing.set(unit, () => systemctlError(UNIT_BUSY));
    await __workloadTestHooks.monitorPass();
    expect((await inspectWorkloadResources()).cleanup.pending).toHaveLength(1);

    failing.delete(unit);
    now += 2_000;
    await __workloadTestHooks.monitorPass();
    const resources = await inspectWorkloadResources();
    expect(resources.active).toEqual([]);
    expect(resources.cleanup).toEqual({
      pending: [],
      abandoned: [],
      abandonedDropped: 0,
    });
    expect(resources.recent.at(-1)).toMatchObject({ unit });
    expect(log.info).toHaveBeenCalledWith(
      'Workload scope settled',
      expect.objectContaining({ unit, failedCleanupAttempts: 1 }),
    );
    // Settled: later polls leave the manager alone.
    now += CAP_MS;
    await __workloadTestHooks.monitorPass();
    expect(attemptsOn(unit)).toBe(2);
  });

  test('shutdown tries every scope once more, abandoned ones included, and reports what did not settle', async () => {
    const abandonedUnit = await orphanScope();
    failing.set(abandonedUnit, () => systemctlError(BUS_EPERM));
    for (let pass = 0; pass < 3; pass += 1) {
      await __workloadTestHooks.monitorPass();
      now += CAP_MS;
    }
    const pendingUnit = await orphanScope();
    failing.set(pendingUnit, () => systemctlError(UNIT_BUSY));
    await __workloadTestHooks.monitorPass();
    const resources = await inspectWorkloadResources();
    expect(resources.cleanup.abandoned.map(({ unit }) => unit)).toEqual([
      abandonedUnit,
    ]);
    expect(resources.cleanup.pending.map(({ unit }) => unit)).toEqual([
      pendingUnit,
    ]);

    // Neither is due, and the abandoned one is never due: shutdown tries both.
    await expect(stopWorkloadResources()).rejects.toThrow(
      'Some workload scopes did not confirm cleanup.',
    );
    expect(attemptsOn(abandonedUnit)).toBe(4);
    expect(attemptsOn(pendingUnit)).toBe(2);
    expect(metricCalls().filter((call) => call.trigger === 'shutdown')).toEqual(
      [
        {
          value: 1,
          outcome: 'retry_scheduled',
          error_kind: 'command_failed',
          trigger: 'shutdown',
        },
        {
          value: 1,
          outcome: 'abandoned',
          error_kind: 'bus_unavailable',
          trigger: 'shutdown',
        },
      ],
    );
  });

  test('shutdown resolves once every scope, abandoned ones included, settles', async () => {
    const unit = await orphanScope();
    failing.set(unit, () => systemctlError(BUS_EPERM));
    for (let pass = 0; pass < 3; pass += 1) {
      await __workloadTestHooks.monitorPass();
      now += CAP_MS;
    }
    expect((await inspectWorkloadResources()).cleanup.abandoned).toHaveLength(
      1,
    );
    failing.delete(unit);
    await expect(stopWorkloadResources()).resolves.toBeUndefined();
    expect((await inspectWorkloadResources()).cleanup.abandoned).toEqual([]);
  });

  test("a workload's own close attempts at once and its failure joins the same backoff", async () => {
    const prepared = prepareChildWorkload('/usr/bin/true', [], {
      PATH: '/usr/bin',
    });
    if (!prepared) throw new Error('no launcher installed');
    const unit = prepared.args
      .find((arg) => arg.startsWith('--unit='))
      ?.slice('--unit='.length) as string;
    const pid = await deadPid();
    trackChildWorkload(prepared, pid);
    failing.set(unit, () => systemctlError(UNIT_BUSY));
    await expect(closeChildWorkload(pid)).rejects.toThrow(/Command failed/);
    await expect(closeChildWorkload(pid)).rejects.toThrow(/Command failed/);
    expect(attemptsOn(unit)).toBe(2);
    // The monitor waits out the 4 s the second failure scheduled.
    now += 3_999;
    await __workloadTestHooks.monitorPass();
    expect(attemptsOn(unit)).toBe(2);
    expect(metricCalls()).toEqual([
      {
        value: 1,
        outcome: 'retry_scheduled',
        error_kind: 'command_failed',
        trigger: 'close',
      },
      {
        value: 1,
        outcome: 'retry_scheduled',
        error_kind: 'command_failed',
        trigger: 'close',
      },
    ]);
  });

  test('metrics count every attempt by outcome and observe the backlog', async () => {
    const [callback] = vi.mocked(workloadScopeCleanupBacklog.addCallback).mock
      .calls[0] as [
      (observer: {
        observe: (value: number, attributes: object) => void;
      }) => void,
    ];
    const observe = () => {
      const seen: Array<[number, object]> = [];
      callback({
        observe: (value, attributes) => seen.push([value, attributes]),
      });
      return seen;
    };
    expect(observe()).toEqual([
      [0, { state: 'pending' }],
      [0, { state: 'abandoned' }],
    ]);

    const settles = await orphanScope();
    const abandons = await orphanScope();
    failing.set(settles, () => new Error('spawn EAGAIN'));
    failing.set(abandons, () => systemctlError(BUS_EPERM));
    await __workloadTestHooks.monitorPass();
    expect(observe()).toEqual([
      [2, { state: 'pending' }],
      [0, { state: 'abandoned' }],
    ]);
    failing.delete(settles);
    for (let pass = 0; pass < 3; pass += 1) {
      now += CAP_MS;
      await __workloadTestHooks.monitorPass();
    }
    expect(observe()).toEqual([
      [0, { state: 'pending' }],
      [1, { state: 'abandoned' }],
    ]);
    const count = (outcome: string, errorKind: string) =>
      metricCalls().filter(
        (call) =>
          call.outcome === outcome &&
          call.error_kind === errorKind &&
          call.trigger === 'monitor',
      ).length;
    expect(count('retry_scheduled', 'other')).toBe(1);
    expect(count('settled', 'none')).toBe(1);
    expect(count('retry_scheduled', 'bus_unavailable')).toBe(2);
    expect(count('abandoned', 'bus_unavailable')).toBe(1);
    expect(metricCalls()).toHaveLength(5);
  });
});
