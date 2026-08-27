import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildTimingReliabilityVitestArgs,
  executeTimingReliabilityVitest,
  maximumTimingReliabilityWorkers,
  parseTimingReliabilityOptions,
  runTimingReliability,
  TIMING_RELIABILITY_TEST_FILES,
} from '../run-timing-reliability.mjs';

const NEVER = new Promise<never>(() => {});

function onlineWorker(index: number, failure: Promise<unknown> = NEVER) {
  return {
    index,
    worker: index,
    online: Promise.resolve(),
    failure,
  };
}

function completedExecution(status = 0) {
  return {
    promise: Promise.resolve({ status, signal: null }),
    isAlive: () => false,
    terminate: () => {},
    forceTerminate: () => {},
  };
}

function pendingExecution() {
  let alive = true;
  const signals: string[] = [];
  return {
    execution: {
      promise: NEVER,
      isAlive: () => alive,
      terminate: () => {
        signals.push('TERM');
        alive = false;
      },
      forceTerminate: () => {
        signals.push('KILL');
        alive = false;
      },
    },
    signals,
  };
}

function quietHarness(overrides: Record<string, unknown> = {}) {
  return {
    workerFactory: ({ index }: { index: number }) => onlineWorker(index),
    workerTerminator: () => {},
    suiteRunner: () => completedExecution(),
    buildArgs: () => ['vitest-args'],
    output: () => {},
    ...overrides,
  };
}

describe('timing reliability runner', () => {
  test('keeps the timing-sensitive test set explicit and serialized', () => {
    expect(TIMING_RELIABILITY_TEST_FILES).toEqual([
      'scripts/__tests__/station-dogfood-launch-path.test.ts',
      'packages/shared/src/__tests__/lifecycle-events.test.ts',
      'src-ui/src/contexts/__tests__/ApiBaseContext.test.tsx',
    ]);
    expect(buildTimingReliabilityVitestArgs('/repo')).toEqual([
      resolve('/repo/node_modules/vitest/vitest.mjs'),
      'run',
      ...TIMING_RELIABILITY_TEST_FILES,
      '--maxWorkers=1',
      '--no-file-parallelism',
    ]);
  });

  test('derives a host-relative worker maximum and validates bounded options', () => {
    expect(maximumTimingReliabilityWorkers(() => 1)).toBe(16);
    expect(maximumTimingReliabilityWorkers(() => 8)).toBe(128);
    expect(() => maximumTimingReliabilityWorkers(() => 0)).toThrow(
      /positive integer/,
    );
    expect(
      parseTimingReliabilityOptions([], { availableParallelism: () => 1 }),
    ).toEqual({ repeat: 3, workers: 4 });
    expect(
      parseTimingReliabilityOptions(['--repeat=20', '--workers=128'], {
        availableParallelism: () => 8,
      }),
    ).toEqual({ repeat: 20, workers: 128 });
    expect(() =>
      parseTimingReliabilityOptions(['--workers=17'], {
        availableParallelism: () => 1,
      }),
    ).toThrow(/1 to 16/);
    expect(() => parseTimingReliabilityOptions(['--repeat=0'])).toThrow(
      /1 to 100/,
    );
    expect(() =>
      parseTimingReliabilityOptions(['--repeat=2', '--repeat=3']),
    ).toThrow(/duplicate/);
    expect(() => parseTimingReliabilityOptions(['--unknown'])).toThrow(
      /unknown argument/,
    );
  });

  test('uses an asynchronous owned child process tree', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: () => boolean;
    };
    child.pid = 1234;
    child.kill = () => true;
    const calls: unknown[][] = [];
    const execution = executeTimingReliabilityVitest(
      { args: ['vitest-args'] },
      ((...args: unknown[]) => {
        calls.push(args);
        return child;
      }) as never,
      { platform: 'linux' },
    );
    child.emit('close', 0, null);
    await expect(execution.promise).resolves.toEqual({
      status: 0,
      signal: null,
    });
    expect(calls).toEqual([
      [
        process.execPath,
        ['vitest-args'],
        {
          stdio: 'inherit',
          windowsHide: true,
          detached: true,
        },
      ],
    ]);
  });

  test('waits for every worker online, runs every ordinary attempt, fails on one attempt, and cleans up', async () => {
    const onlineOrder: number[] = [];
    const executed: number[] = [];
    const terminated: number[] = [];
    const statuses = [0, 1, 0];
    const result = await runTimingReliability(
      { repeat: 3, workers: 2 },
      quietHarness({
        workerFactory: ({ index }: { index: number }) => ({
          ...onlineWorker(index),
          online: Promise.resolve().then(() => {
            onlineOrder.push(index);
          }),
        }),
        workerTerminator: (worker: { index: number }) => {
          terminated.push(worker.index);
        },
        suiteRunner: ({ attempt }: { attempt: number }) => {
          expect(onlineOrder).toEqual([0, 1]);
          executed.push(attempt);
          return completedExecution(statuses.shift());
        },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe('suite_failed');
    expect(result.summary).toEqual({
      attempts: 3,
      passed: 2,
      failed: 1,
      infrastructureErrors: 0,
    });
    expect(executed).toEqual([1, 2, 3]);
    expect(terminated).toEqual([0, 1]);
  });

  test('bounds and terminates a never-settling suite at its per-attempt deadline', async () => {
    const pending = pendingExecution();
    const terminatedWorkers: number[] = [];
    const result = await runTimingReliability(
      { repeat: 3, workers: 1 },
      quietHarness({
        suiteRunner: () => pending.execution,
        workerTerminator: (worker: { index: number }) => {
          terminatedWorkers.push(worker.index);
        },
        attemptTimeoutMs: 5,
        suiteTerminationGraceMs: 5,
        suiteTerminationForceMs: 5,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe('infrastructure_error');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      status: 'infrastructure_error',
      error: { message: expect.stringMatching(/deadline/) },
    });
    expect(pending.signals).toEqual(['TERM']);
    expect(terminatedWorkers).toEqual([0]);
  });

  test('treats an unsettled process tree after TERM and KILL as cleanup failure', async () => {
    const signals: string[] = [];
    const stubbornExecution = {
      promise: NEVER,
      isAlive: () => true,
      terminate: () => signals.push('TERM'),
      forceTerminate: () => signals.push('KILL'),
    };
    const result = await runTimingReliability(
      { repeat: 3, workers: 1 },
      quietHarness({
        suiteRunner: () => stubbornExecution,
        waitForSuiteSettlement: async () => false,
        attemptTimeoutMs: 5,
        suiteTerminationGraceMs: 5,
        suiteTerminationForceMs: 5,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe('cleanup_failed');
    expect(signals).toEqual(['TERM', 'KILL']);
    expect(result.attempts[0]).toMatchObject({
      termination: { settled: false, escalated: true },
    });
    expect(result.cleanup.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'suite',
          message: expect.stringMatching(
            /timing-reliability Vitest process tree remained alive/,
          ),
        }),
      ]),
    );
  });

  test('accepts successful Windows launcher results after required tree cleanup', async () => {
    let cleanups = 0;
    const result = await runTimingReliability(
      { repeat: 3, workers: 1 },
      quietHarness({
        suiteRunner: () => {
          let alive = true;
          return {
            promise: Promise.resolve({ status: 0, signal: null }),
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
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.classification).toBe('passed');
    expect(cleanups).toBe(3);
  });

  test('treats a termination dispatch error as cleanup failure even when the tree settles', async () => {
    const execution = {
      promise: NEVER,
      isAlive: () => true,
      terminate: () => {
        throw new Error('TERM dispatch failed');
      },
      forceTerminate: () => {},
    };
    const result = await runTimingReliability(
      { repeat: 3, workers: 1 },
      quietHarness({
        suiteRunner: () => execution,
        waitForSuiteSettlement: async () => true,
        attemptTimeoutMs: 5,
        suiteTerminationGraceMs: 5,
        suiteTerminationForceMs: 5,
      }),
    );

    expect(result.classification).toBe('cleanup_failed');
    expect(result.attempts[0]).toMatchObject({
      termination: {
        settled: true,
        errors: [expect.objectContaining({ message: 'TERM dispatch failed' })],
      },
    });
    expect(result.cleanup.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'suite',
          message: 'TERM dispatch failed',
        }),
      ]),
    );
  });

  test('handles SIGTERM by terminating the active process tree and cleaning workers', async () => {
    const pending = pendingExecution();
    const handlers = new Map<string, () => void>();
    const removed: string[] = [];
    const terminatedWorkers: number[] = [];
    const result = await runTimingReliability(
      { repeat: 3, workers: 1 },
      quietHarness({
        signalRegistrar: (signal: string, handler: () => void) => {
          handlers.set(signal, handler);
          return () => removed.push(signal);
        },
        suiteRunner: () => {
          queueMicrotask(() => handlers.get('SIGTERM')?.());
          return pending.execution;
        },
        workerTerminator: (worker: { index: number }) => {
          terminatedWorkers.push(worker.index);
        },
        attemptTimeoutMs: 1_000,
        suiteTerminationGraceMs: 5,
        suiteTerminationForceMs: 5,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe('interrupted');
    expect(result.attempts[0]).toMatchObject({ status: 'interrupted' });
    expect(pending.signals).toEqual(['TERM']);
    expect(terminatedWorkers).toEqual([0]);
    expect(removed).toEqual(['SIGINT', 'SIGTERM']);
  });

  test('fails closed when a worker cannot come online and still cleans started workers', async () => {
    const terminated: number[] = [];
    const result = await runTimingReliability(
      { repeat: 3, workers: 2 },
      quietHarness({
        workerFactory: ({ index }: { index: number }) => ({
          ...onlineWorker(index),
          online:
            index === 1
              ? Promise.reject(new Error('online failed'))
              : Promise.resolve(),
        }),
        workerTerminator: (worker: { index: number }) => {
          terminated.push(worker.index);
        },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe('infrastructure_error');
    expect(result.runFailure).toMatchObject({
      message: 'CPU load worker failed during startup',
    });
    expect(result.attempts).toEqual([]);
    expect(terminated).toEqual([0, 1]);
  });

  test('terminates the suite when an online load worker exits prematurely', async () => {
    const pending = pendingExecution();
    const result = await runTimingReliability(
      { repeat: 3, workers: 1 },
      quietHarness({
        workerFactory: () =>
          onlineWorker(
            0,
            Promise.resolve({
              classification: 'stress_not_achieved',
              worker: 0,
              exitCode: 0,
            }),
          ),
        suiteRunner: () => pending.execution,
        suiteTerminationGraceMs: 5,
        suiteTerminationForceMs: 5,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe('stress_not_achieved');
    expect(result.attempts[0]).toMatchObject({
      status: 'stress_not_achieved',
      workerFailure: { worker: 0 },
    });
    expect(pending.signals).toEqual(['TERM']);
  });

  test('classifies an online load-worker error as infrastructure failure', async () => {
    const pending = pendingExecution();
    const result = await runTimingReliability(
      { repeat: 3, workers: 1 },
      quietHarness({
        workerFactory: () =>
          onlineWorker(
            0,
            Promise.resolve({
              classification: 'infrastructure_error',
              worker: 0,
              error: { name: 'Error', message: 'worker crashed' },
            }),
          ),
        suiteRunner: () => pending.execution,
        suiteTerminationGraceMs: 5,
        suiteTerminationForceMs: 5,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe('infrastructure_error');
    expect(result.attempts[0]).toMatchObject({
      status: 'infrastructure_error',
      workerFailure: {
        worker: 0,
        error: { message: 'worker crashed' },
      },
    });
    expect(pending.signals).toEqual(['TERM']);
  });

  test('bounds never-settling load-worker cleanup and reports the failure', async () => {
    const result = await runTimingReliability(
      { repeat: 1, workers: 1 },
      quietHarness({
        workerTerminator: () => NEVER,
        workerTerminationTimeoutMs: 5,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe('cleanup_failed');
    expect(result.summary.passed).toBe(1);
    expect(result.cleanup.errors).toHaveLength(1);
    expect(result.cleanup.errors[0]).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/did not settle/) },
    });
  });
});
