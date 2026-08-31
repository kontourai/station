import { describe, expect, test, vi } from 'vitest';
import { VitestInflightReporter } from '../vitest-inflight-reporter.mjs';

function testModule(moduleId: string, relativeModuleId: string) {
  return { moduleId, relativeModuleId };
}

describe('Vitest in-flight reporter', () => {
  test('emits an unrefed deterministic heartbeat and a final outstanding set', () => {
    const output: string[] = [];
    const callbacks: Array<() => void> = [];
    const timer = { unref: vi.fn() };
    const clearIntervalFn = vi.fn();
    const reporter = new VitestInflightReporter({
      intervalMs: 30_000,
      write: (message: string) => output.push(message),
      setIntervalFn: (callback: () => void, intervalMs: number) => {
        expect(intervalMs).toBe(30_000);
        callbacks.push(callback);
        return timer;
      },
      clearIntervalFn,
    });

    reporter.onTestRunStart();
    expect(timer.unref).toHaveBeenCalledExactlyOnceWith();
    reporter.onTestModuleStart(testModule('/repo/z.test.ts', 'z.test.ts'));
    reporter.onTestModuleStart(testModule('/repo/a.test.ts', 'a.test.ts'));
    reporter.onTestModuleEnd(testModule('/repo/z.test.ts', 'z.test.ts'));

    callbacks[0]!();
    reporter.onTestRunEnd();

    expect(output).toEqual([
      '[vitest-progress] in-flight: a.test.ts\n',
      '[vitest-progress] final in-flight: a.test.ts\n',
    ]);
    expect(clearIntervalFn).toHaveBeenCalledExactlyOnceWith(timer);
  });

  test('bounds and sanitizes heartbeat module identities', () => {
    const output: string[] = [];
    const reporter = new VitestInflightReporter({
      write: (message: string) => output.push(message),
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
});
