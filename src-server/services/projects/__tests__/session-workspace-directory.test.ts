import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { sessionWorkspaceDirectoryFor } from '../session-workspace-directory.js';

let root: string;
let checkout: string;
let worktree: string;
let elsewhere: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'station-session-dir-')));
  checkout = join(root, 'repo');
  worktree = join(root, 'repo-worktrees', 'lane');
  elsewhere = join(root, 'other');
  mkdirSync(join(checkout, 'pkg'), { recursive: true });
  mkdirSync(elsewhere);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: checkout,
      stdio: 'ignore',
      windowsHide: true,
    });
  git('init', '-q', '-b', 'main');
  git(
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  git('worktree', 'add', '-q', '-b', 'lane', worktree);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function deps(
  cwdByThread: Record<string, string | undefined>,
  readable = true,
) {
  return {
    canRead: vi.fn(() => readable),
    listSessions: vi.fn(async () =>
      Object.entries(cwdByThread).map(([threadId, cwd]) => ({
        threadId,
        projectSlug: threadId === 'other-project' ? 'beta' : 'alpha',
        ...(cwd ? { cwd } : {}),
      })),
    ),
    projectDirectory: vi.fn(async () => checkout),
  };
}

describe('which directory a file read for a session targets (#2476)', () => {
  test('a registered worktree, or a folder inside the checkout, is read as the session’s own', async () => {
    const d = deps({ lane: worktree, sub: join(checkout, 'pkg') });
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'lane'),
    ).resolves.toBe(worktree);
    await expect(sessionWorkspaceDirectoryFor(d, 'alpha', 'sub')).resolves.toBe(
      join(checkout, 'pkg'),
    );
  });

  test('a session in the checkout, or with no recorded directory, reads the checkout', async () => {
    const d = deps({ home: checkout, none: undefined });
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'home'),
    ).resolves.toBeUndefined();
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'none'),
    ).resolves.toBeUndefined();
  });

  test('a directory the project cannot vouch for is refused, not read', async () => {
    // Not inside the checkout and not one of its worktrees: whatever the
    // session was started with, the server does not read it.
    // A sibling whose name merely starts with the checkout's is not inside it.
    const sibling = join(root, 'repo-2');
    mkdirSync(sibling, { recursive: true });
    const d = deps({
      stray: elsewhere,
      gone: join(root, 'missing'),
      sibling,
    });
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'sibling'),
    ).resolves.toBeNull();
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'stray'),
    ).resolves.toBeNull();
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'gone'),
    ).resolves.toBeNull();
  });

  test('a forged worktree entry cannot vouch for a directory outside the project', async () => {
    // Anyone who can write the checkout can write `.git/worktrees/<x>/gitdir`
    // and make `git worktree list` name any folder (#2476 delta review).
    // Reached through a symlink inside the checkout, the realpath lands
    // outside; only a listed checkout whose own `.git` leads back counts.
    const secret = join(root, 'secret');
    mkdirSync(secret);
    writeFileSync(join(secret, 'key.txt'), 'private');
    const forged = join(checkout, '.git', 'worktrees', 'evil');
    mkdirSync(forged, { recursive: true });
    writeFileSync(join(forged, 'gitdir'), `${join(secret, '.git')}\n`);
    writeFileSync(join(forged, 'HEAD'), 'ref: refs/heads/main\n');
    symlinkSync(secret, join(checkout, 'pkg', 'link'));
    try {
      const d = deps({
        direct: secret,
        viaLink: join(checkout, 'pkg', 'link'),
      });
      await expect(
        sessionWorkspaceDirectoryFor(d, 'alpha', 'direct'),
      ).resolves.toBeNull();
      await expect(
        sessionWorkspaceDirectoryFor(d, 'alpha', 'viaLink'),
      ).resolves.toBeNull();
    } finally {
      rmSync(forged, { recursive: true, force: true });
      rmSync(join(checkout, 'pkg', 'link'), { force: true });
      rmSync(secret, { recursive: true, force: true });
    }
  });

  test('a session the caller may not read is refused before anything is looked up', async () => {
    const d = deps({ lane: worktree }, false);
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'lane'),
    ).resolves.toBeNull();
    expect(d.listSessions).not.toHaveBeenCalled();
  });

  test('another project’s session, or an unknown one, is refused', async () => {
    const d = deps({ 'other-project': worktree });
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'other-project'),
    ).resolves.toBeNull();
    await expect(
      sessionWorkspaceDirectoryFor(d, 'alpha', 'ghost'),
    ).resolves.toBeNull();
  });
});
