import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  execGit,
  execGitSync,
  gitEnv,
  gitSubcommand,
  spawnGit,
} from '../git-exec.js';

/**
 * #2363: Station runs git in folders other people can write, as the
 * operator. Each case plants the repo-local config that would run code,
 * first proves with PLAIN git that the plant is live (so a green result is
 * not a fixture that never fired), then drives Station's runner and asserts
 * the marker the plant writes is absent.
 *
 * Real git, real temp repositories, no network: remotes are `.invalid`
 * hosts, which fail at name resolution.
 */

const sandboxes: string[] = [];

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'station-git-hard-')));
  sandboxes.push(dir);
  return dir;
}

/** Plain git, NOT Station's runner: the control that proves a plant fires. */
function plainGit(cwd: string, args: string[], input?: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 20_000,
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

function initRepo(): string {
  const repo = sandbox();
  plainGit(repo, ['init', '-q', '-b', 'main']);
  plainGit(repo, ['config', 'user.email', 'test@station.dev']);
  plainGit(repo, ['config', 'user.name', 'Station Test']);
  plainGit(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), '# test\n');
  plainGit(repo, ['add', '-A']);
  plainGit(repo, ['commit', '-q', '-m', 'initial']);
  return repo;
}

/** An executable script that records it ran by creating `marker`. */
function markerScript(dir: string, marker: string): string {
  const script = join(dir, 'planted.sh');
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(script, 0o755);
  return script;
}

function spawnFill(cwd: string, input: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawnGit(['credential', 'fill'], {
      cwd,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('close', (code) => resolve(code));
    child.stdin?.end(input);
  });
}

const FILL = 'protocol=https\nhost=example.invalid\npath=x.git\n\n';

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')(
  'Station git runner hardening (#2363)',
  () => {
    beforeEach(() => {
      // The operator's real global config must not leak into these cases.
      const home = sandbox();
      vi.stubEnv('GIT_CONFIG_GLOBAL', join(home, 'global.gitconfig'));
      vi.stubEnv('GIT_CONFIG_SYSTEM', join(home, 'system.gitconfig'));
      writeFileSync(join(home, 'global.gitconfig'), '');
      writeFileSync(join(home, 'system.gitconfig'), '');
    });

    test('a planted core.fsmonitor does not run on status', async () => {
      const repo = initRepo();
      const marker = join(sandbox(), 'fsmonitor-ran');
      plainGit(repo, [
        'config',
        'core.fsmonitor',
        markerScript(sandbox(), marker),
      ]);

      plainGit(repo, ['status', '--porcelain']);
      expect(existsSync(marker), 'control: plain git runs the plant').toBe(
        true,
      );
      rmSync(marker);

      await execGit(['status', '--porcelain'], { cwd: repo });
      expect(existsSync(marker)).toBe(false);
    });

    test('a repo-local insteadOf to ext:: with protocol.ext.allow runs nothing', async () => {
      const repo = initRepo();
      const marker = join(sandbox(), 'ext-ran');
      plainGit(repo, [
        'remote',
        'add',
        'origin',
        'https://example.invalid/team/repo.git',
      ]);
      plainGit(repo, [
        'config',
        `url.ext::sh -c touch% ${marker}% #.insteadOf`,
        'https://example.invalid/',
      ]);
      plainGit(repo, ['config', 'protocol.ext.allow', 'always']);

      plainGit(repo, ['ls-remote', 'origin']);
      expect(existsSync(marker), 'control: plain git runs the plant').toBe(
        true,
      );
      rmSync(marker);

      await expect(
        execGit(['ls-remote', 'origin'], { cwd: repo, timeout: 20_000 }),
      ).rejects.toThrow(/transport 'ext' not allowed/);
      expect(existsSync(marker)).toBe(false);
    });

    test('a repo-local core.sshCommand does not run (ssh is batch-mode ssh)', async () => {
      const repo = initRepo();
      const marker = join(sandbox(), 'ssh-ran');
      plainGit(repo, [
        'remote',
        'add',
        'origin',
        'ssh://git@example.invalid/team/repo.git',
      ]);
      plainGit(repo, [
        'config',
        'core.sshCommand',
        markerScript(sandbox(), marker),
      ]);

      plainGit(repo, ['ls-remote', 'origin']);
      expect(existsSync(marker), 'control: plain git runs the plant').toBe(
        true,
      );
      rmSync(marker);

      await expect(
        execGit(['ls-remote', 'origin'], { cwd: repo, timeout: 20_000 }),
      ).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
    });

    test('a local path is the file transport: refused unless the caller opts in', async () => {
      const source = initRepo();
      const parent = sandbox();

      await expect(
        execGit(['clone', '-q', source, 'refused'], { cwd: parent }),
      ).rejects.toThrow(/transport 'file' not allowed/);
      expect(existsSync(join(parent, 'refused', '.git'))).toBe(false);

      await execGit(['clone', '-q', source, 'allowed'], {
        cwd: parent,
        hardening: { allowFileProtocol: true },
      });
      expect(existsSync(join(parent, 'allowed', 'README.md'))).toBe(true);
    });

    test('a folder posing as a bare repository is not discovered', async () => {
      const bare = sandbox();
      plainGit(bare, ['init', '-q', '--bare']);
      expect(plainGit(bare, ['rev-parse', '--is-bare-repository']).trim()).toBe(
        'true',
      );

      await expect(
        execGit(['rev-parse', '--is-bare-repository'], { cwd: bare }),
      ).rejects.toThrow(/cannot use bare repository/);
    });

    test('credential helpers: a repo-local helper never runs, and the operator helpers run in plain git order', async () => {
      const config = sandbox();
      const log = join(config, 'helpers.log');
      const helper = (name: string) => `!echo ${name} >> '${log}' #`;
      const system = join(config, 'system.gitconfig');
      const global = join(config, 'global.gitconfig');
      vi.stubEnv('GIT_CONFIG_SYSTEM', system);
      vi.stubEnv('GIT_CONFIG_GLOBAL', global);
      writeFileSync(system, '');
      writeFileSync(global, '');
      const set = (file: string, key: string, value: string) =>
        plainGit(config, ['config', '--file', file, '--add', key, value]);
      // System helper, then a GLOBAL reset that cancels it, then global and
      // URL-scoped helpers. Plain git runs only what follows the reset.
      set(system, 'credential.helper', helper('system-cancelled'));
      set(global, 'credential.helper', '');
      set(global, 'credential.helper', helper('global-one'));
      set(
        global,
        'credential.https://example.invalid.helper',
        helper('global-url'),
      );
      set(global, 'credential.helper', helper('global-two'));

      // Plain git, outside any repository: the reference order.
      plainGit(config, ['credential', 'fill'], FILL);
      const reference = existsSync(log) ? readFileSync(log, 'utf-8') : '';
      rmSync(log, { force: true });
      expect(reference.split('\n').filter(Boolean)).toEqual(
        expect.arrayContaining(['global-one', 'global-url', 'global-two']),
      );
      expect(reference).not.toContain('system-cancelled');

      // A repository whose own config adds a helper.
      const repo = initRepo();
      plainGit(repo, ['config', 'credential.helper', helper('repo-local')]);
      plainGit(repo, ['credential', 'fill'], FILL);
      expect(
        readFileSync(log, 'utf-8'),
        'control: plain git runs the plant',
      ).toContain('repo-local');
      rmSync(log, { force: true });

      await spawnFill(repo, FILL);
      const hardened = existsSync(log) ? readFileSync(log, 'utf-8') : '';
      expect(hardened).not.toContain('repo-local');
      expect(hardened).toBe(reference);
    });

    test('credential helpers: with no reset of its own in the operator config, a repo-local helper still never runs', async () => {
      // The case above cannot prove the runner's own `credential.helper=`
      // reset: the operator's global reset, re-added on the command line,
      // already clears the repo-local helper. Here the operator config has
      // no reset, so only the runner's reset stands between the plant and
      // the credential request. (Re-adding a LOCAL-scope setting is not
      // reachable at all: the operator settings are read from an empty
      // directory under a ceiling, where git reports no repository scope.)
      const config = sandbox();
      const log = join(config, 'helpers.log');
      const helper = (name: string) => `!echo ${name} >> '${log}' #`;
      const global = join(config, 'global.gitconfig');
      vi.stubEnv('GIT_CONFIG_GLOBAL', global);
      writeFileSync(global, '');
      plainGit(config, [
        'config',
        '--file',
        global,
        'credential.helper',
        helper('operator'),
      ]);
      const repo = initRepo();
      plainGit(repo, ['config', 'credential.helper', helper('repo-local')]);
      plainGit(repo, ['credential', 'fill'], FILL);
      expect(
        readFileSync(log, 'utf-8'),
        'control: plain git runs the plant',
      ).toContain('repo-local');
      rmSync(log, { force: true });

      await spawnFill(repo, FILL);
      expect(readFileSync(log, 'utf-8').split('\n').filter(Boolean)).toEqual([
        'operator',
      ]);
    });

    test('a failed network command does not quote the operator credential settings', async () => {
      // A helper setting can carry a token; a failed command's error message
      // quotes its argv, which reaches logs and route errors.
      const config = sandbox();
      const global = join(config, 'global.gitconfig');
      vi.stubEnv('GIT_CONFIG_GLOBAL', global);
      writeFileSync(global, '');
      plainGit(config, [
        'config',
        '--file',
        global,
        'credential.helper',
        '!echo password=SECRET-TOKEN-2363 #',
      ]);
      const repo = initRepo();
      const failure = await execGit(
        ['ls-remote', 'https://example.invalid/team/repo.git'],
        { cwd: repo, timeout: 20_000 },
      ).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).not.toContain('SECRET-TOKEN-2363');
    });

    test('inherited GIT_INDEX_FILE and GIT_CONFIG_PARAMETERS do not reach git; a caller-supplied index does', async () => {
      const repo = initRepo();
      vi.stubEnv('GIT_INDEX_FILE', join(sandbox(), 'no-such-index'));
      vi.stubEnv('GIT_CONFIG_PARAMETERS', `'core.abbrev'='12'`);
      expect(plainGit(repo, ['ls-files']).trim(), 'control').toBe('');
      expect(
        plainGit(repo, ['rev-parse', '--short', 'HEAD']).trim(),
      ).toHaveLength(12);

      const { stdout } = await execGit(['ls-files'], { cwd: repo });
      expect(stdout.trim()).toBe('README.md');
      const short = await execGit(['rev-parse', '--short', 'HEAD'], {
        cwd: repo,
      });
      expect(short.stdout.trim()).not.toHaveLength(12);

      const index = join(sandbox(), 'empty-index');
      const env = gitEnv({ GIT_INDEX_FILE: index });
      expect(env.GIT_INDEX_FILE).toBe(index);
      expect(
        (
          execGitSync(['ls-files'], {
            cwd: repo,
            env: { GIT_INDEX_FILE: index },
            encoding: 'utf-8',
          }) as string
        ).trim(),
      ).toBe('');
    });
  },
);

describe('gitSubcommand', () => {
  test('skips global options and their values', () => {
    expect(gitSubcommand(['-C', '/x', '-c', 'a=b', 'push', 'origin'])).toBe(
      'push',
    );
    expect(gitSubcommand(['--git-dir=/x/.git', '--no-pager', 'status'])).toBe(
      'status',
    );
    expect(gitSubcommand(['--git-dir', '/x/.git', 'fetch'])).toBe('fetch');
    expect(gitSubcommand(['--version'])).toBeUndefined();
  });
});
