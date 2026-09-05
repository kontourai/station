import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runChangedVerification } from '../run-changed-verification.mjs';
import { runFocusedTests } from '../run-focused-tests.mjs';
import { runVerificationCli } from '../run-verification.mjs';
import {
  assertWorkspacePackageProvenance,
  listWorkspacePackageManifests,
} from '../workspace-dependency-provenance.mjs';

const PACKAGE_NAME = '@kontourai/station-contracts';

function writeWorkspacePackage(
  root: string,
  {
    directory = 'packages/contracts',
    manifest = { name: PACKAGE_NAME, version: '0.0.0', main: 'index.js' },
    entry = true,
  }: {
    directory?: string;
    manifest?: Record<string, unknown>;
    entry?: boolean;
  } = {},
) {
  const packageRoot = join(root, directory);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(manifest)}\n`,
  );
  if (entry)
    writeFileSync(
      join(packageRoot, 'index.js'),
      'export const source = true;\n',
    );
  return packageRoot;
}

function writeWorktree(
  root: string,
  packageOptions: Parameters<typeof writeWorkspacePackage>[1] = {},
) {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'station-fixture', workspaces: ['packages/contracts'] })}\n`,
  );
  return writeWorkspacePackage(root, packageOptions);
}

function linkWorkspacePackage(
  root: string,
  target: string,
  packageName = PACKAGE_NAME,
) {
  const scope = join(root, 'node_modules', '@kontourai');
  mkdirSync(scope, { recursive: true });
  const link = join(root, 'node_modules', packageName);
  symlinkSync(relative(scope, target), link, 'dir');
  return link;
}

describe('workspace dependency provenance preflight', () => {
  it('rejects Node resolution through a stale sibling checkout before compilation', () => {
    const fixture = mkdtempSync(
      join(tmpdir(), 'station-workspace-provenance-'),
    );
    const active = join(fixture, 'active');
    const stale = join(fixture, 'stale');
    mkdirSync(active);
    mkdirSync(stale);
    try {
      writeWorktree(active);
      const stalePackage = writeWorkspacePackage(stale);
      // Match npm's relative workspace topology: the active scope is linked
      // to a sibling checkout, whose package link resolves from that sibling.
      linkWorkspacePackage(stale, stalePackage);
      const activeDependencies = join(active, 'node_modules');
      mkdirSync(activeDependencies, { recursive: true });
      symlinkSync(
        relative(activeDependencies, join(stale, 'node_modules', '@kontourai')),
        join(activeDependencies, '@kontourai'),
        'dir',
      );
      expect(readlinkSync(join(activeDependencies, '@kontourai'))).toBe(
        relative(activeDependencies, join(stale, 'node_modules', '@kontourai')),
      );

      expect(() =>
        assertWorkspacePackageProvenance({ repositoryRoot: active }),
      ).toThrow(
        `workspace dependency provenance rejected ${PACKAGE_NAME}: Node resolved ${realpathSync(stalePackage)}`,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects a declared workspace root that is itself symlinked outside the worktree', () => {
    const fixture = mkdtempSync(
      join(tmpdir(), 'station-workspace-provenance-'),
    );
    const active = join(fixture, 'active');
    const foreign = join(fixture, 'foreign');
    mkdirSync(active);
    mkdirSync(foreign);
    try {
      writeFileSync(
        join(active, 'package.json'),
        `${JSON.stringify({ name: 'station-fixture', workspaces: ['packages/contracts'] })}\n`,
      );
      const foreignPackage = writeWorkspacePackage(foreign);
      mkdirSync(join(active, 'packages'), { recursive: true });
      symlinkSync(foreignPackage, join(active, 'packages/contracts'), 'dir');
      linkWorkspacePackage(active, foreignPackage);

      expect(() =>
        assertWorkspacePackageProvenance({ repositoryRoot: active }),
      ).toThrow(
        'workspace dependency provenance rejected declared workspace outside the active worktree',
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('accepts Node resolution to the active worktree package', () => {
    const fixture = mkdtempSync(
      join(tmpdir(), 'station-workspace-provenance-'),
    );
    try {
      const activePackage = writeWorktree(fixture);
      const link = linkWorkspacePackage(fixture, activePackage);
      expect(readlinkSync(link)).toBe(
        relative(join(fixture, 'node_modules', '@kontourai'), activePackage),
      );

      const result = assertWorkspacePackageProvenance({
        repositoryRoot: fixture,
      });
      expect(result.packages).toEqual([
        expect.objectContaining({
          name: PACKAGE_NAME,
          declaredRoot: realpathSync(activePackage),
          resolvedRoot: realpathSync(activePackage),
        }),
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('canonicalizes an aliased repository root before containment checks', () => {
    const fixture = mkdtempSync(
      join(tmpdir(), 'station-workspace-provenance-'),
    );
    const realRoot = join(fixture, 'real');
    const aliasRoot = join(fixture, 'alias');
    mkdirSync(realRoot);
    try {
      const activePackage = writeWorktree(realRoot);
      symlinkSync(realRoot, aliasRoot, 'dir');

      expect(listWorkspacePackageManifests(aliasRoot)).toEqual([
        expect.objectContaining({
          name: PACKAGE_NAME,
          directory: realpathSync(activePackage),
        }),
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('falls back to the fixture-local manifest when an exports entry is unbuilt', () => {
    const fixture = mkdtempSync(
      join(tmpdir(), 'station-workspace-provenance-'),
    );
    try {
      const activePackage = writeWorktree(fixture, {
        manifest: {
          name: PACKAGE_NAME,
          version: '0.0.0',
          type: 'module',
          exports: { '.': './dist/unbuilt.mjs' },
        },
        entry: false,
      });
      linkWorkspacePackage(fixture, activePackage);

      const result = assertWorkspacePackageProvenance({
        repositoryRoot: fixture,
      });
      expect(result.packages).toEqual([
        expect.objectContaining({
          name: PACKAGE_NAME,
          resolvedEntry: realpathSync(join(activePackage, 'package.json')),
          resolvedRoot: realpathSync(activePackage),
        }),
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('does not start the changed-test compiler after a preflight failure', () => {
    const compile = vi.fn();
    const changedPaths = vi.fn();
    expect(() =>
      runChangedVerification(['--base=HEAD'], {
        assertDependencyProvenance: () => {
          throw new Error('injected provenance guard');
        },
        changedPathsFn: changedPaths,
        run: compile,
      }),
    ).toThrow('injected provenance guard');
    expect(changedPaths).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });

  it('checks focused-test provenance before spawning Vitest', async () => {
    const spawnProcess = vi.fn();
    await expect(
      runFocusedTests(
        ['scripts/__tests__/workspace-dependency-provenance.test.ts'],
        {
          assertDependencyProvenance: () => {
            throw new Error('injected provenance guard');
          },
          spawnProcess,
        },
      ),
    ).rejects.toThrow('injected provenance guard');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('rejects a stale workspace before the public verification CLI coordinates a lane', async () => {
    const fixture = mkdtempSync(
      join(tmpdir(), 'station-workspace-provenance-'),
    );
    const active = join(fixture, 'active');
    const stale = join(fixture, 'stale');
    const originalCwd = process.cwd();
    const errors: string[] = [];
    mkdirSync(active);
    mkdirSync(stale);
    try {
      writeWorktree(active);
      const stalePackage = writeWorkspacePackage(stale);
      linkWorkspacePackage(stale, stalePackage);
      const activeDependencies = join(active, 'node_modules');
      mkdirSync(activeDependencies, { recursive: true });
      symlinkSync(
        relative(activeDependencies, join(stale, 'node_modules', '@kontourai')),
        join(activeDependencies, '@kontourai'),
        'dir',
      );
      execFileSync('git', ['init', '--quiet', active]);
      process.chdir(active);

      await expect(
        runVerificationCli(['request', 'ci-fast'], {
          output: () => undefined,
          error: (message: string) => errors.push(message),
        }),
      ).resolves.toBe(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(
        `workspace dependency provenance rejected ${PACKAGE_NAME}`,
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

it('rejects disagreement between npm command workspace metadata and pnpm installation workspaces', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'station-pnpm-workspaces-'));
  try {
    writeWorktree(fixture);
    writeFileSync(
      join(fixture, 'pnpm-workspace.yaml'),
      'packages: [packages/other]\n',
    );
    expect(() => listWorkspacePackageManifests(fixture)).toThrow(
      'workspaces to match pnpm-workspace.yaml',
    );
    writeFileSync(
      join(fixture, 'pnpm-workspace.yaml'),
      'packages: [packages/contracts]\n',
    );
    expect(listWorkspacePackageManifests(fixture)).toHaveLength(1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe('pnpm workspace importer ownership', () => {
  function fixture(root: string) {
    const workspaces = ['packages/contracts', 'packages/consumer'];
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture-root',
        packageManager: 'pnpm@11.25.0',
        workspaces,
        dependencies: { [PACKAGE_NAME]: 'workspace:*' },
      }),
    );
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      `packages: ${JSON.stringify(workspaces)}\n`,
    );
    const contracts = writeWorkspacePackage(root);
    const consumer = writeWorkspacePackage(root, {
      directory: 'packages/consumer',
      manifest: { name: '@kontourai/consumer', version: '1.0.0' },
    });
    linkWorkspacePackage(root, contracts);
    return { contracts, consumer };
  }

  it('accepts an unreferenced workspace member without inventing a root dependency link', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-pnpm-provenance-'));
    try {
      const { contracts } = fixture(root);
      const result = assertWorkspacePackageProvenance({ repositoryRoot: root });
      expect(result.packages).toEqual([
        expect.objectContaining({
          name: PACKAGE_NAME,
          resolvedRoot: realpathSync(contracts),
          importerRoot: realpathSync(root),
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves declared workspace dependencies from each importer and rejects a foreign nested link despite a healthy root link', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-pnpm-provenance-'));
    const foreign = mkdtempSync(join(tmpdir(), 'station-pnpm-foreign-'));
    try {
      const { contracts, consumer } = fixture(root);
      writeFileSync(
        join(consumer, 'package.json'),
        JSON.stringify({
          name: '@kontourai/consumer',
          version: '1.0.0',
          dependencies: { [PACKAGE_NAME]: 'workspace:*' },
        }),
      );
      const nestedLink = linkWorkspacePackage(consumer, contracts);
      expect(
        assertWorkspacePackageProvenance({ repositoryRoot: root }).packages,
      ).toHaveLength(2);
      rmSync(nestedLink);
      linkWorkspacePackage(consumer, writeWorkspacePackage(foreign));
      expect(() =>
        assertWorkspacePackageProvenance({ repositoryRoot: root }),
      ).toThrow(`outside the active worktree ${realpathSync(root)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('rejects a registry copy inside the worktree in place of its declared workspace source', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-pnpm-provenance-'));
    try {
      fixture(root);
      rmSync(join(root, 'node_modules', PACKAGE_NAME));
      writeWorkspacePackage(root, {
        directory: `node_modules/${PACKAGE_NAME}`,
      });
      expect(() =>
        assertWorkspacePackageProvenance({ repositoryRoot: root }),
      ).toThrow('instead of declared workspace');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
