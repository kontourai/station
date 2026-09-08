import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { PluginIncarnationError } from '../../../services/plugins/plugin-incarnation.js';
import { hasGrant } from '../../../services/plugins/plugin-permissions.js';

// This route unit fixture replaces the filesystem/process probes. The shared
// lifecycle suite separately exercises real publication/content-lock ordering.
vi.mock('@kontourai/station-shared/lifecycle-events', async (original) => ({
  ...(await original<
    typeof import('@kontourai/station-shared/lifecycle-events')
  >()),
  acquireFileMutationLockAsync: vi.fn(async () => async () => {}),
}));

vi.mock('../../../telemetry/metrics.js', () => ({
  pluginInstalls: { add: vi.fn() },
  pluginUninstalls: { add: vi.fn() },
  pluginUpdates: { add: vi.fn() },
  pluginSettingsUpdates: { add: vi.fn() },
}));

const clearPluginProviders = vi.hoisted(() => vi.fn());
const replacePluginProviders = vi.hoisted(() => vi.fn());
const replacePluginProvidersForSource = vi.hoisted(() => vi.fn());
const replacePluginProvidersForSourceGeneration = vi.hoisted(() =>
  vi.fn(async () => 'activated' as const),
);
const pluginProviderSourceGeneration = vi.hoisted(() => vi.fn(() => 1));
const retirePluginProvidersForSourceGeneration = vi.hoisted(() =>
  vi.fn(async () => 'retired' as const),
);
const withPluginProviderSourceGeneration = vi.hoisted(() =>
  vi.fn(
    async (_source: string, _generation: number, operation: () => unknown) => ({
      kind: 'applied' as const,
      value: await operation(),
    }),
  ),
);
const agentRegistryProvider = vi.hoisted(() => ({
  install: vi.fn().mockResolvedValue({ success: true }),
  listAvailable: vi.fn().mockResolvedValue([]),
  listInstalled: vi.fn().mockResolvedValue([]),
}));
const pluginRegistryProvider = vi.hoisted(() => ({
  install: vi.fn().mockResolvedValue({ success: true }),
  listAvailable: vi.fn().mockResolvedValue([]),
  listInstalled: vi.fn().mockResolvedValue([]),
  update: vi.fn().mockResolvedValue({ success: true }),
}));
const alternatePluginRegistryProvider = vi.hoisted(() => ({
  install: vi.fn().mockResolvedValue({ success: true }),
  listAvailable: vi.fn().mockResolvedValue([]),
  listInstalled: vi.fn().mockResolvedValue([]),
  update: vi.fn().mockResolvedValue({ success: true }),
}));
const pluginRegistryProviderEntries = vi.hoisted<
  Array<{ provider: any; source: string }>
>(() => []);
vi.mock('../../../providers/registries/registry.js', () => ({
  disposePreparedPluginProviders: vi.fn(async () => {}),
  clearPluginProviders,
  replacePluginProviders,
  replacePluginProvidersForSource,
  replacePluginProvidersForSourceGeneration,
  pluginProviderSourceGeneration,
  pluginProviderRegistryGeneration: vi.fn(() => 1),
  retirePluginProvidersForSourceGeneration,
  withPluginProviderSourceGeneration,
  getAgentRegistryProvider: vi.fn().mockReturnValue(agentRegistryProvider),
  getIntegrationRegistryProvider: vi
    .fn()
    .mockReturnValue({ listInstalled: vi.fn().mockResolvedValue([]) }),
  getPluginRegistryProviders: vi.fn(() => pluginRegistryProviderEntries),
}));

const loadPluginProviders = vi.hoisted(() => vi.fn().mockResolvedValue(0));
const preparePluginProviders = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../plugin-loader.js', () => ({
  loadPluginProviders,
  preparePluginProviders,
}));

// The scanner the install/lifecycle routes actually call. It used to be
// `plugin-prompt-generation.js`, which was DELETED with the copy-into-a-store
// lifecycle; this suite kept mocking that path, so it controlled nothing and
// the real scanner ran against every fixture (review M3).
const scanPluginPromptGeneration = vi.hoisted(() =>
  vi.fn().mockReturnValue([]),
);
const scanPluginCommandSkills = vi.hoisted(() => vi.fn().mockReturnValue([]));
const scanPluginPromptFileSafety = vi.hoisted(() =>
  vi.fn().mockReturnValue([]),
);
vi.mock('../../../services/plugins/plugin-command-skill-source.js', () => ({
  scanPluginPromptGeneration,
  scanPluginCommandSkills,
  scanPluginPromptFileSafety,
}));

const execGit = vi.hoisted(() => vi.fn().mockResolvedValue({ stdout: '' }));
vi.mock('../../../utils/git-exec.js', () => ({ execGit }));

// Spied, not replaced: everything else in this module (the content lock the
// update route runs inside) stays real.
//
// `computePluginContentDigest` is the one exception. The installed-plugin
// readers (`readPluginCatalogInstallation`, `capturePluginRuntimeArtifact`)
// now treat a plugin whose tree has no digest as absent, and the real digest
// walks `readdirSync(..., { encoding: 'buffer' })` — this fixture's
// string-named dirents can never hash, so every route would read the fixture
// plugin as "absent or not ready". The value matches the digest the mocked
// grant derivation below already declares for the same tree.
const forgetPluginContentDigest = vi.hoisted(() => vi.fn());
const computePluginContentDigest = vi.hoisted(() =>
  vi.fn().mockReturnValue('sha256:test'),
);
vi.mock(
  '../../../services/plugins/plugin-content-integrity.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../services/plugins/plugin-content-integrity.js')
    >()),
    computePluginContentDigest,
    computePluginContentDigestAsync: async (...args: unknown[]) =>
      computePluginContentDigest(...args),
    observePluginContentAsync: async (directory: string, name: string) => ({
      digest: computePluginContentDigest(directory, name),
      manifestText: readFileSync(`${directory}/${name}/plugin.json`, 'utf8'),
    }),
    forgetPluginContentDigest,
  }),
);

const rebindGrantsAfterContentChange = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ retained: [], withdrawn: [] }),
);
const snapshotPluginGrantEntry = vi.hoisted(() =>
  vi.fn().mockReturnValue(null),
);
const restorePluginGrantEntry = vi.hoisted(() => vi.fn());
// The update route opens one grant mutation scope per update and closes it
// with `commit()` on success or `rollback()` on failure; this fixture stands
// in for the receipt-owning scope so the suite can pin which branch ran.
const pluginGrantScope = vi.hoisted(() => ({
  revision: 'fixture-grant-revision',
  run: vi.fn(async (operation: () => Promise<unknown>) => operation()),
  commit: vi.fn(),
  rollback: vi.fn(async () => ({ state: 'restored' as const })),
}));
const createPluginGrantMutationScope = vi.hoisted(() =>
  vi.fn(() => pluginGrantScope),
);
// Fully replaced, never spread from the original: every grant read in this
// unit fixture is a declared derivation, and an unmocked export that the
// routes reach fails loudly instead of running the real grants store against
// the mocked filesystem.
vi.mock('../../../services/plugins/plugin-permissions.js', () => ({
  createPluginGrantMutationScope,
  observePluginGrantRevisions: vi.fn(() => ({
    revisionFor: vi.fn(() => 'fixture-grant-revision'),
  })),
  readPluginGrantRevision: vi.fn(() => 'fixture-grant-revision'),
  withPluginProviderGrantSnapshot: vi.fn(
    async (_home: string, resolve: () => unknown) => ({
      snapshot: 'fixture-grant-snapshot',
      value: resolve(),
    }),
  ),
  withPluginProviderGrantsPublication: vi.fn(
    async (
      _home: string,
      names: string[],
      publish: (granted: Set<string>) => unknown,
    ) => publish(new Set(names)),
  ),
  getPermissionTier: vi.fn().mockReturnValue('standard'),
  getPluginGrants: vi.fn().mockReturnValue(['network']),
  grantPermissions: vi.fn(),
  hasGrant: vi.fn().mockReturnValue(true),
  processInstallPermissions: vi.fn(),
  // archive#4288: the list route reads the derivation, not the raw entry.
  readPluginGrantState: vi.fn().mockReturnValue({
    recorded: ['network'],
    granted: ['network'],
    withheld: [],
    binding: 'bound',
    recordedDigest: 'sha256:test',
    currentDigest: 'sha256:test',
  }),
  readPluginGrantRecord: vi.fn().mockReturnValue({
    permissions: ['network'],
    contentDigest: 'sha256:test',
  }),
  describePluginGrantState: vi.fn().mockReturnValue({
    recorded: ['network'],
    granted: ['network'],
    withheld: [],
    binding: 'bound',
    recordedDigest: 'sha256:test',
    currentDigest: 'sha256:test',
  }),
  readPluginGrantStateAsync: vi.fn().mockResolvedValue({
    recorded: ['network'],
    granted: ['network'],
    withheld: [],
    binding: 'bound',
    recordedDigest: 'sha256:test',
    currentDigest: 'sha256:test',
  }),
  rebindGrantsAfterContentChange,
  requiredPermissionsForManifest: vi.fn((manifest: any) => [
    ...(manifest.permissions || []),
    ...(manifest.providers?.length ? ['providers.register'] : []),
    ...(manifest.serverModule ? ['plugin.server'] : []),
  ]),
  restorePluginGrantEntry,
  revokeAllGrants: vi.fn(),
  readPluginDependencyOwnership: vi.fn().mockReturnValue([]),
  removePluginHostRecord: vi.fn().mockResolvedValue(undefined),
  snapshotPluginGrantEntry,
  PluginGrantsUnavailableError: class PluginGrantsUnavailableError extends Error {},
  PluginContentUnavailableError: class PluginContentUnavailableError extends Error {},
  PluginGrantMutationSupersededError: class PluginGrantMutationSupersededError extends Error {},
}));

const mockManifest = vi.hoisted(() => ({
  name: 'test-plugin',
  displayName: 'Test Plugin',
  version: '1.0.0',
  description: 'A test plugin',
  permissions: ['network'],
  settings: [
    {
      key: 'displayLabel',
      label: 'Display Label',
      type: 'string',
      default: 'default-val',
    },
    {
      key: 'secretToken',
      label: 'Secret Token',
      type: 'string',
      secret: true,
    },
  ],
  providers: [{ type: 'test-provider', module: 'provider.js' }],
  layout: { slug: 'test-layout', source: 'layout.js' },
  agents: [],
  links: null,
}));
const mockRegistryInstallAliases = vi.hoisted<
  Record<string, { pluginName: string; registryKey: string }>
>(() => ({}));
// What every synchronous read of the fixture plugin's plugin.json returns.
// The list route reads the manifest more than once per request (a display
// pass and the final projection), so a malformed manifest must stay
// malformed for the whole request, not for one read.
const manifestFileText = vi.hoisted(() => ({
  override: null as string | null,
}));
const enoent = vi.hoisted(
  () => (syscall: string, path: string) =>
    Object.assign(
      new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`),
      {
        code: 'ENOENT',
        syscall,
        path,
      },
    ),
);
// `lstatSync` must agree with whatever `existsSync` a test declares: the
// installed-root resolver lstat's a candidate path BEFORE the update route
// resolves registry aliases, and a stat that answers "directory" for a path
// `existsSync` calls absent captures a phantom install.
const lstatFixture = vi.hoisted(
  () => (exists: (path: string) => boolean) => (path: unknown) => {
    if (!exists(String(path))) throw enoent('lstat', String(path));
    return {
      isSymbolicLink: () => false,
      isDirectory: () => !String(path).endsWith('.json'),
      isFile: () => String(path).endsWith('.json'),
    };
  },
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = vi.fn((p: string) => {
    if (typeof p === 'string' && p.endsWith('/config/registry-installs.json')) {
      return Object.keys(mockRegistryInstallAliases).length > 0;
    }
    if (typeof p === 'string' && p.includes('nonexistent')) return false;
    if (typeof p === 'string' && p.includes('plugins')) return true;
    if (typeof p === 'string' && p.includes('dist/bundle')) return true;
    return false;
  });
  return {
    ...actual,
    existsSync,
    readdirSync: vi.fn().mockReturnValue([
      {
        name: 'test-plugin',
        isDirectory: () => true,
        isSymbolicLink: () => false,
      },
    ]),
    // Real JSON-schema reads (e.g. the domain validator's
    // `schemas/*.schema.json` singleton, transitively pulled in by
    // `config-loader-agents.js`'s `owningProjectExists` reuse — archive#1004
    // review HIGH-1) must reach the real file, never the plugin-manifest
    // fixture below, or AJV compiles the fixture's shape as a schema and
    // throws "unknown keyword".
    readFileSync: vi.fn((p: unknown, enc?: unknown) => {
      if (typeof p === 'string' && p.includes('.schema.json')) {
        return actual.readFileSync(p, enc as any);
      }
      if (
        typeof p === 'string' &&
        p.endsWith('/config/registry-installs.json')
      ) {
        return JSON.stringify(mockRegistryInstallAliases);
      }
      return manifestFileText.override ?? JSON.stringify(mockManifest);
    }),
    lstatSync: vi.fn(lstatFixture((path) => existsSync(path))),
    // No fixture path is a symbolic link unless a test says so through
    // `lstatSync`; a test that does must also answer the link's target here.
    readlinkSync: vi.fn((path: unknown) => {
      throw enoent('readlink', String(path));
    }),
    realpathSync: vi.fn((p: string) => p),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    cpSync: vi.fn(),
    writeFileSync: vi.fn(),
    // Alias removal now uses the canonical atomic writer. This unit fixture
    // mocks its staging write too, so publishing must not touch real /tmp.
    renameSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([
    {
      name: 'test-plugin',
      isDirectory: () => true,
      isSymbolicLink: () => false,
    },
  ]),
  readFile: vi.fn().mockResolvedValue(JSON.stringify(mockManifest)),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: any,
      cb: (
        error: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => cb(null, { stdout: '', stderr: '' }),
  ),
}));

vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();
  return {
    ...actual,
    promisify: () => vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  };
});

vi.mock('@kontourai/station-shared/build', () => ({
  buildPlugin: vi.fn().mockResolvedValue({ built: false }),
}));
vi.mock('@kontourai/station-shared/parsers', () => ({
  copyPluginIntegrations: vi.fn(),
}));

const mockOverrides: Record<string, any> = {};
vi.mock('../../../domain/config-loader.js', () => ({
  ConfigLoader: vi.fn().mockImplementation(function MockConfigLoader() {
    return {
      loadPluginOverrides: vi.fn().mockResolvedValue(mockOverrides),
      savePluginOverrides: vi
        .fn()
        .mockImplementation(async (o: any) => Object.assign(mockOverrides, o)),
    };
  }),
}));

const { createPluginRoutes } = await import('../plugins.js');

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const eventBus = { emit: vi.fn() };

function setup(runtime?: {
  applyConfigurationMutation: any;
  settleProviderAdapterRetirements: () => Promise<void>;
}) {
  return createPluginRoutes(
    '/tmp/project',
    logger as any,
    eventBus as any,
    runtime,
  );
}

describe('Plugin Routes', () => {
  // Reset the shared overrides store between tests — the PUT /overrides test
  // mutates this module-level object, which leaked into GET /providers (the
  // provider's `enabled` flag) when tests ran in a different order.
  beforeEach(() => {
    clearPluginProviders.mockClear();
    replacePluginProviders.mockClear();
    replacePluginProvidersForSource.mockClear();
    agentRegistryProvider.install.mockClear();
    agentRegistryProvider.listAvailable.mockClear();
    agentRegistryProvider.listInstalled.mockClear();
    pluginRegistryProvider.install.mockClear();
    pluginRegistryProvider.listAvailable.mockClear();
    pluginRegistryProvider.listInstalled.mockClear();
    pluginRegistryProvider.update.mockClear();
    alternatePluginRegistryProvider.install.mockClear();
    alternatePluginRegistryProvider.listAvailable.mockClear();
    alternatePluginRegistryProvider.listInstalled.mockClear();
    alternatePluginRegistryProvider.update.mockClear();
    pluginRegistryProviderEntries.splice(
      0,
      pluginRegistryProviderEntries.length,
      {
        provider: pluginRegistryProvider,
        source: 'test-plugin-registry',
      },
    );
    loadPluginProviders.mockClear();
    rebindGrantsAfterContentChange.mockClear();
    rebindGrantsAfterContentChange.mockResolvedValue({
      retained: [],
      withdrawn: [],
    });
    snapshotPluginGrantEntry.mockClear();
    snapshotPluginGrantEntry.mockReturnValue(null);
    restorePluginGrantEntry.mockClear();
    forgetPluginContentDigest.mockClear();
    scanPluginPromptGeneration.mockClear();
    scanPluginCommandSkills.mockClear();
    scanPluginPromptFileSafety.mockClear();
    execGit.mockClear();
    vi.mocked(cpSync).mockClear();
    vi.mocked(rmSync).mockClear();
    vi.mocked(existsSync).mockImplementation((p) => {
      if (
        typeof p === 'string' &&
        p.endsWith('/config/registry-installs.json')
      ) {
        return Object.keys(mockRegistryInstallAliases).length > 0;
      }
      if (typeof p === 'string' && p.includes('nonexistent')) return false;
      if (typeof p === 'string' && p.includes('plugins')) return true;
      if (typeof p === 'string' && p.includes('dist/bundle')) return true;
      return false;
    });
    vi.mocked(lstatSync).mockImplementation(
      lstatFixture((path) => existsSync(path)) as any,
    );
    vi.mocked(readlinkSync).mockImplementation((path: unknown) => {
      throw enoent('readlink', String(path));
    });
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockManifest));
    manifestFileText.override = null;
    pluginGrantScope.run.mockClear();
    pluginGrantScope.commit.mockClear();
    pluginGrantScope.rollback.mockClear();
    createPluginGrantMutationScope.mockClear();
    for (const key of Object.keys(mockOverrides)) {
      delete mockOverrides[key];
    }
    for (const key of Object.keys(mockRegistryInstallAliases)) {
      delete mockRegistryInstallAliases[key];
    }
  });

  test('POST /reload clears stale providers even when the plugins directory is absent', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const app = setup();

    const body = await json(await app.request('/reload', { method: 'POST' }));

    expect(body).toEqual({ success: true, loaded: 0 });
    expect(replacePluginProviders).toHaveBeenCalledWith(
      [],
      expect.any(Function),
    );
  });

  test('rejects a plugin identity change and restores the prior provider source', async () => {
    const oldManifest = { ...mockManifest, name: 'test-plugin' };
    const renamedManifest = { ...mockManifest, name: 'renamed-plugin' };
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify(oldManifest))
      .mockResolvedValueOnce(JSON.stringify(renamedManifest));
    const beginMutation = vi.fn();
    const applyConfigurationMutation = vi.fn(
      async (operation, _options?: unknown) =>
        operation(beginMutation, { status: 'applied' }),
    );
    const settleProviderAdapterRetirements = vi
      .fn()
      .mockResolvedValue(undefined);
    const app = setup({
      applyConfigurationMutation,
      settleProviderAdapterRetirements,
    });

    const response = await app.request('/test-plugin/update', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining('identity cannot change'),
    });
    expect(applyConfigurationMutation.mock.calls[0]?.[1]).toEqual({
      rediscoverSkills: true,
    });
    expect(beginMutation).toHaveBeenCalledOnce();
    expect(loadPluginProviders).toHaveBeenCalledWith(
      '/tmp/project/plugins',
      'test-plugin',
      oldManifest,
      logger,
      { strict: true },
    );
    expect(loadPluginProviders).not.toHaveBeenCalledWith(
      expect.anything(),
      'renamed-plugin',
      expect.anything(),
      expect.anything(),
    );
    expect(settleProviderAdapterRetirements).toHaveBeenCalledOnce();
  });

  test('captures each update rollback snapshot only after its configuration lease starts', async () => {
    let releasePull!: () => void;
    const blockedPull = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    execGit.mockImplementationOnce(() => blockedPull);
    let queue = Promise.resolve();
    const applyConfigurationMutation = vi.fn((operation) => {
      const result = queue.then(() =>
        operation(vi.fn(), { status: 'applied' }),
      );
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    const app = setup({
      applyConfigurationMutation,
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const first = app.request('/test-plugin/update', { method: 'POST' });
    await vi.waitFor(() => expect(execGit).toHaveBeenCalledOnce());
    const second = app.request('/test-plugin/update', { method: 'POST' });
    await Promise.resolve();
    expect(cpSync).toHaveBeenCalledTimes(1);

    releasePull();
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(cpSync).toHaveBeenCalledTimes(2);
  });

  test('updates non-Git plugins through the plugin registry without touching the agent registry', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/test-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      { id: 'test-plugin', version: '1.0.0', installed: true },
    ]);
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/test-plugin/update', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true });
    expect(pluginRegistryProvider.update).toHaveBeenCalledWith('test-plugin');
    expect(pluginRegistryProvider.install).not.toHaveBeenCalled();
    expect(agentRegistryProvider.install).not.toHaveBeenCalled();
    expect(agentRegistryProvider.listAvailable).not.toHaveBeenCalled();
    expect(agentRegistryProvider.listInstalled).not.toHaveBeenCalled();
  });

  /**
   * archive#4288: consent belongs to the bytes it was given for, so an update
   * must re-bind BEFORE anything reads a grant from the replaced tree. The
   * ordering is the load-bearing part — a re-bind after `loadPluginProviders`
   * would still let the new code register providers under the old consent.
   */
  test('station#4288: an update re-binds consent before the first grant read, and reports what it withdrew', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/test-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      { id: 'test-plugin', version: '1.0.0', installed: true },
    ]);
    const order: string[] = [];
    rebindGrantsAfterContentChange.mockImplementation(async () => {
      order.push('rebind');
      return { retained: ['navigation.dock'], withdrawn: ['plugin.server'] };
    });
    loadPluginProviders.mockImplementation(async () => {
      order.push('loadProviders');
      return 0;
    });
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/test-plugin/update', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(rebindGrantsAfterContentChange).toHaveBeenCalledWith(
      '/tmp/project',
      'test-plugin',
      expect.objectContaining({ name: 'test-plugin' }),
    );
    expect(order).toEqual(['rebind', 'loadProviders']);
    // Named in the response, so a plugin that lost a capability is never
    // silently diminished.
    expect(body).toMatchObject({
      permissions: {
        withdrawn: ['plugin.server'],
        retained: ['navigation.dock'],
      },
    });
    expect(eventBus.emit).toHaveBeenCalledWith('plugins:grants-changed', {
      name: 'test-plugin',
    });
  });

  test('station#4288: a failed update rolls back the grant scope it opened, after the re-bind', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/test-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      { id: 'test-plugin', version: '1.0.0', installed: true },
    ]);
    const order: string[] = [];
    rebindGrantsAfterContentChange.mockImplementation(async () => {
      order.push('rebind');
      return { retained: [], withdrawn: ['plugin.server'] };
    });
    pluginGrantScope.rollback.mockImplementation(async () => {
      order.push('rollback');
      return { state: 'restored' as const };
    });
    // Fail AFTER the re-bind has already withdrawn consent.
    loadPluginProviders.mockRejectedValueOnce(new Error('provider blew up'));
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/test-plugin/update', {
      method: 'POST',
    });

    expect(response.status).toBe(500);
    // The tree went back to the reviewed bytes, so the consent recorded
    // against them goes back too: the route owns exactly one grant mutation
    // scope for the update, opened against the revision it observed before
    // touching anything, and it rolls that scope back (never commits it)
    // after the re-bind withdrew consent.
    expect(createPluginGrantMutationScope).toHaveBeenCalledWith(
      '/tmp/project',
      'test-plugin',
      { expectedRevision: 'fixture-grant-revision' },
    );
    expect(pluginGrantScope.rollback).toHaveBeenCalledOnce();
    expect(pluginGrantScope.commit).not.toHaveBeenCalled();
    expect(order).toEqual(['rebind', 'rollback']);
  });

  /**
   * archive#4288, delta review MEDIUM 1 — the same defect the install
   * rollback carries, found in this route while fixing that one.
   * `rebindGrantsAfterContentChange` refreshes the memoized digest to the
   * UPDATED tree's value. The rollback then restores the OLD tree and the old
   * grant record, and reads `hasGrant(..., 'providers.register')` — which,
   * against a memo still holding the updated tree's digest, derives `changed`
   * and reloads the restored plugin with no providers at all. A failed update
   * would silently unregister a working plugin's providers until a restart.
   *
   * The memo is process-global, so this pins the ORDER: the rollback drops it
   * before the read that would otherwise answer from it.
   */
  test('station#4288: a failed update drops the memoized digest before the rollback reads a grant', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/test-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      { id: 'test-plugin', version: '1.0.0', installed: true },
    ]);
    const order: string[] = [];
    forgetPluginContentDigest.mockImplementation(() => {
      order.push('forget');
    });
    vi.mocked(hasGrant).mockImplementation(() => {
      order.push('hasGrant');
      return true;
    });
    // Fails after the re-bind, so the rollback is the only path left.
    loadPluginProviders.mockRejectedValueOnce(new Error('provider blew up'));
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/test-plugin/update', {
      method: 'POST',
    });

    expect(response.status).toBe(500);
    expect(forgetPluginContentDigest).toHaveBeenCalledWith(
      '/tmp/project/plugins',
      'test-plugin',
    );
    // The forget belongs to the rollback and must precede its grant read.
    expect(order.indexOf('forget')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('forget')).toBeLessThan(order.lastIndexOf('hasGrant'));
    vi.mocked(hasGrant).mockReturnValue(true);
  });

  // Proves the mock above is bound to the seam the routes actually call. A
  // mock pointed at a module nothing imports is indistinguishable from a
  // working one until you make it misbehave and nothing changes (review M3).
  test('a plugin update runs the plugin-command-skill scanner this suite controls', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/test-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      { id: 'test-plugin', version: '1.0.0', installed: true },
    ]);
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    await app.request('/test-plugin/update', { method: 'POST' });

    expect(scanPluginPromptGeneration).toHaveBeenCalled();
  });

  test('a scanner refusal fails the update instead of being scanned around', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/test-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      { id: 'test-plugin', version: '1.0.0', installed: true },
    ]);
    scanPluginPromptGeneration.mockImplementationOnce(() => {
      throw new Error('context-safety refusal');
    });
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/test-plugin/update', {
      method: 'POST',
    });

    expect(response.status).not.toBe(200);
    expect((await json(response)).success).toBe(false);
  });

  test('updates aliased registry plugins by installed name while calling the provider registry id', async () => {
    const aliasedManifest = { ...mockManifest, name: 'actual-plugin' };
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/registry-plugin')) return false;
      if (p.includes('/plugins/actual-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      {
        id: 'registry-plugin',
        installedPluginName: 'actual-plugin',
        version: '1.0.0',
        installed: true,
      },
    ]);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(aliasedManifest));
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/actual-plugin/update', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true });
    expect(pluginRegistryProvider.update).toHaveBeenCalledWith(
      'registry-plugin',
    );
    expect(pluginRegistryProvider.update).not.toHaveBeenCalledWith(
      'actual-plugin',
    );
    expect(loadPluginProviders).toHaveBeenCalledWith(
      '/tmp/project/plugins',
      'actual-plugin',
      aliasedManifest,
      logger,
      { strict: true },
    );
    expect(agentRegistryProvider.install).not.toHaveBeenCalled();
  });

  test('updates aliased registry plugins by registry id while targeting the installed plugin directory', async () => {
    const aliasedManifest = { ...mockManifest, name: 'actual-plugin' };
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/registry-plugin')) return false;
      if (p.includes('/plugins/actual-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      {
        id: 'registry-plugin',
        installedPluginName: 'actual-plugin',
        version: '1.0.0',
        installed: true,
      },
    ]);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(aliasedManifest));
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/registry-plugin/update', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(cpSync).toHaveBeenCalledWith(
      '/tmp/project/plugins/actual-plugin',
      expect.any(String),
      // archive#4288: `verbatimSymlinks` is load-bearing, not cosmetic — see
      // `PLUGIN_TREE_COPY`. Without it the backup resolves relative symlinks
      // to absolute paths, so restoring it produces a tree with a different
      // content digest and a rolled-back update strips every permission.
      { recursive: true, verbatimSymlinks: true },
    );
    expect(pluginRegistryProvider.update).toHaveBeenCalledWith(
      'registry-plugin',
    );
    expect(loadPluginProviders).toHaveBeenCalledWith(
      '/tmp/project/plugins',
      'actual-plugin',
      aliasedManifest,
      logger,
      { strict: true },
    );
  });

  test('rejects registry id routes when the id also names a different installed plugin directory', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/registry-plugin')) return true;
      if (p.includes('/plugins/actual-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      {
        id: 'registry-plugin',
        installedPluginName: 'actual-plugin',
        version: '1.0.0',
        installed: true,
      },
    ]);
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/registry-plugin/update', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining(
        "but plugin 'registry-plugin' also exists",
      ),
    });
    expect(cpSync).not.toHaveBeenCalled();
    expect(pluginRegistryProvider.update).not.toHaveBeenCalled();
    expect(pluginRegistryProvider.install).not.toHaveBeenCalled();
  });

  test('rejects aliased registry updates when the provider only exposes install fallback', async () => {
    const fallbackRegistryProvider = {
      install: vi.fn().mockResolvedValue({ success: true }),
      listAvailable: vi.fn().mockResolvedValue([]),
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'registry-plugin',
          installedPluginName: 'actual-plugin',
          version: '1.0.0',
          installed: true,
        },
      ]),
    };
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/registry-plugin')) return false;
      if (p.includes('/plugins/actual-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProviderEntries.splice(
      0,
      pluginRegistryProviderEntries.length,
      {
        provider: fallbackRegistryProvider,
        source: 'json-plugin-registry',
      },
    );
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/actual-plugin/update', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining('cannot update aliased plugin'),
    });
    expect(fallbackRegistryProvider.install).not.toHaveBeenCalled();
    expect(loadPluginProviders).not.toHaveBeenCalled();
  });

  test('rejects ambiguous non-Git plugin updates before touching registry providers', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/test-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      { id: 'test-plugin', version: '1.0.0', installed: true },
    ]);
    alternatePluginRegistryProvider.listInstalled.mockResolvedValue([
      { id: 'test-plugin', version: '1.0.0', installed: true },
    ]);
    pluginRegistryProviderEntries.splice(
      0,
      pluginRegistryProviderEntries.length,
      { provider: pluginRegistryProvider, source: 'test-plugin-registry' },
      {
        provider: alternatePluginRegistryProvider,
        source: 'alternate-plugin-registry',
      },
    );
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/test-plugin/update', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining('multiple plugin registry providers'),
    });
    expect(pluginRegistryProvider.update).not.toHaveBeenCalled();
    expect(pluginRegistryProvider.install).not.toHaveBeenCalled();
    expect(alternatePluginRegistryProvider.update).not.toHaveBeenCalled();
    expect(alternatePluginRegistryProvider.install).not.toHaveBeenCalled();
    expect(agentRegistryProvider.install).not.toHaveBeenCalled();
  });

  test('rejects same-provider registry id and installed-name collisions before touching registry providers', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/bar')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      {
        id: 'foo',
        installedPluginName: 'bar',
        version: '1.0.0',
        installed: true,
      },
      {
        id: 'bar',
        installedPluginName: 'baz',
        version: '1.0.0',
        installed: true,
      },
    ]);
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/bar/update', { method: 'POST' });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining('multiple plugin registry providers'),
    });
    expect(cpSync).not.toHaveBeenCalled();
    expect(pluginRegistryProvider.update).not.toHaveBeenCalled();
    expect(pluginRegistryProvider.install).not.toHaveBeenCalled();
  });

  test('rejects duplicate installed target claims even when the request matches only one registry id', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/actual-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      {
        id: 'registry-a',
        installedPluginName: 'actual-plugin',
        version: '1.0.0',
        installed: true,
      },
    ]);
    alternatePluginRegistryProvider.listInstalled.mockResolvedValue([
      {
        id: 'registry-b',
        installedPluginName: 'actual-plugin',
        version: '1.0.0',
        installed: true,
      },
    ]);
    pluginRegistryProviderEntries.splice(
      0,
      pluginRegistryProviderEntries.length,
      { provider: pluginRegistryProvider, source: 'test-plugin-registry' },
      {
        provider: alternatePluginRegistryProvider,
        source: 'alternate-plugin-registry',
      },
    );
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/registry-a/update', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining('multiple plugin registry providers'),
    });
    expect(pluginRegistryProvider.update).not.toHaveBeenCalled();
    expect(pluginRegistryProvider.install).not.toHaveBeenCalled();
    expect(alternatePluginRegistryProvider.update).not.toHaveBeenCalled();
    expect(alternatePluginRegistryProvider.install).not.toHaveBeenCalled();
  });

  test('updates registry-owned Git-backed plugins through the owning registry provider', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/test-plugin/.git')) return true;
      if (p.includes('/plugins/test-plugin')) return true;
      if (p.includes('/dist/bundle')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      { id: 'test-plugin', version: '1.0.0', installed: true },
    ]);
    pluginRegistryProvider.update.mockResolvedValue({
      success: true,
      message: 'updated by registry',
    });
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/test-plugin/update', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true });
    expect(pluginRegistryProvider.update).toHaveBeenCalledWith('test-plugin');
    expect(execGit).not.toHaveBeenCalledWith(
      ['pull', '--ff-only'],
      expect.anything(),
    );
  });

  test('rejects updates when the installed plugin root is a symbolic link', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/test-plugin/.git')) return true;
      if (p.includes('/plugins/test-plugin')) return true;
      return false;
    });
    vi.mocked(lstatSync).mockReturnValue({
      isSymbolicLink: () => true,
    } as any);
    // A link that points anywhere but the host's own `.generations` layout.
    vi.mocked(readlinkSync).mockReturnValue('/elsewhere/test-plugin');
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/test-plugin/update', {
      method: 'POST',
    });
    const body = await json(response);

    // Without an installation journal the update target is captured through
    // `resolveInstalledPluginRoot`, which refuses any symlinked root that is
    // not a Station-owned incarnation pointer.
    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: new PluginIncarnationError('unsafe-pointer').message,
    });
    expect(cpSync).not.toHaveBeenCalled();
    expect(execGit).not.toHaveBeenCalled();
  });

  test('reports registry updates from provider-local installed versions', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/test-plugin')) return true;
      return false;
    });
    pluginRegistryProvider.listAvailable.mockResolvedValue([
      {
        id: 'test-plugin',
        displayName: 'Test Plugin',
        version: '2.0.0',
        source: 'registry',
        installed: false,
      },
    ]);
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      {
        id: 'test-plugin',
        displayName: 'Test Plugin',
        version: '1.0.0',
        source: 'registry',
        installed: true,
      },
    ]);
    const app = setup();

    const response = await app.request('/check-updates');
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      updates: [
        {
          name: 'test-plugin',
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
          source: 'registry',
        },
      ],
    });
  });

  test('reports aliased registry updates by installed plugin name', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('/.git')) return false;
      if (p.includes('nonexistent')) return false;
      if (p.includes('/plugins/actual-plugin')) return true;
      return false;
    });
    pluginRegistryProvider.listAvailable.mockResolvedValue([
      {
        id: 'registry-plugin',
        displayName: 'Actual Plugin',
        version: '2.0.0',
        source: 'registry',
        installed: false,
      },
    ]);
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      {
        id: 'registry-plugin',
        installedPluginName: 'actual-plugin',
        displayName: 'Actual Plugin',
        version: '1.0.0',
        source: 'registry',
        installed: true,
      },
    ]);
    const app = setup();

    const response = await app.request('/check-updates');
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      updates: [
        {
          name: 'actual-plugin',
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
          source: 'registry',
        },
      ],
    });
  });

  test('uninstall runs inside configuration activation and waits for adapter retirement', async () => {
    const beginMutation = vi.fn();
    const applyConfigurationMutation = vi.fn(
      async (operation, _options?: unknown) =>
        operation(beginMutation, { status: 'applied' }),
    );
    const settleProviderAdapterRetirements = vi
      .fn()
      .mockResolvedValue(undefined);
    const app = setup({
      applyConfigurationMutation,
      settleProviderAdapterRetirements,
    });

    const response = await app.request('/test-plugin', { method: 'DELETE' });

    await expect(json(response)).resolves.toEqual({ success: true });
    expect(response.status).toBe(200);
    expect(applyConfigurationMutation).toHaveBeenCalledOnce();
    expect(applyConfigurationMutation.mock.calls[0]?.[1]).toEqual({
      rediscoverSkills: true,
    });
    expect(beginMutation).toHaveBeenCalledOnce();
    expect(replacePluginProvidersForSource).toHaveBeenCalledWith(
      'test-plugin',
      [],
    );
    expect(settleProviderAdapterRetirements).toHaveBeenCalledOnce();
  });

  test('removes a direct local plugin without consulting an unavailable registry', async () => {
    pluginRegistryProvider.listInstalled.mockRejectedValue(
      new Error('unrelated registry is offline'),
    );
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    let response: Response;
    try {
      response = await app.request('/test-plugin', { method: 'DELETE' });
    } finally {
      pluginRegistryProvider.listInstalled.mockResolvedValue([]);
    }

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({ success: true });
    expect(pluginRegistryProvider.listInstalled).not.toHaveBeenCalled();
  });

  test('removes an aliased registry plugin by its validated installed target', async () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      if (typeof path !== 'string') return false;
      if (path.endsWith('/config/registry-installs.json')) return true;
      if (path.includes('/plugins/demo')) return false;
      if (path.includes('/plugins/actual-plugin')) return true;
      if (path.includes('plugins')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      {
        id: 'demo',
        installedPluginName: 'actual-plugin',
        version: '1.0.0',
        installed: true,
      },
    ]);
    mockRegistryInstallAliases.demo = {
      pluginName: 'actual-plugin',
      registryKey: 'test-plugin-registry',
    };
    const app = setup({
      applyConfigurationMutation: vi.fn(async (operation) =>
        operation(vi.fn(), { status: 'applied' }),
      ),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/demo', { method: 'DELETE' });

    expect(response.status, JSON.stringify(await json(response.clone()))).toBe(
      200,
    );
    expect(vi.mocked(rmSync)).toHaveBeenCalledWith(
      '/tmp/project/plugins/actual-plugin',
      { recursive: true, force: true },
    );
    expect(vi.mocked(rmSync)).not.toHaveBeenCalledWith(
      '/tmp/project/plugins/demo',
      expect.anything(),
    );
  });

  test('refuses an alias collision without deleting the rejected directory', async () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      if (typeof path !== 'string') return false;
      if (path.endsWith('/config/registry-installs.json')) return true;
      if (path.includes('/plugins/demo')) return true;
      if (path.includes('/plugins/actual-plugin')) return true;
      if (path.includes('plugins')) return true;
      return false;
    });
    pluginRegistryProvider.listInstalled.mockResolvedValue([
      {
        id: 'demo',
        installedPluginName: 'actual-plugin',
        version: '1.0.0',
        installed: true,
      },
    ]);
    mockRegistryInstallAliases.demo = {
      pluginName: 'actual-plugin',
      registryKey: 'test-plugin-registry',
    };
    const applyConfigurationMutation = vi.fn();
    const app = setup({
      applyConfigurationMutation,
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/demo', { method: 'DELETE' });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining(
        "resolves to installed plugin 'actual-plugin', but plugin 'demo' also exists",
      ),
    });
    expect(applyConfigurationMutation).not.toHaveBeenCalled();
    expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
  });

  test('rejects plugin lifecycle names that escape the plugin root', async () => {
    const app = setup({
      applyConfigurationMutation: vi.fn(),
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const update = await app.request('/..%2Fvictim/update', { method: 'POST' });
    const removal = await app.request('/..%2Fvictim', { method: 'DELETE' });
    const settings = await app.request('/..%2Fvictim/settings');

    expect(update.status).toBe(400);
    expect(removal.status).toBe(400);
    expect(settings.status).toBe(400);
  });

  test('does not report plugin removal complete while runtime activation is pending', async () => {
    const applyConfigurationMutation = vi.fn(async (operation) => {
      const activation = { status: 'applied' } as {
        status: 'applied' | 'pending';
        reason?: string;
      };
      const value = await operation(vi.fn(), activation);
      activation.status = 'pending';
      activation.reason = 'runtime reload pending';
      return value;
    });
    const app = setup({
      applyConfigurationMutation,
      settleProviderAdapterRetirements: vi.fn().mockResolvedValue(undefined),
    });

    const response = await app.request('/test-plugin', { method: 'DELETE' });
    const body = await json(response);

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      success: false,
      configurationActivation: {
        status: 'pending',
        reason: 'runtime reload pending',
      },
    });
  });

  // ── GET / — SDK usePluginsQuery reads json.plugins ──

  test('GET / returns { plugins } with fields the UI reads', async () => {
    const app = setup();
    const body = await json(await app.request('/'));
    expect(body.plugins).toBeDefined();
    expect(Array.isArray(body.plugins)).toBe(true);
    const p = body.plugins[0];
    // PluginManagementView reads these fields
    expect(p).toHaveProperty('name');
    expect(p).toHaveProperty('displayName');
    expect(p).toHaveProperty('version');
    expect(p).toHaveProperty('description');
    expect(p).toHaveProperty('hasBundle');
    expect(p).toHaveProperty('hasSettings');
    expect(p).toHaveProperty('permissions');
    expect(p.permissions).toHaveProperty('declared');
    expect(p.permissions).toHaveProperty('granted');
    expect(p.permissions).toHaveProperty('missing');
    expect(p.permissions.declared).toContain('providers.register');
    expect(p.permissions.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ permission: 'providers.register' }),
      ]),
    );
  });

  test('GET / keeps a rejected manifest visible with exact recovery copy', async () => {
    manifestFileText.override = '{"name":"test-plugin","version":';

    const body = await json(await setup().request('/'));

    expect(body.plugins).toEqual([
      {
        status: 'rejected',
        name: 'test-plugin',
        displayName: 'test-plugin',
        rejection: {
          code: 'malformed-json',
          reason: 'plugin.json contains malformed JSON.',
          recovery: {
            kind: 'repair-manifest',
            instruction:
              'Repair plugin.json so it is valid JSON, then choose Reload plugins.',
          },
        },
      },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Installed plugin manifest rejected',
      expect.objectContaining({
        pluginDirectory: 'test-plugin',
        code: 'malformed-json',
      }),
    );
  });

  // ── GET /:name/settings — UI reads settingsData.schema and settingsData.values ──

  test('GET /:name/settings returns { schema, values }', async () => {
    const app = setup();
    const body = await json(await app.request('/test-plugin/settings'));
    expect(body.schema).toBeDefined();
    expect(Array.isArray(body.schema)).toBe(true);
    expect(body.schema[0]).toHaveProperty('key');
    expect(body.schema[0]).toHaveProperty('label');
    expect(body.values).toBeDefined();
    // Default value should be populated
    expect(body.values.displayLabel).toBe('default-val');
    expect(body.values.secretToken).toBeNull();
  });

  test('GET /:name/settings redacts stored secret values', async () => {
    mockOverrides['test-plugin'] = {
      settings: { displayLabel: 'visible', secretToken: 'stored-secret' },
    };
    const app = setup();

    const body = await json(await app.request('/test-plugin/settings'));

    expect(body.values.displayLabel).toBe('visible');
    expect(body.values.secretToken).toBeNull();
    expect(JSON.stringify(body)).not.toContain('stored-secret');
  });

  test('GET /:name/settings returns 404 for missing plugin', async () => {
    const app = setup();
    const res = await app.request('/nonexistent/settings');
    expect(res.status).toBe(404);
  });

  // ── PUT /:name/settings — returns { success: true } ──

  test('PUT /:name/settings saves and returns { success: true }', async () => {
    const app = setup();
    const body = await json(
      await app.request('/test-plugin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { displayLabel: 'new-key' } }),
      }),
    );
    expect(body).toEqual({ success: true });
  });

  test('PUT /:name/settings preserves stored secrets when clients send redacted null values', async () => {
    mockOverrides['test-plugin'] = {
      settings: { displayLabel: 'old-key', secretToken: 'stored-secret' },
    };
    const app = setup();

    const body = await json(
      await app.request('/test-plugin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { displayLabel: 'new-key', secretToken: null },
        }),
      }),
    );

    expect(body).toEqual({ success: true });
    expect(mockOverrides['test-plugin'].settings).toMatchObject({
      displayLabel: 'new-key',
      secretToken: 'stored-secret',
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      'plugins:settings-changed',
      expect.objectContaining({
        settings: { displayLabel: 'new-key' },
      }),
    );
  });

  // ── GET /:name/providers — UI reads data.providers as array ──

  test('GET /:name/providers returns { providers } with enabled flag', async () => {
    const app = setup();
    const body = await json(await app.request('/test-plugin/providers'));
    expect(body.providers).toBeDefined();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers[0]).toMatchObject({
      type: 'test-provider',
      module: 'provider.js',
      enabled: true,
    });
  });

  // ── GET /:name/overrides — returns non-secret projection ──

  test('GET /:name/overrides does not return stored settings', async () => {
    mockOverrides['test-plugin'] = {
      disabled: ['test-provider'],
      settings: { displayLabel: 'visible-key', secretToken: 'stored-secret' },
    };
    const app = setup();
    const body = await json(await app.request('/test-plugin/overrides'));
    expect(body).toEqual({ disabled: ['test-provider'] });
    expect(JSON.stringify(body)).not.toContain('stored-secret');
    expect(JSON.stringify(body)).not.toContain('visible-key');
  });

  // ── PUT /:name/overrides — returns { success: true } ──

  test('PUT /:name/overrides saves disabled providers without removing settings', async () => {
    mockOverrides['test-plugin'] = {
      settings: { displayLabel: 'visible-key', secretToken: 'stored-secret' },
    };
    const app = setup();
    const body = await json(
      await app.request('/test-plugin/overrides', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: ['test-provider'] }),
      }),
    );
    expect(body).toEqual({ success: true });
    expect(mockOverrides['test-plugin']).toMatchObject({
      disabled: ['test-provider'],
      settings: { displayLabel: 'visible-key', secretToken: 'stored-secret' },
    });
  });

  test('PUT /:name/settings does not emit persisted settings removed from the manifest', async () => {
    mockOverrides['test-plugin'] = {
      settings: { retiredSecret: 'old-secret', displayLabel: 'old-key' },
    };
    const app = setup();

    const body = await json(
      await app.request('/test-plugin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { displayLabel: 'new-key' } }),
      }),
    );

    expect(body).toEqual({ success: true });
    expect(eventBus.emit).toHaveBeenCalledWith(
      'plugins:settings-changed',
      expect.objectContaining({
        settings: { displayLabel: 'new-key' },
      }),
    );
    expect(JSON.stringify(eventBus.emit.mock.calls)).not.toContain(
      'old-secret',
    );
  });
});
