/**
 * The hardened git invocation plugin publishing uses (epic #2323 S6,
 * security review H1/H2/M1), driven against real repositories.
 *
 * These tests plant repo-local config that the route's allowlist would
 * refuse before git ever ran, and call the git layer DIRECTLY. That is on
 * purpose: they prove the second line of defence on its own, so removing an
 * override turns them red even though the allowlist would still stand in
 * front of it at the route.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  checkRepositoryConfig,
  runPublishGit,
  streamPublishStatus,
} from '../plugin-publish-git.js';

let root: string;
let repo: string;
let marker: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A shell command that proves it ran by creating the marker file. */
function touchMarker(): string {
  return `touch '${marker}'; false`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'station-plugin-publish-git-'));
  repo = join(root, 'repo');
  marker = join(root, 'marker');
  mkdirSync(repo);
  const globalConfig = join(root, 'gitconfig');
  writeFileSync(
    globalConfig,
    '[user]\n\tname = T\n\temail = t@example.test\n[init]\n\tdefaultBranch = main\n',
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  git(repo, ['init', '--quiet']);
  writeFileSync(join(repo, 'plugin.json'), '{}');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const LIMITS = { maxPaths: 1000, timeoutMs: 15_000 };

test('a repo-local core.fsmonitor does not run on status', async () => {
  git(repo, ['config', 'core.fsmonitor', touchMarker()]);
  const { changes } = await streamPublishStatus(repo, [], {}, LIMITS);
  expect(changes.map((change) => change.path)).toEqual(['plugin.json']);
  expect(existsSync(marker)).toBe(false);
});

test('repo-local hooks, by core.hooksPath or in .git/hooks, do not run on commit', async () => {
  const hooks = join(repo, 'planted-hooks');
  mkdirSync(hooks);
  for (const dir of [hooks, join(repo, '.git', 'hooks')]) {
    writeFileSync(join(dir, 'pre-commit'), `#!/bin/sh\n${touchMarker()}\n`, {
      mode: 0o755,
    });
  }
  git(repo, ['config', 'core.hooksPath', hooks]);
  await runPublishGit(repo, ['add', '--all'], {}, 15_000);
  await runPublishGit(repo, ['commit', '--quiet', '-m', 'x'], {}, 15_000);
  expect(existsSync(marker)).toBe(false);
});

test('a repo-local core.sshCommand does not run on push', async () => {
  git(repo, ['config', 'core.sshCommand', touchMarker()]);
  git(repo, ['remote', 'add', 'origin', 'ssh://git@example.invalid/x/y.git']);
  git(repo, ['add', '--all']);
  git(repo, ['commit', '--quiet', '-m', 'x']);
  const failure = await runPublishGit(
    repo,
    ['push', 'origin', 'main'],
    {},
    30_000,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(existsSync(marker)).toBe(false);
  // It failed for the ssh reason (no such host), not because it never ran.
  expect(failure).not.toBeNull();
});

test('a repo-local insteadOf to ext:: (with protocol.ext.allow) does not run on push', async () => {
  const script = join(root, 'ext.sh');
  writeFileSync(script, `#!/bin/sh\n${touchMarker()}\n`, { mode: 0o755 });
  git(repo, [
    'config',
    `url.ext::sh ${script} .insteadOf`,
    'https://evil.example/',
  ]);
  git(repo, ['config', 'protocol.ext.allow', 'always']);
  git(repo, ['remote', 'add', 'origin', 'https://evil.example/x/y.git']);
  git(repo, ['add', '--all']);
  git(repo, ['commit', '--quiet', '-m', 'x']);
  const failure = await runPublishGit(
    repo,
    ['push', 'origin', 'main'],
    {},
    30_000,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  // The property first: the helper never ran. Then why the push failed.
  expect(existsSync(marker)).toBe(false);
  expect(String((failure as { stderr?: unknown })?.stderr)).toMatch(
    /transport 'ext' not allowed/,
  );
});

test('status stops at the path cap and reports too many', async () => {
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(join(repo, `file-${index}.txt`), 'x');
  }
  const result = await streamPublishStatus(
    repo,
    [],
    {},
    {
      maxPaths: 5,
      timeoutMs: 15_000,
    },
  );
  expect(result).toMatchObject({ tooMany: true });
  expect(result.changes).toHaveLength(5);
});

test('status that runs out of time reports too many, not a failure', async () => {
  const result = await streamPublishStatus(
    repo,
    [],
    {},
    {
      maxPaths: 1000,
      timeoutMs: 0,
    },
  );
  expect(result.tooMany).toBe(true);
});

test('the config allowlist', async () => {
  expect(await checkRepositoryConfig(root)).toBe('absent');
  git(repo, ['remote', 'add', 'origin', 'https://example.test/a/b.git']);
  expect(await checkRepositoryConfig(repo)).toBe('ok');
  git(repo, ['config', 'core.fsmonitor', 'x']);
  git(repo, ['config', 'include.path', '/elsewhere']);
  git(repo, ['config', 'url.x.insteadOf', 'y']);
  expect(await checkRepositoryConfig(repo)).toEqual({
    code: 'repository-config-refused',
    keys: ['core.fsmonitor', 'include.path', 'url.x.insteadof'],
  });
});

test('a .git file is refused', async () => {
  const other = join(root, 'other');
  mkdirSync(other);
  writeFileSync(join(other, '.git'), `gitdir: ${join(repo, '.git')}\n`);
  expect(await checkRepositoryConfig(other)).toEqual({
    code: 'git-dir-not-directory',
  });
});
