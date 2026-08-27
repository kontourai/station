import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveVerificationToolchain } from '../lib/test-reliability.mjs';
import {
  boundedPromise,
  createStressContext,
  fixtureProvenance,
  parseStressArgs,
  runInjectedStressConformance,
  runLiveStress,
  STRESS_LIMITS,
  settleTrackedChildren,
  startTrackedFixture,
  stressPlan,
  timeoutScenarioBudgetMs,
} from '../run-verification-stress.mjs';

function fakeChild(pid = 4_242) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal: string) => boolean;
  };
  const signals: string[] = [];
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  return { child, signals };
}

function wait(milliseconds: number) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function fakeTimers() {
  let nextId = 0;
  const active = new Map<number, () => void>();
  const cleared: number[] = [];
  return {
    setTimer(callback: () => void) {
      const id = nextId;
      nextId += 1;
      active.set(id, callback);
      return id;
    },
    clearTimer(id: number) {
      cleared.push(id);
      active.delete(id);
    },
    active,
    cleared,
  };
}

describe('verification stress harness', () => {
  test('is dry by default and publishes explicit bounded limits', () => {
    expect(parseStressArgs([])).toEqual({ run: false });
    expect(stressPlan()).toMatchObject({
      mode: 'dry',
      mutatesCurrentWorktree: false,
      requiresExplicitRun: true,
      limits: STRESS_LIMITS,
    });
  });

  test('requires the one explicit live-run flag', () => {
    expect(parseStressArgs(['--run'])).toEqual({ run: true });
    expect(() => parseStressArgs(['--force'])).toThrow('usage:');
    expect(() => parseStressArgs(['--run', '--force'])).toThrow('usage:');
  });

  test('keeps worktree, process, duration, and output caps small', () => {
    expect(STRESS_LIMITS.maxWorktrees).toBe(2);
    expect(STRESS_LIMITS.maxFixtureProcesses).toBeLessThanOrEqual(8);
    expect(STRESS_LIMITS.maxDurationMs).toBeLessThanOrEqual(10_000);
    expect(STRESS_LIMITS.maxOutputBytes).toBeLessThanOrEqual(1_024);
  });

  test('scales the timeout scenario deadline with observed admission latency, never below the floor (station#1804)', () => {
    // The defect was a fixed 100 ms deadline that had to cover the
    // coordinator's admission handshake as well as the runner overrun it was
    // measuring. Sweeping that constant measured the handshake at 25 ms on a
    // quiet host and 50 ms with eight concurrent vitest processes, so the
    // budget has to follow the contention this run is actually under.
    const { minTimeoutHeadroomMs, admissionHeadroomFactor } = STRESS_LIMITS;

    // Below the crossover the floor holds — the old constant is preserved as a
    // lower bound, so a quiet host behaves exactly as it did.
    expect(timeoutScenarioBudgetMs(0)).toBe(minTimeoutHeadroomMs);
    expect(timeoutScenarioBudgetMs(1)).toBe(minTimeoutHeadroomMs);

    // Above it the budget is derived, not constant. This is the assertion that
    // fails if someone replaces the derivation with a bigger magic number.
    const crossover = minTimeoutHeadroomMs / admissionHeadroomFactor;
    expect(timeoutScenarioBudgetMs(crossover * 4)).toBe(
      minTimeoutHeadroomMs * 4,
    );
    expect(timeoutScenarioBudgetMs(50)).toBe(50 * admissionHeadroomFactor);
    expect(timeoutScenarioBudgetMs(50)).toBeGreaterThan(
      timeoutScenarioBudgetMs(25),
    );

    // A missing or nonsensical observation must not silently produce a budget
    // of zero — an unmeasurable admission falls back to the floor.
    expect(timeoutScenarioBudgetMs(Number.NaN)).toBe(minTimeoutHeadroomMs);
    expect(timeoutScenarioBudgetMs(-1)).toBe(minTimeoutHeadroomMs);
  });

  test('clears losing deadline timers on early success and rejection, while preserving timeout failure', async () => {
    const successTimers = fakeTimers();
    await expect(
      boundedPromise(Promise.resolve('done'), 10_000, 'timeout', successTimers),
    ).resolves.toBe('done');
    expect(successTimers.active.size).toBe(0);
    expect(successTimers.cleared).toEqual([0]);

    const rejectionTimers = fakeTimers();
    await expect(
      boundedPromise(
        Promise.reject(new Error('fixture failed')),
        10_000,
        'timeout',
        rejectionTimers,
      ),
    ).rejects.toThrow('fixture failed');
    expect(rejectionTimers.active.size).toBe(0);
    expect(rejectionTimers.cleared).toEqual([0]);

    const timeoutTimers = fakeTimers();
    const timed = boundedPromise(
      new Promise(() => {}),
      10_000,
      'deadline fired',
      timeoutTimers,
    );
    timeoutTimers.active.get(0)?.();
    await expect(timed).rejects.toThrow('deadline fired');
    expect(timeoutTimers.active.size).toBe(0);
    expect(timeoutTimers.cleared).toEqual([0]);
  });

  test('runs bounded coordinator conformance with injected fixture results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-stress-test-'));
    const worktreeA = join(root, 'a');
    const worktreeB = join(root, 'b');
    mkdirSync(worktreeA);
    mkdirSync(worktreeB);
    try {
      const result = await runInjectedStressConformance({
        fixture: {
          coordinatorRoot: join(root, 'coordinator'),
          repositoryId: 'a'.repeat(64),
          headSha: 'b'.repeat(40),
          worktrees: [worktreeA, worktreeB],
        },
        executeFixture: async ({ name }: { name: string }) => {
          const stdout = `fixture ${name}\n`;
          const stderr = `diagnostic ${name}\n`;
          return {
            status: 0,
            output: {
              stdout: {
                text: stdout,
                sourceBytes: Buffer.byteLength(stdout),
                truncated: false,
              },
              stderr: {
                text: stderr,
                sourceBytes: Buffer.byteLength(stderr),
                truncated: false,
              },
              truncated: false,
            },
            cleanup: { status: 'passed', survivingOwnedChildren: 0 },
          };
        },
      });
      expect(result).toMatchObject({ checks: 7, equivalentCalls: 1 });
      expect(result.fixtureProcesses).toBeLessThanOrEqual(
        STRESS_LIMITS.maxFixtureProcesses,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses the bound executable toolchain identity for a staged coordinator request', () => {
    const toolchain = resolveVerificationToolchain();
    const provenance = fixtureProvenance(
      {
        repositoryId: 'a'.repeat(64),
        headSha: 'b'.repeat(40),
      },
      '/fixture/worktree',
      'stale-owner',
      toolchain,
    );

    expect(provenance.toolchain).toBe(toolchain.toolchain);
    expect(provenance.toolchainIdentity).toEqual(toolchain.identity);
    expect(provenance.toolchainIdentity.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('aborts a hanging tracked child after an early scenario failure and removes its root', async () => {
    const root = mkdtempSync(
      join(tmpdir(), 'station-verification-stress-test-'),
    );
    const context = createStressContext({
      limits: { ...STRESS_LIMITS, maxDurationMs: 400, cleanupReserveMs: 200 },
    });
    const started = Date.now();
    await expect(
      runLiveStress({
        context,
        createFixture: () => ({ root }),
        runConformance: () => {
          startTrackedFixture(context);
          throw new Error('early scenario failure');
        },
      }),
    ).rejects.toThrow('early scenario failure');
    expect(Date.now() - started).toBeLessThanOrEqual(400);
    expect(context.tracker.children.every((child) => child.closed)).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  test('retains and reports the exact root when cleanup cannot settle', async () => {
    const root = mkdtempSync(
      join(tmpdir(), 'station-verification-stress-test-'),
    );
    const context = createStressContext({
      limits: { ...STRESS_LIMITS, maxDurationMs: 150, cleanupReserveMs: 75 },
    });
    context.tracker.children.push({
      child: { kill: () => true },
      closed: false,
      settlement: new Promise(() => {}),
    });
    try {
      await expect(
        runLiveStress({
          context,
          createFixture: () => ({ root }),
          runConformance: () => {
            throw new Error('scenario failed');
          },
        }),
      ).rejects.toMatchObject({ retainedRoot: root });
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('races a hung scenario at its deadline and retains its root to avoid a cleanup race', async () => {
    const root = mkdtempSync(
      join(tmpdir(), 'station-verification-stress-test-'),
    );
    const context = createStressContext({
      limits: { ...STRESS_LIMITS, maxDurationMs: 200, cleanupReserveMs: 100 },
    });
    const started = Date.now();
    try {
      await expect(
        runLiveStress({
          context,
          createFixture: () => ({ root }),
          runConformance: () => new Promise(() => {}),
        }),
      ).rejects.toMatchObject({ retainedRoot: root });
      expect(Date.now() - started).toBeLessThanOrEqual(200);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reserves capacity before spawn and refuses a second hanging child at the cap', async () => {
    const context = createStressContext({
      limits: { ...STRESS_LIMITS, maxFixtureProcesses: 1 },
    });
    const first = fakeChild();
    let spawns = 0;
    startTrackedFixture(context, 'hanging fixture', {
      spawnImpl: () => {
        spawns += 1;
        return first.child as never;
      },
    });
    expect(() =>
      startTrackedFixture(context, 'must not spawn', {
        spawnImpl: () => {
          spawns += 1;
          return fakeChild().child as never;
        },
      }),
    ).toThrow('fixture process cap exceeded');
    expect(spawns).toBe(1);

    const cleanup = settleTrackedChildren(context);
    await wait(1);
    expect(first.signals).toContain('SIGTERM');
    first.child.emit('close', null, 'SIGTERM');
    await expect(cleanup).resolves.toBe(true);
    expect(context.tracker.children.every((child) => child.closed)).toBe(true);
  });

  test('rolls back a reservation when spawn throws before returning a child', async () => {
    const context = createStressContext({
      limits: { ...STRESS_LIMITS, maxFixtureProcesses: 1 },
    });
    expect(() =>
      startTrackedFixture(context, 'spawn failure', {
        spawnImpl: () => {
          throw new Error('spawn unavailable');
        },
      }),
    ).toThrow('spawn unavailable');
    expect(context.tracker.count).toBe(0);

    const fixture = fakeChild();
    startTrackedFixture(context, 'recovered capacity', {
      spawnImpl: () => fixture.child as never,
    });
    expect(context.tracker.count).toBe(1);
    const cleanup = settleTrackedChildren(context);
    fixture.child.emit('close', null, 'SIGTERM');
    await expect(cleanup).resolves.toBe(true);
  });

  test('waits for close after child and stream errors, including an injected kill', async () => {
    const context = createStressContext({
      limits: { ...STRESS_LIMITS, cleanupReserveMs: 250 },
    });
    const fixture = fakeChild();
    const record = startTrackedFixture(context, 'stream error fixture', {
      spawnImpl: () => fixture.child as never,
    });
    let settled = false;
    void record.settlement.then(() => {
      settled = true;
    });
    fixture.child.stdout.emit('error', new Error('stream failed'));
    fixture.child.emit('error', new Error('child reported an error'));
    await Promise.resolve();
    expect(record.streamError).toBeInstanceOf(Error);
    expect(record.closed).toBe(false);
    expect(settled).toBe(false);

    const cleanup = settleTrackedChildren(context);
    await wait(110);
    expect(fixture.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(settled).toBe(false);
    fixture.child.emit('close', null, 'SIGKILL');
    await expect(cleanup).resolves.toBe(true);
    expect(record.closed).toBe(true);
  });
});
