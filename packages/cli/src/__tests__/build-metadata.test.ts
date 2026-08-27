import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizedGitEnvironment } from '../../../../scripts/lib/git-environment.mjs';
import { deriveCliBundleMetadata } from '../../build-metadata.mjs';

const SHA = 'a'.repeat(40);
const roots: string[] = [];

function checkout(content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'station-cli-build-metadata-'));
  roots.push(root);
  mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
  execFileSync('git', ['init'], {
    cwd: root,
    windowsHide: true,
    timeout: 10_000,
    env: sanitizedGitEnvironment(process.env),
  });
  // Git excludes its own directory from worktree status, so this isolated
  // fixture config cannot falsely dirty the source checkout.
  const fixtureGlobalConfig = join(root, '.git', 'fixture.gitconfig');
  writeFileSync(fixtureGlobalConfig, '');
  const run = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 10_000,
      env: sanitizedGitEnvironment({
        ...sanitizedGitEnvironment(process.env),
        GIT_AUTHOR_NAME: 'Station Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Station Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
        GIT_CONFIG_GLOBAL: fixtureGlobalConfig,
        GIT_CONFIG_NOSYSTEM: '1',
      }),
    });
  writeFileSync(join(root, 'tracked.txt'), content);
  run(['add', 'tracked.txt']);
  run(['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial']);
  return root;
}

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('CLI bundle metadata', () => {
  it('uses the intended checkout despite inherited Git locations and marks staged source dirty', () => {
    const calls: Array<{
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    }> = [];
    const metadata = deriveCliBundleMetadata({
      packageDir: '/fixture/foreign-cwd/packages/cli',
      packageVersion: '0.6.0',
      env: {
        GIT_DIR: '/hostile/.git',
        GIT_WORK_TREE: '/hostile',
        GIT_INDEX_FILE: '/hostile/index',
        STATION_CHANNEL: 'stable',
      },
      git: (args, cwd, env) => {
        calls.push({ args, cwd, env });
        return args[0] === 'rev-parse'
          ? SHA
          : 'M  packages/cli/src/cli.ts\n?? note';
      },
    });

    expect(metadata).toEqual({
      version: '0.6.0',
      sourceSha: `${SHA}-dirty`,
      channel: 'development',
    });
    expect(calls.map((call) => call.cwd)).toEqual([
      '/fixture/foreign-cwd',
      '/fixture/foreign-cwd',
    ]);
    for (const call of calls) {
      expect(call.env.GIT_DIR).toBeUndefined();
      expect(call.env.GIT_WORK_TREE).toBeUndefined();
      expect(call.env.GIT_INDEX_FILE).toBeUndefined();
    }
  });

  it('rejects malformed controlled inputs and an indeterminate dirty check', () => {
    expect(
      deriveCliBundleMetadata({
        packageDir: '/fixture/packages/cli',
        packageVersion: '0.6.0',
        env: {
          STATION_CLI_SOURCE_SHA: 'not-a-sha',
          STATION_CLI_BUILD_CHANNEL: 'Stable!',
        },
      }),
    ).toEqual({
      version: '0.6.0',
      sourceSha: 'source-unavailable',
      channel: 'development',
    });

    expect(
      deriveCliBundleMetadata({
        packageDir: '/fixture/packages/cli',
        packageVersion: '0.6.0',
        git: (args) => {
          if (args[0] === 'rev-parse') return SHA;
          throw new Error('status unavailable');
        },
      }).sourceSha,
    ).toBe('source-unavailable');
  });

  it('uses the real intended repository, not a hostile inherited Git location', () => {
    const source = checkout('source clean\n');
    const hostile = checkout('hostile clean\n');
    const hostileStatus = execFileSync('git', ['status', '--porcelain=v1'], {
      cwd: hostile,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: sanitizedGitEnvironment(),
    });
    const hostileSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: hostile,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: sanitizedGitEnvironment(),
    }).trim();
    writeFileSync(join(source, 'tracked.txt'), 'staged dirty\n');
    execFileSync('git', ['add', 'tracked.txt'], {
      cwd: source,
      windowsHide: true,
      timeout: 10_000,
      env: sanitizedGitEnvironment(),
    });
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: source,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: sanitizedGitEnvironment(),
    }).trim();
    expect(hostileStatus).toBe('');
    expect(hostileSha).not.toBe(expectedSha);

    expect(
      deriveCliBundleMetadata({
        packageDir: join(source, 'packages', 'cli'),
        packageVersion: '0.6.0',
        env: {
          ...process.env,
          GIT_DIR: join(hostile, '.git'),
          GIT_WORK_TREE: hostile,
          GIT_INDEX_FILE: join(hostile, '.git', 'index'),
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: '/hostile',
        },
      }).sourceSha,
    ).toBe(`${expectedSha}-dirty`);
  });
});
