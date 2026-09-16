import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_INTERVAL_MS,
  HEARTBEATS_PER_TIMEOUT_BUDGET,
  VitestInflightReporter,
} from '../vitest-inflight-reporter.mjs';

function testModule(moduleId: string, relativeModuleId: string) {
  return { moduleId, relativeModuleId };
}

describe('Vitest in-flight reporter', () => {
  test('emits an unrefed deterministic heartbeat and a final outstanding set', () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const reporter = new VitestInflightReporter({
      intervalMs: 30_000,
      write: (message: string) => {
        output.push(message);
        return true;
      },
    });
    try {
      reporter.onTestRunStart();
      expect(reporter.intervalMs).toBe(30_000);
      expect(reporter.timer?.hasRef()).toBe(false);
      reporter.onTestModuleStart(testModule('/repo/z.test.ts', 'z.test.ts'));
      reporter.onTestModuleStart(testModule('/repo/a.test.ts', 'a.test.ts'));
      reporter.onTestModuleEnd(testModule('/repo/z.test.ts', 'z.test.ts'));

      vi.advanceTimersByTime(30_000);
      reporter.onTestRunEnd();

      expect(output).toEqual([
        '[vitest-progress] in-flight: a.test.ts\n',
        '[vitest-progress] final in-flight: a.test.ts\n',
      ]);
      expect(reporter.timer).toBeNull();
    } finally {
      reporter.stopTimer();
      vi.useRealTimers();
    }
  });

  test('bounds and sanitizes heartbeat module identities', () => {
    const output: string[] = [];
    const reporter = new VitestInflightReporter({
      write: (message: string) => {
        output.push(message);
        return true;
      },
    });
    for (let index = 0; index < 18; index += 1) {
      reporter.onTestModuleStart(
        testModule(
          `/repo/${index}`,
          `${String(index).padStart(2, '0')}-module\n${'x'.repeat(300)}`,
        ),
      );
    }

    reporter.emit('[vitest-progress] in-flight:');

    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain('\nxx');
    expect(output[0]).toContain('00-module ');
    expect(output[0]).toContain('... +2\n');
    expect(output[0]!.length).toBeLessThan(4_500);
  });

  /**
   * The reporter's whole purpose is naming the module that hung. Its heartbeat
   * used to tick at 30_000 — the SAME period as `testTimeout`/`hookTimeout` —
   * and is anchored to run start, so a module that hung for its full budget got
   * at most one heartbeat and often zero, and with `maxWorkers: 4` that one
   * line named four modules. The diagnostic was timed out by the thing it
   * reports on.
   *
   * Pinned against the config's OWN value, read from the file, rather than
   * against a literal transcribed here: a transcribed `30_000` would keep this
   * green while someone raised the real budget and silently restored the
   * matched-period defect.
   */
  test('the heartbeat ticks several times inside the timeout it diagnoses', () => {
    const config = readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'vitest.config.ts'),
      'utf8',
    );
    const budgets = [
      ...config.matchAll(/(?:testTimeout|hookTimeout):\s*([0-9_]+)/g),
    ].map((match) => Number(match[1]!.replace(/_/g, '')));
    // Guards against a rename making this vacuous: no match would leave an
    // empty array, and `every` on an empty array is trivially true.
    expect(budgets.length).toBeGreaterThanOrEqual(2);
    expect(
      budgets.every((budget) => Number.isFinite(budget) && budget > 0),
    ).toBe(true);

    const smallest = Math.min(...budgets);
    expect(DEFAULT_INTERVAL_MS).toBeLessThan(smallest);
    // Not merely "less than": a module hanging its whole budget must be named
    // repeatedly, so one heartbeat lost to scheduling is not the only one.
    expect(Math.floor(smallest / DEFAULT_INTERVAL_MS)).toBeGreaterThanOrEqual(
      HEARTBEATS_PER_TIMEOUT_BUDGET,
    );
  });

  test('a module that hangs a full budget is named in every heartbeat, not once', () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const reporter = new VitestInflightReporter({
      write: (message: string) => {
        output.push(message);
        return true;
      },
    });
    try {
      reporter.onTestRunStart();
      reporter.onTestModuleStart({
        moduleId: '/repo/hangs.test.ts',
        relativeModuleId: 'hangs.test.ts',
      });
      // The module never ends — the case the reporter exists for.
      vi.advanceTimersByTime(30_000);
      expect(output.length).toBeGreaterThanOrEqual(
        HEARTBEATS_PER_TIMEOUT_BUDGET,
      );
      expect(output.every((line) => line.includes('hangs.test.ts'))).toBe(true);
    } finally {
      reporter.stopTimer();
      vi.useRealTimers();
    }
  });
});
