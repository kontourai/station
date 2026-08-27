import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  install,
  isOnPath,
  planInstall,
  stampFor,
  withShebang,
} from '../install-station-dev.mjs';
import {
  distFreshnessVerdict,
  findCheckoutRoot,
  identificationLine,
  isStationCheckoutRoot,
  readGitRef,
  resolveNodeExecutable,
  run,
} from '../station-dev.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shimPath = join(repoRoot, 'scripts', 'station-dev.mjs');

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds a minimal fake Station checkout under a fresh temp directory. */
function makeFakeCheckout() {
  const root = makeTempDir('station-dev-checkout-');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@kontourai/station-core', version: '0.0.0' }),
  );
  mkdirSync(join(root, 'packages', 'cli', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'cli', 'dist'), { recursive: true });
  return root;
}

describe('isStationCheckoutRoot / findCheckoutRoot', () => {
  it('recognizes a directory with the marker package name and packages/cli', () => {
    const root = makeFakeCheckout();
    expect(isStationCheckoutRoot(root)).toBe(true);
  });

  it('rejects the marker name alone without packages/cli', () => {
    const root = makeTempDir('station-dev-nocli-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@kontourai/station-core' }),
    );
    expect(isStationCheckoutRoot(root)).toBe(false);
  });

  it('rejects packages/cli alone without the marker name', () => {
    const root = makeTempDir('station-dev-wrongname-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'some-other-package' }),
    );
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    expect(isStationCheckoutRoot(root)).toBe(false);
  });

  it('rejects a directory with no package.json, and an unparseable one', () => {
    const root = makeTempDir('station-dev-nomanifest-');
    expect(isStationCheckoutRoot(root)).toBe(false);
    writeFileSync(join(root, 'package.json'), '{ not json');
    expect(isStationCheckoutRoot(root)).toBe(false);
  });

  it('finds the checkout root from a nested subdirectory', () => {
    const root = makeFakeCheckout();
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    expect(findCheckoutRoot(deep)).toBe(root);
  });

  it('finds a checkout when standing at its own root', () => {
    const root = makeFakeCheckout();
    expect(findCheckoutRoot(root)).toBe(root);
  });

  it('returns null when no checkout is found before the filesystem root', () => {
    const outside = makeTempDir('station-dev-outside-');
    expect(findCheckoutRoot(outside)).toBeNull();
  });

  it('stops at the innermost checkout, not an outer one', () => {
    const outer = makeFakeCheckout();
    const innerRoot = join(outer, 'nested-checkout');
    mkdirSync(innerRoot, { recursive: true });
    writeFileSync(
      join(innerRoot, 'package.json'),
      JSON.stringify({ name: '@kontourai/station-core' }),
    );
    mkdirSync(join(innerRoot, 'packages', 'cli', 'src'), { recursive: true });
    const deep = join(innerRoot, 'x');
    mkdirSync(deep, { recursive: true });
    expect(findCheckoutRoot(deep)).toBe(innerRoot);
  });
});

describe('distFreshnessVerdict', () => {
  it('reports missing when dist/station.mjs does not exist', () => {
    const root = makeFakeCheckout();
    expect(distFreshnessVerdict(root)).toBe('missing');
  });

  it('reports fresh when the dist file is newer than every src file', () => {
    const root = makeFakeCheckout();
    const srcFile = join(root, 'packages', 'cli', 'src', 'bin.ts');
    const distFile = join(root, 'packages', 'cli', 'dist', 'station.mjs');
    writeFileSync(srcFile, '// src');
    writeFileSync(distFile, '// dist');
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(srcFile, older, older);
    utimesSync(distFile, newer, newer);
    expect(distFreshnessVerdict(root)).toBe('fresh');
  });

  it('reports stale when a src file is newer than the dist file', () => {
    const root = makeFakeCheckout();
    const srcFile = join(root, 'packages', 'cli', 'src', 'bin.ts');
    const distFile = join(root, 'packages', 'cli', 'dist', 'station.mjs');
    writeFileSync(distFile, '// dist');
    const older = new Date(Date.now() - 60_000);
    utimesSync(distFile, older, older);
    writeFileSync(srcFile, '// edited after build');
    const newer = new Date();
    utimesSync(srcFile, newer, newer);
    expect(distFreshnessVerdict(root)).toBe('stale');
  });

  it('reports stale for a nested src file, not just top-level ones', () => {
    const root = makeFakeCheckout();
    const distFile = join(root, 'packages', 'cli', 'dist', 'station.mjs');
    writeFileSync(distFile, '// dist');
    const older = new Date(Date.now() - 60_000);
    utimesSync(distFile, older, older);
    const nestedSrc = join(
      root,
      'packages',
      'cli',
      'src',
      'commands',
      'nested.ts',
    );
    mkdirSync(dirname(nestedSrc), { recursive: true });
    writeFileSync(nestedSrc, '// nested');
    const newer = new Date();
    utimesSync(nestedSrc, newer, newer);
    expect(distFreshnessVerdict(root)).toBe('stale');
  });

  it('treats an empty src tree as fresh (nothing to compare against)', () => {
    const root = makeFakeCheckout();
    const distFile = join(root, 'packages', 'cli', 'dist', 'station.mjs');
    writeFileSync(distFile, '// dist');
    expect(distFreshnessVerdict(root)).toBe('fresh');
  });
});

describe('readGitRef', () => {
  it('reads a branch name from an ordinary .git directory', () => {
    const root = makeTempDir('station-dev-git-dir-');
    const gitDir = join(root, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feat/example\n');
    expect(readGitRef(root)).toBe('feat/example');
  });

  it('reads a short SHA for a detached HEAD', () => {
    const root = makeTempDir('station-dev-git-detached-');
    const gitDir = join(root, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      join(gitDir, 'HEAD'),
      '0123456789abcdef0123456789abcdef01234567\n',
    );
    expect(readGitRef(root)).toBe('0123456789ab');
  });

  it('follows a linked worktree .git FILE (gitdir: <path>) to its own HEAD', () => {
    const root = makeTempDir('station-dev-worktree-');
    const realGitDir = makeTempDir('station-dev-worktree-realgit-');
    mkdirSync(realGitDir, { recursive: true });
    writeFileSync(join(realGitDir, 'HEAD'), 'ref: refs/heads/lane/nine\n');
    writeFileSync(join(root, '.git'), `gitdir: ${realGitDir}\n`);
    expect(readGitRef(root)).toBe('lane/nine');
  });

  it("resolves a RELATIVE gitdir path against the .git file's own directory", () => {
    const root = makeTempDir('station-dev-worktree-rel-');
    mkdirSync(join(root, '.git-real'), { recursive: true });
    writeFileSync(
      join(root, '.git-real', 'HEAD'),
      'ref: refs/heads/rel-branch\n',
    );
    writeFileSync(join(root, '.git'), 'gitdir: .git-real\n');
    expect(readGitRef(root)).toBe('rel-branch');
  });

  it('returns null when there is no .git at all', () => {
    const root = makeTempDir('station-dev-nogit-');
    expect(readGitRef(root)).toBeNull();
  });

  it('degrades identificationLine to just the root when no ref is readable', () => {
    const root = makeTempDir('station-dev-nogit-id-');
    expect(identificationLine(root)).toBe(`station-dev: ${root}`);
  });

  it('identificationLine includes the ref when one is readable', () => {
    const root = makeTempDir('station-dev-withgit-id-');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(identificationLine(root)).toBe(`station-dev: ${root} @ main`);
  });
});

describe('resolveNodeExecutable', () => {
  it('falls back to the current Node when mise is unavailable', () => {
    const spawn = () => {
      throw new Error('ENOENT: mise not found');
    };
    expect(resolveNodeExecutable({ spawn })).toBe(process.execPath);
  });

  it('falls back when mise reports a non-zero status', () => {
    const spawn = () => ({ status: 1, stdout: '', error: undefined });
    expect(resolveNodeExecutable({ spawn })).toBe(process.execPath);
  });

  it('falls back when the mise-reported directory has no bin/node', () => {
    const missingDir = join(
      makeTempDir('station-dev-mise-empty-'),
      'nonexistent',
    );
    const spawn = () => ({
      status: 0,
      stdout: `${missingDir}\n`,
      error: undefined,
    });
    expect(resolveNodeExecutable({ spawn })).toBe(process.execPath);
  });

  it('uses the mise-reported bin/node when it exists', () => {
    const miseDir = makeTempDir('station-dev-mise-real-');
    mkdirSync(join(miseDir, 'bin'), { recursive: true });
    writeFileSync(join(miseDir, 'bin', 'node'), '#!/bin/sh\n');
    const spawn = () => ({
      status: 0,
      stdout: `${miseDir}\n`,
      error: undefined,
    });
    expect(resolveNodeExecutable({ spawn })).toBe(join(miseDir, 'bin', 'node'));
  });
});

describe('run (pure orchestration, stubbed spawn)', () => {
  it('exits 1 with the npx pointer when no checkout is found', () => {
    const outside = makeTempDir('station-dev-run-outside-');
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = run([], { cwd: outside });
      expect(code).toBe(1);
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(stderrChunks.join('')).toContain('npx @kontourai/station-cli@');
  });

  it('exits 1 naming npm run build:cli when dist is missing', () => {
    const root = makeFakeCheckout();
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = run([], { cwd: root });
      expect(code).toBe(1);
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(stderrChunks.join('')).toContain('npm run build:cli');
  });

  it('delegates to the resolved dist file with the given args and propagates the exit code', () => {
    const root = makeFakeCheckout();
    const distFile = join(root, 'packages', 'cli', 'dist', 'station.mjs');
    writeFileSync(distFile, '// dist');
    const calls: { cmd: string; args: string[] }[] = [];
    // The same stub `spawn` also backs resolveNodeExecutable's internal
    // `mise where node@24` probe, so it is called once for that (falling
    // back to process.execPath here, since this stub never reports success)
    // and once more for the actual delegated dispatch.
    const spawn = (cmd: string, args: string[] = []) => {
      calls.push({ cmd, args });
      return { status: 7, error: undefined };
    };
    const code = run(['agents', 'list'], { cwd: root, spawn });
    expect(code).toBe(7);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ cmd: 'mise', args: ['where', 'node@24'] });
    const dispatch = calls[1];
    expect(dispatch.cmd).toBe(process.execPath);
    expect(dispatch.args).toEqual([distFile, 'agents', 'list']);
  });

  it('reports a launch failure as exit 1', () => {
    const root = makeFakeCheckout();
    writeFileSync(
      join(root, 'packages', 'cli', 'dist', 'station.mjs'),
      '// dist',
    );
    const spawn = () => ({ status: null, error: new Error('boom') });
    const code = run([], { cwd: root, spawn });
    expect(code).toBe(1);
  });
});

describe('station-dev as a real subprocess', () => {
  it("runs this repo's own build and reaches the real CLI usage output", () => {
    const result = spawnSync('node', [shimPath, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/^station-dev: .+\n$/);
    expect(result.stdout).toContain('Station CLI (@kontourai/station-cli)');
  });

  it('exits 1 with the npx pointer when run from outside any checkout', () => {
    const outside = makeTempDir('station-dev-subprocess-outside-');
    const result = spawnSync('node', [shimPath, '--help'], {
      cwd: outside,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('npx @kontourai/station-cli@');
    expect(result.stderr).toContain('no Station checkout found');
  });
});

describe('install-station-dev: planInstall (refuse-to-overwrite guard)', () => {
  it('writes when nothing exists at the destination yet', () => {
    const plan = planInstall({
      sourceContent: '// station-dev-shim-marker: v1\nx',
      existingContent: undefined,
    });
    expect(plan.action).toBe('write');
  });

  it('writes (upgrades) when the existing file carries the shim marker', () => {
    const plan = planInstall({
      sourceContent: '// station-dev-shim-marker: v1\nnew',
      existingContent:
        '#!/usr/bin/env node\n// station-dev-shim-marker: v1\nold',
    });
    expect(plan.action).toBe('write');
  });

  it('refuses when the existing file lacks the shim marker', () => {
    const plan = planInstall({
      sourceContent: '// station-dev-shim-marker: v1\nnew',
      existingContent: '#!/usr/bin/env node\necho "not station-dev"\n',
    });
    expect(plan.action).toBe('refuse');
  });

  it('prepends a shebang only when one is not already present', () => {
    expect(withShebang('no shebang here')).toBe(
      '#!/usr/bin/env node\nno shebang here',
    );
    expect(withShebang('#!/usr/bin/env node\nalready has one')).toBe(
      '#!/usr/bin/env node\nalready has one',
    );
  });

  it('stampFor is stable for identical content and differs for different content', () => {
    expect(stampFor('a')).toBe(stampFor('a'));
    expect(stampFor('a')).not.toBe(stampFor('b'));
    expect(stampFor('a')).toHaveLength(8);
  });

  it('isOnPath finds an exact directory entry, not a prefix match', () => {
    expect(
      isOnPath('/foo/bin', { pathEnv: '/usr/bin:/foo/bin:/bin', sep: ':' }),
    ).toBe(true);
    expect(
      isOnPath('/foo/bi', { pathEnv: '/usr/bin:/foo/bin:/bin', sep: ':' }),
    ).toBe(false);
  });
});

describe('install-station-dev: install (filesystem)', () => {
  it('installs the real shim to a fresh destDir and marks it executable', () => {
    const destDir = makeTempDir('station-dev-install-dest-');
    const result = install({
      sourcePath: shimPath,
      destDir,
      env: { PATH: destDir },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.destPath).toBe(join(destDir, 'station-dev'));
    expect(result.onPath).toBe(true);
    const spawned = spawnSync('node', [result.destPath, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(spawned.status).toBe(0);
    expect(spawned.stdout).toContain('Station CLI (@kontourai/station-cli)');
  });

  it('reports onPath: false when the destination directory is not on PATH', () => {
    const destDir = makeTempDir('station-dev-install-notpath-');
    const result = install({
      sourcePath: shimPath,
      destDir,
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.onPath).toBe(false);
  });

  it('refuses to overwrite a pre-existing unrelated file, and does not touch it', () => {
    const destDir = makeTempDir('station-dev-install-conflict-');
    const destPath = join(destDir, 'station-dev');
    writeFileSync(destPath, '#!/bin/sh\necho "someone else installed this"\n');
    const result = install({
      sourcePath: shimPath,
      destDir,
      env: { PATH: '' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('refusing to overwrite');
    expect(readFileSync(destPath, 'utf8')).toContain(
      'someone else installed this',
    );
  });

  it('upgrades a previously-installed shim in place', () => {
    const destDir = makeTempDir('station-dev-install-upgrade-');
    const first = install({ sourcePath: shimPath, destDir, env: { PATH: '' } });
    expect(first.ok).toBe(true);
    const second = install({
      sourcePath: shimPath,
      destDir,
      env: { PATH: '' },
    });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    // Same source, same bytes in -> same stamp out: an upgrade from the same
    // shim version is idempotent and verifiable.
    expect(second.stamp).toBe(first.stamp);
  });
});
