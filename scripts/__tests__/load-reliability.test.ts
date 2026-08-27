import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildLoadReliabilityPlan,
  createDefaultLoadavg,
  executeVerifyLocal,
  isTrackedPath,
  parseLoadReliabilityOptions,
  preflightLoadReceiptDestination,
  runLoadReliability,
  runWindowsTaskkill,
} from '../run-load-reliability.mjs';

const PROVENANCE = {
  headSha: 'a'.repeat(40),
  dirty: false,
  workspaceDigest: 'b'.repeat(64),
  manifestDigest: 'c'.repeat(64),
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  files: [],
  vitestArguments: [],
};

function runOptions(overrides: Record<string, unknown> = {}) {
  return {
    run: true,
    targetLoad: 50,
    workers: 2,
    warmupMs: 1_000,
    sampleIntervalMs: 1_000,
    deadlineMs: 300_000,
    output: '.kontourai/test-reliability/test-load.json',
    ...overrides,
  } as ReturnType<typeof parseLoadReliabilityOptions>;
}

function createHarness(overrides: Record<string, unknown> = {}) {
  let time = 0;
  const workers: number[] = [];
  const terminated: number[] = [];
  const suiteCalls: Array<Record<string, unknown>> = [];
  const receiptCheckpoints: Array<Record<string, unknown>> = [];
  const signals = new Map<string, () => void>();
  const timers: Array<() => void> = [];
  const loadValues = [
    ...((overrides.loadValues as number[] | undefined) ?? [51]),
  ];
  const statuses = [
    ...((overrides.statuses as number[] | undefined) ?? [0, 0, 0]),
  ];
  const provenanceValues = [
    ...((overrides.provenanceValues as
      | Record<string, unknown>[]
      | undefined) ?? [PROVENANCE, PROVENANCE]),
  ];
  const harness = {
    loadavg: () => [loadValues.shift() ?? 51, 0, 0],
    workerFactory: ({ index }: { index: number }) => {
      workers.push(index);
      return index;
    },
    workerTerminator: async (worker: number) => {
      terminated.push(worker);
      if (overrides.cleanupFailure === worker)
        throw new Error('cannot terminate');
    },
    suiteExecutor: (input: Record<string, unknown>) => {
      suiteCalls.push(input);
      if (overrides.suiteError) {
        return { status: null, error: new Error('suite launch failed') };
      }
      return { status: statuses.shift() ?? 0 };
    },
    signalRegistrar: (signal: string, handler: () => void) => {
      signals.set(signal, handler);
      return () => signals.delete(signal);
    },
    now: () => time,
    sleep: async (milliseconds: number) => {
      time += milliseconds;
    },
    setTimer: (callback: () => void) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: () => {},
    provenance: () => provenanceValues.shift() ?? PROVENANCE,
    writeReceipt: (_output: string, contents: string) => {
      receiptCheckpoints.push(JSON.parse(contents));
    },
    receiptRoot: '/unused',
    command: ['node', 'scripts/run-load-reliability.mjs', '--run'],
    preflightReceipt: () => undefined,
  };
  return {
    harness,
    workers,
    terminated,
    suiteCalls,
    receiptCheckpoints,
    signals,
    timers,
  };
}

describe('load-reliability runner', () => {
  test('strictly validates bounded options and repository-contained output', () => {
    expect(parseLoadReliabilityOptions([])).toMatchObject({
      run: false,
      targetLoad: 50,
      deadlineMs: 90 * 60_000,
    });
    expect(
      parseLoadReliabilityOptions([
        '--run',
        '--target-load=50',
        '--workers=64',
        '--warmup-ms=1000',
        '--sample-interval-ms=1000',
        '--deadline-ms=300000',
      ]),
    ).toMatchObject({ run: true, workers: 64 });
    expect(() => parseLoadReliabilityOptions(['--workers=0'])).toThrow(
      /1 to 128/,
    );
    expect(() => parseLoadReliabilityOptions(['--target-load=49'])).toThrow(
      /50 to 100/,
    );
    expect(() =>
      parseLoadReliabilityOptions([
        '--warmup-ms=300000',
        '--deadline-ms=300000',
      ]),
    ).toThrow(/less than --deadline-ms/);
    expect(() => parseLoadReliabilityOptions(['--unknown'])).toThrow(
      /unknown argument/,
    );
    expect(() =>
      parseLoadReliabilityOptions(['--output=/tmp/receipt.json']),
    ).toThrow(/beneath .kontourai\/test-reliability/);
    expect(() =>
      parseLoadReliabilityOptions(['--output=../receipt.json']),
    ).toThrow(/beneath .kontourai\/test-reliability/);
    expect(() =>
      parseLoadReliabilityOptions([
        '--output=.kontourai/test-reliability/../.git/config.json',
      ]),
    ).toThrow(/beneath .kontourai\/test-reliability/);
  });

  test('uses node:os loadavg as the production default without creating load', () => {
    const loadavg = createDefaultLoadavg({ loadavg: () => [57, 2, 1] });
    expect(loadavg()).toEqual([57, 2, 1]);
  });

  test('keeps the production suite execution pending until the child closes', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid?: number;
      kill: () => boolean;
    };
    child.kill = () => true;
    const calls: unknown[][] = [];
    const execution = executeVerifyLocal(
      { attempt: 1, command: ['npm', 'run', 'verify:local'] },
      ((...args: unknown[]) => {
        calls.push(args);
        return child;
      }) as never,
      { platform: 'linux' },
    );
    let settled = false;
    void execution.promise.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', 0, null);
    await expect(execution.promise).resolves.toEqual({
      status: 0,
      signal: null,
    });
    expect(calls).toEqual([
      [
        process.execPath,
        ['scripts/run-verification.mjs', 'request', 'verify-local', '--force'],
        {
          stdio: 'inherit',
          windowsHide: true,
          detached: true,
        },
      ],
    ]);
  });

  test('preflights only ignored JSON receipts beneath the dedicated evidence root', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-load-receipt-'));
    const output = '.kontourai/test-reliability/receipt.json';
    try {
      expect(() =>
        preflightLoadReceiptDestination('scripts/receipt.json', root, {
          isTracked: () => false,
        }),
      ).toThrow(/beneath/);
      expect(() =>
        preflightLoadReceiptDestination(output, root, {
          isTracked: () => true,
        }),
      ).toThrow(/tracked/);
      mkdirSync(join(root, '.kontourai', 'test-reliability'), {
        recursive: true,
      });
      expect(() =>
        preflightLoadReceiptDestination(output, root, {
          isTracked: () => false,
        }),
      ).not.toThrow();
      writeFileSync(join(root, output), 'not a receipt directory');
      expect(existsSync(join(root, output))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when Git tracking verification is unavailable or unexpected', () => {
    const unavailable = () => ({
      status: null,
      error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
    });
    expect(() =>
      isTrackedPath('receipt.json', process.cwd(), unavailable as never),
    ).toThrow(/cannot verify.*ENOENT/);

    const repositoryError = () => ({ status: 128, error: undefined });
    expect(() =>
      isTrackedPath('receipt.json', process.cwd(), repositoryError as never),
    ).toThrow(/status 128/);

    expect(
      isTrackedPath('receipt.json', process.cwd(), (() => ({
        status: 0,
      })) as never),
    ).toBe(true);
    expect(
      isTrackedPath('receipt.json', process.cwd(), (() => ({
        status: 1,
      })) as never),
    ).toBe(false);
  });

  test.runIf(process.platform !== 'win32')(
    'rejects directory and symlink receipt destinations before workers start',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'station-load-receipt-'));
      const output = '.kontourai/test-reliability/receipt.json';
      const destination = join(root, output);
      try {
        mkdirSync(destination, { recursive: true });
        expect(() =>
          preflightLoadReceiptDestination(output, root, {
            isTracked: () => false,
          }),
        ).toThrow(/not a regular file/);
        rmSync(destination, { recursive: true });
        writeFileSync(join(root, 'outside.json'), 'keep');
        symlinkSync(join(root, 'outside.json'), destination);
        expect(() =>
          preflightLoadReceiptDestination(output, root, {
            isTracked: () => false,
          }),
        ).toThrow(/symbolic link/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('is dry by default and starts neither workers, suite, nor receipt', async () => {
    const { harness, workers, suiteCalls, receiptCheckpoints } =
      createHarness();
    const result = await runLoadReliability(
      parseLoadReliabilityOptions([]),
      harness,
    );
    expect(result.exitCode).toBe(0);
    expect(result.receipt).toBeNull();
    expect(result.plan).toEqual(
      buildLoadReliabilityPlan(parseLoadReliabilityOptions([])),
    );
    expect(workers).toEqual([]);
    expect(suiteCalls).toEqual([]);
    expect(receiptCheckpoints).toEqual([]);
  });

  test('preflights and checkpoints startup before creating any workers', async () => {
    const fixture = createHarness();
    const events: string[] = [];
    fixture.harness.preflightReceipt = () => events.push('preflight');
    fixture.harness.writeReceipt = (_output: string, contents: string) => {
      events.push(`receipt:${JSON.parse(contents).phase}`);
    };
    fixture.harness.workerFactory = ({ index }: { index: number }) => {
      events.push(`worker:${index}`);
      return index;
    };
    await runLoadReliability(runOptions(), fixture.harness);
    expect(events.slice(0, 3)).toEqual([
      'preflight',
      'receipt:startup',
      'worker:0',
    ]);
  });

  test('runs exactly three sequential authoritative suite attempts under strict load', async () => {
    const { harness, workers, terminated, suiteCalls, receiptCheckpoints } =
      createHarness();
    const result = await runLoadReliability(runOptions(), harness);
    expect(result.exitCode).toBe(0);
    expect(suiteCalls).toEqual([
      expect.objectContaining({
        attempt: 1,
        command: [
          process.execPath,
          'scripts/run-verification.mjs',
          'request',
          'verify-local',
          '--force',
        ],
        windowsHide: true,
      }),
      expect.objectContaining({ attempt: 2 }),
      expect.objectContaining({ attempt: 3 }),
    ]);
    expect(result.receipt).toMatchObject({
      classification: 'passed',
      complete: true,
      summary: { attempts: 3, passed: 3, passRate: 1 },
      stress: { achieved: true },
      provenance: { stable: true, before: PROVENANCE, after: PROVENANCE },
      cleanup: { complete: true },
    });
    expect(workers).toEqual([0, 1]);
    expect(terminated).toEqual([0, 1]);
    expect(receiptCheckpoints.map((receipt) => receipt.phase)).toEqual(
      expect.arrayContaining(['startup', 'warmup', 'attempt', 'complete']),
    );
    expect(receiptCheckpoints.at(-1)).toMatchObject({
      complete: true,
      classification: 'passed',
    });
    expect(receiptCheckpoints).toContainEqual(
      expect.objectContaining({
        phase: 'cleanup',
        complete: false,
        cleanup: expect.objectContaining({ complete: true }),
      }),
    );
  });

  test('requires observed one-minute load to be strictly greater than target', async () => {
    const { harness, suiteCalls, terminated } = createHarness({
      loadValues: [50],
    });
    const result = await runLoadReliability(runOptions(), harness);
    expect(result.exitCode).toBe(1);
    expect(result.receipt).toMatchObject({
      classification: 'stress_not_achieved',
      primaryFailure: 'stress_not_achieved',
      attempts: [],
      load: { samples: [expect.objectContaining({ aboveTarget: false })] },
      provenance: { stable: true, before: PROVENANCE, after: PROVENANCE },
    });
    expect(suiteCalls).toEqual([]);
    expect(terminated).toEqual([0, 1]);
  });

  test('records suite and infrastructure failures distinctly while still attempting all three suites', async () => {
    const suiteFailure = createHarness({ statuses: [0, 1, 0] });
    const suiteResult = await runLoadReliability(
      runOptions(),
      suiteFailure.harness,
    );
    expect(suiteResult.receipt).toMatchObject({
      classification: 'suite_failed',
      summary: { attempts: 3, passed: 2, failed: 1, testFailures: 1 },
    });
    expect(suiteFailure.suiteCalls).toHaveLength(3);

    const infrastructureFailure = createHarness({ suiteError: true });
    const infrastructureResult = await runLoadReliability(
      runOptions(),
      infrastructureFailure.harness,
    );
    expect(infrastructureResult.receipt?.classification).toBe(
      'infrastructure_error',
    );
    expect(
      infrastructureResult.receipt?.attempts.every(
        (attempt) => attempt.status === 'infrastructure_error',
      ),
    ).toBe(true);
  });

  test('distinguishes attempt-level stress shortfall and provenance drift', async () => {
    const shortfall = createHarness({ loadValues: [51, 50, 50, 50] });
    const shortfallResult = await runLoadReliability(
      runOptions(),
      shortfall.harness,
    );
    expect(shortfallResult.receipt).toMatchObject({
      classification: 'stress_not_achieved',
      summary: { attempts: 3, passed: 3 },
      stress: { achieved: false },
    });

    const drift = createHarness({
      provenanceValues: [
        PROVENANCE,
        { ...PROVENANCE, workspaceDigest: 'd'.repeat(64) },
      ],
    });
    const driftResult = await runLoadReliability(runOptions(), drift.harness);
    expect(driftResult.receipt).toMatchObject({
      classification: 'provenance_drift',
      provenance: { stable: false },
    });
  });

  test('stops the active suite on interruption and cleans every owned worker', async () => {
    const fixture = createHarness();
    let releaseSuite:
      | ((result: { status: number; signal?: string }) => void)
      | undefined;
    let terminatedSuite = 0;
    let sleeps = 0;
    fixture.harness.suiteExecutor = () => ({
      promise: new Promise((resolve) => {
        releaseSuite = resolve;
      }),
      terminate: () => {
        terminatedSuite += 1;
        releaseSuite?.({ status: 1, signal: 'SIGINT' });
      },
    });
    fixture.harness.sleep = async (milliseconds: number) => {
      fixture.harness.now = () => milliseconds;
      if (milliseconds === 0) return;
      sleeps += 1;
      if (sleeps === 2) fixture.signals.get('SIGINT')?.();
    };
    const result = await runLoadReliability(runOptions(), fixture.harness);
    expect(result.receipt).toMatchObject({
      classification: 'interrupted',
      interruption: { signal: 'SIGINT' },
      cleanup: { complete: true },
    });
    expect(terminatedSuite).toBeGreaterThanOrEqual(1);
    expect(fixture.terminated).toEqual([0, 1]);
  });

  test('turns an overall deadline into infrastructure failure and terminates the active suite', async () => {
    const fixture = createHarness();
    let fireDeadline: (() => void) | undefined;
    let releaseSuite: ((result: { status: number }) => void) | undefined;
    let terminatedSuite = 0;
    fixture.harness.setTimer = (callback: () => void) => {
      fireDeadline = callback;
      return callback;
    };
    fixture.harness.suiteExecutor = () => ({
      promise: new Promise((resolve) => {
        releaseSuite = resolve;
      }),
      terminate: () => {
        terminatedSuite += 1;
        releaseSuite?.({ status: 1 });
      },
    });
    let sleeps = 0;
    fixture.harness.sleep = async (milliseconds: number) => {
      if (milliseconds === 0) return;
      sleeps += 1;
      if (sleeps === 2) fireDeadline?.();
    };
    const result = await runLoadReliability(runOptions(), fixture.harness);
    expect(result.receipt).toMatchObject({
      classification: 'infrastructure_error',
      error: { message: 'overall deadline exceeded' },
    });
    expect(terminatedSuite).toBeGreaterThanOrEqual(1);
    expect(fixture.terminated).toEqual([0, 1]);
  });

  test('waits for an unsettled owned suite, then escalates to force termination', async () => {
    const fixture = createHarness();
    let releaseSuite: ((result: { status: number }) => void) | undefined;
    let alive = true;
    let graceful = 0;
    let forced = 0;
    let settlementChecks = 0;
    fixture.harness.suiteExecutor = () => ({
      promise: new Promise((resolve) => {
        releaseSuite = resolve;
      }),
      isAlive: () => alive,
      terminate: () => {
        graceful += 1;
      },
      forceTerminate: () => {
        forced += 1;
        alive = false;
        releaseSuite?.({ status: 1 });
      },
    });
    fixture.harness.waitForSuiteSettlement = async () => {
      settlementChecks += 1;
      return settlementChecks > 1;
    };
    let sleeps = 0;
    fixture.harness.sleep = async (milliseconds: number) => {
      if (milliseconds === 0) return;
      sleeps += 1;
      if (sleeps === 2) fixture.timers[0]?.();
    };
    const result = await runLoadReliability(runOptions(), fixture.harness);
    expect(result.receipt).toMatchObject({
      classification: 'infrastructure_error',
      cleanup: { errors: [] },
    });
    expect(graceful).toBe(1);
    expect(forced).toBe(1);
    expect(settlementChecks).toBe(2);
  });

  test('never accepts a successful wrapper while its owned descendants remain alive', async () => {
    const fixture = createHarness();
    fixture.harness.suiteExecutor = () => ({
      promise: Promise.resolve({ status: 0 }),
      isAlive: () => true,
      terminate: () => {
        throw new Error('soft kill failed');
      },
      forceTerminate: () => {
        throw new Error('force kill failed');
      },
    });
    fixture.harness.waitForSuiteSettlement = async () => false;
    const result = await runLoadReliability(runOptions(), fixture.harness);
    expect(result.exitCode).toBe(1);
    expect(result.receipt).toMatchObject({
      classification: 'cleanup_failed',
      complete: false,
      phase: 'cleanup',
      attempts: [],
      cleanup: {
        complete: false,
        suite: { settled: false, escalated: true },
        errors: expect.arrayContaining([
          expect.objectContaining({
            scope: 'suite',
            message: 'soft kill failed',
          }),
          expect.objectContaining({
            scope: 'suite',
            message: 'force kill failed',
          }),
          expect.objectContaining({
            scope: 'suite',
            message: expect.stringMatching(/remained alive/),
          }),
        ]),
      },
    });
  });

  test('accepts a successful Windows launcher only after its required tree cleanup settles', async () => {
    const fixture = createHarness();
    let cleanups = 0;
    fixture.harness.suiteExecutor = () => {
      let alive = true;
      return {
        promise: Promise.resolve({ status: 0 }),
        completionRequiresCleanup: true,
        isAlive: () => alive,
        terminate: () => {
          cleanups += 1;
          alive = false;
        },
        forceTerminate: () => {
          alive = false;
        },
      };
    };

    const result = await runLoadReliability(runOptions(), fixture.harness);

    expect(result.exitCode).toBe(0);
    expect(result.receipt.classification).toBe('passed');
    expect(cleanups).toBe(3);
  });

  test('awaits Windows taskkill and preserves spawn and nonzero failures', async () => {
    const calls: unknown[][] = [];
    const spawnFailure = (_command: string, ...args: unknown[]) => {
      calls.push(args);
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit('error', new Error('taskkill spawn failed')),
      );
      return child;
    };
    await expect(
      runWindowsTaskkill(42, false, spawnFailure as never),
    ).rejects.toThrow(/spawn failed/);
    expect(calls[0]).toEqual([
      ['/pid', '42', '/t'],
      { stdio: 'ignore', windowsHide: true },
    ]);

    const nonzero = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 5));
      return child;
    };
    await expect(
      runWindowsTaskkill(43, true, nonzero as never),
    ).rejects.toThrow(/status 5/);

    let helperKilled = false;
    const hanging = () => {
      const child = new EventEmitter() as EventEmitter & {
        kill: () => boolean;
      };
      child.kill = () => {
        helperKilled = true;
        return true;
      };
      return child;
    };
    await expect(
      runWindowsTaskkill(44, true, hanging as never, 1),
    ).rejects.toThrow(/did not settle/);
    expect(helperKilled).toBe(true);
  });

  test('observes coalesced signals during yielded worker startup', async () => {
    const fixture = createHarness();
    let startupYields = 0;
    fixture.harness.sleep = async (milliseconds: number) => {
      if (milliseconds === 0 && startupYields++ === 0) {
        fixture.signals.get('SIGTERM')?.();
        fixture.signals.get('SIGINT')?.();
      }
    };
    const result = await runLoadReliability(runOptions(), fixture.harness);
    expect(fixture.workers).toEqual([0]);
    expect(fixture.terminated).toEqual([0]);
    expect(result.receipt).toMatchObject({
      classification: 'interrupted',
      interruption: { signal: 'SIGTERM' },
    });
  });

  test('keeps signal handlers installed through worker cleanup and final persistence', async () => {
    const fixture = createHarness();
    fixture.harness.workerTerminator = async (worker: number) => {
      expect(fixture.signals.size).toBe(2);
      fixture.terminated.push(worker);
      if (worker === 0) fixture.signals.get('SIGTERM')?.();
    };
    const result = await runLoadReliability(runOptions(), fixture.harness);
    expect(result.receipt).toMatchObject({
      classification: 'interrupted',
      interruption: { signal: 'SIGTERM' },
    });
    expect(fixture.signals.size).toBe(0);
  });

  test('records process-tree kill failures instead of returning with an owned child', async () => {
    const fixture = createHarness();
    let releaseSuite: ((result: { status: number }) => void) | undefined;
    let alive = true;
    fixture.harness.suiteExecutor = () => ({
      promise: new Promise((resolve) => {
        releaseSuite = resolve;
      }),
      isAlive: () => alive,
      terminate: () => {
        throw new Error('SIGTERM failed');
      },
      forceTerminate: () => {
        alive = false;
        releaseSuite?.({ status: 1 });
      },
    });
    fixture.harness.waitForSuiteSettlement = async (_execution: unknown) => {
      if (alive) return false;
      return true;
    };
    let sleeps = 0;
    fixture.harness.sleep = async (milliseconds: number) => {
      if (milliseconds === 0) return;
      sleeps += 1;
      if (sleeps === 2) fixture.timers[0]?.();
    };
    const result = await runLoadReliability(runOptions(), fixture.harness);
    expect(result.receipt).toMatchObject({
      classification: 'cleanup_failed',
      cleanup: {
        errors: [
          expect.objectContaining({
            scope: 'suite',
            message: 'SIGTERM failed',
          }),
        ],
      },
    });
    expect(alive).toBe(false);
  });

  test('gives cleanup failure final precedence while preserving the primary failure', async () => {
    const { harness } = createHarness({
      statuses: [1, 0, 0],
      cleanupFailure: 1,
    });
    const result = await runLoadReliability(runOptions(), harness);
    expect(result.exitCode).toBe(1);
    expect(result.receipt).toMatchObject({
      classification: 'cleanup_failed',
      primaryFailure: 'suite_failed',
      cleanup: {
        complete: true,
        errors: [
          expect.objectContaining({ index: 1, message: 'cannot terminate' }),
        ],
      },
    });
  });
});
