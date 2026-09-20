import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { execGit } from '../../../utils/git-exec.js';
import { resolveWorkspaceIdentity } from '../workspace-identity.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test('shares one git identity across root and subdirectory without blocking the event loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-identity-'));
  roots.push(root);
  await execGit(['init'], { cwd: root });
  const child = join(root, 'nested');
  await mkdir(child);
  let ticked = false;
  const resolving = resolveWorkspaceIdentity(child);
  setTimeout(() => (ticked = true), 0);
  const identity = await resolving;
  expect(ticked).toBe(true);
  expect(identity).toEqual({
    kind: 'git',
    key: `git:${await realpath(root)}`,
    root: await realpath(root),
  });
});

test('keeps existing non-git and foreign Windows workspaces usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-directory-'));
  roots.push(root);
  await expect(resolveWorkspaceIdentity(root)).resolves.toMatchObject({
    kind: 'directory',
  });
  await expect(
    resolveWorkspaceIdentity('/peer/windows/repo', 'remote'),
  ).resolves.toEqual({ kind: 'remote' });
  await expect(
    resolveWorkspaceIdentity(join(root, 'missing')),
  ).rejects.toThrow();
});
