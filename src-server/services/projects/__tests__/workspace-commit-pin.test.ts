import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { execGit } from '../../../utils/git-exec.js';
import { repositoryArgs } from '../git-directory-confinement.js';
import {
  pinWorkspace,
  WorkspaceCommitPinError,
} from '../workspace-commit-pin.js';

const temporary = trackTempDirs();

async function git(dir: string, args: string[]): Promise<string> {
  return (
    await execGit(args, {
      cwd: dir,
      timeout: 10_000,
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
  test('a clean tree returns HEAD and the empty status digest', async () => {
    const { dir, head } = await repository();
    expect(await pinWorkspace(dir)).toEqual({
      commit: head,
      clean: true,
      statusDigest: `sha256:${createHash('sha256').update('').digest('hex')}`,
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
