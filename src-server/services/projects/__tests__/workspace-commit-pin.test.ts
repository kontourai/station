import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { scaleLivenessMs } from '../../../../scripts/lib/liveness-scale.mjs';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../../scripts/lib/owned-process.mjs';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import * as gitExec from '../../../utils/git-exec.js';
import { execGit } from '../../../utils/git-exec.js';
import { repositoryArgs } from '../git-directory-confinement.js';
import {
  pinWorkspace,
  WorkspaceCommitPinError,
} from '../workspace-commit-pin.js';

const temporary = trackTempDirs();
const stagedFile = `100644 ${'a'.repeat(40)} 0\tfile-160000 name\0`;
const stagedGitlink = `160000 ${'b'.repeat(40)} 0\tsubmodule\0`;

function interceptLsFiles(source: string) {
  let execution: ReturnType<typeof executeOwnedProcess> | undefined;
  const spy = vi
    .spyOn(gitExec, 'spawnGit')
    .mockImplementationOnce((args, options) => {
      expect(args).toContain('ls-files');
      execution = executeOwnedProcess(
        process.execPath,
        ['-e', source],
        spawn,
        'Capture ls-files fixture',
        { ...options, windowsHide: true },
      );
      return execution.child;
    });
  return {
    child: () => {
      if (!execution) throw new Error('The ls-files seam was not reached');
      return execution.child;
    },
    dispose: async () => {
      spy.mockRestore();
      if (execution) {
        expect(
          await terminateSuiteExecution(execution, {
            processLabel: 'Capture ls-files fixture',
            waitForSuiteSettlement,
            terminationGraceMs: 1000,
            terminationForceMs: 1000,
          }),
        ).toMatchObject({ settled: true, errors: [] });
      }
    },
  };
}

async function git(
  dir: string,
  args: string[],
  input?: string,
): Promise<string> {
  return (
    await execGit(args, {
      cwd: dir,
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      input,
      windowsHide: true,
      env: {
        GIT_AUTHOR_NAME: 'Station Test',
        GIT_AUTHOR_EMAIL: 'test@station.dev',
        GIT_COMMITTER_NAME: 'Station Test',
        GIT_COMMITTER_EMAIL: 'test@station.dev',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
  ).stdout.trim();
}

async function repository(): Promise<{ dir: string; head: string }> {
  const dir = temporary('station-commit-pin-');
  await git(dir, ['init']);
  writeFileSync(join(dir, 'tracked.txt'), 'committed\n');
  await git(dir, [...repositoryArgs(dir), 'add', 'tracked.txt']);
  await git(dir, [...repositoryArgs(dir), 'commit', '-m', 'fixture']);
  const head = await git(dir, [...repositoryArgs(dir), 'rev-parse', 'HEAD']);
  return { dir, head };
}

describe('pinWorkspace', () => {
  test.each([
    ['mid-mode', ['16', stagedGitlink.slice(2)], true],
    ['exactly after NUL', [stagedFile, stagedGitlink], true],
    [
      'starting with NUL',
      [stagedFile.slice(0, -1), `\0${stagedGitlink}`],
      true,
    ],
    ['byte by byte', [...stagedGitlink], true],
    ['mode text inside a filename', [stagedFile], false],
    [
      'split filename mode text',
      [stagedFile.slice(0, -10), stagedFile.slice(-10)],
      false,
    ],
  ] as const)('ls-files chunk framing: %s', async (_name, chunks, gitlink) => {
    const { dir, head } = await repository();
    const spy = vi.spyOn(gitExec, 'spawnGit').mockImplementationOnce(() => {
      const child = new ChildProcess();
      const stdout = new PassThrough();
      child.stdout = stdout;
      queueMicrotask(() => {
        for (const chunk of chunks) stdout.write(Buffer.from(chunk));
        stdout.end();
        child.emit('close', 0, null);
      });
      return child;
    });
    try {
      expect(await pinWorkspace(dir)).toMatchObject({
        commit: head,
        clean: !gitlink,
        submodules: gitlink ? 'unobserved' : 'none',
      });
    } finally {
      spy.mockRestore();
    }
  });

  test('an ls-files nonzero exit refuses the pin with a bounded stderr tail', async () => {
    const { dir } = await repository();
    const fixture = interceptLsFiles(`
      process.stderr.write('discarded-prefix:' + 'x'.repeat(8192) + ':fatal-tail', () => process.exit(23));
    `);
    try {
      const result = pinWorkspace(dir);
      await expect(result).rejects.toBeInstanceOf(WorkspaceCommitPinError);
      await expect(result).rejects.toMatchObject({
        code: 'workspace-unavailable',
        cause: {
          exitCode: 23,
          signal: null,
          timedOut: false,
          stderr: `${'x'.repeat(4096 - ':fatal-tail'.length)}:fatal-tail`,
        },
      });
      expect(fixture.child().exitCode).toBe(23);
    } finally {
      await fixture.dispose();
    }
  });

  test('an ls-files child error refuses the pin even after a successful close', async () => {
    const { dir } = await repository();
    const spawnError = new Error('ls-files child failed');
    const spy = vi.spyOn(gitExec, 'spawnGit').mockImplementationOnce((args) => {
      expect(args).toContain('ls-files');
      const child = new ChildProcess();
      queueMicrotask(() => {
        child.emit('error', spawnError);
        child.emit('close', 0, null);
      });
      return child;
    });
    try {
      await expect(pinWorkspace(dir)).rejects.toMatchObject({
        code: 'workspace-unavailable',
        cause: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          spawnError,
        },
      });
    } finally {
      spy.mockRestore();
    }
  });

  test('an ls-files timeout refuses the pin and closes its child', {
    timeout: scaleLivenessMs(20_000),
  }, async () => {
    const { dir } = await repository();
    const fixture = interceptLsFiles(`
      process.stderr.write('waiting-for-ls-files');
      setInterval(() => {}, 1000);
    `);
    try {
      await expect(pinWorkspace(dir)).rejects.toMatchObject({
        code: 'workspace-unavailable',
        cause: {
          exitCode: null,
          signal: 'SIGKILL',
          timedOut: true,
          stderr: 'waiting-for-ls-files',
        },
      });
      expect(fixture.child().signalCode).toBe('SIGKILL');
      expect(() => process.kill(fixture.child().pid!, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
    } finally {
      await fixture.dispose();
    }
  });

  test('a gitlink stops ls-files before its deadline and resolves after child close', {
    timeout: scaleLivenessMs(20_000),
  }, async () => {
    const { dir, head } = await repository();
    const fixture = interceptLsFiles(`
      process.stdout.write(${JSON.stringify(stagedGitlink)});
      setInterval(() => {}, 1000);
    `);
    try {
      expect(await pinWorkspace(dir)).toMatchObject({
        commit: head,
        clean: false,
        submodules: 'unobserved',
      });
      expect(fixture.child().signalCode).toBe('SIGKILL');
      expect(() => process.kill(fixture.child().pid!, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
    } finally {
      await fixture.dispose();
    }
  });

  test('a clean tree returns HEAD and the empty status digest', async () => {
    const { dir, head } = await repository();
    expect(await pinWorkspace(dir)).toEqual({
      commit: head,
      clean: true,
      submodules: 'none',
      statusDigest: `sha256:${createHash('sha256').update('').digest('hex')}`,
    });
  });

  test('a clean index whose staged listing exceeds 16 MiB can still pin', {
    timeout: 30_000,
  }, async () => {
    const { dir, head } = await repository();
    const blob = await git(dir, ['rev-parse', 'HEAD:tracked.txt']);
    const paths = Array.from(
      { length: 200_000 },
      (_, index) =>
        `capture-${String(index).padStart(6, '0')}-${'x'.repeat(40)}`,
    );
    await git(
      dir,
      ['update-index', '--index-info'],
      paths.map((path) => `100644 ${blob}\t${path}\n`).join(''),
    );
    // Index-only fixtures need no 200k physical files to present a clean tree.
    await git(
      dir,
      ['update-index', '--skip-worktree', '--stdin'],
      paths.join('\n'),
    );
    const tree = await git(dir, ['write-tree']);
    const commit = await git(dir, [
      'commit-tree',
      tree,
      '-p',
      head,
      '-m',
      'large index',
    ]);
    await git(dir, ['update-ref', 'HEAD', commit]);
    const listing = await git(dir, ['ls-files', '--stage', '-z']);
    expect(Buffer.byteLength(listing)).toBeGreaterThan(16 * 1024 * 1024);
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
    const pin = await pinWorkspace(dir).catch((error: unknown) => {
      if (!(error instanceof WorkspaceCommitPinError)) throw error;
      // Avoid serializing the overflowing command's multi-megabyte stdout on failure.
      return {
        error: error.code,
        cause: (error.cause as NodeJS.ErrnoException | undefined)?.code,
      };
    });
    expect(pin).toMatchObject({
      commit,
      clean: true,
      submodules: 'none',
    });
  });

  test.each(['unstaged', 'staged'])(
    '%s changes report unclean',
    async (state) => {
      const { dir, head } = await repository();
      const before = await pinWorkspace(dir);
      writeFileSync(join(dir, 'tracked.txt'), 'changed\n');
      if (state === 'staged')
        await git(dir, [...repositoryArgs(dir), 'add', 'tracked.txt']);
      const pin = await pinWorkspace(dir);
      expect(pin.commit).toBe(head);
      expect(pin.clean).toBe(false);
      expect(pin.statusDigest).not.toBe(before.statusDigest);
      expect((await pinWorkspace(dir)).statusDigest).toBe(pin.statusDigest);
    },
  );

  test('an untracked file reports unclean', async () => {
    const { dir, head } = await repository();
    writeFileSync(join(dir, 'untracked.txt'), 'untracked\n');
    expect(await pinWorkspace(dir)).toMatchObject({
      commit: head,
      clean: false,
    });
  });

  test('a dirty submodule is unobserved and cannot pin as clean', async () => {
    const { dir } = await repository();
    const child = join(dir, 'submodule');
    mkdirSync(child);
    await git(child, ['init']);
    writeFileSync(join(child, 'child.txt'), 'committed\n');
    await git(child, [...repositoryArgs(child), 'add', 'child.txt']);
    await git(child, [...repositoryArgs(child), 'commit', '-m', 'child']);
    const childHead = await git(child, ['rev-parse', 'HEAD']);
    writeFileSync(
      join(dir, '.gitmodules'),
      '[submodule "submodule"]\n\tpath = submodule\n\turl = ./child\n',
    );
    await git(dir, ['add', '.gitmodules']);
    await git(dir, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${childHead},submodule`,
    ]);
    await git(dir, ['commit', '-m', 'submodule']);
    // Even a currently clean submodule cannot be qualified by hardened status.
    expect(await pinWorkspace(dir)).toMatchObject({
      clean: false,
      submodules: 'unobserved',
    });
    writeFileSync(join(child, 'child.txt'), 'dirty\n');
    expect(await git(child, ['status', '--porcelain'])).toContain('child.txt');
    expect(await pinWorkspace(dir)).toMatchObject({
      clean: false,
      submodules: 'unobserved',
    });
  });

  test.each(['empty repository', 'unborn branch'])(
    '%s has a typed unborn refusal',
    async (state) => {
      const dir =
        state === 'empty repository'
          ? temporary('station-empty-repo-')
          : (await repository()).dir;
      if (state === 'empty repository') await git(dir, ['init']);
      else await git(dir, ['checkout', '--orphan', 'unborn']);
      await expect(pinWorkspace(dir)).rejects.toMatchObject({ code: 'unborn' });
    },
  );

  test('repository changes during status invalidate the pin', async () => {
    const { dir } = await repository();
    const actual = gitExec.execGit;
    let changed = false;
    const spy = vi
      .spyOn(gitExec, 'execGit')
      .mockImplementation(async (args, options) => {
        const result = await actual(args, options);
        if (args.includes('status')) {
          appendFileSync(
            join(dir, '.git', 'config'),
            '\n# concurrent configuration edit\n',
          );
          changed = true;
        }
        return result;
      });
    try {
      await expect(pinWorkspace(dir)).rejects.toMatchObject({
        code: 'workspace-changed',
      });
      expect(changed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('a non-repository is refused with a typed error', async () => {
    const result = pinWorkspace(temporary('station-not-a-repo-'));
    await expect(result).rejects.toBeInstanceOf(WorkspaceCommitPinError);
    await expect(result).rejects.toMatchObject({ code: 'not-a-repository' });
  });

  test('a linked worktree returns its own clean HEAD', async () => {
    const { dir, head } = await repository();
    const worktree = temporary('station-commit-pin-worktree-');
    await git(dir, [
      ...repositoryArgs(dir),
      'worktree',
      'add',
      '--detach',
      worktree,
      head,
    ]);
    expect(await pinWorkspace(worktree)).toMatchObject({
      commit: head,
      clean: true,
    });
  });

  test('a plain directory inside a repository does not pin the ancestor', async () => {
    const { dir } = await repository();
    const child = join(dir, 'child');
    mkdirSync(child);
    await expect(pinWorkspace(child)).rejects.toMatchObject({
      code: 'not-a-repository',
    });
  });

  test('a repository-configured clean filter is refused before status', async () => {
    const { dir } = await repository();
    await git(dir, [
      ...repositoryArgs(dir),
      'config',
      'filter.capture.clean',
      'exit 1',
    ]);
    writeFileSync(join(dir, '.gitattributes'), '*.txt filter=capture\n');
    await expect(pinWorkspace(dir)).rejects.toMatchObject({
      code: 'repository-refused',
    });
  });
});
