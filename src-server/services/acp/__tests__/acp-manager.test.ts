import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const probeInstances: Array<{
  probe: ReturnType<typeof vi.fn>;
  isAvailable: () => boolean;
  dispose: ReturnType<typeof vi.fn>;
  lastProbeAt: number;
}> = [];

vi.mock('../acp-probe.js', () => ({
  ACPProbe: vi.fn().mockImplementation(function MockACPProbe() {
    const instance = {
      lastProbeAt: 0,
      isAvailable: () => true,
      dispose: vi.fn().mockResolvedValue(undefined),
      probe: vi.fn(async () => {
        instance.lastProbeAt = Date.now();
        return true;
      }),
    };
    probeInstances.push(instance);
    return instance;
  }),
}));

import { ACPManager } from '../acp-manager.js';

/**
 * station#1908: end-to-end proof, through the real `ACPManager` and its
 * real 60-second `setInterval`, that the periodic probe loop no longer
 * re-spawns an already-fresh connection on every single tick forever.
 */
describe('ACPManager periodic probe cadence (station#1908)', () => {
  beforeEach(() => {
    probeInstances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test('does not spawn the engine binary on every 60s tick forever', async () => {
    const manager = new ACPManager(
      {} as any,
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      '/tmp',
    );

    await manager.startAll([
      { id: 'opencode', name: 'OpenCode', command: 'opencode', enabled: true },
    ]);

    expect(probeInstances).toHaveLength(1);
    const probe = probeInstances[0];
    // startAll's addConnection already probed (spawned) once.
    expect(probe.probe).toHaveBeenCalledTimes(1);

    // Advance 30 minutes of the manager's real 60s timer -- the exact
    // cadence station#1908 measured spawning the engine binary forever,
    // roughly 2x/minute once codex/claude connections are counted too.
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    // Before the fix this would be 31 (1 initial + 1 per 60s tick,
    // unbounded). The staleness gate bounds it to a fraction of that.
    expect(probe.probe.mock.calls.length).toBeLessThan(10);
    expect(probe.probe.mock.calls.length).toBeGreaterThan(1);

    await manager.shutdown();
  });
});
