import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dependentNameFor,
  findPeerProblems,
  findPnpmLockProblems,
  findWorkspaceMetadataProblems,
  isOverridden,
  loadWorkspaceMetadata,
  pnpmPackageExtensionsChecksum,
} from '../lockfile-sync-gate.mjs';

/**
 * The range check's scoping is deliberate and load-bearing. An earlier draft
 * without it flagged autoevals' bundled openai@4 wanting zod@^3.23.8 against
 * the root's zod@4 — a pairing npm resolves without complaint. A gate that
 * cries wolf on a non-problem is worse than no gate, so the narrowing is
 * pinned here rather than left to the next reader's judgement to re-widen.
 *
 * The rules, verified against npm's own resolver: a conflict only hard-fails
 * when the dependent is TOP-LEVEL and the peer is something the root itself
 * depends on. A nested dependent gets its own nested copy; a non-root peer
 * conflict is a soft `ERESOLVE overriding peer dependency` warning.
 */

function lockOf(packages: Record<string, unknown>) {
  return { packages };
}

describe('findPeerProblems — unsatisfiable peer ranges', () => {
  it('flags the real #1233 shape: top-level dependent, root-dep peer, stale range', () => {
    const { unsatisfiable } = findPeerProblems({
      lock: lockOf({
        'node_modules/@strands-agents/sdk': {
          version: '1.11.1',
          peerDependencies: { '@anthropic-ai/sdk': '^0.109.1' },
          peerDependenciesMeta: { '@anthropic-ai/sdk': { optional: true } },
        },
        'node_modules/@anthropic-ai/sdk': { version: '0.115.0' },
      }),
      manifest: { dependencies: { '@anthropic-ai/sdk': '^0.115.0' } },
    });

    expect(unsatisfiable).toEqual([
      {
        name: '@anthropic-ai/sdk',
        range: '^0.109.1',
        locked: '0.115.0',
        dependent: '@strands-agents/sdk',
      },
    ]);
  });

  it('stays quiet for a NESTED dependent — npm nests its own copy', () => {
    const { unsatisfiable } = findPeerProblems({
      lock: lockOf({
        'node_modules/autoevals/node_modules/openai': {
          version: '4.104.0',
          peerDependencies: { zod: '^3.23.8' },
          peerDependenciesMeta: { zod: { optional: true } },
        },
        'node_modules/zod': { version: '4.4.3' },
      }),
      manifest: { dependencies: { zod: '^4.4.3' } },
    });

    expect(unsatisfiable).toEqual([]);
  });

  it('stays quiet when the peer is not a root dependency', () => {
    const { unsatisfiable } = findPeerProblems({
      lock: lockOf({
        'node_modules/some-pkg': {
          version: '1.0.0',
          peerDependencies: { 'transitive-only': '^1.0.0' },
        },
        'node_modules/transitive-only': { version: '2.0.0' },
      }),
      manifest: { dependencies: {} },
    });

    expect(unsatisfiable).toEqual([]);
  });

  it('treats an override on the dependent as the sanctioned escape hatch', () => {
    const lock = lockOf({
      'node_modules/dep': {
        version: '1.0.0',
        peerDependencies: { peerpkg: '^1.0.0' },
      },
      'node_modules/peerpkg': { version: '2.0.0' },
    });
    const base = { dependencies: { peerpkg: '^2.0.0' } };

    expect(
      findPeerProblems({ lock, manifest: base }).unsatisfiable,
    ).toHaveLength(1);
    expect(
      findPeerProblems({
        lock,
        manifest: { ...base, overrides: { dep: { peerpkg: '$peerpkg' } } },
      }).unsatisfiable,
    ).toEqual([]);
  });

  it('does not opt into prereleases, matching npm rather than being laxer than it', () => {
    // npm's peer check is semver.satisfies(v, range, true) — loose, NOT
    // includePrerelease. A prerelease root pin that a plain range does not
    // admit must read as unsatisfiable here too, or the gate goes green on a
    // tree `npm install` will refuse.
    const { unsatisfiable } = findPeerProblems({
      lock: lockOf({
        'node_modules/dep': {
          version: '1.0.0',
          peerDependencies: { peerpkg: '^1.0.0' },
        },
        // 1.2.0-beta.1 against ^1.0.0 is the case that actually discriminates:
        // includePrerelease admits it, loose does not. A prerelease outside the
        // range entirely (2.0.0-beta.1) fails under both flags and would prove
        // nothing about which one is in use.
        'node_modules/peerpkg': { version: '1.2.0-beta.1' },
      }),
      manifest: { dependencies: { peerpkg: '1.2.0-beta.1' } },
    });

    expect(unsatisfiable).toHaveLength(1);
  });

  it('ignores a peer with no locked entry — that is the missing-peer class, not this one', () => {
    const { unsatisfiable } = findPeerProblems({
      lock: lockOf({
        'node_modules/dep': {
          version: '1.0.0',
          peerDependencies: { absent: '^1.0.0' },
          peerDependenciesMeta: { absent: { optional: true } },
        },
      }),
      manifest: { dependencies: { absent: '^1.0.0' } },
    });

    expect(unsatisfiable).toEqual([]);
  });
});

describe('findPeerProblems — missing peers (pre-existing behaviour)', () => {
  it('flags a required peer with no lock entry', () => {
    const { missing } = findPeerProblems({
      lock: lockOf({
        'node_modules/dep': {
          version: '1.0.0',
          peerDependencies: { graphql: '^16.0.0' },
        },
      }),
      manifest: {},
    });

    expect(missing).toEqual([
      { name: 'graphql', requiredBy: 'node_modules/dep' },
    ]);
  });

  it('does not flag an optional peer, or one nested under the dependent', () => {
    const { missing } = findPeerProblems({
      lock: lockOf({
        'node_modules/dep': {
          version: '1.0.0',
          peerDependencies: { opt: '^1.0.0', nested: '^1.0.0' },
          peerDependenciesMeta: { opt: { optional: true } },
        },
        'node_modules/dep/node_modules/nested': { version: '1.0.0' },
      }),
      manifest: {},
    });

    expect(missing).toEqual([]);
  });

  it('reports both classes together rather than hiding one behind the other', () => {
    const { missing, unsatisfiable } = findPeerProblems({
      lock: lockOf({
        'node_modules/dep': {
          version: '1.0.0',
          peerDependencies: { peerpkg: '^1.0.0', graphql: '^16.0.0' },
        },
        'node_modules/peerpkg': { version: '2.0.0' },
      }),
      manifest: { dependencies: { peerpkg: '^2.0.0' } },
    });

    expect(unsatisfiable).toHaveLength(1);
    expect(missing).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('dependentNameFor handles scoped packages and nesting', () => {
    expect(dependentNameFor('node_modules/@strands-agents/sdk')).toBe(
      '@strands-agents/sdk',
    );
    expect(dependentNameFor('node_modules/@a/b/node_modules/@c/d')).toBe(
      '@c/d',
    );
    expect(dependentNameFor('')).toBe('<root>');
  });

  it('isOverridden matches npm version-pinned override keys too', () => {
    const manifest = {
      overrides: {
        'plain-dep': { peerpkg: '$peerpkg' },
        'pinned-dep@1.2.3': { peerpkg: '$peerpkg' },
        '@scoped/dep@2.0.0': { peerpkg: '$peerpkg' },
      },
    };

    expect(isOverridden(manifest, 'plain-dep', 'peerpkg')).toBe(true);
    expect(isOverridden(manifest, 'pinned-dep', 'peerpkg')).toBe(true);
    expect(isOverridden(manifest, '@scoped/dep', 'peerpkg')).toBe(true);
    expect(isOverridden(manifest, 'plain-dep', 'other')).toBe(false);
    expect(isOverridden(manifest, 'unrelated', 'peerpkg')).toBe(false);
  });
});

function workspaceFixture(): {
  manifest: Record<string, unknown>;
  workspaces: Record<string, Record<string, unknown>>;
  lock: { packages: Record<string, Record<string, unknown>> };
} {
  return {
    manifest: {
      name: 'root',
      version: '1.0.0',
      workspaces: ['packages/a', 'packages/b'],
    },
    workspaces: {
      'packages/a': {
        name: 'fixture-a',
        version: '1.0.0',
        dependencies: { 'fixture-b': '^1.0.0' },
      },
      'packages/b': { name: 'fixture-b', version: '1.0.0' },
    },
    lock: {
      packages: {
        '': {
          name: 'root',
          version: '1.0.0',
          workspaces: ['packages/a', 'packages/b'],
        },
        'packages/a': {
          name: 'fixture-a',
          version: '1.0.0',
          dependencies: { 'fixture-b': '^1.0.0' },
        },
        'packages/b': { name: 'fixture-b', version: '1.0.0' },
      },
    },
  };
}

describe('findWorkspaceMetadataProblems', () => {
  it('reports the #1422-shaped stale version and exact root/workspace internal ranges', () => {
    const fixture = workspaceFixture();
    fixture.manifest.dependencies = { 'fixture-a': '^1.0.1' };
    fixture.manifest.devDependencies = { 'fixture-b': '~1.0.1' };
    fixture.manifest.peerDependencies = { 'fixture-a': '>=1.0.1' };
    fixture.manifest.optionalDependencies = { 'fixture-b': '1.0.1' };
    fixture.lock.packages[''].dependencies = { 'fixture-a': '^1.0.0' };
    fixture.lock.packages[''].devDependencies = { 'fixture-b': '~1.0.0' };
    fixture.lock.packages[''].peerDependencies = { 'fixture-a': '>=1.0.0' };
    fixture.lock.packages[''].optionalDependencies = { 'fixture-b': '1.0.0' };
    fixture.workspaces['packages/a'].version = '1.0.1';
    fixture.workspaces['packages/a'].dependencies = { 'fixture-b': '^1.0.1' };

    expect(findWorkspaceMetadataProblems(fixture)).toEqual([
      {
        workspace: '.',
        field: 'dependencies.fixture-a',
        manifestValue: '^1.0.1',
        lockValue: '^1.0.0',
      },
      {
        workspace: '.',
        field: 'devDependencies.fixture-b',
        manifestValue: '~1.0.1',
        lockValue: '~1.0.0',
      },
      {
        workspace: '.',
        field: 'optionalDependencies.fixture-b',
        manifestValue: '1.0.1',
        lockValue: '1.0.0',
      },
      {
        workspace: '.',
        field: 'peerDependencies.fixture-a',
        manifestValue: '>=1.0.1',
        lockValue: '>=1.0.0',
      },
      {
        workspace: 'packages/a',
        field: 'dependencies.fixture-b',
        manifestValue: '^1.0.1',
        lockValue: '^1.0.0',
      },
      {
        workspace: 'packages/a',
        field: 'version',
        manifestValue: '1.0.1',
        lockValue: '1.0.0',
      },
    ]);
  });

  it('accepts coherent workspace metadata and ignores external dependency ranges', () => {
    const fixture = workspaceFixture();
    fixture.manifest.dependencies = { external: 'not-a-semver' };
    fixture.lock.packages[''].dependencies = { external: 42 };

    expect(findWorkspaceMetadataProblems(fixture)).toEqual([]);
  });

  it('catches both directions when an internal edge is deleted or moved', () => {
    const fixture = workspaceFixture();
    fixture.manifest.dependencies = { 'fixture-a': '^1.0.0' };
    fixture.lock.packages[''].devDependencies = { 'fixture-a': '^1.0.0' };

    expect(findWorkspaceMetadataProblems(fixture)).toEqual([
      {
        workspace: '.',
        field: 'dependencies.fixture-a',
        manifestValue: '^1.0.0',
        lockValue: undefined,
      },
      {
        workspace: '.',
        field: 'devDependencies.fixture-a',
        manifestValue: undefined,
        lockValue: '^1.0.0',
      },
    ]);
  });

  it('fails closed for missing entries, non-explicit paths, and malformed metadata', () => {
    const fixture = workspaceFixture();
    delete fixture.lock.packages['packages/a'];
    fixture.manifest.workspaces = ['packages/*', '../escape', 'packages/b'];
    fixture.lock.packages[''].workspaces = [
      'packages/*',
      '../escape',
      'packages/b',
    ];
    fixture.workspaces['packages/b'].name = 17;

    expect(findWorkspaceMetadataProblems(fixture)).toEqual(
      expect.arrayContaining([
        {
          workspace: 'packages/b',
          field: 'name',
          manifestValue: 17,
          lockValue: 'fixture-b',
        },
        {
          workspace: '.',
          field: 'workspaces[0]',
          manifestValue: 'packages/*',
          lockValue: undefined,
        },
        {
          workspace: '.',
          field: 'workspaces[1]',
          manifestValue: '../escape',
          lockValue: undefined,
        },
      ]),
    );
  });

  it('rejects duplicate workspace names and a missing workspace lock entry', () => {
    const fixture = workspaceFixture();
    fixture.workspaces['packages/b'].name = 'fixture-a';
    delete fixture.lock.packages['packages/b'];

    expect(findWorkspaceMetadataProblems(fixture)).toEqual(
      expect.arrayContaining([
        {
          workspace: 'packages/b',
          field: 'lockEntry',
          manifestValue: 'required',
          lockValue: undefined,
        },
        {
          workspace: 'packages/b',
          field: 'name',
          manifestValue: 'fixture-a',
          lockValue: 'duplicate name',
        },
      ]),
    );
  });

  it('rejects a workspace with no name', () => {
    const fixture = workspaceFixture();
    delete fixture.workspaces['packages/a'].name;

    expect(findWorkspaceMetadataProblems(fixture)).toEqual(
      expect.arrayContaining([
        {
          workspace: 'packages/a',
          field: 'name',
          manifestValue: undefined,
          lockValue: 'fixture-a',
        },
      ]),
    );
  });

  it('refuses unsupported workspace declarations and duplicate explicit paths', () => {
    const unsupported = workspaceFixture();
    unsupported.manifest.workspaces = { packages: ['packages/a'] };
    unsupported.lock.packages[''].workspaces = { packages: ['packages/a'] };

    expect(findWorkspaceMetadataProblems(unsupported)).toEqual(
      expect.arrayContaining([
        {
          workspace: '.',
          field: 'workspaces',
          manifestValue: { packages: ['packages/a'] },
          lockValue: undefined,
        },
        {
          workspace: '.',
          field: 'workspaces',
          manifestValue: undefined,
          lockValue: { packages: ['packages/a'] },
        },
      ]),
    );

    const duplicate = workspaceFixture();
    duplicate.manifest.workspaces = ['packages/a', 'packages/a'];
    duplicate.lock.packages[''].workspaces = ['packages/a', 'packages/a'];

    expect(findWorkspaceMetadataProblems(duplicate)).toEqual(
      expect.arrayContaining([
        {
          workspace: '.',
          field: 'workspaces[1]',
          manifestValue: 'packages/a',
          lockValue: undefined,
        },
        {
          workspace: '.',
          field: 'workspaces[1]',
          manifestValue: undefined,
          lockValue: 'packages/a',
        },
      ]),
    );
  });
});

describe('loadWorkspaceMetadata', () => {
  it('loads an explicit Windows workspace without allowing traversal outside its root', () => {
    const root = 'C:\\release';
    const files = new Map([
      [
        win32.join(root, 'package.json'),
        JSON.stringify({
          name: 'fixture-root',
          version: '1.0.0',
          workspaces: ['packages/a', '../escape'],
        }),
      ],
      [
        win32.join(root, 'package-lock.json'),
        JSON.stringify({
          packages: {
            '': {
              name: 'fixture-root',
              version: '1.0.0',
              workspaces: ['packages/a', '../escape'],
            },
            'packages/a': { name: 'fixture-a', version: '1.0.0' },
          },
        }),
      ],
      [
        win32.join(root, 'packages', 'a', 'package.json'),
        JSON.stringify({ name: 'fixture-a', version: '1.0.0' }),
      ],
    ]);
    const readFile = ((path: string) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`unexpected read: ${path}`);
      return file;
    }) as typeof import('node:fs').readFileSync;

    const loaded = loadWorkspaceMetadata(root, {
      readFile,
      pathOps: win32,
    });

    expect(loaded.workspaces).toEqual({
      'packages/a': { name: 'fixture-a', version: '1.0.0' },
    });
    expect(findWorkspaceMetadataProblems(loaded)).toEqual(
      expect.arrayContaining([
        {
          workspace: '.',
          field: 'workspaces[1]',
          manifestValue: '../escape',
          lockValue: undefined,
        },
      ]),
    );
  });
});

describe('pnpm lock authority', () => {
  function inputs() {
    return {
      manifests: {
        '.': { dependencies: { consumer: '^1.0.0' } },
        'packages/widget': { dependencies: { consumer: '^2.0.0' } },
      },
      config: { overrides: { 'consumer>peer': '^3.0.0' } },
      lock: {
        importers: {
          '.': {
            dependencies: {
              consumer: { specifier: '^1.0.0', version: '1.0.0(peer@3.0.0)' },
            },
          },
          'packages/widget': {
            dependencies: {
              consumer: { specifier: '^2.0.0', version: '2.0.0(peer@3.0.0)' },
            },
          },
        },
        overrides: { 'consumer>peer': '^3.0.0' },
        packages: {
          'consumer@1.0.0': { peerDependencies: { peer: '^2.0.0' } },
          'consumer@2.0.0': { peerDependencies: { peer: '^3.0.0' } },
          'peer@3.0.0': {},
        },
        snapshots: {
          'consumer@1.0.0(peer@3.0.0)': { dependencies: { peer: '3.0.0' } },
          'consumer@2.0.0(peer@3.0.0)': { dependencies: { peer: '3.0.0' } },
          'peer@3.0.0': {},
        },
      },
    };
  }

  it('uses importer-specific specifiers and peer-qualified snapshots with explicit overrides', () => {
    const fixture = inputs();
    expect(findPnpmLockProblems(fixture)).toEqual([]);
    fixture.manifests['packages/widget'].dependencies.consumer = '^3.0.0';
    expect(findPnpmLockProblems(fixture)).toEqual([
      expect.objectContaining({
        workspace: 'packages/widget',
        field: 'dependencies.consumer.specifier',
        lockValue: '^2.0.0',
      }),
    ]);
  });

  it('rejects stale overrides, settings, patch bytes, and missing importers', () => {
    const fixture = inputs();
    const changed = {
      ...fixture,
      config: { overrides: {}, autoInstallPeers: false },
      patchHashes: { 'native@1.0.0': 'changed-content-hash' },
    };
    changed.lock.importers = {
      '.': changed.lock.importers['.'],
    } as typeof changed.lock.importers;
    const fields = findPnpmLockProblems(changed).map(
      (entry: { field: string }) => entry.field,
    );
    expect(fields).toEqual(
      expect.arrayContaining([
        'importers',
        'overrides',
        'settings.autoInstallPeers',
        'patchedDependencies',
      ]),
    );
  });

  it('checks package-extension configuration against the native pnpm checksum', () => {
    // Independently generated by pnpm 11.25.0 lockfile-only resolution.
    const packageExtensions = {
      '@kontourai/flow-agents@6.2.0': {
        dependencies: { '@kontourai/datum': '0.7.0' },
      },
    };
    const expected = 'sha256-8U/NwfVvJih09yZJqI4A31Zbu76ddMrtGmxoWvtwaaI=';
    expect(pnpmPackageExtensionsChecksum(packageExtensions)).toBe(expected);
    const fixture = inputs();
    const changed = {
      ...fixture,
      config: { ...fixture.config, packageExtensions },
      lock: { ...fixture.lock, packageExtensionsChecksum: expected },
    };
    expect(findPnpmLockProblems(changed)).toEqual([]);
    changed.config.packageExtensions[
      '@kontourai/flow-agents@6.2.0'
    ].dependencies['@kontourai/datum'] = '0.8.0';
    expect(findPnpmLockProblems(changed)).toEqual([
      expect.objectContaining({
        field: 'packageExtensionsChecksum',
        lockValue: expected,
      }),
    ]);
  });

  it('rejects an unresolved snapshot and unsatisfied or missing peers even with a frozen-installable lock', () => {
    const fixture = inputs();
    fixture.lock.snapshots['consumer@2.0.0(peer@3.0.0)'].dependencies.peer =
      '4.0.0';
    expect(findPnpmLockProblems(fixture)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'peer.peer', lockValue: '4.0.0' }),
        expect.objectContaining({ field: 'peer.peer.snapshot' }),
      ]),
    );
    delete (
      fixture.lock.snapshots['consumer@2.0.0(peer@3.0.0)']
        .dependencies as Record<string, string>
    ).peer;
    expect(findPnpmLockProblems(fixture)).toEqual([
      expect.objectContaining({ field: 'peer.peer', lockValue: undefined }),
    ]);
    delete (fixture.lock.snapshots as Record<string, unknown>)[
      'consumer@2.0.0(peer@3.0.0)'
    ];
    expect(findPnpmLockProblems(fixture)).toEqual([
      expect.objectContaining({ field: 'dependencies.consumer.snapshot' }),
    ]);
  });
});
