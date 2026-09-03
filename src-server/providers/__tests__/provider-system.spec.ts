import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../domain/config-loader.js';
import type { ProviderAdapterShape } from '../adapter-shape.js';
import { BedrockAdapter } from '../adapters/bedrock-adapter.js';
import {
  clearAll,
  clearPluginProviders,
  createProviderAdapterRegistry,
  disposePreparedPluginProviders,
  disposeRetainedPreparedPluginProviders,
  getAllPrerequisites,
  getBrandingProvider,
  getProvider,
  getProviderAdapter,
  getProviderAdapters,
  listProviders,
  providerAdapterLaunchabilitySource,
  registerBrandingProvider,
  registerProvider,
  registerProviderAdapter,
  replacePluginProviders,
  replacePluginProvidersForSource,
} from '../registries/registry.js';
import { resolvePluginProviders } from '../resolver.js';

describe('Provider System', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'provider-test-'));
    clearAll();
  });

  afterAll(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('resolver.ts', () => {
    it('returns empty resolved and no conflicts for empty plugins dir', () => {
      const result = resolvePluginProviders(join(tempDir, 'nonexistent'), {});
      expect(result.resolved).toEqual([]);
      expect(result.conflicts).toEqual([]);
    });

    it('warns when a manifest cannot be read, because the plugin silently disappears', () => {
      // This skip makes a plugin vanish -- its providers stop loading, with no
      // user-facing signal anywhere. archive#4307 widened what gets rejected
      // here (`manifest.name` is now held to `isCanonicalPluginId` plus the
      // reserved-key check), so a plugin installed under a name that was legal
      // before and is not now disappears on upgrade. At debug level nobody
      // ever learned why (archive#4322).
      const pluginsDir = join(tempDir, 'plugins');
      const pluginDir = join(pluginsDir, 'broken-plugin');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'plugin.json'), '{ not json at all');

      const warnings: Array<{ message: string; context?: unknown }> = [];
      const result = resolvePluginProviders(pluginsDir, {}, () => true, {
        warn: (message: string, context?: unknown) =>
          warnings.push({ message, context }),
      });

      expect(result.resolved).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toEqual({
        message: 'Installed plugin manifest rejected',
        context: expect.objectContaining({
          pluginDirectory: 'broken-plugin',
          code: 'malformed-json',
        }),
      });
    });

    it('resolves single plugin with one provider correctly', () => {
      const pluginsDir = join(tempDir, 'plugins');
      const pluginDir = join(pluginsDir, 'test-plugin');
      mkdirSync(pluginDir, { recursive: true });

      writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
          name: 'test-plugin',
          version: '1.0.0',
          providers: [{ type: 'auth', module: './auth.js' }],
        }),
      );

      const warnings: string[] = [];
      const result = resolvePluginProviders(pluginsDir, {}, () => true, {
        warn: (message: string) => warnings.push(message),
      });
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0]).toEqual({
        pluginName: 'test-plugin',
        type: 'auth',
        module: './auth.js',
        layout: undefined,
      });
      expect(result.conflicts).toEqual([]);
      // The happy path stays quiet: a warn here would be noise on every boot.
      expect(warnings).toEqual([]);
    });

    it('filters out disabled provider', () => {
      const pluginsDir = join(tempDir, 'plugins');
      const pluginDir = join(pluginsDir, 'test-plugin');
      mkdirSync(pluginDir, { recursive: true });

      writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
          name: 'test-plugin',
          version: '1.0.0',
          providers: [{ type: 'auth', module: './auth.js' }],
        }),
      );

      const overrides = { 'test-plugin': { disabled: ['auth'] } };
      const result = resolvePluginProviders(pluginsDir, overrides);
      expect(result.resolved).toEqual([]);
      expect(result.conflicts).toEqual([]);
    });

    it('creates conflict for two plugins providing same singleton type', () => {
      const pluginsDir = join(tempDir, 'plugins');

      const plugin1Dir = join(pluginsDir, 'plugin1');
      mkdirSync(plugin1Dir, { recursive: true });
      writeFileSync(
        join(plugin1Dir, 'plugin.json'),
        JSON.stringify({
          name: 'plugin1',
          version: '1.0.0',
          providers: [{ type: 'auth', module: './auth.js' }],
        }),
      );

      const plugin2Dir = join(pluginsDir, 'plugin2');
      mkdirSync(plugin2Dir, { recursive: true });
      writeFileSync(
        join(plugin2Dir, 'plugin.json'),
        JSON.stringify({
          name: 'plugin2',
          version: '1.0.0',
          providers: [{ type: 'auth', module: './auth.js' }],
        }),
      );

      const result = resolvePluginProviders(pluginsDir, {});
      expect(result.resolved).toEqual([]);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toEqual({
        type: 'auth',
        layout: '*',
        candidates: ['plugin1', 'plugin2'],
      });
    });

    it('filters plugins before singleton conflict resolution', () => {
      const pluginsDir = join(tempDir, 'plugins');

      const grantedDir = join(pluginsDir, 'granted-plugin');
      mkdirSync(grantedDir, { recursive: true });
      writeFileSync(
        join(grantedDir, 'plugin.json'),
        JSON.stringify({
          name: 'granted-plugin',
          version: '1.0.0',
          providers: [{ type: 'auth', module: './auth.js' }],
        }),
      );

      const ungrantedDir = join(pluginsDir, 'ungranted-plugin');
      mkdirSync(ungrantedDir, { recursive: true });
      writeFileSync(
        join(ungrantedDir, 'plugin.json'),
        JSON.stringify({
          name: 'ungranted-plugin',
          version: '1.0.0',
          providers: [{ type: 'auth', module: './auth.js' }],
        }),
      );

      const result = resolvePluginProviders(
        pluginsDir,
        {},
        (pluginName) => pluginName === 'granted-plugin',
      );

      expect(result.conflicts).toEqual([]);
      expect(result.resolved).toEqual([
        {
          pluginName: 'granted-plugin',
          type: 'auth',
          module: './auth.js',
          layout: undefined,
        },
      ]);
    });

    it('resolves two plugins providing same additive type without conflict', () => {
      const pluginsDir = join(tempDir, 'plugins');

      const plugin1Dir = join(pluginsDir, 'plugin1');
      mkdirSync(plugin1Dir, { recursive: true });
      writeFileSync(
        join(plugin1Dir, 'plugin.json'),
        JSON.stringify({
          name: 'plugin1',
          version: '1.0.0',
          providers: [{ type: 'pluginRegistry', module: './registry.json' }],
        }),
      );

      const plugin2Dir = join(pluginsDir, 'plugin2');
      mkdirSync(plugin2Dir, { recursive: true });
      writeFileSync(
        join(plugin2Dir, 'plugin.json'),
        JSON.stringify({
          name: 'plugin2',
          version: '1.0.0',
          providers: [{ type: 'pluginRegistry', module: './registry.json' }],
        }),
      );

      const result = resolvePluginProviders(pluginsDir, {});
      expect(result.resolved).toHaveLength(2);
      expect(result.conflicts).toEqual([]);
    });

    it('skips plugin with no providers array', () => {
      const pluginsDir = join(tempDir, 'plugins');
      const pluginDir = join(pluginsDir, 'test-plugin');
      mkdirSync(pluginDir, { recursive: true });

      writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
          name: 'test-plugin',
          version: '1.0.0',
        }),
      );

      const result = resolvePluginProviders(pluginsDir, {});
      expect(result.resolved).toEqual([]);
      expect(result.conflicts).toEqual([]);
    });
  });

  describe('registry.ts', () => {
    it('registerProvider + getProvider round-trip for singleton type', () => {
      const mockProvider = { test: 'value' };
      registerProvider('auth', mockProvider);

      const retrieved = getProvider('auth');
      expect(retrieved).toBe(mockProvider);
    });

    it('getProvider returns null when nothing registered', () => {
      const result = getProvider('auth');
      expect(result).toBeNull();
    });

    it('getProvider with layout scoping', () => {
      const globalProvider = { scope: 'global' };
      const layoutProvider = { scope: 'layout' };

      registerProvider('auth', globalProvider);
      registerProvider('auth', layoutProvider, { layout: 'test-ws' });

      expect(getProvider('auth')).toBe(globalProvider);
      expect(getProvider('auth', 'test-ws')).toBe(layoutProvider);
      expect(getProvider('auth', 'other-ws')).toBe(globalProvider);
    });

    it('listProviders returns all entries for additive types', () => {
      const provider1 = { id: 1 };
      const provider2 = { id: 2 };

      registerProvider('pluginRegistry', provider1, { source: 'plugin1' });
      registerProvider('pluginRegistry', provider2, { source: 'plugin2' });

      const entries = listProviders('pluginRegistry');
      expect(entries).toHaveLength(2);
      expect(entries[0].provider).toBe(provider1);
      expect(entries[1].provider).toBe(provider2);
    });

    it('includes plugin singleton and additive provider prerequisites in system status', async () => {
      registerProvider(
        'auth',
        {
          getPrerequisites: vi
            .fn()
            .mockResolvedValue([{ id: 'auth-env', status: 'missing' }]),
        },
        { plugin: true, source: 'plugin-auth' },
      );
      registerProvider(
        'pluginRegistry',
        {
          getPrerequisites: vi
            .fn()
            .mockResolvedValue([{ id: 'registry-env', status: 'ready' }]),
        },
        { plugin: true, source: 'plugin-registry' },
      );

      await expect(getAllPrerequisites()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'auth-env', source: 'plugin-auth' }),
          expect.objectContaining({
            id: 'registry-env',
            source: 'plugin-registry',
          }),
        ]),
      );
    });

    it('surfaces provider prerequisite discovery failures as required errors', async () => {
      registerProvider(
        'pluginRegistry',
        {
          getPrerequisites: vi
            .fn()
            .mockRejectedValue(new Error('credential probe failed')),
        },
        { plugin: true, source: 'plugin-registry' },
      );

      await expect(getAllPrerequisites()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'provider-prerequisites:plugin-registry',
            source: 'plugin-registry',
            status: 'error',
            category: 'required',
            description: 'credential probe failed',
          }),
        ]),
      );
    });

    it('probes provider prerequisites in parallel', async () => {
      let resolveAuth:
        | ((value: Array<{ id: string; status: 'installed' }>) => void)
        | undefined;
      let resolveRegistry:
        | ((value: Array<{ id: string; status: 'installed' }>) => void)
        | undefined;
      const authProbe = vi.fn(
        () =>
          new Promise<Array<{ id: string; status: 'installed' }>>((resolve) => {
            resolveAuth = resolve;
          }),
      );
      const registryProbe = vi.fn(
        () =>
          new Promise<Array<{ id: string; status: 'installed' }>>((resolve) => {
            resolveRegistry = resolve;
          }),
      );
      registerProvider(
        'auth',
        { getPrerequisites: authProbe },
        { source: 'auth' },
      );
      registerProvider(
        'pluginRegistry',
        { getPrerequisites: registryProbe },
        { source: 'registry' },
      );

      const prerequisites = getAllPrerequisites();
      await vi.waitFor(() => {
        expect(authProbe).toHaveBeenCalledOnce();
        expect(registryProbe).toHaveBeenCalledOnce();
      });
      resolveAuth?.([{ id: 'auth', status: 'installed' }]);
      resolveRegistry?.([{ id: 'registry', status: 'installed' }]);

      await expect(prerequisites).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'auth', source: 'auth' }),
          expect.objectContaining({ id: 'registry', source: 'registry' }),
        ]),
      );
    });

    it('records an explicit timed-out prerequisite when the shared budget expires', async () => {
      registerProvider(
        'pluginRegistry',
        { getPrerequisites: () => new Promise(() => undefined) },
        { source: 'slow-provider' },
      );
      const controller = new AbortController();
      const prerequisites = getAllPrerequisites({
        signal: controller.signal,
      });

      controller.abort(new Error('test prerequisite budget expired'));

      await expect(prerequisites).resolves.toEqual([
        expect.objectContaining({
          id: 'provider-prerequisites:slow-provider',
          source: 'slow-provider',
          status: 'error',
          category: 'required',
          reason: 'timed_out',
          description: 'Prerequisite discovery timed out.',
        }),
      ]);
    });

    it('collapses identical timed-out placeholders from providers sharing one source', async () => {
      const hanging = () => new Promise<never>(() => undefined);
      registerProvider(
        'pluginRegistry',
        { getPrerequisites: hanging },
        { source: 'shared-source' },
      );
      registerProvider(
        'skillRegistry',
        { getPrerequisites: hanging },
        { source: 'shared-source' },
      );
      registerProvider(
        'notification',
        { getPrerequisites: hanging },
        { source: 'shared-source' },
      );
      const controller = new AbortController();
      const prerequisites = getAllPrerequisites({
        signal: controller.signal,
      });

      controller.abort(new Error('test prerequisite budget expired'));

      await expect(prerequisites).resolves.toEqual([
        expect.objectContaining({
          id: 'provider-prerequisites:shared-source',
          source: 'shared-source',
          status: 'error',
          category: 'required',
          reason: 'timed_out',
          description: 'Prerequisite discovery timed out. (3 providers)',
        }),
      ]);
    });

    it('retains placeholders with different descriptions from one source', async () => {
      registerProvider(
        'pluginRegistry',
        { getPrerequisites: () => new Promise<never>(() => undefined) },
        { source: 'shared-source' },
      );
      registerProvider(
        'skillRegistry',
        {
          getPrerequisites: vi.fn().mockRejectedValue(new Error('boom')),
        },
        { source: 'shared-source' },
      );
      const controller = new AbortController();
      const prerequisites = getAllPrerequisites({
        signal: controller.signal,
      });

      // Let the rejecting provider's failure settle before the budget expires
      // so only the hanging provider is recorded as timed out.
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort(new Error('test prerequisite budget expired'));

      await expect(prerequisites).resolves.toEqual([
        expect.objectContaining({
          id: 'provider-prerequisites:shared-source',
          source: 'shared-source',
          status: 'error',
          category: 'required',
          reason: 'timed_out',
          description: 'Prerequisite discovery timed out.',
        }),
        expect.objectContaining({
          id: 'provider-prerequisites:shared-source',
          source: 'shared-source',
          status: 'error',
          category: 'required',
          description: 'boom',
        }),
      ]);
    });

    it('uses provider metadata for additive types such as acpConnections', () => {
      const provider1 = { getConnections: () => [{ id: 'kiro' }] };
      const provider2 = { getConnections: () => [{ id: 'cursor' }] };

      registerProvider('acpConnections', provider1, { source: 'plugin1' });
      registerProvider('acpConnections', provider2, { source: 'plugin2' });

      const entries = listProviders('acpConnections');
      expect(entries).toHaveLength(2);
      expect(entries[0].provider).toBe(provider1);
      expect(entries[1].provider).toBe(provider2);
    });

    it('registers and resolves provider adapters by provider kind', () => {
      const adapter = new BedrockAdapter();

      registerProviderAdapter(adapter, { builtin: true });

      expect(getProviderAdapter('bedrock')).toBe(adapter);
      expect(getProviderAdapters()).toContain(adapter);
    });

    it('creates a provider adapter registry facade', () => {
      const adapter: ProviderAdapterShape = new BedrockAdapter();
      const registry = createProviderAdapterRegistry();

      registry.register(adapter);

      expect(registry.get('bedrock')).toBe(adapter);
      expect(registry.list()).toEqual([adapter]);
    });

    it('preserves built-in adapters when clearing plugin providers', () => {
      const builtInAdapter = new BedrockAdapter();
      const pluginAdapter = {
        provider: 'custom-runtime',
        metadata: {
          displayName: 'Custom Runtime',
          description: 'Plugin runtime',
          capabilities: ['agent-runtime'],
          engineId: engineId('custom-runtime'),
          builtin: true,
        },
        startSession: async () => {
          throw new Error('not implemented');
        },
        sendTurn: async () => {
          throw new Error('not implemented');
        },
        interruptTurn: async () => ({ outcome: 'no-active-turn' as const }),
        respondToRequest: async () => undefined,
        stopSession: async () => undefined,
        listSessions: async () => [],
        hasSession: async () => false,
        stopAll: async () => undefined,
        streamEvents: async function* () {},
      } satisfies ProviderAdapterShape;

      registerProviderAdapter(builtInAdapter, { builtin: true });
      registerProviderAdapter(pluginAdapter, { builtin: false });
      const revisionBeforeClear =
        providerAdapterLaunchabilitySource.getLaunchabilityRevision();

      clearPluginProviders();

      expect(getProviderAdapters()).toEqual([builtInAdapter]);
      expect(
        providerAdapterLaunchabilitySource.getLaunchabilityRevision(),
      ).toBe(revisionBeforeClear + 1);
    });

    it('restores a built-in adapter after clearing a plugin override with the same provider id', () => {
      const builtInAdapter = new BedrockAdapter();
      const pluginAdapter = new BedrockAdapter();

      registerProviderAdapter(builtInAdapter, { builtin: true });
      registerProviderAdapter(pluginAdapter, { builtin: false });
      expect(getProviderAdapter('bedrock')).toBe(pluginAdapter);

      clearPluginProviders();

      expect(getProviderAdapters()).toEqual([builtInAdapter]);
      expect(getProviderAdapter('bedrock')).toBe(builtInAdapter);
    });

    it('atomically replaces only plugin entries and restores shadowed core providers', async () => {
      const coreAuth = { id: 'core-auth' };
      const coreRegistry = { id: 'core-registry' };
      const pluginAuth = { id: 'plugin-auth' };
      const pluginRegistry = { id: 'plugin-registry' };
      registerProvider('auth', coreAuth);
      registerProvider('pluginRegistry', coreRegistry);

      await replacePluginProviders([
        {
          type: 'auth',
          provider: pluginAuth,
          source: 'plugin-one',
        },
        {
          type: 'pluginRegistry',
          provider: pluginRegistry,
          source: 'plugin-one',
        },
      ]);

      expect(getProvider('auth')).toBe(pluginAuth);
      expect(
        listProviders('pluginRegistry').map((entry) => entry.provider),
      ).toEqual([coreRegistry, pluginRegistry]);

      await replacePluginProviders([]);

      expect(getProvider('auth')).toBe(coreAuth);
      expect(
        listProviders('pluginRegistry').map((entry) => entry.provider),
      ).toEqual([coreRegistry]);
    });

    it('stops staged adapters displaced by provider-id deduplication', async () => {
      const first = new BedrockAdapter();
      const second = new BedrockAdapter();
      const stopFirst = vi.spyOn(first, 'stopAll').mockResolvedValue();
      const stopSecond = vi.spyOn(second, 'stopAll').mockResolvedValue();

      await replacePluginProviders([
        { type: 'providerAdapter', provider: first, source: 'plugin-one' },
        { type: 'providerAdapter', provider: second, source: 'plugin-one' },
      ]);

      expect(getProviderAdapter('bedrock')).toBe(second);
      expect(stopFirst).toHaveBeenCalledOnce();
      expect(stopSecond).not.toHaveBeenCalled();
    });

    it('atomically removes only the replaced plugin source generation', async () => {
      const sourceA = new BedrockAdapter();
      const sourceB = { id: 'source-b' };
      await replacePluginProvidersForSource('plugin-a', [
        { type: 'providerAdapter', provider: sourceA, source: 'plugin-a' },
      ]);
      await replacePluginProvidersForSource('plugin-b', [
        { type: 'auth', provider: sourceB, source: 'plugin-b' },
      ]);

      await replacePluginProvidersForSource('plugin-a', []);

      expect(getProviderAdapter('bedrock')).toBeUndefined();
      expect(getProvider('auth')).toBe(sourceB);
    });

    it('restores an older plugin adapter when a newer same-provider source is removed', async () => {
      const sourceA = new BedrockAdapter();
      const sourceB = new BedrockAdapter();

      await replacePluginProvidersForSource('plugin-a', [
        { type: 'providerAdapter', provider: sourceA, source: 'plugin-a' },
      ]);
      await replacePluginProvidersForSource('plugin-b', [
        { type: 'providerAdapter', provider: sourceB, source: 'plugin-b' },
      ]);

      expect(getProviderAdapter('bedrock')).toBe(sourceB);

      await replacePluginProvidersForSource('plugin-b', []);

      expect(getProviderAdapter('bedrock')).toBe(sourceA);
    });

    it('retains shadowed plugin adapters during full provider generation reloads', async () => {
      const sourceA = new BedrockAdapter();
      const sourceB = new BedrockAdapter();

      await replacePluginProviders([
        { type: 'providerAdapter', provider: sourceA, source: 'plugin-a' },
        { type: 'providerAdapter', provider: sourceB, source: 'plugin-b' },
      ]);

      expect(getProviderAdapter('bedrock')).toBe(sourceB);

      await replacePluginProvidersForSource('plugin-b', []);

      expect(getProviderAdapter('bedrock')).toBe(sourceA);
    });

    it('bounds staged cleanup, invokes every adapter, and retries retained ownership', async () => {
      vi.useFakeTimers();
      try {
        const synchronousFailure = new BedrockAdapter();
        const stalled = new BedrockAdapter();
        const stopFailure = vi
          .spyOn(synchronousFailure, 'stopAll')
          .mockImplementation(() => {
            throw new Error('sync cleanup failure');
          });
        const stopStalled = vi
          .spyOn(stalled, 'stopAll')
          .mockImplementationOnce(() => new Promise<void>(() => undefined))
          .mockResolvedValueOnce(undefined);

        const cleanup = disposePreparedPluginProviders([
          {
            type: 'providerAdapter',
            provider: synchronousFailure,
            source: 'plugin-a',
          },
          { type: 'providerAdapter', provider: stalled, source: 'plugin-b' },
        ]);
        const cleanupFailure = expect(cleanup).rejects.toThrow(
          'Prepared plugin provider cleanup failed',
        );
        await vi.advanceTimersByTimeAsync(2_001);

        await cleanupFailure;
        expect(stopFailure).toHaveBeenCalledOnce();
        expect(stopStalled).toHaveBeenCalledOnce();

        stopFailure.mockResolvedValue(undefined);
        await disposeRetainedPreparedPluginProviders();
        expect(stopFailure).toHaveBeenCalledTimes(2);
        expect(stopStalled).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('publishes adapter registration revisions for inventory invalidation', () => {
      const revisions: number[] = [];
      const unsubscribe =
        providerAdapterLaunchabilitySource.onLaunchabilityChange((revision) =>
          revisions.push(revision),
        );

      registerProviderAdapter(new BedrockAdapter(), { builtin: true });
      unsubscribe();

      expect(revisions).toEqual([
        providerAdapterLaunchabilitySource.getLaunchabilityRevision(),
      ]);
    });

    it('re-registering a provider adapter replaces the existing entry instead of duplicating it', () => {
      const first = new BedrockAdapter();
      const second = new BedrockAdapter();

      registerProviderAdapter(first);
      registerProviderAdapter(second);

      expect(getProviderAdapters()).toEqual([second]);
      expect(getProviderAdapter('bedrock')).toBe(second);
    });

    it('clearAll resets both stores', () => {
      registerProvider('auth', { test: 'singleton' });
      registerProvider('pluginRegistry', { test: 'additive' });

      expect(getProvider('auth')).not.toBeNull();
      expect(listProviders('pluginRegistry')).toHaveLength(1);

      clearAll();

      expect(getProvider('auth')).toBeNull();
      expect(listProviders('pluginRegistry')).toHaveLength(0);
    });

    it('backward-compat: registerBrandingProvider + getBrandingProvider', () => {
      const mockBranding = { getAppName: () => Promise.resolve('Test App') };
      registerBrandingProvider(mockBranding);

      const retrieved = getBrandingProvider();
      expect(retrieved).toBe(mockBranding);
    });

    it('getBrandingProvider returns DefaultBrandingProvider when nothing registered', () => {
      const defaultBranding = getBrandingProvider();
      expect(defaultBranding).toBeDefined();
      expect(typeof defaultBranding.getAppName).toBe('function');
    });
  });

  describe('ConfigLoader override tests', () => {
    let configLoader: ConfigLoader;
    let projectHomeDir: string;

    beforeEach(() => {
      projectHomeDir = join(tempDir, 'station');
      configLoader = new ConfigLoader({ projectHomeDir });
    });

    it('loadPluginOverrides returns {} when file does not exist', async () => {
      const overrides = await configLoader.loadPluginOverrides();
      expect(overrides).toEqual({});
    });

    it('savePluginOverrides + loadPluginOverrides round-trip', async () => {
      const testOverrides = {
        plugin1: { disabled: ['auth', 'branding'] },
        plugin2: { disabled: ['onboarding'] },
      };

      await configLoader.savePluginOverrides(testOverrides);
      const loaded = await configLoader.loadPluginOverrides();

      expect(loaded).toEqual(testOverrides);
    });
  });
});
