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
import { afterEach, describe, expect, test, vi } from 'vitest';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import { replacePluginProvidersForSource } from '../../../providers/registries/registry.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  closePluginActivationSession,
  createPluginActivationSession,
} from '../../../services/plugins/plugin-activation-composition.js';
import { resolveInstalledPluginRoot } from '../../../services/plugins/plugin-incarnation.js';
import {
  derivePluginConsentBasis,
  type PluginInstallConsent,
} from '../../../services/plugins/plugin-install-consent.js';
import { readPluginManifestFile } from '../../../services/plugins/plugin-manifest-loader.js';
import { readPluginDependencyOwnership } from '../../../services/plugins/plugin-permissions.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';
import {
  installPluginFromSource,
  previewInstalledPluginRecovery,
  uninstallInstalledPlugin,
} from '../plugin-install-shared.js';
import { fetchPluginSource } from '../plugin-source.js';

const cleanupDirs: string[] = [];
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
  async function fixture(cycle = false) {
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
    registerPluginInstallRoutes(app, installDeps);
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
  registerPluginInstallRoutes(app, installDeps);
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
