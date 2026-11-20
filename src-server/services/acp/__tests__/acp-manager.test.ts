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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * archive#1908: end-to-end proof, through the real `ACPManager` and its
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

  test('sweeps only while it owns probes, including after a dynamic re-add', async () => {
    const manager = new ACPManager(
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      '/tmp',
    );
    const config = {
      id: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
      enabled: true,
    };
    const initialTimerCount = vi.getTimerCount();
    try {
      await manager.startAll([], 'background');
      await vi.advanceTimersByTimeAsync(180_000);
      expect.soft(vi.getTimerCount()).toBe(initialTimerCount);

      await manager.addConnection(config);
      const first = probeInstances[0];
      await vi.advanceTimersByTimeAsync(180_000);
      expect(vi.getTimerCount()).toBe(initialTimerCount + 1);
      expect(first.probe).toHaveBeenCalledExactlyOnceWith('request');

      await manager.removeConnection(config.id);
      await vi.advanceTimersByTimeAsync(180_000);
      expect.soft(vi.getTimerCount()).toBe(initialTimerCount);

      await manager.addConnection(config);
      const second = probeInstances[1];
      second.lastProbeAt = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(second.probe).toHaveBeenLastCalledWith('background');
      expect(first.probe).toHaveBeenCalledTimes(1);

      second.lastProbeAt = 0;
      await manager.sweep();
      expect(second.probe).toHaveBeenCalledTimes(3);
      expect(second.probe).toHaveBeenLastCalledWith('background');
    } finally {
      await manager.shutdown();
    }
  });

  test.each(['rejects', 'completes'] as const)(
    'waits for the remaining startup probe before enabling periodic sweeps when it %s',
    async (outcome) => {
      const slow = deferred<boolean>();
      const fastProbe = {
        probe: vi.fn().mockResolvedValue(true),
        isAvailable: () => true,
      };
      const slowProbe = {
        probe: vi
          .fn()
          .mockReturnValueOnce(slow.promise)
          .mockResolvedValue(true),
        isAvailable: () => true,
      };
      const createProbe = vi
        .fn()
        .mockReturnValueOnce(fastProbe)
        .mockReturnValue(slowProbe);
      const manager = new ACPManager({}, '/tmp', undefined, createProbe);
      const config = {
        id: 'fast',
        name: 'Test',
        command: 'test-acp',
        enabled: true,
      };
      try {
        const startup = manager.startAll(
          [config, { ...config, id: 'slow' }],
          'background',
        );
        await vi.advanceTimersByTimeAsync(180_000);
        expect(fastProbe.probe).toHaveBeenCalledExactlyOnceWith('background');
        expect(slowProbe.probe).toHaveBeenCalledExactlyOnceWith('background');
        if (outcome === 'rejects') {
          slow.reject(new Error('startup probe failed'));
          await expect(startup).rejects.toThrow('startup probe failed');
        } else {
          slow.resolve(true);
          await startup;
        }
        await vi.advanceTimersByTimeAsync(60_000);
        const expected = outcome === 'completes' ? 2 : 1;
        expect(fastProbe.probe).toHaveBeenCalledTimes(expected);
        expect(slowProbe.probe).toHaveBeenCalledTimes(expected);
      } finally {
        slow.resolve(false);
        await manager.shutdown();
      }
    },
  );

  test('keeps sweeping when an add settles before the last old probe is removed', async () => {
    const disposal = deferred<void>();
    const old = {
      probe: vi.fn().mockResolvedValue(true),
      dispose: vi.fn(() => disposal.promise),
      isAvailable: () => true,
    };
    const replacement = {
      probe: vi.fn().mockResolvedValue(true),
      isAvailable: () => true,
    };
    const createProbe = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockReturnValue(replacement);
    const manager = new ACPManager({}, '/tmp', undefined, createProbe);
    const config = {
      id: 'old',
      name: 'Test',
      command: 'test-acp',
      enabled: true,
    };
    try {
      await manager.startAll([config]);
      const removing = manager.removeConnection(config.id);
      await manager.addConnection({ ...config, id: 'new' });
      disposal.resolve();
      await removing;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(replacement.probe.mock.calls).toEqual([
        ['request'],
        ['background'],
      ]);
      expect(old.probe).toHaveBeenCalledExactlyOnceWith('request');
    } finally {
      disposal.resolve();
      await manager.shutdown();
    }
  });

  test('an in-flight startup cannot rearm periodic sweeps after shutdown', async () => {
    const handshake = deferred<boolean>();
    const probe = {
      probe: vi.fn(() => handshake.promise),
      isAvailable: () => true,
    };
    const manager = new ACPManager({}, '/tmp', undefined, () => probe);
    const config = {
      id: 'test',
      name: 'Test',
      command: 'test-acp',
      enabled: true,
    };
    const starting = manager.startAll([config]);
    await manager.shutdown();
    handshake.resolve(true);
    await starting;
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(['succeeds', 'rejects'] as const)(
    'a start during shutdown leaves no sweep timer when disposal %s',
    async (outcome) => {
      const teardown = deferred<void>();
      const old = {
        probe: vi.fn().mockResolvedValue(true),
        dispose: vi
          .fn()
          .mockReturnValueOnce(teardown.promise)
          .mockResolvedValue(undefined),
        isAvailable: () => true,
      };
      const fresh = {
        probe: vi.fn().mockResolvedValue(true),
        isAvailable: () => true,
      };
      const manager = new ACPManager({}, '/tmp', undefined, (config) =>
        config.id === 'old' ? old : fresh,
      );
      const config = {
        id: 'old',
        name: 'Test',
        command: 'test-acp',
        enabled: true,
      };
      const initialTimerCount = vi.getTimerCount();
      try {
        await manager.startAll([config]);
        const stopping = manager.shutdown();
        const stopped =
          outcome === 'rejects'
            ? expect(stopping).rejects.toThrow('ACP probe shutdown failed')
            : expect(stopping).resolves.toBeUndefined();
        await manager.startAll([{ ...config, id: 'new' }]);
        if (outcome === 'rejects')
          teardown.reject(new Error('disposal failed'));
        else teardown.resolve();
        await stopped;
        await vi.advanceTimersByTimeAsync(180_000);
        expect.soft(vi.getTimerCount()).toBe(initialTimerCount);
        expect(fresh.probe).toHaveBeenCalledExactlyOnceWith('request');

        await manager.startAll([{ ...config, id: 'next' }]);
        expect(vi.getTimerCount()).toBe(initialTimerCount + 1);
      } finally {
        teardown.resolve();
        await manager.shutdown();
      }
    },
  );

  test('does not spawn the engine binary on every 60s tick forever', async () => {
    const manager = new ACPManager(
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
    // cadence archive#1908 measured spawning the engine binary forever,
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

describe('ACPManager.removeConnection', () => {
  test('resolves for a configured connection that never got a probe', async () => {
    // The connection routes remove by config id on update and delete, and a
    // disabled or unregistered connection was never added, so its id is
    // unknown to the manager. That must not fail the route.
    const manager = new ACPManager(
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      '/tmp',
    );
    await expect(manager.removeConnection('disabled')).resolves.toBeUndefined();
  });
});

describe('ACPManager.startAll repeated calls (#3421)', () => {
  beforeEach(() => {
    probeInstances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test('a second startAll replaces the sweep timer instead of stacking one', async () => {
    const manager = new ACPManager(
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      '/tmp',
    );
    const config = {
      id: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
      enabled: true,
    };

    await manager.startAll([config]);
    await manager.startAll([config]);
    expect(vi.getTimerCount()).toBe(1);

    await manager.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
});
