import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  mergeRuntimeACPConnections,
  scheduleRuntimeDailyReload,
  scheduleRuntimePluginUpdateCheck,
  startRuntimeACPConnections,
} from '../runtime-background-tasks.js';
import { initializeRuntimeBackgroundTasks } from '../runtime-initialize.js';

const { loadOrCreateAgentRegistry } = vi.hoisted(() => ({
  loadOrCreateAgentRegistry: vi.fn(),
}));

vi.mock('../../../domain/agent-registry.js', () => ({
  loadOrCreateAgentRegistry,
  reconcilePluginEngineConnections: vi.fn(),
}));

const { reapEngineSpawnTmpDir } = vi.hoisted(() => ({
  reapEngineSpawnTmpDir: vi.fn(),
}));

vi.mock('../../../services/infra/engine-spawn-tmpdir.js', () => ({
  engineSpawnTmpDirPath: vi.fn(() => '/tmp/station-engine-spawn'),
  reapEngineSpawnTmpDir,
}));

describe('mergeRuntimeACPConnections', () => {
  test('merges provider ACP connections without duplicating configured ids', () => {
    const merged = mergeRuntimeACPConnections(
      [
        { id: 'configured-1', name: 'Configured One' },
        { id: 'shared', name: 'Configured Shared' },
      ],
      [
        {
          provider: {
            getConnections: () => [
              { id: 'provider-1', name: 'Provider One' },
              { id: 'shared', name: 'Provider Shared' },
            ],
          },
        },
      ],
    );

    expect(merged).toEqual([
      { id: 'configured-1', name: 'Configured One' },
      { id: 'shared', name: 'Configured Shared' },
      { id: 'provider-1', name: 'Provider One' },
    ]);
  });
});

describe('startRuntimeACPConnections', () => {
  function harness() {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const acpBridge = {
      startAll: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
    };
    return { logger, acpBridge };
  }

  test('starts configured ACP connections and reports readiness', async () => {
    const { logger, acpBridge } = harness();
    const onReady = vi.fn();

    startRuntimeACPConnections({
      loadACPConfig: async () => ({ connections: [] }),
      acpBridge: acpBridge as any,
      logger: logger as any,
      listProvidersFn: (() => []) as any,
      onReady,
    });
    // archive#3404: boot is the `'background'` probe path — nothing awaits
    // this chain, so first contact with a cold engine may take the long
    // budget. Asserted here because it is the ONE call site that opts in.
    await vi.waitFor(() =>
      expect(acpBridge.startAll).toHaveBeenCalledWith([], 'background'),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[Runtime] ACP connections established',
    );
    expect(onReady).toHaveBeenCalledOnce();
  });

  test('reports ACP-ready reconciliation failure without relabeling startup as failed', async () => {
    const { logger, acpBridge } = harness();
    startRuntimeACPConnections({
      loadACPConfig: async () => ({ connections: [] }),
      acpBridge: acpBridge as any,
      logger: logger as any,
      listProvidersFn: (() => []) as any,
      onReady: async () => {
        throw new Error('rebind failed');
      },
    });

    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        '[Runtime] ACP-ready reconciliation failed',
        { error: 'rebind failed' },
      ),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[Runtime] ACP startup failed',
      expect.anything(),
    );
  });

  test('reports a failed ACP startup', async () => {
    const { logger, acpBridge } = harness();
    acpBridge.startAll.mockRejectedValue(new Error('bridge down'));
    startRuntimeACPConnections({
      loadACPConfig: async () => ({ connections: [] }),
      acpBridge: acpBridge as any,
      logger: logger as any,
      listProvidersFn: (() => []) as any,
    });
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith('[Runtime] ACP startup failed', {
        error: 'bridge down',
      }),
    );
  });

  test('starts only ACP runtimes committed in the Agent registry', async () => {
    const { logger, acpBridge } = harness();
    startRuntimeACPConnections({
      loadACPConfig: async () => ({
        connections: [
          { id: 'committed', name: 'Committed' },
          { id: 'orphan', name: 'Failed CAS orphan' },
        ],
      }),
      loadRegisteredRuntimeConnectionIds: async () =>
        new Set(['committed', 'plugin-committed']),
      acpBridge: acpBridge as any,
      logger: logger as any,
      listProvidersFn: (() => [
        {
          provider: {
            getConnections: () => [
              { id: 'plugin-committed', name: 'Plugin committed' },
              { id: 'plugin-orphan', name: 'Plugin orphan' },
            ],
          },
        },
      ]) as any,
    });

    await vi.waitFor(() =>
      expect(acpBridge.startAll).toHaveBeenCalledWith(
        [
          { id: 'committed', name: 'Committed' },
          { id: 'plugin-committed', name: 'Plugin committed' },
        ],
        'background',
      ),
    );
  });
});

describe('scheduleRuntimeEngineSpawnTmpReaping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadOrCreateAgentRegistry.mockReset();
    reapEngineSpawnTmpDir.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test.each([
    {
      failure: 'ACP config loading',
      loadACPConfig: async () => {
        throw new Error('corrupt ACP config');
      },
      setRegistryFailure: () => undefined,
      error: 'corrupt ACP config',
    },
    {
      failure: 'Agent registry loading',
      loadACPConfig: async () => ({ connections: [] }),
      setRegistryFailure: () =>
        loadOrCreateAgentRegistry.mockRejectedValueOnce(
          new Error('corrupt Agent registry'),
        ),
      error: 'corrupt Agent registry',
    },
  ])(
    'arms the reaper through runtime initialization when $failure rejects',
    async ({ loadACPConfig, setRegistryFailure, error }) => {
      const timers: NodeJS.Timeout[] = [];
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const acpBridge = {
        startAll: vi.fn(),
        isConnected: vi.fn(),
      };

      setRegistryFailure();
      // Exercise the production runtime-initialize wiring rather than manually
      // imposing the desired helper-call order. If reaping moves behind ACP
      // startup again, either rejection leaves no interval or initial sweep.
      initializeRuntimeBackgroundTasks({
        timers,
        logger: logger as any,
        configLoader: { loadACPConfig } as any,
        acpBridge: acpBridge as any,
      });

      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          '[Runtime] ACP startup failed',
          {
            error,
          },
        ),
      );
      await vi.waitFor(() =>
        expect(reapEngineSpawnTmpDir).toHaveBeenCalledTimes(1),
      );
      expect(timers).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(reapEngineSpawnTmpDir).toHaveBeenCalledTimes(2);
      expect(acpBridge.startAll).not.toHaveBeenCalled();
    },
  );
});

describe('scheduleRuntimeDailyReload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T18:30:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('schedules reload for the next midnight and reschedules after running', async () => {
    const timers: NodeJS.Timeout[] = [];
    const reloadAgents = vi.fn(async () => {});

    scheduleRuntimeDailyReload({ timers, reloadAgents });

    expect(timers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5.5 * 60 * 60 * 1000);
    expect(reloadAgents).toHaveBeenCalledTimes(1);
    expect(timers.length).toBeGreaterThanOrEqual(2);
  });
});

describe('scheduleRuntimePluginUpdateCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('emits an event when plugin updates are available', async () => {
    const timers: NodeJS.Timeout[] = [];
    const eventBus = { emit: vi.fn() };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ updates: [{ id: 'plugin-1' }] }),
    })) as any;

    scheduleRuntimePluginUpdateCheck({
      timers,
      port: 4111,
      eventBus,
      logger,
      fetchImpl,
    });

    expect(timers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:4111/api/plugins/check-updates',
    );
    expect(eventBus.emit).toHaveBeenCalledWith('plugins:updates-available', {
      count: 1,
      updates: [{ id: 'plugin-1' }],
    });
    expect(logger.info).toHaveBeenCalledWith('Plugin updates available', {
      count: 1,
    });
  });
});
