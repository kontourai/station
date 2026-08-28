import { describe, expect, test, vi } from 'vitest';
import {
  ACP_PROBE_STALE_AFTER_MS,
  addACPManagerConnection,
  reconnectACPManagerConnection,
  removeACPManagerConnection,
  runACPManagerProbes,
  shutdownACPManager,
} from '../acp-manager-orchestration.js';

describe('acp-manager-orchestration helpers', () => {
  test('runACPManagerProbes skips probing while sessions are active', async () => {
    const probe = {
      probe: vi.fn().mockResolvedValue(true),
      isAvailable: () => true,
    };

    await runACPManagerProbes({
      sessions: new Map([['conv-1', {}]]),
      probes: new Map([['kiro', probe]]),
      getAvailableConnectionCount: () => 1,
    });

    expect(probe.probe).not.toHaveBeenCalled();
  });

  test('runACPManagerProbes emits when connection availability changes', async () => {
    let availableCount = 1;
    const emit = vi.fn();
    const probe = {
      probe: vi.fn().mockImplementation(async () => {
        availableCount = 2;
        return true;
      }),
      isAvailable: () => availableCount > 0,
    };

    await runACPManagerProbes({
      sessions: new Map(),
      probes: new Map([['kiro', probe]]),
      eventBus: { emit },
      getAvailableConnectionCount: () => availableCount,
    });

    expect(probe.probe).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('agents:changed');
  });

  test('station#3404: the sweep probes on the background path', async () => {
    // The sweep is the only caller nothing is waiting on, so it is the only
    // one that may take the enlarged first-contact budget. Asserted at the
    // call site because the budget choice is invisible from outside the probe.
    const probe = {
      probe: vi.fn().mockResolvedValue(true),
      isAvailable: () => true,
      lastProbeAt: 0,
    };

    await runACPManagerProbes({
      sessions: new Map(),
      probes: new Map([['opencode', probe]]),
      getAvailableConnectionCount: () => 1,
    });

    expect(probe.probe).toHaveBeenCalledWith('background');
  });

  test('station#1908: skips re-probing a connection probed less than staleAfterMs ago', async () => {
    const probe = {
      probe: vi.fn().mockResolvedValue(true),
      isAvailable: () => true,
      lastProbeAt: 1_000_000,
    };

    await runACPManagerProbes({
      sessions: new Map(),
      probes: new Map([['opencode', probe]]),
      getAvailableConnectionCount: () => 1,
      now: () => 1_000_000 + ACP_PROBE_STALE_AFTER_MS - 1,
    });

    expect(probe.probe).not.toHaveBeenCalled();
  });

  test('station#1908: re-probes a connection once it has gone stale', async () => {
    const probe = {
      probe: vi.fn().mockResolvedValue(true),
      isAvailable: () => true,
      lastProbeAt: 1_000_000,
    };

    await runACPManagerProbes({
      sessions: new Map(),
      probes: new Map([['opencode', probe]]),
      getAvailableConnectionCount: () => 1,
      now: () => 1_000_000 + ACP_PROBE_STALE_AFTER_MS,
    });

    expect(probe.probe).toHaveBeenCalledTimes(1);
  });

  test('station#1908: a never-probed connection (lastProbeAt 0/absent) is always due', async () => {
    const neverProbed = {
      probe: vi.fn().mockResolvedValue(true),
      isAvailable: () => true,
      lastProbeAt: 0,
    };
    const noField = {
      probe: vi.fn().mockResolvedValue(true),
      isAvailable: () => true,
    };

    await runACPManagerProbes({
      sessions: new Map(),
      probes: new Map([
        ['never-probed', neverProbed],
        ['no-field', noField],
      ]),
      getAvailableConnectionCount: () => 2,
      now: () => 1_000_000,
    });

    expect(neverProbed.probe).toHaveBeenCalledTimes(1);
    expect(noField.probe).toHaveBeenCalledTimes(1);
  });

  test('station#1908: over repeated ticks at the OLD 60s cadence, a fresh connection is probed on only a fraction of ticks, not every tick', async () => {
    let clock = 0;
    const probe = {
      probe: vi.fn(async () => {
        probe.lastProbeAt = clock;
        return true;
      }),
      isAvailable: () => true,
      lastProbeAt: 0,
    };
    const probes = new Map([['opencode', probe]]);

    // Simulate the ACPManager's 60s wall-clock timer firing 30 times in a
    // row (30 minutes of ticks) -- the exact cadence archive#1908 measured
    // spawning the engine binary on every single tick, forever.
    for (let tick = 0; tick < 30; tick++) {
      clock += 60_000;
      await runACPManagerProbes({
        sessions: new Map(),
        probes,
        getAvailableConnectionCount: () => 1,
        now: () => clock,
      });
    }

    // Before the staleness gate this would be 30 (one spawn per tick,
    // forever). With a 5-minute gate over 30 minutes it is bounded to ~6.
    expect(probe.probe.mock.calls.length).toBeLessThan(10);
    expect(probe.probe.mock.calls.length).toBeGreaterThan(0);
  });

  test('add/reconnect/remove ACP manager connections mutate maps and emit changes', async () => {
    const config = {
      id: 'kiro',
      name: 'Kiro',
      command: 'kiro',
      args: ['acp'],
      enabled: true,
    };
    const probes = new Map<string, { probe(): Promise<boolean> }>();
    const configs = new Map();
    const emit = vi.fn();
    const probe = { probe: vi.fn().mockResolvedValue(true) };
    const removeConnection = vi.fn().mockResolvedValue(undefined);

    const added = await addACPManagerConnection({
      config,
      probes,
      configs,
      logger: { info: vi.fn() },
      managedWorkspaceHomeDir: '/tmp',
      eventBus: { emit },
      createProbe: () => probe,
      removeConnection,
    });

    expect(added).toBe(true);
    expect(probes.get('kiro')).toBe(probe);
    expect(configs.get('kiro')).toEqual(config);
    expect(emit).toHaveBeenCalledWith('agents:changed');

    const reconnected = await reconnectACPManagerConnection({
      id: 'kiro',
      probes,
      eventBus: { emit },
    });

    expect(reconnected).toBe(true);
    expect(probe.probe).toHaveBeenCalledTimes(2);
    // archive#3404: both of these are awaited by an HTTP request, so neither
    // may take the enlarged budget — add defaults to it, reconnect states it.
    expect(probe.probe).toHaveBeenNthCalledWith(1, 'request');
    expect(probe.probe).toHaveBeenNthCalledWith(2, 'request');

    await removeACPManagerConnection({
      id: 'kiro',
      probes,
      configs,
    });

    expect(probes.has('kiro')).toBe(false);
    expect(configs.has('kiro')).toBe(false);
  });

  test('shutdown clears ACP manager probes/configs and timers', async () => {
    const probeTimer = setInterval(() => {}, 60_000);
    const cullTimer = setInterval(() => {}, 30_000);
    const probes = new Map([['kiro', { probe: vi.fn() }]]);
    const configs = new Map([
      [
        'kiro',
        {
          id: 'kiro',
          name: 'Kiro',
          command: 'kiro',
          args: ['acp'],
          enabled: true,
        },
      ],
    ]);

    const timers = await shutdownACPManager({
      probeTimer,
      cullTimer,
      probes,
      configs,
    });

    expect(timers).toEqual({ probeTimer: null, cullTimer: null });
    expect(probes.size).toBe(0);
    expect(configs.size).toBe(0);
  });

  test('retains probe ownership when removal cleanup fails', async () => {
    const probe = {
      probe: vi.fn(),
      dispose: vi.fn().mockRejectedValue(new Error('cleanup failed')),
    };
    const probes = new Map([['kiro', probe]]);
    const configs = new Map([
      [
        'kiro',
        { id: 'kiro', name: 'Kiro', command: 'kiro-cli', enabled: true },
      ],
    ]);

    await expect(
      removeACPManagerConnection({ id: 'kiro', probes, configs }),
    ).rejects.toThrow('cleanup failed');
    expect(probes.get('kiro')).toBe(probe);
    expect(configs.has('kiro')).toBe(true);
  });

  test('retains failed probes for shutdown retry', async () => {
    const probe = {
      probe: vi.fn(),
      dispose: vi.fn().mockRejectedValue(new Error('cleanup failed')),
    };
    const probes = new Map([['kiro', probe]]);
    const configs = new Map([
      [
        'kiro',
        { id: 'kiro', name: 'Kiro', command: 'kiro-cli', enabled: true },
      ],
    ]);

    await expect(
      shutdownACPManager({
        probeTimer: null,
        cullTimer: null,
        probes,
        configs,
      }),
    ).rejects.toThrow('ACP probe shutdown failed');
    expect(probes.get('kiro')).toBe(probe);
    expect(configs.has('kiro')).toBe(true);
  });
});
