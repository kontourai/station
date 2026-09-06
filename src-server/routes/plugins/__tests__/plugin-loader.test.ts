import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  clearAll,
  createProviderAdapterRegistry,
  listProviders,
  providerAdapterLaunchabilitySource,
} from '../../../providers/registries/registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { grantPermissions } from '../../../services/plugins/plugin-permissions.js';
import { loadPluginProviders } from '../plugin-loader.js';

describe('loadPluginProviders', () => {
  let projectHome = '';

  afterEach(() => {
    clearAll();
    if (projectHome) rmSync(projectHome, { recursive: true, force: true });
  });

  test('a second-provider admission refusal disposes the first prepared instance without publishing or running the second factory', async () => {
    projectHome = mkdtempSync(
      join(tmpdir(), 'station-provider-admission-cleanup-'),
    );
    const pluginsDir = join(projectHome, 'plugins'),
      pluginDir = join(pluginsDir, 'admission-cleanup');
    mkdirSync(pluginDir, { recursive: true });
    const globals = globalThis as typeof globalThis & {
      __stationFirstPrepared?: number;
      __stationFirstDisposed?: number;
      __stationSecondPrepared?: number;
    };
    globals.__stationFirstPrepared = 0;
    globals.__stationFirstDisposed = 0;
    globals.__stationSecondPrepared = 0;
    writeFileSync(
      join(pluginDir, 'first.mjs'),
      "export default function () { globalThis.__stationFirstPrepared++; return { provider: 'first-prepared', metadata: { displayName: 'First', description: 'Fixture', capabilities: ['agent-runtime'], runtimeId: 'first-prepared' }, startSession: async () => ({}), sendTurn: async () => ({}), interruptTurn: async () => {}, respondToRequest: async () => {}, stopSession: async () => {}, listSessions: async () => [], hasSession: async () => false, streamEvents: async function* () {}, stopAll: async () => { globalThis.__stationFirstDisposed++; } }; }",
    );
    writeFileSync(
      join(pluginDir, 'second.mjs'),
      "export default function () { globalThis.__stationSecondPrepared++; return { provider: 'second-prepared', metadata: { displayName: 'Second', description: 'Fixture', capabilities: ['agent-runtime'], runtimeId: 'second-prepared' }, startSession: async () => ({}), sendTurn: async () => ({}), interruptTurn: async () => {}, respondToRequest: async () => {}, stopSession: async () => {}, listSessions: async () => [], hasSession: async () => false, streamEvents: async function* () {}, stopAll: async () => {} }; }",
    );
    try {
      await expect(
        loadPluginProviders(
          pluginsDir,
          'admission-cleanup',
          {
            name: 'admission-cleanup',
            version: '1.0.0',
            providers: [
              { type: 'providerAdapter', module: './first.mjs' },
              { type: 'providerAdapter', module: './second.mjs' },
            ],
          },
          { error: vi.fn() },
          {
            strict: true,
            beforeEffect: async () => {
              if (globals.__stationFirstPrepared)
                throw new Error('policy admission withdrawn');
            },
          },
        ),
      ).rejects.toThrow('policy admission withdrawn');
      expect(globals.__stationFirstPrepared).toBe(1);
      expect(globals.__stationFirstDisposed).toBe(1);
      expect(globals.__stationSecondPrepared).toBe(0);
      expect(
        listProviders('providerAdapter').some(
          (entry) => entry.source === 'admission-cleanup',
        ),
      ).toBe(false);
    } finally {
      delete globals.__stationFirstPrepared;
      delete globals.__stationFirstDisposed;
      delete globals.__stationSecondPrepared;
    }
  });

  test('registers plugin adapters through the revision-aware adapter API', async () => {
    projectHome = mkdtempSync(join(tmpdir(), 'station-plugin-loader-'));
    const pluginsDir = join(projectHome, 'plugins');
    const pluginDir = join(pluginsDir, 'runtime-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'adapter.mjs'),
      `export default {
        provider: 'plugin-runtime',
        metadata: {
          displayName: 'Plugin Runtime',
          description: 'Plugin runtime',
          capabilities: ['agent-runtime'],
          runtimeId: 'plugin-runtime'
        },
        startSession: async (input) => ({
          provider: 'plugin-runtime',
          threadId: input.threadId,
          status: 'ready',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }),
        sendTurn: async (input) => ({ threadId: input.threadId, turnId: 'turn-1' }),
        interruptTurn: async () => undefined,
        respondToRequest: async () => undefined,
        stopSession: async () => undefined,
        listSessions: async () => [],
        hasSession: async () => false,
        stopAll: async () => undefined,
        streamEvents: async function* () {}
      };`,
    );
    await grantPermissions(projectHome, 'runtime-plugin', [
      'providers.register',
    ]);
    const before =
      providerAdapterLaunchabilitySource.getLaunchabilityRevision();

    const loaded = await loadPluginProviders(
      pluginsDir,
      'runtime-plugin',
      {
        displayName: 'Runtime Plugin',
        providers: [{ type: 'providerAdapter', module: 'adapter.mjs' }],
      } as any,
      { error: vi.fn() } as any,
    );

    expect(loaded).toBe(1);
    expect(createProviderAdapterRegistry().list()).toEqual([
      expect.objectContaining({ provider: 'plugin-runtime' }),
    ]);
    expect(providerAdapterLaunchabilitySource.getLaunchabilityRevision()).toBe(
      before + 1,
    );
  });

  test('treats an old plugin interrupt result as unacknowledged without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let eventStore: EventStore | undefined;
    try {
      projectHome = mkdtempSync(join(tmpdir(), 'station-plugin-loader-'));
      const pluginsDir = join(projectHome, 'plugins');
      const pluginDir = join(pluginsDir, 'legacy-runtime-plugin');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(pluginDir, 'adapter.mjs'),
        `const sessions = new Set();
        export default {
          provider: 'plugin-runtime',
          metadata: {
            displayName: 'Plugin Runtime', description: 'Plugin runtime',
            capabilities: ['agent-runtime'], runtimeId: 'plugin-runtime'
          },
          interruptCalls: [], stopCalls: [],
          startSession: async (input) => {
            sessions.add(input.threadId);
            return {
              provider: 'plugin-runtime', threadId: input.threadId, status: 'ready',
              createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
            };
          },
          sendTurn: async (input) => ({ threadId: input.threadId, turnId: 'turn-1' }),
          interruptTurn: async function (threadId, turnId) {
            this.interruptCalls.push([threadId, turnId]);
            return undefined;
          },
          respondToRequest: async () => undefined,
          stopSession: async function (threadId) { this.stopCalls.push(threadId); sessions.delete(threadId); },
          listSessions: async () => [], hasSession: async (threadId) => sessions.has(threadId),
          stopAll: async () => undefined, streamEvents: async function* () {}
        };`,
      );
      await grantPermissions(projectHome, 'legacy-runtime-plugin', [
        'providers.register',
      ]);
      await loadPluginProviders(
        pluginsDir,
        'legacy-runtime-plugin',
        {
          displayName: 'Legacy Runtime Plugin',
          providers: [{ type: 'providerAdapter', module: 'adapter.mjs' }],
        } as any,
        { error: vi.fn() } as any,
      );
      const registry = createProviderAdapterRegistry();
      const plugin = registry.get('plugin-runtime') as any;
      eventStore = new EventStore(join(projectHome, 'orchestration.sqlite'));
      const service = new OrchestrationService({
        adapterRegistry: registry,
        eventBus: new EventBus(),
        eventStore,
        cooperativeStopBudgetMs: 25,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      await service.dispatch({
        type: 'startSession',
        input: { threadId: 'legacy-plugin-turn', provider: 'plugin-runtime' },
      });
      eventStore.appendEvent({
        eventId: 'legacy-plugin-turn-started',
        provider: 'plugin-runtime',
        threadId: 'legacy-plugin-turn',
        turnId: 'turn-1',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'cancel me',
      });

      const stopping = service.dispatch({
        type: 'interruptTurn',
        threadId: 'legacy-plugin-turn',
      });
      // Let dispatch install its cooperative timer before moving fake time.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(25);
      await stopping;
      await Promise.resolve();

      expect(plugin.interruptCalls).toEqual([['legacy-plugin-turn', 'turn-1']]);
      expect(plugin.stopCalls).toEqual(['legacy-plugin-turn']);
      expect(unhandled).toEqual([]);
      await service.shutdown();
    } finally {
      eventStore?.close();
      process.off('unhandledRejection', onUnhandled);
      vi.useRealTimers();
    }
  });

  test('rejects malformed plugin adapters', async () => {
    projectHome = mkdtempSync(join(tmpdir(), 'station-plugin-loader-'));
    const pluginsDir = join(projectHome, 'plugins');
    const pluginDir = join(pluginsDir, 'runtime-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'adapter.mjs'),
      `export default { provider: 'plugin-runtime', metadata: {} };`,
    );
    const logger = { error: vi.fn() } as any;

    const loaded = await loadPluginProviders(
      pluginsDir,
      'runtime-plugin',
      {
        displayName: 'Runtime Plugin',
        providers: [{ type: 'providerAdapter', module: 'adapter.mjs' }],
      } as any,
      logger,
    );

    expect(loaded).toBe(0);
    expect(createProviderAdapterRegistry().list()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'Invalid plugin provider adapter shape',
      { plugin: 'runtime-plugin', type: 'providerAdapter' },
    );
  });

  test('rejects provider modules that escape the plugin root', async () => {
    projectHome = mkdtempSync(join(tmpdir(), 'station-plugin-loader-'));
    const pluginsDir = join(projectHome, 'plugins');
    const pluginDir = join(pluginsDir, 'runtime-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(projectHome, 'outside.mjs'), 'export default {};');

    await expect(
      loadPluginProviders(
        pluginsDir,
        'runtime-plugin',
        {
          displayName: 'Runtime Plugin',
          providers: [{ type: 'providerAdapter', module: '../outside.mjs' }],
        } as any,
        { error: vi.fn() } as any,
      ),
    ).rejects.toThrow(/Plugin provider module escapes root/);
  });

  test('removes a source generation when an updated manifest has no providers', async () => {
    projectHome = mkdtempSync(join(tmpdir(), 'station-plugin-loader-'));
    const pluginsDir = join(projectHome, 'plugins');
    const pluginDir = join(pluginsDir, 'runtime-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'adapter.mjs'),
      `export default {
        provider: 'plugin-runtime',
        metadata: {
          displayName: 'Plugin Runtime',
          description: 'Plugin runtime',
          capabilities: ['agent-runtime'],
          runtimeId: 'plugin-runtime'
        },
        startSession: async () => ({}),
        sendTurn: async () => ({}),
        interruptTurn: async () => undefined,
        respondToRequest: async () => undefined,
        stopSession: async () => undefined,
        listSessions: async () => [],
        hasSession: async () => false,
        stopAll: async () => undefined,
        streamEvents: async function* () {}
      };`,
    );
    const logger = { error: vi.fn() } as any;
    const before =
      providerAdapterLaunchabilitySource.getLaunchabilityRevision();
    await grantPermissions(projectHome, 'runtime-plugin', [
      'providers.register',
    ]);
    await loadPluginProviders(
      pluginsDir,
      'runtime-plugin',
      {
        providers: [{ type: 'providerAdapter', module: 'adapter.mjs' }],
      } as any,
      logger,
    );

    const loaded = await loadPluginProviders(
      pluginsDir,
      'runtime-plugin',
      {} as any,
      logger,
    );

    expect(loaded).toBe(0);
    expect(createProviderAdapterRegistry().list()).toEqual([]);
    expect(providerAdapterLaunchabilitySource.getLaunchabilityRevision()).toBe(
      before + 2,
    );
  });
});
