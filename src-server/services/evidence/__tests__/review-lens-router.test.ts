import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execGit } from '../../../utils/git-exec.js';
import { ReviewLensRouter } from '../review-lens-router.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'station-review-lenses-'));
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
  await write(
    root,
    '.veritas/repo-map.json',
    JSON.stringify({
      graph: {
        nodes: [
          {
            id: 'product.src-server',
            label: 'server',
            kind: 'area',
            patterns: ['src-server/'],
          },
          {
            id: 'product.src-ui',
            label: 'ui',
            kind: 'area',
            patterns: ['src-ui/'],
          },
          {
            id: 'verification.tests',
            label: 'tests',
            kind: 'area',
            patterns: ['tests/'],
          },
          {
            id: 'governance.root-manifests',
            label: 'root manifests',
            kind: 'area',
            patterns: ['package.json'],
          },
        ],
      },
    }),
  );
  await write(
    root,
    'config/review-lenses.json',
    JSON.stringify({
      version: 1,
      lenses: [
        {
          id: 'runtime',
          nodeIds: ['product.src-server'],
          instructions: 'Review runtime.',
        },
        { id: 'ui', nodeIds: ['product.src-ui'], instructions: 'Review UI.' },
        {
          id: 'verification',
          nodeIds: ['verification.tests'],
          instructions: 'Review tests.',
        },
      ],
    }),
  );
  await write(
    root,
    'src-server/services/evidence/review-lens-router.ts',
    '// trusted router',
  );
  await write(
    root,
    'src-server/services/evidence/git-review-workspace-source.ts',
    '// trusted source',
  );
  await write(
    root,
    'src-server/providers/adapters/codex-approval-mode.ts',
    '// trusted approval policy',
  );
  await write(
    root,
    'src-server/providers/adapters/codex-adapter.ts',
    '// trusted adapter policy',
  );
  await write(
    root,
    'src-server/services/orchestration/orchestration-service.ts',
    '// trusted orchestration policy',
  );
  await write(root, 'src-server/base.ts', 'export const base = true;\n');
  await write(root, 'package.json', '{"name":"fixture"}\n');
  await execGit(['-C', root, 'add', '.']);
  await execGit(['-C', root, 'commit', '-m', 'base']);
  const base = (await execGit(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  return { root, base };
}

async function write(root: string, path: string, content: string) {
  const file = join(root, path);
  await (await import('node:fs/promises')).mkdir(join(file, '..'), {
    recursive: true,
  });
  await writeFile(file, content);
}

async function commit(root: string, message: string) {
  await execGit(['-C', root, 'add', '-A']);
  await execGit(['-C', root, 'commit', '-m', message]);
  return (await execGit(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
}

describe('ReviewLensRouter', () => {
  it('reports an exact empty range without manufacturing a lens plan', async () => {
    const repo = await fixture();
    await expect(
      new ReviewLensRouter(repo.base).plan({
        repositoryRoot: repo.root,
        baseSha: repo.base,
        headSha: repo.base,
      }),
    ).resolves.toEqual({ kind: 'no-change', changes: [] });
  });

  it('routes generated files through the Repo Map deterministically', async () => {
    const repo = await fixture();
    await write(repo.root, 'src-server/generated/client.ts', 'export {}\n');
    const head = await commit(repo.root, 'generated server artifact');
    const router = new ReviewLensRouter(repo.base);
    const first = await router.plan({
      repositoryRoot: repo.root,
      baseSha: repo.base,
      headSha: head,
    });
    const second = await router.plan({
      repositoryRoot: repo.root,
      baseSha: repo.base,
      headSha: head,
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: 'planned',
      affectedNodes: ['product.src-server'],
      lenses: [{ id: 'runtime' }],
    });
  });

  it('classifies both rename sides and deletion old paths', async () => {
    const repo = await fixture();
    await write(repo.root, 'src-ui/.keep', '');
    await execGit([
      '-C',
      repo.root,
      'mv',
      'src-server/base.ts',
      'src-ui/moved.ts',
    ]);
    const renamed = await commit(repo.root, 'rename across areas');
    await expect(
      new ReviewLensRouter(repo.base).plan({
        repositoryRoot: repo.root,
        baseSha: repo.base,
        headSha: renamed,
      }),
    ).resolves.toMatchObject({
      kind: 'planned',
      lenses: [{ id: 'runtime' }, { id: 'ui' }],
    });

    const deletedBase = renamed;
    await execGit(['-C', repo.root, 'rm', 'src-ui/moved.ts']);
    const deleted = await commit(repo.root, 'delete UI file');
    await expect(
      new ReviewLensRouter(repo.base).plan({
        repositoryRoot: repo.root,
        baseSha: deletedBase,
        headSha: deleted,
      }),
    ).resolves.toMatchObject({
      kind: 'planned',
      lenses: [{ id: 'ui' }],
    });
  });

  it('requires human coverage for unknown paths and candidate policy changes', async () => {
    const repo = await fixture();
    await write(repo.root, 'unmapped/file.txt', 'unknown\n');
    const unknown = await commit(repo.root, 'unknown');
    await expect(
      new ReviewLensRouter(repo.base).plan({
        repositoryRoot: repo.root,
        baseSha: repo.base,
        headSha: unknown,
      }),
    ).resolves.toMatchObject({ kind: 'human-review-required' });

    await write(
      repo.root,
      'config/review-lenses.json',
      '{"version":1,"lenses":[]}',
    );
    const policy = await commit(repo.root, 'candidate policy');
    await expect(
      new ReviewLensRouter(repo.base).plan({
        repositoryRoot: repo.root,
        baseSha: unknown,
        headSha: policy,
      }),
    ).resolves.toMatchObject({ kind: 'human-review-required' });
  });

  it.each([
    {
      path: 'src-server/providers/adapters/codex-approval-mode.ts',
      change: async (root: string, path: string) =>
        write(root, path, '// changed approval policy\n'),
    },
    {
      path: 'src-server/providers/adapters/codex-adapter.ts',
      change: async (root: string, path: string) =>
        execGit(['-C', root, 'rm', path]),
    },
    {
      path: 'src-server/services/orchestration/orchestration-service.ts',
      change: async (root: string, path: string) =>
        execGit([
          '-C',
          root,
          'mv',
          path,
          'src-server/services/orchestration/renamed-service.ts',
        ]),
    },
  ])(
    'requires human review when Codex read-only enforcement policy changes by $path',
    async ({ path, change }) => {
      const repo = await fixture();
      await change(repo.root, path);
      const head = await commit(repo.root, 'change enforcement policy');

      await expect(
        new ReviewLensRouter(repo.base).plan({
          repositoryRoot: repo.root,
          baseSha: repo.base,
          headSha: head,
        }),
      ).resolves.toMatchObject({
        kind: 'human-review-required',
        reason: 'Review routing policy changed in the candidate.',
      });
    },
  );

  it('requires human coverage when any mapped changed path lacks a configured lens', async () => {
    const repo = await fixture();
    await write(repo.root, 'package.json', '{"name":"changed"}\n');
    await write(repo.root, 'src-ui/view.ts', 'export const view = true;\n');
    const head = await commit(repo.root, 'change root manifest and UI');

    await expect(
      new ReviewLensRouter(repo.base).plan({
        repositoryRoot: repo.root,
        baseSha: repo.base,
        headSha: head,
      }),
    ).resolves.toMatchObject({
      kind: 'human-review-required',
      reason: 'Changed Repo Map paths have no configured review lens coverage.',
    });
  });
});
