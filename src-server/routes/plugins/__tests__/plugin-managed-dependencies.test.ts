import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import { replacePluginProvidersForSource } from '../../../providers/registries/registry.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  closePluginActivationSession,
  createPluginActivationSession,
} from '../../../services/plugins/plugin-activation-composition.js';
import {
  createPluginCommandEffectService,
  FilePluginCommandEffectStore,
} from '../../../services/plugins/plugin-command-effects.js';
import { resolveInstalledPluginRoot } from '../../../services/plugins/plugin-incarnation.js';
import {
  derivePluginConsentBasis,
  type PluginInstallConsent,
} from '../../../services/plugins/plugin-install-consent.js';
import {
  installPluginFromSource,
  previewInstalledPluginRecovery,
  uninstallInstalledPlugin,
} from '../../../services/plugins/plugin-install-transaction.js';
import { readPluginManifestFile } from '../../../services/plugins/plugin-manifest-loader.js';
import { readPluginDependencyOwnership } from '../../../services/plugins/plugin-permissions.js';
import {
  capturePluginRuntimeArtifact,
  pluginInstallationGeneration,
} from '../../../services/plugins/plugin-runtime-artifact.js';
import { fetchPluginSource } from '../../../services/plugins/plugin-source.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { registerPluginConfigRoutes } from '../plugin-config-routes.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';

const cleanupDirs: string[] = [];
const tempDir = trackTempDirs();
const packageStores: EventStore[] = [];
function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as any;
}
function deps(root: string) {
  return {
    agentsDir: join(root, 'agents'),
    buildPlugin: vi.fn().mockResolvedValue(undefined),
    logger: logger(),
    pluginsDir: join(root, 'plugins'),
    projectHomeDir: root,
  };
}
function writePlugin(source: string, manifest: Record<string, unknown>) {
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'plugin.json'), JSON.stringify(manifest, null, 2));
}
async function approvedConsent(
  source: string,
  root: string,
  dependencies?: string[],
): Promise<Extract<PluginInstallConsent, { kind: 'operator-decision' }>> {
  const staged = await fetchPluginSource(
    source,
    join(root, 'plugins'),
    logger(),
  );
  if ('error' in staged) throw new Error(staged.error);
  try {
    const basis = derivePluginConsentBasis(
      staged.tempDir,
      await readPluginManifestFile(join(staged.tempDir, 'plugin.json')),
    )!;
    return {
      kind: 'operator-decision',
      permissions: basis.required,
      contentDigest: basis.contentDigest,
      dependencies: dependencies ?? basis.dependencies,
    };
  } finally {
    rmSync(staged.tempDir, { recursive: true, force: true });
  }
}
afterEach(async () => {
  await replacePluginProvidersForSource('managed-dependency-catalog', []);
  for (const store of packageStores.splice(0)) store.close();
  for (const root of cleanupDirs.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('managed dependency graph uses canonical lifecycle owners', () => {
  async function fixture(cycle = false, shapeChild?: (child: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'station-managed-dependency-'));
    cleanupDirs.push(root);
    mkdirSync(join(root, 'plugins'));
    const parent = join(root, 'parent-source');
    const child = join(root, 'child-source');
    const leaf = join(root, 'leaf-source');
    const portable = (name: string, extension: Record<string, unknown>) => ({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name,
      version: '1.0.0',
      extensions: {
        'io.kontourai.station': { schemaVersion: '1.0', ...extension },
      },
    });
    writePlugin(
      parent,
      portable('parent', {
        dependencies: [{ name: 'child', version: '1.0.0' }],
      }),
    );
    writePlugin(
      child,
      portable('child', {
        dependencies: [{ name: cycle ? 'parent' : 'leaf', version: '*' }],
        agents: [
          { slug: 'child-agent', source: './agents/child-agent/agent.json' },
        ],
      }),
    );
    mkdirSync(join(child, 'agents', 'child-agent'), { recursive: true });
    writeFileSync(
      join(child, 'agents', 'child-agent', 'agent.json'),
      JSON.stringify({ name: 'Child', prompt: 'Child agent' }),
    );
    writePlugin(leaf, portable('leaf', {}));
    shapeChild?.(child);
    const sources: Record<string, string> = {
      child,
      leaf,
      ...(cycle ? { parent } : {}),
    };
    const catalogPath = join(root, 'registry.json');
    writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        plugins: Object.entries(sources).map(([id, source]) => ({
          id,
          source,
          displayName: id,
          version: '1.0.0',
        })),
      }),
    );
    const catalog = new JsonManifestRegistryProvider(catalogPath, root);
    await replacePluginProvidersForSource('managed-dependency-catalog', [
      {
        type: 'pluginRegistry',
        provider: catalog,
        source: 'managed-dependency-catalog',
      },
    ]);
    const store = new EventStore(join(root, 'events.sqlite'));
    packageStores.push(store);
    const installDeps = {
      ...deps(root),
      packageMcpJournal: store.createPackageMcpAdmissionJournal(),
    };
    const app = new Hono();
    registerPluginInstallRoutes(app, {
      ...installDeps,
      projectVisiblePlugins: () => (installed) => installed,
    });
    const response = await app.request('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: parent }),
    });
    const preview = (await response.json()) as any;
    expect(preview, JSON.stringify(preview)).toMatchObject({ valid: true });
    const consent: Extract<
      PluginInstallConsent,
      { kind: 'operator-decision' }
    > = {
      kind: 'operator-decision',
      permissions: preview.permissions.required,
      contentDigest: preview.contentDigest,
      dependencies: preview.dependencies.map((entry: any) => entry.id),
      dependencyApprovals: preview.dependencies.map((entry: any) => ({
        id: entry.id,
        permissions: entry.consent.permissions,
        contentDigest: entry.consent.contentDigest,
        dependencies: entry.consent.dependencies,
      })),
    };
    return {
      root,
      parent,
      child,
      leaf,
      installDeps,
      consent,
      registryKey: catalog.registryKey,
    };
  }

  test('real preview consent creates a nested graph, and parent removal withdraws owned children while retaining their code and data', async () => {
    const f = await fixture();
    await installPluginFromSource(f.parent, [], f.installDeps, {
      consent: f.consent,
    });
    expect(
      readPluginDependencyOwnership(f.root, 'parent').map((entry) => entry.id),
    ).toEqual(['child']);
    expect(
      readPluginDependencyOwnership(f.root, 'child').map((entry) => entry.id),
    ).toEqual(['leaf']);
    expect(
      existsSync(join(f.root, 'agents', 'child-agent', 'agent.json')),
    ).toBe(true);
    const child = resolveInstalledPluginRoot(
      f.installDeps.pluginsDir,
      'child',
    )!;
    const leaf = resolveInstalledPluginRoot(f.installDeps.pluginsDir, 'leaf')!;
    writeFileSync(join(child.dataRoot!, 'state'), 'preserve child');
    await uninstallInstalledPlugin('parent', f.installDeps);
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('child').state,
    ).toBe('not-observed');
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('leaf').state,
    ).toBe('not-observed');
    expect(existsSync(join(f.root, 'agents', 'child-agent'))).toBe(false);
    expect(existsSync(child.packageRoot)).toBe(true);
    expect(existsSync(leaf.packageRoot)).toBe(true);
    expect(readFileSync(join(child.dataRoot!, 'state'), 'utf8')).toBe(
      'preserve child',
    );
  });

  test('stages a portable dependency the way its preview did, leaving every .git entry out', async () => {
    // Nested repository metadata in a portable dependency: the preview
    // approved it staged in dependency mode, so the install must stage it the
    // same way (not fail closed, not carry the metadata in). Nested only: a
    // registry source with a top-level `.git` is refused by the registry.
    const f = await fixture(false, (child) => {
      mkdirSync(join(child, 'tools', '.Git'), { recursive: true });
      writeFileSync(
        join(child, 'tools', '.Git', 'HEAD'),
        'ref: refs/heads/main\n',
      );
      mkdirSync(join(child, 'vendor', '.git'), { recursive: true });
      writeFileSync(join(child, 'vendor', '.git', 'HEAD'), 'x\n');
      writeFileSync(join(child, 'vendor', 'kept.txt'), 'kept\n');
    });
    await installPluginFromSource(f.parent, [], f.installDeps, {
      consent: f.consent,
    });
    const child = resolveInstalledPluginRoot(
      f.installDeps.pluginsDir,
      'child',
    )!;
    expect(
      readFileSync(join(child.packageRoot, 'vendor', 'kept.txt'), 'utf8'),
    ).toBe('kept\n');
    const gitLike = (dir: string) =>
      readdirSync(dir).filter((entry) => /^\.git[. ]*$/i.test(entry));
    expect(gitLike(join(child.packageRoot, 'tools'))).toEqual([]);
    expect(gitLike(join(child.packageRoot, 'vendor'))).toEqual([]);
  });

  test('late parent withdrawal failure compensates the nested graph with fresh child admissions', async () => {
    const f = await fixture();
    await installPluginFromSource(f.parent, [], f.installDeps, {
      consent: f.consent,
    });
    const child = f.installDeps.packageMcpJournal.currentInstallation('child');
    const leaf = f.installDeps.packageMcpJournal.currentInstallation('leaf');
    let failed = false;
    await expect(
      uninstallInstalledPlugin('parent', {
        ...f.installDeps,
        eventBus: {
          emit(event, payload) {
            if (
              !failed &&
              event === 'plugins:removed' &&
              payload?.name === 'parent'
            ) {
              failed = true;
              throw new Error('parent publication failed');
            }
          },
        },
      }),
    ).rejects.toThrow(/parent publication failed/);
    const restoredChild =
      f.installDeps.packageMcpJournal.currentInstallation('child');
    const restoredLeaf =
      f.installDeps.packageMcpJournal.currentInstallation('leaf');
    expect(restoredChild.state).toBe('observed');
    expect(restoredLeaf.state).toBe('observed');
    if (
      child.state !== 'observed' ||
      leaf.state !== 'observed' ||
      restoredChild.state !== 'observed' ||
      restoredLeaf.state !== 'observed'
    )
      throw new Error('Missing graph observation');
    expect(restoredChild.installation.incarnation).not.toBe(
      child.installation.incarnation,
    );
    expect(restoredLeaf.installation.incarnation).not.toBe(
      leaf.installation.incarnation,
    );
    expect(restoredChild.installation.dataScope).toBe(
      child.installation.dataScope,
    );
    expect(
      existsSync(join(f.root, 'agents', 'child-agent', 'agent.json')),
    ).toBe(true);
    expect(
      readPluginDependencyOwnership(f.root, 'parent').map((entry) => entry.id),
    ).toEqual(['child']);
    await uninstallInstalledPlugin('parent', f.installDeps);
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('child').state,
    ).toBe('not-observed');
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('leaf').state,
    ).toBe('not-observed');
  });

  test('a changed child source is refused under its own preview digest before any graph is installed', async () => {
    const f = await fixture();
    writeFileSync(join(f.child, 'unreviewed.txt'), 'changed after preview');
    await expect(
      installPluginFromSource(f.parent, [], f.installDeps, {
        consent: f.consent,
      }),
    ).rejects.toThrow(/changed after it was reviewed/);
    expect(f.installDeps.buildPlugin).not.toHaveBeenCalled();
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('parent').state,
    ).toBe('not-observed');
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('child').state,
    ).toBe('not-observed');
  });
  test('shared managed dependency custody transfers to a surviving root and its final removal withdraws the nested graph', async () => {
    const f = await fixture();
    await installPluginFromSource(f.parent, [], f.installDeps, {
      consent: f.consent,
    });
    const survivor = join(f.root, 'survivor-source');
    writePlugin(survivor, {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'survivor',
      version: '1.0.0',
      extensions: {
        'io.kontourai.station': {
          schemaVersion: '1.0',
          dependencies: [{ name: 'child', version: '1.0.0' }],
        },
      },
    });
    await installPluginFromSource(survivor, [], f.installDeps, {
      consent: {
        ...(await approvedConsent(survivor, f.root, ['child', 'leaf'])),
        dependencyApprovals: f.consent.dependencyApprovals,
      },
    });
    await uninstallInstalledPlugin('parent', f.installDeps);
    expect(
      readPluginDependencyOwnership(f.root, 'survivor').map(
        (entry) => entry.id,
      ),
    ).toEqual(['child']);
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('child').state,
    ).toBe('observed');
    await uninstallInstalledPlugin('survivor', f.installDeps);
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('child').state,
    ).toBe('not-observed');
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('leaf').state,
    ).toBe('not-observed');
  });

  test('H3: removing a parent withdraws command effects of its managed dependencies through their nested removals', async () => {
    const f = await fixture();
    await installPluginFromSource(f.parent, [], f.installDeps, {
      consent: f.consent,
    });
    const child = capturePluginRuntimeArtifact(
      f.installDeps.pluginsDir,
      'child',
      f.installDeps.packageMcpJournal,
    );
    expect(child).not.toBeNull();
    const effects = createPluginCommandEffectService({
      store: new FilePluginCommandEffectStore(f.root),
    });
    const admitted = await effects.recordAdmission({
      principalId: 'local-operator',
      pluginId: 'child',
      installationGeneration: pluginInstallationGeneration(child!),
      requiresPluginServer: false,
      commandId: 'child.open',
      target: { kind: 'destination', destinationId: 'plugins' },
      content: { kind: 'navigate', destinationId: 'plugins' },
      documentId: 'document-managed-child',
      documentKey: 'k'.repeat(43),
      requestId: 'request-managed-child',
      issuedAt: Date.now(),
    });
    if (admitted.kind !== 'admitted') throw new Error(admitted.reason);
    const removed = await uninstallInstalledPlugin('parent', f.installDeps);
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('child').state,
    ).toBe('not-observed');
    expect(removed.dependencyCommandEffects).toEqual([
      expect.objectContaining({ status: 'winding-down', outstanding: 1 }),
    ]);
    await expect(
      effects.withdrawal(removed.dependencyCommandEffects![0]!.withdrawalId),
    ).resolves.toMatchObject({
      pluginId: 'child',
      outstandingEffectIds: [admitted.receipt.effectId],
    });
  });

  test('canonical nested installation refuses cycles before adopting the parent', async () => {
    const f = await fixture(true);
    await expect(
      installPluginFromSource(f.parent, [], f.installDeps, {
        consent: f.consent,
      }),
    ).rejects.toThrow(/cycle detected/);
    expect(f.installDeps.buildPlugin).not.toHaveBeenCalled();
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('parent').state,
    ).toBe('not-observed');
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('child').state,
    ).toBe('not-observed');
  });
  test('same-bytes independent child reinstall is not withdrawn under an older creator admission', async () => {
    const f = await fixture();
    await installPluginFromSource(f.parent, [], f.installDeps, {
      consent: f.consent,
    });
    const before = f.installDeps.packageMcpJournal.currentInstallation('child');
    await installPluginFromSource(f.child, [], f.installDeps, {
      registryId: 'child',
      registryKey: f.registryKey,
      consent: {
        ...(await approvedConsent(f.child, f.root)),
        dependencyApprovals: f.consent.dependencyApprovals,
      },
    });
    const after = f.installDeps.packageMcpJournal.currentInstallation('child');
    if (before.state !== 'observed' || after.state !== 'observed')
      throw new Error('Missing child admission');
    expect(after.installation.contentDigest).toBe(
      before.installation.contentDigest,
    );
    expect(after.installation.incarnation).not.toBe(
      before.installation.incarnation,
    );
    await uninstallInstalledPlugin('parent', f.installDeps);
    expect(
      f.installDeps.packageMcpJournal.currentInstallation('child'),
    ).toEqual(after);
    expect(
      existsSync(join(f.root, 'agents', 'child-agent', 'agent.json')),
    ).toBe(true);
  });
});

test('a legacy parent’s local portable dependency with a root .git installs as its preview staged it, without the repository', async () => {
  // No registry: the legacy parent names the portable child by a relative
  // source, and the child is a git checkout at its root.
  const root = tempDir('station-legacy-portable-git-');
  mkdirSync(join(root, 'plugins'));
  const parent = join(root, 'parent-source');
  const child = join(root, 'child-source');
  writePlugin(parent, {
    name: 'parent',
    version: '1.0.0',
    dependencies: [{ id: 'child', source: '../child-source' }],
  });
  writePlugin(child, {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'child',
    version: '1.0.0',
    extensions: { 'io.kontourai.station': { schemaVersion: '1.0' } },
  });
  execGitSync(['init', '-b', 'main'], { cwd: child });
  execGitSync(['add', '-A'], { cwd: child });
  execGitSync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'child',
    ],
    { cwd: child },
  );
  const store = new EventStore(join(root, 'events.sqlite'));
  packageStores.push(store);
  const installDeps = {
    ...deps(root),
    packageMcpJournal: store.createPackageMcpAdmissionJournal(),
  };
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    ...installDeps,
    projectVisiblePlugins: () => (installed) => installed,
  });
  const response = await app.request('/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: parent }),
  });
  const preview = (await response.json()) as any;
  expect(preview, JSON.stringify(preview)).toMatchObject({
    valid: true,
    dependencies: [expect.objectContaining({ id: 'child' })],
  });
  await installPluginFromSource(parent, [], installDeps, {
    consent: {
      kind: 'operator-decision',
      permissions: preview.permissions.required,
      contentDigest: preview.contentDigest,
      dependencies: preview.dependencies.map((entry: any) => entry.id),
      dependencyApprovals: preview.dependencies.map((entry: any) => ({
        id: entry.id,
        permissions: entry.consent.permissions,
        contentDigest: entry.consent.contentDigest,
        dependencies: entry.consent.dependencies,
      })),
    },
  });
  const installed = resolveInstalledPluginRoot(installDeps.pluginsDir, 'child');
  expect(installed?.kind).toBe('incarnation');
  expect(
    readdirSync(installed!.packageRoot).filter((entry) =>
      /^\.git[. ]*$/i.test(entry),
    ),
  ).toEqual([]);
  expect(
    readPluginDependencyOwnership(root, 'parent').map((entry) => entry.id),
  ).toEqual(['child']);
});

test('a legacy parent’s consented provider dependency lists its settings and a pending providers.register grant, and leaves the list with its parent', async () => {
  // The provider dependency asks for providers.register through its preview
  // consent. Consent admits the install; it does not grant provider
  // activation, so the inventory must show that grant as missing rather than
  // loading the provider (its factory throws if anything ever does).
  const root = tempDir('station-legacy-provider-dependency-');
  mkdirSync(join(root, 'plugins'));
  const parent = join(root, 'parent-source');
  const provider = join(root, 'provider-source');
  writePlugin(parent, {
    name: 'parent',
    version: '1.0.0',
    dependencies: [{ id: 'provider', source: '../provider-source' }],
  });
  writePlugin(provider, {
    name: 'provider',
    version: '1.0.0',
    settings: [{ key: 'fixtureLabel', label: 'Fixture label', type: 'text' }],
    providers: [{ type: 'auth', module: './provider.js' }],
  });
  writeFileSync(
    join(provider, 'provider.js'),
    "export default function create() { throw new Error('unapproved provider activated'); }\n",
  );
  const store = new EventStore(join(root, 'events.sqlite'));
  packageStores.push(store);
  const installDeps = {
    ...deps(root),
    packageMcpJournal: store.createPackageMcpAdmissionJournal(),
  };
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    ...installDeps,
    projectVisiblePlugins: () => (installed) => installed,
  });
  registerPluginConfigRoutes(app, installDeps);
  const preview = (await (
    await app.request('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: parent }),
    })
  ).json()) as any;
  expect(preview, JSON.stringify(preview)).toMatchObject({
    valid: true,
    dependencies: [
      expect.objectContaining({
        id: 'provider',
        consent: expect.objectContaining({
          permissions: expect.arrayContaining(['providers.register']),
        }),
      }),
    ],
  });
  await installPluginFromSource(parent, [], installDeps, {
    consent: {
      kind: 'operator-decision',
      permissions: preview.permissions.required,
      contentDigest: preview.contentDigest,
      dependencies: preview.dependencies.map((entry: any) => entry.id),
      dependencyApprovals: preview.dependencies.map((entry: any) => ({
        id: entry.id,
        permissions: entry.consent.permissions,
        contentDigest: entry.consent.contentDigest,
        dependencies: entry.consent.dependencies,
      })),
    },
  });
  const listed = async () =>
    ((await (await app.request('/')).json()) as any).plugins as Array<{
      name: string;
      hasSettings: boolean;
      permissions: {
        granted: string[];
        missing: Array<{ permission: string }>;
      };
    }>;
  const installed = await listed();
  expect(installed.map((plugin) => plugin.name).sort()).toEqual([
    'parent',
    'provider',
  ]);
  const providerRow = installed.find((plugin) => plugin.name === 'provider')!;
  expect(providerRow.hasSettings).toBe(true);
  expect(providerRow.permissions.granted).not.toContain('providers.register');
  expect(providerRow.permissions.missing).toContainEqual(
    expect.objectContaining({ permission: 'providers.register' }),
  );
  const settings = await app.request('/provider/settings');
  expect(settings.status).toBe(200);
  expect(((await settings.json()) as any).schema).toContainEqual(
    expect.objectContaining({ key: 'fixtureLabel', type: 'text' }),
  );

  await uninstallInstalledPlugin('parent', installDeps);
  expect(await listed()).toEqual([]);
  expect((await app.request('/provider/settings')).status).toBe(404);
});

test('retained diamond recovery checks every version edge before deduplicating shared dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'station-retained-diamond-'));
  cleanupDirs.push(root);
  mkdirSync(join(root, 'plugins'));
  const store = new EventStore(join(root, 'events.sqlite'));
  packageStores.push(store);
  const installDeps = {
    ...deps(root),
    packageMcpJournal: store.createPackageMcpAdmissionJournal(),
  };
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    ...installDeps,
    projectVisiblePlugins: () => (installed) => installed,
  });
  const source = (
    name: string,
    dependencies: Array<{ name: string; version: string }>,
    version = '1.0.0',
  ) => {
    const path = join(root, `${name}-source`);
    writePlugin(path, {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name,
      version,
      extensions: {
        'io.kontourai.station': { schemaVersion: '1.0', dependencies },
      },
    });
    return path;
  };
  const install = async (
    path: string,
    activationSession?: ReturnType<typeof createPluginActivationSession>,
  ) => {
    const response = await app.request('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: path }),
    });
    const preview = (await response.json()) as any;
    expect(preview, JSON.stringify(preview)).toMatchObject({ valid: true });
    return installPluginFromSource(path, [], installDeps, {
      activationSession,
      consent: {
        kind: 'operator-decision',
        contentDigest: preview.contentDigest,
        grantRevision: preview.grantRevision,
        permissions: preview.permissions.required,
        dependencies: preview.dependencies.map((entry: any) => entry.id),
        dependencyApprovals: preview.dependencies.flatMap((entry: any) =>
          entry.consent
            ? [
                {
                  id: entry.id,
                  contentDigest: entry.consent.contentDigest,
                  grantRevision: entry.consent.grantRevision,
                  permissions: entry.consent.permissions,
                  dependencies: entry.consent.dependencies,
                },
              ]
            : [],
        ),
      },
    });
  };
  await install(source('shared', []));
  await install(source('left', [{ name: 'shared', version: '1.0.0' }]));
  await install(source('right', [{ name: 'shared', version: '1.0.0' }]));
  const pending = createPluginActivationSession();
  try {
    await install(
      source('diamond', [
        { name: 'left', version: '*' },
        { name: 'right', version: '*' },
      ]),
      pending,
    );
  } finally {
    closePluginActivationSession(pending);
  }
  // A different installed branch is upgraded, then the shared package changes
  // again. The pending parent's bytes still exist, but its graph is incompatible.
  await install(source('shared', [], '2.0.0'));
  await install(source('right', [{ name: 'shared', version: '2.0.0' }]));
  await install(source('shared', []));
  const before = installDeps.packageMcpJournal.currentInstallation('diamond');
  await expect(
    previewInstalledPluginRecovery('diamond', installDeps),
  ).rejects.toThrow(/shared.*required version '2.0.0'/);
  expect(installDeps.packageMcpJournal.currentInstallation('diamond')).toEqual(
    before,
  );
});
