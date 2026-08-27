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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getProviderAdapterRegistrationProvenance } from '../../../providers/adapter-shape.js';
import {
  clearAll,
  getProvider,
  getProviderAdapter,
  getProviderAdapters,
} from '../../../providers/registries/registry.js';
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
    rmSync(projectHomeDir, { recursive: true, force: true });
  });

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
      'Plugin grants store unavailable; denying permission check',
      expect.objectContaining({
        path: grantsPath,
        plugin: 'corrupt-grants-runtime',
        permission: 'providers.register',
      }),
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
