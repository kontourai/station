import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  admitEngineStartForIntent,
  ConcurrentEngineStartCapacityError,
  computeRuntimeCpuBusyPercent,
  createRuntimeCpuSampler,
  createRuntimeResourcePostureController,
  deriveRuntimeResourcePosture,
} from '../resource-posture.js';

const observation = (busyPercent: number) => ({
  busyPercent,
  cpuCount: 8,
  sampledAt: 100,
  sampleMs: 500,
  thresholdPercent: 85,
  source: 'test',
});

function cpuSnapshot(idle: number, user: number) {
  return [
    {
      model: 'test',
      speed: 1,
      times: { idle, user, nice: 0, sys: 0, irq: 0 },
    },
  ];
}

describe('runtime resource diagnostics', () => {
  test('computes CPU busy percent from two os.cpus snapshots', () => {
    expect(
      computeRuntimeCpuBusyPercent(
        cpuSnapshot(100, 100),
        cpuSnapshot(110, 190),
      ),
    ).toBe(90);
    expect(computeRuntimeCpuBusyPercent([], [])).toBeUndefined();
  });

  test('the product-owned sampler reports an observed diagnostic', async () => {
    const snapshots = [cpuSnapshot(100, 100), cpuSnapshot(110, 190)];
    const sample = createRuntimeCpuSampler({
      readCpus: () => snapshots.shift()!,
      wait: async () => undefined,
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValue(1_500),
    });
    await expect(sample()).resolves.toMatchObject({
      busyPercent: 90,
      cpuCount: 1,
      sampledAt: 1_500,
      sampleMs: 500,
      source: 'runtime-diagnostics',
    });
  });

  test('keeps a 99%-busy observation diagnostic while admitting engine starts', async () => {
    const sample = vi.fn(async () => observation(99));
    const controller = createRuntimeResourcePostureController({ sample });

    await expect(controller.observe()).resolves.toMatchObject({
      kind: 'critical',
      busyPercent: 99,
    });
    const lease = await admitEngineStartForIntent(
      controller,
      undefined,
      'interactive_user',
      { binding: 'thread-a' },
    );
    expect(sample).toHaveBeenCalledOnce();
    await expect(
      admitEngineStartForIntent(controller, undefined, 'webhook', {
        binding: 'thread-b',
      }),
    ).rejects.toThrow(ConcurrentEngineStartCapacityError);
    lease?.release();
    await expect(
      admitEngineStartForIntent(controller, undefined, 'webhook', {
        binding: 'thread-b',
      }),
    ).resolves.toBeDefined();
    expect(sample).toHaveBeenCalledOnce();
  });

  test('supervised starts wait FIFO, canceled waiters release their place, and ordinary starts still refuse', async () => {
    const controller = createRuntimeResourcePostureController();
    const first = controller.reserveEngineStart();
    const cancelled = new AbortController();
    const active = new AbortController();
    const abandoned = controller.waitForEngineStart(cancelled.signal);
    const cancellation = new Error('cancelled');
    const refusal = expect(abandoned).rejects.toBe(cancellation);
    const admissionOrder: string[] = [];
    const next = controller.waitForEngineStart(active.signal).then((lease) => {
      admissionOrder.push('second');
      return lease;
    });
    const last = controller.waitForEngineStart(active.signal).then((lease) => {
      admissionOrder.push('third');
      return lease;
    });
    expect(() => controller.reserveEngineStart()).toThrow(
      ConcurrentEngineStartCapacityError,
    );
    cancelled.abort(cancellation);
    await refusal;
    expect(admissionOrder).toEqual([]);
    first.release();
    const second = await Promise.race([next, last]);
    expect(admissionOrder).toEqual(['second']);
    first.release();
    expect(() => controller.reserveEngineStart()).toThrow(
      ConcurrentEngineStartCapacityError,
    );
    expect(admissionOrder).toEqual(['second']);
    second.release();
    const third = await last;
    expect(admissionOrder).toEqual(['second', 'third']);
    expect(() => controller.reserveEngineStart()).toThrow(
      ConcurrentEngineStartCapacityError,
    );
    third.release();
    const final = controller.reserveEngineStart();
    final.release();
  });

  test('classifies malformed observations as unavailable', () => {
    expect(deriveRuntimeResourcePosture({ source: 'test' })).toMatchObject({
      kind: 'unavailable',
      cpuCount: 0,
    });
  });

  test('aborted and expired waiters cannot acquire a later lease', async () => {
    vi.useFakeTimers();
    try {
      const controller = createRuntimeResourcePostureController();
      const held = controller.reserveEngineStart();
      const abort = new AbortController();
      const cancelled = admitEngineStartForIntent(
        controller,
        undefined,
        'interactive_user',
        {
          binding: 'cancelled',
          signal: abort.signal,
        },
      );
      const expired = admitEngineStartForIntent(
        controller,
        undefined,
        'interactive_user',
        {
          binding: 'expired',
        },
      );
      const cancelledResult = expect(cancelled).rejects.toMatchObject({
        name: 'AbortError',
      });
      const expiredResult = expect(expired).rejects.toThrow(
        ConcurrentEngineStartCapacityError,
      );
      abort.abort();
      await vi.advanceTimersByTimeAsync(60_000);
      await cancelledResult;
      await expiredResult;
      held.release();
      const next = controller.reserveEngineStart();
      next.release();
    } finally {
      vi.useRealTimers();
    }
  });

  test('normalizes non-Error abort reasons for pending and already-aborted starts', async () => {
    const controller = createRuntimeResourcePostureController();
    const held = controller.reserveEngineStart();
    const abort = new AbortController();
    const pending = controller.waitForEngineStart(abort.signal);
    abort.abort('person left');
    await expect(pending).rejects.toEqual(new Error('Operation aborted.'));
    await expect(controller.waitForEngineStart(abort.signal)).rejects.toEqual(
      new Error('Operation aborted.'),
    );
    const reason = new Error('cancelled by caller');
    const errorAbort = new AbortController();
    const errorPending = controller.waitForEngineStart(errorAbort.signal);
    errorAbort.abort(reason);
    await expect(errorPending).rejects.toBe(reason);
    held.release();
  });

  test('grants waiting interactive starts in arrival order', async () => {
    const controller = createRuntimeResourcePostureController();
    const held = controller.reserveEngineStart();
    const first = controller.waitForEngineStart();
    const second = controller.waitForEngineStart();
    held.release();
    const admitted = await Promise.race([
      first.then((lease) => ({ name: 'first', lease })),
      second.then((lease) => ({ name: 'second', lease })),
    ]);
    admitted.lease.release();
    const remaining = await (admitted.name === 'first' ? second : first);
    remaining.release();
    expect(admitted.name).toBe('first');
  });

  test('refuses the 33rd interactive waiter without waiting for timeout', async () => {
    const controller = createRuntimeResourcePostureController();
    const held = controller.reserveEngineStart();
    const abort = new AbortController();
    const waiters = Array.from({ length: 32 }, () =>
      controller.waitForEngineStart(abort.signal),
    );
    const settledWaiters = Promise.allSettled(waiters);
    // All 32 must still be queued before the 33rd arrives; a lower cap would
    // refuse one of them here.
    let refusedWithinCap = 0;
    for (const waiter of waiters)
      waiter.catch(() => {
        refusedWithinCap += 1;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(refusedWithinCap).toBe(0);
    const extra = controller.waitForEngineStart(abort.signal);
    const outcome = extra.then(
      () => 'admitted',
      (error: unknown) =>
        error instanceof ConcurrentEngineStartCapacityError
          ? 'refused'
          : 'aborted',
    );
    try {
      expect(waiters).toHaveLength(32);
      expect(
        await Promise.race([
          outcome,
          new Promise<'pending'>((resolve) =>
            setImmediate(() => resolve('pending')),
          ),
        ]),
      ).toBe('refused');
    } finally {
      abort.abort();
      await settledWaiters;
      await outcome;
      held.release();
    }
  });

  test('production server modules never import verification scripts', () => {
    const serverRoot = join(process.cwd(), 'src-server');
    const violations: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') visit(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(path, 'utf8');
        if (/from\s+['"][^'"]*scripts\//u.test(source))
          violations.push(relative(process.cwd(), path));
      }
    };
    visit(serverRoot);
    expect(violations).toEqual([]);
  });
});
