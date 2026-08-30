import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { productLawObservationTimeoutMs } from '../lib/product-laws.mjs';
import {
  machineConditions,
  resolveVerificationToolchain,
} from '../lib/test-reliability.mjs';
import { coordinateVerification } from '../lib/verification-coordinator.mjs';
import {
  assertInstalledDependenciesMatchLockfile,
  collectDirectDependencyDeclarations,
  findStaleInstalledDependencies,
  resolveLockEntry,
  toLockRelDir,
  VerificationEnvironmentStaleError,
} from '../lib/verification-environment-preflight.mjs';
import { VERIFICATION_RECEIPT_ROOT } from '../lib/verification-request-identity.mjs';
import { submitVerification } from '../lib/verification-submission.mjs';
import { runVerificationCli } from '../run-verification.mjs';

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function writeInstalledPackage(
  root: string,
  name: string,
  version: string,
  relDir = '',
) {
  const dir = join(root, relDir, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'package.json'), { name, version });
}

function removeInstalledPackage(root: string, name: string, relDir = '') {
  rmSync(join(root, relDir, 'node_modules', name), {
    recursive: true,
    force: true,
  });
}

/** A minimal worktree with one root direct dependency and a matching lock. */
function writeCleanWorktree(root: string) {
  writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    dependencies: { 'left-pad': '^1.3.0' },
  });
  writeJson(join(root, 'package-lock.json'), {
    name: 'fixture-root',
    packages: {
      '': { name: 'fixture-root', dependencies: { 'left-pad': '^1.3.0' } },
      'node_modules/left-pad': { version: '1.3.0' },
    },
  });
  writeInstalledPackage(root, 'left-pad', '1.3.0');
}

function makeStale(root: string) {
  writeInstalledPackage(root, 'left-pad', '1.2.0');
}

function makeMatching(root: string) {
  writeInstalledPackage(root, 'left-pad', '1.3.0');
}

function tempRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('findStaleInstalledDependencies (station#4109)', () => {
  it('reports a direct dependency whose installed version does not match the lock', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeCleanWorktree(temp.root);
      makeStale(temp.root);
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root }),
      ).toEqual({
        mismatches: [
          { name: 'left-pad', relDir: '', installed: '1.2.0', locked: '1.3.0' },
        ],
        skipped: [],
        lockfileUnreadable: false,
      });
    } finally {
      temp.remove();
    }
  });

  it('reports a missing installed package as a mismatch', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeCleanWorktree(temp.root);
      removeInstalledPackage(temp.root, 'left-pad');
      const result = findStaleInstalledDependencies({
        repositoryRoot: temp.root,
      });
      expect(result.mismatches).toEqual([
        { name: 'left-pad', relDir: '', installed: undefined, locked: '1.3.0' },
      ]);
    } finally {
      temp.remove();
    }
  });

  it('passes a tree whose installed version matches the lock', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeCleanWorktree(temp.root);
      makeMatching(temp.root);
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root }),
      ).toEqual({ mismatches: [], skipped: [], lockfileUnreadable: false });
    } finally {
      temp.remove();
    }
  });

  it('degrades to no mismatches when there is no root manifest (fixture worktrees with no package.json)', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      // Mirrors the empty worktree directories many coordinator/submission
      // tests already construct via bare mkdirSync -- this preflight must
      // stay inert for them rather than throwing ENOENT.
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root }),
      ).toEqual({ mismatches: [], skipped: [], lockfileUnreadable: false });
    } finally {
      temp.remove();
    }
  });

  it('resolves a workspace-only dependency through its nested node_modules when root has no hoisted copy', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeJson(join(temp.root, 'package.json'), {
        name: 'fixture-root',
        workspaces: ['packages/widget'],
      });
      mkdirSync(join(temp.root, 'packages', 'widget'), { recursive: true });
      writeJson(join(temp.root, 'packages', 'widget', 'package.json'), {
        name: 'widget',
        dependencies: { 'nested-only': '^2.0.0' },
      });
      writeJson(join(temp.root, 'package-lock.json'), {
        name: 'fixture-root',
        packages: {
          '': { name: 'fixture-root', workspaces: ['packages/widget'] },
          'packages/widget': { name: 'widget' },
          'packages/widget/node_modules/nested-only': { version: '2.0.0' },
        },
      });
      writeInstalledPackage(
        temp.root,
        'nested-only',
        '1.9.0',
        'packages/widget',
      );
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root })
          .mismatches,
      ).toEqual([
        {
          name: 'nested-only',
          relDir: 'packages/widget',
          installed: '1.9.0',
          locked: '2.0.0',
        },
      ]);
    } finally {
      temp.remove();
    }
  });

  it('excludes workspace packages themselves from the check', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeJson(join(temp.root, 'package.json'), {
        name: 'fixture-root',
        workspaces: ['packages/widget'],
        dependencies: { '@fixture/widget': '0.0.0' },
      });
      mkdirSync(join(temp.root, 'packages', 'widget'), { recursive: true });
      writeJson(join(temp.root, 'packages', 'widget', 'package.json'), {
        name: '@fixture/widget',
      });
      writeJson(join(temp.root, 'package-lock.json'), {
        name: 'fixture-root',
        packages: {
          '': { name: 'fixture-root' },
          'packages/widget': { name: '@fixture/widget' },
        },
      });
      // No node_modules/@fixture/widget on disk at all -- if the workspace
      // package name were not excluded this would read as "missing".
      expect(
        collectDirectDependencyDeclarations(temp.root).some(
          (declaration) => declaration.name === '@fixture/widget',
        ),
      ).toBe(false);
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root })
          .mismatches,
      ).toEqual([]);
    } finally {
      temp.remove();
    }
  });

  it('resolves an npm: alias by its local declared name, comparing the alias target’s real version', () => {
    // package.json: "foo": "npm:bar@^1.0.0" -- npm installs the ALIAS TARGET
    // (bar's real content, bar's real version) under the LOCAL name "foo" in
    // node_modules, and the lock keys it the same way. Both sides are keyed
    // by "foo" here, so no alias-specific resolution is needed; this fixture
    // proves that stays true rather than asserting it by inspection.
    const temp = tempRoot('station-env-preflight-');
    try {
      writeJson(join(temp.root, 'package.json'), {
        name: 'fixture-root',
        dependencies: { foo: 'npm:bar@^1.0.0' },
      });
      writeJson(join(temp.root, 'package-lock.json'), {
        name: 'fixture-root',
        packages: {
          '': { name: 'fixture-root', dependencies: { foo: 'npm:bar@^1.0.0' } },
          'node_modules/foo': {
            name: 'bar',
            version: '1.2.3',
            resolved: 'https://registry.npmjs.org/bar/-/bar-1.2.3.tgz',
          },
        },
      });
      mkdirSync(join(temp.root, 'node_modules', 'foo'), { recursive: true });
      writeJson(join(temp.root, 'node_modules', 'foo', 'package.json'), {
        name: 'bar',
        version: '1.2.3',
      });
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root }),
      ).toEqual({ mismatches: [], skipped: [], lockfileUnreadable: false });
    } finally {
      temp.remove();
    }
  });
});

describe('findStaleInstalledDependencies scope isolation (station#4109 review H1)', () => {
  // Reproduces the live counterexample from the review verbatim in shape:
  // packages/contracts requires @kontourai/datum@0.8.0 (its own direct
  // dependency, nested), while an UNRELATED root direct dependency of the
  // same name is separately locked at 0.7.0. The two must never be
  // collapsed into one "the" resolution for the name.
  function writeTwoScopeWorktree(root: string) {
    writeJson(join(root, 'package.json'), {
      name: 'fixture-root',
      workspaces: ['packages/contracts'],
      dependencies: { '@fixture/datum': '^0.7.0' },
    });
    mkdirSync(join(root, 'packages', 'contracts'), { recursive: true });
    writeJson(join(root, 'packages', 'contracts', 'package.json'), {
      name: '@fixture/contracts',
      dependencies: { '@fixture/datum': '^0.8.0' },
    });
    writeJson(join(root, 'package-lock.json'), {
      name: 'fixture-root',
      packages: {
        '': {
          name: 'fixture-root',
          workspaces: ['packages/contracts'],
          dependencies: { '@fixture/datum': '^0.7.0' },
        },
        'packages/contracts': {
          name: '@fixture/contracts',
          dependencies: { '@fixture/datum': '^0.8.0' },
        },
        'node_modules/@fixture/datum': { version: '0.7.0' },
        'packages/contracts/node_modules/@fixture/datum': { version: '0.8.0' },
      },
    });
  }

  it('flags only the nested scope when the nested install is stale and root matches', () => {
    const temp = tempRoot('station-env-preflight-scope-');
    try {
      writeTwoScopeWorktree(temp.root);
      writeInstalledPackage(temp.root, '@fixture/datum', '0.7.0'); // root: matches
      writeInstalledPackage(
        temp.root,
        '@fixture/datum',
        '0.7.5', // packages/contracts: stale relative to its own 0.8.0 lock
        'packages/contracts',
      );
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root })
          .mismatches,
      ).toEqual([
        {
          name: '@fixture/datum',
          relDir: 'packages/contracts',
          installed: '0.7.5',
          locked: '0.8.0',
        },
      ]);
    } finally {
      temp.remove();
    }
  });

  it('flags only the root scope when the root install is stale and the nested install matches', () => {
    const temp = tempRoot('station-env-preflight-scope-');
    try {
      writeTwoScopeWorktree(temp.root);
      writeInstalledPackage(temp.root, '@fixture/datum', '0.6.9'); // root: stale
      writeInstalledPackage(
        temp.root,
        '@fixture/datum',
        '0.8.0', // packages/contracts: matches
        'packages/contracts',
      );
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root })
          .mismatches,
      ).toEqual([
        {
          name: '@fixture/datum',
          relDir: '',
          installed: '0.6.9',
          locked: '0.7.0',
        },
      ]);
    } finally {
      temp.remove();
    }
  });

  it('does not false-refuse a platform-absent optional root entry when the nested direct install is healthy', () => {
    const temp = tempRoot('station-env-preflight-scope-');
    try {
      writeJson(join(temp.root, 'package.json'), {
        name: 'fixture-root',
        workspaces: ['packages/contracts'],
        dependencies: { '@fixture/native-widget': '^1.0.0' },
      });
      mkdirSync(join(temp.root, 'packages', 'contracts'), { recursive: true });
      writeJson(join(temp.root, 'packages', 'contracts', 'package.json'), {
        name: '@fixture/contracts',
        dependencies: { '@fixture/native-widget': '^1.0.0' },
      });
      writeJson(join(temp.root, 'package-lock.json'), {
        name: 'fixture-root',
        packages: {
          '': {
            name: 'fixture-root',
            workspaces: ['packages/contracts'],
            dependencies: { '@fixture/native-widget': '^1.0.0' },
          },
          'packages/contracts': {
            name: '@fixture/contracts',
            dependencies: { '@fixture/native-widget': '^1.0.0' },
          },
          // Root's copy is registry-optional and legitimately not installed
          // on this platform (os/cpu restricted).
          'node_modules/@fixture/native-widget': {
            version: '1.0.0',
            optional: true,
          },
          'packages/contracts/node_modules/@fixture/native-widget': {
            version: '1.0.0',
          },
        },
      });
      // No node_modules/@fixture/native-widget at root -- deliberate.
      writeInstalledPackage(
        temp.root,
        '@fixture/native-widget',
        '1.0.0',
        'packages/contracts',
      );
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root }),
      ).toEqual({ mismatches: [], skipped: [], lockfileUnreadable: false });
    } finally {
      temp.remove();
    }
  });

  it('still flags an installed-but-stale optional entry (optional excuses absence, not staleness)', () => {
    const temp = tempRoot('station-env-preflight-scope-');
    try {
      writeJson(join(temp.root, 'package.json'), {
        name: 'fixture-root',
        dependencies: { '@fixture/native-widget': '^1.0.0' },
      });
      writeJson(join(temp.root, 'package-lock.json'), {
        name: 'fixture-root',
        packages: {
          '': {
            name: 'fixture-root',
            dependencies: { '@fixture/native-widget': '^1.0.0' },
          },
          'node_modules/@fixture/native-widget': {
            version: '1.0.0',
            optional: true,
          },
        },
      });
      writeInstalledPackage(temp.root, '@fixture/native-widget', '0.9.0');
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root })
          .mismatches,
      ).toEqual([
        {
          name: '@fixture/native-widget',
          relDir: '',
          installed: '0.9.0',
          locked: '1.0.0',
        },
      ]);
    } finally {
      temp.remove();
    }
  });
});

describe('relDir path-separator normalization (station#4109 review H1, Windows follow-up)', () => {
  // Deliberately platform-independent: `toLockRelDir` is an unconditional
  // backslash-to-forward-slash transform (not gated on the current
  // platform's `path.sep`), so it is exercisable -- and meaningfully
  // discriminating -- on any single platform, including this one.
  it('normalizes a backslash-separated relDir (the Windows path.relative shape) to the lockfile convention', () => {
    expect(toLockRelDir('packages\\contracts')).toBe('packages/contracts');
    expect(toLockRelDir('packages\\widget\\nested')).toBe(
      'packages/widget/nested',
    );
  });

  it('leaves an already forward-slash (POSIX) relDir untouched', () => {
    expect(toLockRelDir('packages/contracts')).toBe('packages/contracts');
    expect(toLockRelDir('')).toBe('');
  });

  it('resolves the nested lock key when fed a hand-built backslash relDir through the normalizer, rather than falling back to root', () => {
    // Same datum-shaped topology as the H1 scope-isolation fixtures above,
    // but constructed by hand directly against resolveLockEntry: a decoy
    // root entry at a DIFFERENT version proves this reads the nested entry,
    // not a root fallback silently reintroduced by an unnormalized key.
    const packages = {
      'node_modules/@fixture/datum': { version: '0.7.0' },
      'packages/contracts/node_modules/@fixture/datum': { version: '0.8.0' },
    };
    const rawWindowsRelDir = 'packages\\contracts';
    const resolved = resolveLockEntry(
      packages,
      toLockRelDir(rawWindowsRelDir),
      '@fixture/datum',
    );
    expect(resolved).toEqual({
      scope: 'packages/contracts',
      entry: { version: '0.8.0' },
    });
  });

  it('feeding resolveLockEntry the RAW (unnormalized) backslash relDir misses the nested key -- pinning why normalization must happen at storage time, not at lookup time', () => {
    const packages = {
      'node_modules/@fixture/datum': { version: '0.7.0' },
      'packages/contracts/node_modules/@fixture/datum': { version: '0.8.0' },
    };
    const resolved = resolveLockEntry(
      packages,
      'packages\\contracts', // never normalized
      '@fixture/datum',
    );
    // Falls back to the root entry instead of finding the nested one --
    // this is the exact bug shape the review flagged, and is why the fix
    // normalizes once at the single point relDir is first computed rather
    // than trusting every call site to do it.
    expect(resolved).toEqual({ scope: '', entry: { version: '0.7.0' } });
  });
});

describe('findStaleInstalledDependencies unverifiable entries (station#4109 review M2)', () => {
  it('names git/file/link/versionless entries as skipped rather than comparing or silently dropping them', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeJson(join(temp.root, 'package.json'), {
        name: 'fixture-root',
        dependencies: {
          'git-dep': 'github:example/git-dep',
          'file-dep': 'file:../file-dep',
          'link-dep': 'link:../link-dep',
          'versionless-dep': 'https://example.test/versionless-dep.tgz',
        },
      });
      writeJson(join(temp.root, 'package-lock.json'), {
        name: 'fixture-root',
        packages: {
          '': { name: 'fixture-root' },
          'node_modules/git-dep': {
            version: '1.0.0',
            resolved:
              'git+https://github.com/example/git-dep.git#abcdef1234567',
          },
          'node_modules/file-dep': {
            version: '1.0.0',
            resolved: 'file:../file-dep',
          },
          'node_modules/link-dep': {
            link: true,
            resolved: '../link-dep',
          },
          'node_modules/versionless-dep': {
            resolved: 'https://example.test/versionless-dep.tgz',
          },
        },
      });
      const result = findStaleInstalledDependencies({
        repositoryRoot: temp.root,
      });
      expect(result.mismatches).toEqual([]);
      expect(
        [...result.skipped].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      ).toEqual([
        { name: 'file-dep', relDir: '', reason: 'file' },
        { name: 'git-dep', relDir: '', reason: 'git' },
        { name: 'link-dep', relDir: '', reason: 'link' },
        { name: 'versionless-dep', relDir: '', reason: 'versionless' },
      ]);
      expect(() =>
        assertInstalledDependenciesMatchLockfile({ repositoryRoot: temp.root }),
      ).not.toThrow();
    } finally {
      temp.remove();
    }
  });
});

describe('findStaleInstalledDependencies malformed lockfile (station#4109 review M3)', () => {
  it('distinguishes an unparseable lockfile from an absent one and refuses rather than passing silently', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeJson(join(temp.root, 'package.json'), {
        name: 'fixture-root',
        dependencies: { 'left-pad': '^1.3.0' },
      });
      writeFileSync(join(temp.root, 'package-lock.json'), '{ not valid json');
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root }),
      ).toEqual({ mismatches: [], skipped: [], lockfileUnreadable: true });

      let caught: unknown;
      try {
        assertInstalledDependenciesMatchLockfile({
          repositoryRoot: temp.root,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(VerificationEnvironmentStaleError);
      const error = caught as InstanceType<
        typeof VerificationEnvironmentStaleError
      >;
      expect(error.disposition).toBe('environment-stale');
      expect(error.reason).toBe('lockfile-unreadable');
      expect(error.message).toContain(
        'package-lock.json unreadable/unsupported shape',
      );
      expect(error.message).toContain('run `npm run dependencies:ci` in');
    } finally {
      temp.remove();
    }
  });

  it('refuses a v1-shaped lockfile (no packages map) instead of silently disabling the gate', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeJson(join(temp.root, 'package.json'), {
        name: 'fixture-root',
        dependencies: { 'left-pad': '^1.3.0' },
      });
      // npm lockfileVersion 1 shape: a "dependencies" tree, no "packages" map.
      writeJson(join(temp.root, 'package-lock.json'), {
        name: 'fixture-root',
        lockfileVersion: 1,
        requires: true,
        dependencies: { 'left-pad': { version: '1.3.0' } },
      });
      writeInstalledPackage(temp.root, 'left-pad', '1.2.0');
      const result = findStaleInstalledDependencies({
        repositoryRoot: temp.root,
      });
      expect(result.lockfileUnreadable).toBe(true);
      expect(result.mismatches).toEqual([]);
      expect(() =>
        assertInstalledDependenciesMatchLockfile({ repositoryRoot: temp.root }),
      ).toThrow(VerificationEnvironmentStaleError);
    } finally {
      temp.remove();
    }
  });

  it('stays inert (absent, not unreadable) when there is no lockfile at all', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeJson(join(temp.root, 'package.json'), {
        name: 'fixture-root',
        dependencies: { 'left-pad': '^1.3.0' },
      });
      expect(
        findStaleInstalledDependencies({ repositoryRoot: temp.root }),
      ).toEqual({ mismatches: [], skipped: [], lockfileUnreadable: false });
    } finally {
      temp.remove();
    }
  });
});

describe('assertInstalledDependenciesMatchLockfile (station#4109)', () => {
  it('throws a named environment-stale error listing the scope and mismatched package', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeCleanWorktree(temp.root);
      makeStale(temp.root);
      let caught: unknown;
      try {
        assertInstalledDependenciesMatchLockfile({
          repositoryRoot: temp.root,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(VerificationEnvironmentStaleError);
      const error = caught as InstanceType<
        typeof VerificationEnvironmentStaleError
      >;
      expect(error.disposition).toBe('environment-stale');
      expect(error.reason).toBe('dependency-mismatch');
      expect(error.mismatches).toEqual([
        { name: 'left-pad', relDir: '', installed: '1.2.0', locked: '1.3.0' },
      ]);
      expect(error.message).toContain(
        'root → left-pad: installed 1.2.0, locked 1.3.0',
      );
    } finally {
      temp.remove();
    }
  });

  it('names the inspected tree, because the remedy runs there and not in the caller', () => {
    // The gate inspects roots the caller is not standing in — the prepared
    // transfer baseline sibling, or a frozen worktree. An unqualified "run
    // npm run dependencies:ci" sends the operator to repair their own tree,
    // which changes nothing and reproduces the identical error.
    const temp = tempRoot('station-env-preflight-');
    try {
      writeCleanWorktree(temp.root);
      makeStale(temp.root);
      let caught: unknown;
      try {
        assertInstalledDependenciesMatchLockfile({ repositoryRoot: temp.root });
      } catch (error) {
        caught = error;
      }
      const error = caught as InstanceType<
        typeof VerificationEnvironmentStaleError
      >;
      expect(error.repositoryRoot).toBe(temp.root);
      expect(error.message).toContain(temp.root);
      expect(error.message).toContain(
        `run \`npm run dependencies:ci\` in ${temp.root}`,
      );
    } finally {
      temp.remove();
    }
  });

  it('does not throw for a matching tree', () => {
    const temp = tempRoot('station-env-preflight-');
    try {
      writeCleanWorktree(temp.root);
      makeMatching(temp.root);
      expect(() =>
        assertInstalledDependenciesMatchLockfile({
          repositoryRoot: temp.root,
        }),
      ).not.toThrow();
    } finally {
      temp.remove();
    }
  });
});

// Matches the full current return shape of collectVerificationProvenance
// (scripts/lib/test-reliability.mjs) -- collectRepositoryIdentity's
// repositoryId/repositoryRoot/worktree/commonGitDirectory/origin,
// collectWorkspaceProvenance's headSha/dirty/workspaceDigest/nodeVersion/
// platform/arch/machine, plus collectVerificationProvenance's own
// dependencyDigest/toolchain/toolchainIdentity/environmentDigest/
// productLawObservationTimeoutMs. Only a subset of these actually
// participates in receipt identity (see createVerificationRequest in
// verification-receipt.mjs), but coordinateVerification/submitVerification's
// `collectProvenance` option is typed from the real function's full return
// type, so a fake supplied here must satisfy all of it or the object-literal
// assignment fails to typecheck (station#4109, upstream provenance shape
// change: dirty/machine/repositoryRoot/commonGitDirectory/origin/
// productLawObservationTimeoutMs were added after this file was written).
function provenance(worktree: string, identity = 'stable') {
  const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const toolchain = resolveVerificationToolchain({ cwd: worktree });
  return {
    repositoryId: hash('repository'),
    repositoryRoot: worktree,
    worktree,
    commonGitDirectory: join(worktree, '.git'),
    origin: '',
    headSha: 'b'.repeat(40),
    dirty: false,
    workspaceDigest: hash(`workspace-${identity}`),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    machine: machineConditions(),
    dependencyDigest: 'c'.repeat(64),
    toolchain: toolchain.toolchain,
    toolchainIdentity: toolchain.identity,
    environmentDigest: 'e'.repeat(64),
    productLawObservationTimeoutMs: productLawObservationTimeoutMs(),
  };
}

function coordinatorFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const worktree = join(root, 'worktree');
  mkdirSync(worktree);
  return {
    root,
    worktree,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('full-regression admission preflight (station#4109 gate probe)', () => {
  it('refuses a stale worktree before any phase is admitted, and never publishes a receipt', async () => {
    const temp = coordinatorFixture('station-env-preflight-coordinator-');
    const runner = async () => ({ status: 0 });
    try {
      writeCleanWorktree(temp.worktree);
      makeStale(temp.worktree);

      await expect(
        coordinateVerification({
          laneId: 'test-changed',
          root: temp.root,
          cwd: temp.worktree,
          collectProvenance: () => provenance(temp.worktree, 'stale'),
          runner,
        }),
      ).rejects.toMatchObject({
        name: 'VerificationEnvironmentStaleError',
        disposition: 'environment-stale',
      });

      // Gate probe: a refusal this early must never reach receipt
      // publication -- there is nothing under the worktree's receipt root,
      // and the coordinator root holds no admitted/finished job for it.
      expect(existsSync(join(temp.worktree, VERIFICATION_RECEIPT_ROOT))).toBe(
        false,
      );
      const requestsRoot = join(temp.root, 'requests');
      const remainingJobs = existsSync(requestsRoot)
        ? readdirSync(requestsRoot)
        : [];
      expect(remainingJobs).toEqual([]);

      // Re-running the identical request must refuse again, not reuse or
      // cache the prior refusal as a completed/reusable result.
      await expect(
        coordinateVerification({
          laneId: 'test-changed',
          root: temp.root,
          cwd: temp.worktree,
          collectProvenance: () => provenance(temp.worktree, 'stale'),
          runner,
        }),
      ).rejects.toMatchObject({ disposition: 'environment-stale' });
    } finally {
      temp.remove();
    }
  });

  it('admits normally once the tree matches the lock (negative control)', async () => {
    const temp = coordinatorFixture('station-env-preflight-coordinator-');
    try {
      writeCleanWorktree(temp.worktree);
      makeMatching(temp.worktree);

      const result = await coordinateVerification({
        laneId: 'test-changed',
        root: temp.root,
        cwd: temp.worktree,
        collectProvenance: () => provenance(temp.worktree, 'matching'),
        runner: async () => ({ status: 0 }),
      });

      expect(result.receipt).toBeDefined();
      expect(result.receipt.terminal.passed).toBe(true);
    } finally {
      temp.remove();
    }
  });
});

describe('submitVerification preflight (station#4109)', () => {
  it('refuses a stale worktree before acquiring a handoff', async () => {
    const temp = coordinatorFixture('station-env-preflight-submission-');
    try {
      writeCleanWorktree(temp.worktree);
      makeStale(temp.worktree);

      let spawned = false;
      await expect(
        submitVerification({
          laneId: 'full-regression',
          cwd: temp.worktree,
          root: temp.root,
          collectProvenance: () => provenance(temp.worktree, 'submit-stale'),
          spawnWorker: () => {
            spawned = true;
            throw new Error('must not spawn a worker after a refusal');
          },
        }),
      ).rejects.toMatchObject({ disposition: 'environment-stale' });
      expect(spawned).toBe(false);
      const submissionsRoot = join(temp.root, 'submissions');
      expect(
        existsSync(submissionsRoot) ? readdirSync(submissionsRoot) : [],
      ).toEqual([]);
    } finally {
      temp.remove();
    }
  });
});

describe('run-verification CLI end-to-end preflight (station#4109)', () => {
  it('refuses a stale worktree before the public CLI coordinates a lane', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'station-env-preflight-cli-'));
    const originalCwd = process.cwd();
    const PACKAGE_NAME = '@kontourai/station-fixture-widget';
    try {
      writeJson(join(fixture, 'package.json'), {
        name: 'station-fixture',
        workspaces: ['packages/widget'],
        dependencies: { 'left-pad': '^1.3.0' },
      });
      // node_modules must be gitignored: collectWorkspaceProvenance hashes
      // every untracked file (a symlink is not a regular file) and would
      // otherwise choke on the workspace-package symlink installed below.
      writeFileSync(join(fixture, '.gitignore'), 'node_modules\n');
      const packageDir = join(fixture, 'packages', 'widget');
      mkdirSync(packageDir, { recursive: true });
      writeJson(join(packageDir, 'package.json'), {
        name: PACKAGE_NAME,
        version: '0.0.0',
        main: 'index.js',
      });
      writeFileSync(
        join(packageDir, 'index.js'),
        'export const source = true;\n',
      );
      const scope = join(fixture, 'node_modules', '@kontourai');
      mkdirSync(scope, { recursive: true });
      symlinkSync(
        relative(scope, packageDir),
        join(fixture, 'node_modules', PACKAGE_NAME),
        'dir',
      );
      writeJson(join(fixture, 'package-lock.json'), {
        name: 'station-fixture',
        packages: {
          '': {
            name: 'station-fixture',
            workspaces: ['packages/widget'],
            dependencies: { 'left-pad': '^1.3.0' },
          },
          'packages/widget': { name: PACKAGE_NAME, version: '0.0.0' },
          'node_modules/left-pad': { version: '1.3.0' },
        },
      });
      writeInstalledPackage(fixture, 'left-pad', '1.2.0');

      execFileSync('git', ['init', '--quiet', fixture]);
      execFileSync('git', ['config', 'user.email', 'station@example.test'], {
        cwd: fixture,
      });
      execFileSync('git', ['config', 'user.name', 'Station'], {
        cwd: fixture,
      });
      execFileSync(
        'git',
        ['remote', 'add', 'origin', 'https://example.test/station.git'],
        { cwd: fixture },
      );
      execFileSync('git', ['add', 'package.json', 'package-lock.json'], {
        cwd: fixture,
      });
      execFileSync('git', ['commit', '--quiet', '-m', 'initial'], {
        cwd: fixture,
      });
      process.chdir(fixture);

      const errors: string[] = [];
      await expect(
        runVerificationCli(['request', 'ci-fast'], {
          output: () => undefined,
          error: (message: string) => errors.push(message),
        }),
      ).resolves.toBe(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('environment-stale');
      expect(errors[0]).toContain(
        'root → left-pad: installed 1.2.0, locked 1.3.0',
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
