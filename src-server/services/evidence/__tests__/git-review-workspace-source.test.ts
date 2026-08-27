import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execGit } from '../../../utils/git-exec.js';
import {
  GitReviewWorkspaceSource,
  inspectGitReviewRange,
} from '../git-review-workspace-source.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'station-review-git-'));
  roots.push(root);
  await execGit(['-C', root, 'init', '--initial-branch=main']);
  await execGit(['-C', root, 'config', 'user.name', 'Station Test']);
  await execGit([
    '-C',
    root,
    'config',
    'user.email',
    'station@example.invalid',
  ]);
  await writeFile(join(root, 'module.ts'), 'export const value = 1;\n', 'utf8');
  await execGit(['-C', root, 'add', 'module.ts']);
  await execGit(['-C', root, 'commit', '-m', 'base']);
  const base = (await execGit(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(root, 'module.ts'), 'export const value = 2;\n', 'utf8');
  await execGit(['-C', root, 'commit', '-am', 'head']);
  const head = (await execGit(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  return { root, base, head };
}

describe('GitReviewWorkspaceSource', () => {
  it('materializes the exact detached head outside the live project and removes it', async () => {
    const repo = await repository();
    const coordination = join(
      repo.root,
      '..',
      `review-coordination-${Date.now()}`,
    );
    roots.push(coordination);
    const source = new GitReviewWorkspaceSource(
      { workspace: () => repo.root },
      coordination,
    );
    const workspace = await source.open({
      kind: 'git-range',
      projectSlug: 'station',
      baseRevision: repo.base,
      headRevision: repo.head,
    });

    expect(workspace.root).not.toBe(repo.root);
    expect(await readFile(join(workspace.root, 'module.ts'), 'utf8')).toContain(
      'value = 2',
    );
    expect(workspace.target).toMatchObject({
      baseSha: repo.base,
      headSha: repo.head,
    });
    expect(workspace.target.diffSha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      workspace.validateLocation({ file: 'module.ts', line: 1 }),
    ).resolves.toBeUndefined();
    await expect(
      workspace.validateLocation({ file: 'module.ts', line: 3 }),
    ).rejects.toThrow('line is absent');

    const path = workspace.root;
    await workspace.close();
    await expect(
      readFile(join(path, 'module.ts'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 15_000);

  it('refuses an empty range before provisioning a reviewer workspace', async () => {
    const repo = await repository();
    const source = new GitReviewWorkspaceSource(
      { workspace: () => repo.root },
      join(repo.root, '..', `review-empty-${Date.now()}`),
    );
    await expect(
      source.open({
        kind: 'git-range',
        projectSlug: 'station',
        baseRevision: repo.head,
        headRevision: repo.head,
      }),
    ).rejects.toThrow('no revision change');
  }, 15_000);

  it('bounds retained protected workspaces without pruning a possibly live reviewer', async () => {
    const repo = await repository();
    const coordination = join(repo.root, '..', `review-capacity-${Date.now()}`);
    roots.push(coordination);
    const source = new GitReviewWorkspaceSource(
      { workspace: () => repo.root },
      coordination,
      { maxWorkspaces: 1 },
    );
    const target = {
      kind: 'git-range' as const,
      projectSlug: 'station',
      baseRevision: repo.base,
      headRevision: repo.head,
    };
    const retained = await source.open(target);

    await expect(source.open(target)).rejects.toThrow(
      'capacity is exhausted by protected workspaces',
    );
    expect(await readFile(join(retained.root, 'module.ts'), 'utf8')).toContain(
      'value = 2',
    );

    await retained.close();
    const reopened = await source.open(target);
    await reopened.close();
  }, 20_000);

  it('refuses a committed symlink finding instead of reading outside the Git head', async () => {
    const repo = await repository();
    const outside = join(repo.root, '..', `review-outside-${Date.now()}.ts`);
    roots.push(outside);
    await writeFile(outside, 'outside\nsecret\n', 'utf8');
    await symlink(outside, join(repo.root, 'linked.ts'));
    await execGit(['-C', repo.root, 'add', 'linked.ts']);
    await execGit(['-C', repo.root, 'commit', '-m', 'add symlink']);
    const head = (
      await execGit(['-C', repo.root, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    const coordination = join(repo.root, '..', `review-link-${Date.now()}`);
    roots.push(coordination);
    const source = new GitReviewWorkspaceSource(
      { workspace: () => repo.root },
      coordination,
    );
    const workspace = await source.open({
      kind: 'git-range',
      projectSlug: 'station',
      baseRevision: repo.head,
      headRevision: head,
    });

    await expect(
      workspace.validateLocation({ file: 'linked.ts', line: 1 }),
    ).rejects.toThrow('absent from the reviewed head');
    await workspace.close();
  }, 15_000);

  it('preserves NUL name-status rename sides under the same frozen range', async () => {
    const repo = await repository();
    await mkdir(join(repo.root, 'src'));
    await writeFile(join(repo.root, 'src', 'old name.ts'), 'export {}\n');
    await execGit(['-C', repo.root, 'add', 'src/old name.ts']);
    await execGit(['-C', repo.root, 'commit', '-m', 'add old path']);
    const base = (
      await execGit(['-C', repo.root, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    await execGit([
      '-C',
      repo.root,
      'mv',
      'src/old name.ts',
      'src/new\tname.ts',
    ]);
    await execGit(['-C', repo.root, 'commit', '-m', 'rename path']);
    const head = (
      await execGit(['-C', repo.root, 'rev-parse', 'HEAD'])
    ).stdout.trim();

    const inspection = await inspectGitReviewRange(repo.root, {
      kind: 'git-range',
      projectSlug: 'station',
      baseRevision: base,
      headRevision: head,
    });
    expect(inspection.target).toMatchObject({ baseSha: base, headSha: head });
    expect(inspection.changes).toEqual([
      {
        status: expect.stringMatching(/^R/),
        oldPath: 'src/old name.ts',
        newPath: 'src/new\tname.ts',
      },
    ]);
  }, 15_000);
});
