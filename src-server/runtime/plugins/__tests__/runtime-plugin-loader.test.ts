import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getProviderAdapterRegistrationProvenance } from '../../../providers/adapter-shape.js';
import {
  capturePluginProviderGeneration,
  loadPluginProviders,
  preparePluginProviderGeneration,
  preparePluginProviders,
  publishPluginProviderGeneration,
} from '../../../providers/plugin-provider-loader.js';
import {
  clearAll,
  getProvider,
  getProviderAdapter,
  getProviderAdapters,
  pluginProviderSourceGeneration,
  replacePluginProvidersForSource,
  retirePluginProvidersForSourceGeneration,
} from '../../../providers/registries/registry.js';
import { registerPluginLifecycleRoutes } from '../../../routes/plugins/plugin-lifecycle-routes.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import { createPluginGrantReconciliationService } from '../../../services/plugins/plugin-grant-reconciliation.js';
import { publishGrantedPluginProviderGeneration } from '../../../services/plugins/plugin-installation-generation-fence.js';
import {
  getPluginGrants,
  grantPermissions,
  revokeGrants,
} from '../../../services/plugins/plugin-permissions.js';
import type { Logger } from '../../../utils/logger.js';
import {
  loadRuntimePluginPrompts,
  loadRuntimePluginProviders,
} from '../runtime-plugin-loader.js';

const ADAPTER_METHODS = `
  startSession: async (input) => ({
    provider: 'custom',
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
`;

function writePlugin(
  pluginsDir: string,
  name: string,
  moduleSource: string,
  grantProvider = true,
  providerType = 'providerAdapter',
): void {
  const pluginDir = join(pluginsDir, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      providers: [{ type: providerType, module: './adapter.mjs' }],
    }),
  );
  writeFileSync(join(pluginDir, 'adapter.mjs'), moduleSource);
  if (grantProvider) {
    const grantsPath = join(pluginsDir, '..', 'plugin-grants.json');
    const grants = existsSync(grantsPath)
      ? JSON.parse(readFileSync(grantsPath, 'utf-8'))
      : {};
    grants[name] = ['providers.register'];
    writeFileSync(grantsPath, JSON.stringify(grants, null, 2));
  }
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('loadRuntimePluginProviders providerAdapter entries', () => {
  let projectHomeDir: string;

  beforeEach(() => {
    projectHomeDir = mkdtempSync(join(tmpdir(), 'runtime-plugin-loader-'));
    clearAll();
  });

  afterEach(() => {
    clearAll();
    delete (globalThis as any).__untrustedProviderImported;
    delete (globalThis as any).__ungrantedSingletonImported;
    delete (globalThis as any).__grantPublicationProbe;
    rmSync(projectHomeDir, { recursive: true, force: true });
  });

  test.each(['bootstrap', 'HTTP reload'] as const)(
    'an absent plugin directory does not let %s bypass unavailable grant authority',
    async (path) => {
      const logger = createLogger();
      const old = { retained: true };
      await replacePluginProvidersForSource('missing-tree', [
        { type: 'settings', source: 'missing-tree', provider: old },
      ]);
      const generation = pluginProviderSourceGeneration('missing-tree');
      writeFileSync(join(projectHomeDir, 'plugin-grants.json'), 'not json');
      if (path === 'bootstrap') {
        await loadRuntimePluginProviders({
          projectHomeDir,
          logger,
          loadPluginOverrides: async () => ({}),
        });
        expect(logger.error).toHaveBeenCalled();
      } else {
        const app = new Hono();
        registerPluginLifecycleRoutes(app, {
          agentsDir: join(projectHomeDir, 'agents'),
          pluginsDir: join(projectHomeDir, 'plugins'),
          projectHomeDir,
          logger: logger as unknown as Logger,
          buildPlugin: async () => {},
          applyConfigurationMutation: async (operation) =>
            operation(() => {}, { status: 'applied' }),
        });
        const response = await app.request('/reload', { method: 'POST' });
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({
          success: false,
          error: expect.stringContaining('grants store is unavailable'),
        });
      }
      expect(getProvider('settings')).toBe(old);
      expect(pluginProviderSourceGeneration('missing-tree')).toBe(generation);
    },
  );

  test.each(['bootstrap', 'HTTP reload'] as const)(
    'an older %s cannot strand a newly granted source by superseding its reconciliation',
    async (path) => {
      const pluginsDir = join(projectHomeDir, 'plugins');
      let entered = false;
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      (globalThis as any).__grantPublicationProbe = {
        started: () => {
          entered = true;
        },
        wait,
      };
      writePlugin(
        pluginsDir,
        'slow-existing',
        `
      globalThis.__grantPublicationProbe.started();
      await globalThis.__grantPublicationProbe.wait;
      export default { label: 'a' };
    `,
        true,
        'branding',
      );
      writePlugin(
        pluginsDir,
        'newly-granted',
        `
      globalThis.__grantPublicationProbe.grantStarted();
      await globalThis.__grantPublicationProbe.grantWait;
      export default { label: 'new-b' };
    `,
        false,
        'settings',
      );
      await replacePluginProvidersForSource('newly-granted', [
        {
          type: 'settings',
          source: 'newly-granted',
          provider: { label: 'old-b' },
        },
      ]);
      const logger = createLogger();
      const app = new Hono();
      registerPluginLifecycleRoutes(app, {
        agentsDir: join(projectHomeDir, 'agents'),
        pluginsDir,
        projectHomeDir,
        logger: logger as unknown as Logger,
        buildPlugin: async () => {},
        applyConfigurationMutation: async (operation) =>
          operation(() => {}, { status: 'applied' }),
      });
      let reloadStatus: number | undefined;
      const loading =
        path === 'bootstrap'
          ? loadRuntimePluginProviders({
              projectHomeDir,
              logger,
              loadPluginOverrides: async () => ({}),
            })
          : Promise.resolve(app.request('/reload', { method: 'POST' })).then(
              (response) => {
                reloadStatus = response.status;
              },
            );
      let releaseSnapshot!: () => void;
      const snapshotWait = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      let snapshotCaptured = false;
      Object.assign((globalThis as any).__grantPublicationProbe, {
        grantStarted: () => {
          snapshotCaptured = true;
        },
        grantWait: snapshotWait,
      });
      let reconciliation: Promise<unknown> | undefined;
      try {
        await vi.waitFor(() => expect(entered).toBe(true), { timeout: 3000 });
        // This write must finish while A's real top-level await is still paused.
        await grantPermissions(projectHomeDir, 'newly-granted', [
          'providers.register',
        ]);
        const service = createPluginGrantReconciliationService({
          snapshot: async (name) => ({
            installed: true,
            installationGeneration: computePluginContentDigest(
              pluginsDir,
              name,
            ),
            providerGeneration: pluginProviderSourceGeneration(name),
            grants: getPluginGrants(projectHomeDir, name),
          }),
          quiesceModule: async () => ({ release() {} }),
          quiesceSubscriptions: async () => ({ release() {} }),
          retireProviders: retirePluginProvidersForSourceGeneration,
          activateProviders: async (name, expected, current) => {
            const manifest = JSON.parse(
              readFileSync(join(pluginsDir, name, 'plugin.json'), 'utf8'),
            );
            const prepared = await preparePluginProviders(
              pluginsDir,
              name,
              manifest,
              logger,
              { strict: true },
            );
            return publishGrantedPluginProviderGeneration({
              projectHomeDir,
              pluginName: name,
              expectedProviderGeneration: expected.providerGeneration,
              prepared,
              isCurrent: current,
            });
          },
          settleProviderAdapters: async () => {},
          removeEngineConnections: async () => 'removed',
          reconcileEngineConnections: async () => {},
          reconcileSubscriptions: async () => ({ kind: 'applied' }),
        });
        reconciliation = service.reconcile({
          pluginName: 'newly-granted',
          permissions: ['providers.register'],
        });
        // B now pauses in its real module import after the final generation read.
        await vi.waitFor(() => expect(snapshotCaptured).toBe(true), {
          timeout: 3000,
        });
        finish();
        await loading;
        releaseSnapshot();
        await expect(reconciliation).resolves.toMatchObject({
          status: 'completed',
        });
        expect(getProvider('settings')).toMatchObject({ label: 'new-b' });
        if (path === 'HTTP reload') expect(reloadStatus).toBe(500);
      } finally {
        finish();
        releaseSnapshot();
        await loading;
        await reconciliation;
      }
    },
  );

  test.each([
    'direct lifecycle loader',
    'runtime bootstrap',
    'full reload',
  ] as const)(
    'does not publish from %s after durable revocation during real module import',
    async (path) => {
      const pluginsDir = join(projectHomeDir, 'plugins');
      let started!: () => void;
      let finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stopAll = vi.fn(async () => undefined);
      (globalThis as any).__grantPublicationProbe = { started, wait, stopAll };
      writePlugin(
        pluginsDir,
        'racing-plugin',
        `
        globalThis.__grantPublicationProbe.started();
        await globalThis.__grantPublicationProbe.wait;
        export default { provider: 'custom', metadata: {displayName:'Custom',description:'Fixture adapter',capabilities:['agent-runtime'],runtimeId:'custom-runtime'}, ${ADAPTER_METHODS}, stopAll: globalThis.__grantPublicationProbe.stopAll };
      `,
      );
      const manifest = JSON.parse(
        readFileSync(join(pluginsDir, 'racing-plugin', 'plugin.json'), 'utf8'),
      );
      const { basis } = await capturePluginProviderGeneration(
        projectHomeDir,
        () => undefined,
      );
      const logger = createLogger();
      const loading =
        path === 'runtime bootstrap'
          ? loadRuntimePluginProviders({
              projectHomeDir,
              logger,
              loadPluginOverrides: async () => ({}),
            })
          : path === 'full reload'
            ? preparePluginProviderGeneration(
                pluginsDir,
                [{ pluginName: 'racing-plugin', manifest }],
                logger,
              ).then((prepared) =>
                publishPluginProviderGeneration(basis, prepared),
              )
            : loadPluginProviders(
                pluginsDir,
                'racing-plugin',
                manifest,
                logger,
                { strict: true },
              );
      await entered;
      await revokeGrants(projectHomeDir, 'racing-plugin', [
        'providers.register',
      ]);
      finish();
      if (path === 'full reload')
        await expect(loading).rejects.toThrow('grant snapshot was superseded');
      else await loading;
      expect(getProviderAdapter('custom')).toBeUndefined();
      expect(stopAll).toHaveBeenCalledOnce();
    },
  );

  test('registers plugin runtime adapters through the adapter registry path', async () => {
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'custom-runtime',
      `export default {
        provider: 'custom',
        metadata: {
          displayName: 'Custom Runtime',
          description: 'Plugin-provided runtime adapter',
          capabilities: ['agent-runtime'],
          runtimeId: 'custom-runtime',
          builtin: true
        },
        ${ADAPTER_METHODS}
      };`,
    );

    await loadRuntimePluginProviders({
      logger: createLogger(),
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    });

    expect(getProviderAdapter('custom')?.metadata.displayName).toBe(
      'Custom Runtime',
    );
    expect(
      getProviderAdapterRegistrationProvenance(getProviderAdapter('custom')!),
    ).toBe('plugin');
  });

  test('deduplicates plugin runtime adapters by provider id', async () => {
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'adapter-a',
      `export default {
        provider: 'custom',
        metadata: {
          displayName: 'First Runtime',
          description: 'First plugin adapter',
          capabilities: ['agent-runtime'],
          runtimeId: 'custom-runtime',
          builtin: false
        },
        ${ADAPTER_METHODS}
      };`,
    );
    writePlugin(
      pluginsDir,
      'adapter-b',
      `export default {
        provider: 'custom',
        metadata: {
          displayName: 'Replacement Runtime',
          description: 'Second plugin adapter',
          capabilities: ['agent-runtime'],
          runtimeId: 'custom-runtime',
          builtin: false
        },
        ${ADAPTER_METHODS}
      };`,
    );

    await loadRuntimePluginProviders({
      logger: createLogger(),
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    });

    expect(getProviderAdapters().map((adapter) => adapter.provider)).toEqual([
      'custom',
    ]);
    expect(getProviderAdapter('custom')?.metadata.displayName).toBe(
      'Replacement Runtime',
    );
  });

  test('rejects malformed providerAdapter modules without registering them', async () => {
    const logger = createLogger();
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'bad-runtime',
      `export default { provider: 'bad', metadata: { displayName: 'Bad' } };`,
    );

    await loadRuntimePluginProviders({
      logger,
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    });

    expect(getProviderAdapter('bad')).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Invalid plugin provider adapter shape',
      { plugin: 'bad-runtime', type: 'providerAdapter' },
    );
  });

  test('validates untyped plugin engine identities before registration', async () => {
    const logger = createLogger();
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'bad-identity-runtime',
      `export default {
        provider: 'bad-identity',
        metadata: {
          displayName: 'Bad Identity Runtime',
          description: 'Invalid private and public engine identities',
          capabilities: ['agent-runtime'],
          runtimeId: 'bad_runtime',
          engineId: '__engine:bad'
        },
        ${ADAPTER_METHODS}
      };`,
    );

    await loadRuntimePluginProviders({
      logger,
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    });

    expect(getProviderAdapter('bad-identity')).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Invalid plugin provider adapter shape',
      { plugin: 'bad-identity-runtime', type: 'providerAdapter' },
    );
  });

  test('fails closed on a corrupt grants store: no provider registered, error logged, loader does not throw (#1835)', async () => {
    const logger = createLogger();
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'corrupt-grants-runtime',
      `export default {
        provider: 'corrupt-grants',
        metadata: {
          displayName: 'Corrupt Grants Runtime',
          description: 'Should never register',
          capabilities: ['agent-runtime'],
          runtimeId: 'corrupt-grants-runtime',
          builtin: false
        },
        ${ADAPTER_METHODS}
      };`,
      // The plugin HAS a grant on record — but the store is then corrupted,
      // so the grant must not be readable as granted.
      true,
    );
    const grantsPath = join(projectHomeDir, 'plugin-grants.json');
    writeFileSync(grantsPath, 'not json');

    // Must not throw past the loader boundary.
    await loadRuntimePluginProviders({
      logger,
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    });

    expect(getProviderAdapter('corrupt-grants')).toBeUndefined();
    expect(getProviderAdapters()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('grants store is unavailable'),
      expect.any(Object),
    );
  });

  test('does not import provider modules without providers.register grant', async () => {
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'untrusted-runtime',
      `globalThis.__untrustedProviderImported = true;
export default {
  provider: 'untrusted',
  metadata: {
    displayName: 'Untrusted Runtime',
    description: 'Should not import',
    capabilities: ['agent-runtime']
  },
  ${ADAPTER_METHODS}
};`,
      false,
    );

    await loadRuntimePluginProviders({
      logger: createLogger(),
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    });

    expect(getProviderAdapter('untrusted')).toBeUndefined();
    expect((globalThis as any).__untrustedProviderImported).toBeUndefined();
  });

  test('excludes ungranted plugins before singleton provider conflict resolution', async () => {
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'granted-auth',
      `export default {
  getStatus: async () => ({ authenticated: true })
};`,
      true,
      'auth',
    );
    writePlugin(
      pluginsDir,
      'ungranted-auth',
      `globalThis.__ungrantedSingletonImported = true;
export default {
  getStatus: async () => ({ authenticated: false })
};`,
      false,
      'auth',
    );

    await loadRuntimePluginProviders({
      logger: createLogger(),
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    });

    expect(getProvider('auth')).toBeDefined();
    expect((globalThis as any).__ungrantedSingletonImported).toBeUndefined();
  });

  test('retains the active plugin generation when replacement staging fails', async () => {
    const logger = createLogger();
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'custom-runtime',
      `export default {
        provider: 'custom',
        metadata: {
          displayName: 'Stable Runtime',
          description: 'Stable plugin adapter',
          capabilities: ['agent-runtime']
        },
        ${ADAPTER_METHODS}
      };`,
    );
    const context = {
      logger,
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    };
    await loadRuntimePluginProviders(context);
    const stable = getProviderAdapter('custom');
    writeFileSync(
      join(pluginsDir, 'custom-runtime', 'broken.mjs'),
      `export default { provider: 'custom', metadata: { displayName: 'Broken' } };`,
    );
    writeFileSync(
      join(pluginsDir, 'custom-runtime', 'plugin.json'),
      JSON.stringify({
        name: 'custom-runtime',
        version: '1.0.0',
        providers: [{ type: 'providerAdapter', module: './broken.mjs' }],
      }),
    );

    await loadRuntimePluginProviders(context);

    expect(getProviderAdapter('custom')).toBe(stable);
    expect(logger.error).toHaveBeenCalledWith(
      'Invalid plugin provider adapter shape',
      { plugin: 'custom-runtime', type: 'providerAdapter' },
    );
  });

  test('retains the active plugin generation when a replacement factory throws', async () => {
    const logger = createLogger();
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'custom-runtime',
      `export default {
        provider: 'custom',
        metadata: {
          displayName: 'Stable Runtime',
          description: 'Stable plugin adapter',
          capabilities: ['agent-runtime']
        },
        ${ADAPTER_METHODS}
      };`,
    );
    const context = {
      logger,
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    };
    await loadRuntimePluginProviders(context);
    const stable = getProviderAdapter('custom');
    writeFileSync(
      join(pluginsDir, 'custom-runtime', 'adapter.mjs'),
      `export default () => { throw new Error('factory failed'); };`,
    );

    await loadRuntimePluginProviders(context);

    expect(getProviderAdapter('custom')).toBe(stable);
    expect(logger.error).toHaveBeenCalledWith('Plugin provider factory threw', {
      plugin: 'custom-runtime',
      type: 'providerAdapter',
      error: 'factory failed',
    });
  });

  test('stops adapters staged before a later provider fails', async () => {
    const cleanupKey = Symbol.for('station.test.staged-plugin-cleanup');
    Reflect.deleteProperty(globalThis, cleanupKey);
    const logger = createLogger();
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'adapter-a',
      `export default {
        provider: 'custom-a',
        metadata: {
          displayName: 'Staged Runtime',
          description: 'Staged plugin adapter',
          capabilities: ['agent-runtime']
        },
        ${ADAPTER_METHODS.replace(
          'stopAll: async () => undefined',
          "stopAll: async () => { globalThis[Symbol.for('station.test.staged-plugin-cleanup')] = 1; }",
        )}
      };`,
    );
    writePlugin(
      pluginsDir,
      'bad-runtime',
      `export default { provider: 'custom-b', metadata: { displayName: 'Bad' } };`,
    );

    await loadRuntimePluginProviders({
      logger,
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    });

    expect(Reflect.get(globalThis, cleanupKey)).toBe(1);
    expect(getProviderAdapter('custom-a')).toBeUndefined();
    Reflect.deleteProperty(globalThis, cleanupKey);
  });

  test('removes stale plugin adapters when the plugins directory disappears', async () => {
    const pluginsDir = join(projectHomeDir, 'plugins');
    writePlugin(
      pluginsDir,
      'custom-runtime',
      `export default {
        provider: 'custom',
        metadata: {
          displayName: 'Custom Runtime',
          description: 'Plugin-provided runtime adapter',
          capabilities: ['agent-runtime']
        },
        ${ADAPTER_METHODS}
      };`,
    );
    const context = {
      logger: createLogger(),
      projectHomeDir,
      loadPluginOverrides: vi.fn(async () => ({})),
    };

    await loadRuntimePluginProviders(context);
    expect(getProviderAdapter('custom')).toBeDefined();

    rmSync(pluginsDir, { recursive: true, force: true });
    await loadRuntimePluginProviders(context);

    expect(getProviderAdapter('custom')).toBeUndefined();
  });
});

describe('loadRuntimePluginPrompts', () => {
  let projectHomeDir: string;

  beforeEach(() => {
    projectHomeDir = mkdtempSync(join(tmpdir(), 'runtime-plugin-prompts-'));
    process.env.STATION_HOME = projectHomeDir;
  });

  afterEach(() => {
    delete process.env.STATION_HOME;
    rmSync(projectHomeDir, { recursive: true, force: true });
  });

  test('skips prompt sources that escape the plugin root', async () => {
    const logger = createLogger();
    const pluginDir = join(projectHomeDir, 'plugins', 'escape-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'escape-plugin',
        version: '1.0.0',
        prompts: { source: '../outside' },
      }),
    );

    await loadRuntimePluginPrompts({ logger, projectHomeDir });

    expect(logger.warn).toHaveBeenCalledWith(
      'Skipped invalid plugin prompts during prompt load',
      {
        error: expect.stringMatching(/Plugin prompts source escapes root/),
        plugin: 'escape-plugin',
      },
    );
  });
});
