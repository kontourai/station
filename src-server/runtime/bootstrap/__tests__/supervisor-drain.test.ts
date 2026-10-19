// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { StationRuntime } from '../station-runtime.js';
import { runSupervisorDrain } from '../supervisor-drain.js';
import type { DrainRequest } from '../supervisor-link.js';

function request(
  source: DrainRequest['source'],
  settled: Promise<{ lingering: number }> = Promise.resolve({ lingering: 0 }),
): DrainRequest {
  return { deadlineMs: 10_000, source, connectionsSettled: settled };
}

function link() {
  return {
    reportDrainProgress: vi.fn(),
    reportDrained: vi.fn(async () => {}),
  };
}

describe('runSupervisorDrain', () => {
  it('reports live voice calls, waits for them to end, then shuts down for the drain', async () => {
    const reporter = link();
    const counts = [2, 2, 1, 0];
    const runtime = {
      activeVoiceSessionCount: vi.fn(() => counts.shift() ?? 0),
    };
    const shutdown = vi.fn(async () => {});
    await runSupervisorDrain(request('supervisor'), {
      link: reporter,
      runtime: () => runtime,
      shutdown: () => shutdown,
      exit: vi.fn(),
      pollMs: 1,
    });
    expect(reporter.reportDrainProgress.mock.calls.map(([n]) => n)).toEqual([
      2, 1, 0,
    ]);
    expect(shutdown).toHaveBeenCalledWith('supervisor_drain', 0);
  });

  it('does not shut down before in-progress connections settle', async () => {
    let settle!: (value: { lingering: number }) => void;
    const settled = new Promise<{ lingering: number }>((resolve) => {
      settle = resolve;
    });
    const shutdown = vi.fn(async () => {});
    const drained = runSupervisorDrain(request('supervisor', settled), {
      link: link(),
      runtime: () => undefined,
      shutdown: () => shutdown,
      exit: vi.fn(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shutdown).not.toHaveBeenCalled();
    settle({ lingering: 0 });
    await drained;
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('after SIGTERM, shuts down without waiting for voice calls', async () => {
    const reporter = link();
    const shutdown = vi.fn(async () => {});
    await runSupervisorDrain(request('signal'), {
      link: reporter,
      runtime: () => ({ activeVoiceSessionCount: () => 3 }),
      shutdown: () => shutdown,
      exit: vi.fn(),
      pollMs: 1,
    });
    expect(reporter.reportDrainProgress).toHaveBeenCalledWith(3);
    expect(shutdown).toHaveBeenCalledWith('SIGTERM', 0);
  });

  it('before boot finished, reports drained and exits', async () => {
    const reporter = link();
    const exit = vi.fn();
    await runSupervisorDrain(request('supervisor'), {
      link: reporter,
      runtime: () => undefined,
      shutdown: () => undefined,
      exit,
    });
    expect(reporter.reportDrainProgress).toHaveBeenCalledWith(0);
    expect(reporter.reportDrained).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('StationRuntime.activeVoiceSessionCount', () => {
  it('reads the voice service, and is 0 before it exists', () => {
    const count = StationRuntime.prototype.activeVoiceSessionCount;
    expect(
      count.call({
        voiceService: { getActiveCount: () => 2 },
      } as unknown as StationRuntime),
    ).toBe(2);
    expect(count.call({} as unknown as StationRuntime)).toBe(0);
  });
});
