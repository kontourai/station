import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execGit } from '../../../utils/git-exec.js';
import { RepoMapReviewSelection } from '../repo-map-review-selection.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'station-review-selection-'));
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
            id: 'product.src-ui',
            label: 'ui',
            kind: 'area',
            patterns: ['src-ui/'],
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
          id: 'ui',
          nodeIds: ['product.src-ui'],
          instructions: 'Trusted UI review.',
        },
      ],
    }),
  );
  await write(root, 'src-ui/view.ts', 'export const view = 1;\n');
  await execGit(['-C', root, 'add', '.']);
  await execGit(['-C', root, 'commit', '-m', 'base']);
  const base = (await execGit(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  await write(root, 'src-ui/view.ts', 'export const view = 2;\n');
  await execGit(['-C', root, 'commit', '-am', 'change UI']);
  const head = (await execGit(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  return { root, base, head };
}

async function write(root: string, path: string, content: string) {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
}

function selection(
  root: string,
  globalAgentSlugs: string[],
  policyRevision = 'HEAD~1',
) {
  return new RepoMapReviewSelection({
    target: () => ({
      projectSlug: 'station',
      workspace: root,
      globalAgentSlugs,
    }),
    listAgents: async () => [
      {
        slug: 'codex-reviewer' as never,
        name: 'Codex reviewer',
        updatedAt: '2026-01-01T00:00:00.000Z',
        execution: { agentConnectionId: 'codex' as never },
      },
    ],
    supportsReadOnlyReview: () => true,
    isCodexReviewerAvailable: (agent) =>
      agent.execution?.agentConnectionId === 'codex',
    policyRevision,
  });
}

const request = (base: string, head: string) => ({
  requestId: 'selection-1',
  mode: 'initial' as const,
  target: {
    kind: 'git-range' as const,
    projectSlug: 'station',
    baseRevision: base,
    headRevision: head,
  },
  implementerAgentSlug: 'implementer',
  reviewers: [],
  selection: { kind: 'repo-map' as const },
});

describe('RepoMapReviewSelection', () => {
  it('selects a project-eligible Codex Agent and records trusted routing', async () => {
    const repo = await fixture();
    await expect(
      selection(repo.root, ['codex-reviewer']).resolve(
        request(repo.base, repo.head),
        {},
      ),
    ).resolves.toMatchObject({
      kind: 'selected',
      reviewers: [
        {
          executorAgentSlug: 'codex-reviewer',
          lens: { id: 'ui', instructions: 'Trusted UI review.' },
        },
      ],
      routing: { kind: 'repo-map', affectedNodes: ['product.src-ui'] },
    });
  });

  it.each([
    {
      policyRevision: 'HEAD',
      baseRevision: 'origin/main',
      headRevision: 'HEAD',
    },
    {
      policyRevision: 'origin/main',
      baseRevision: 'origin/main',
      headRevision: 'HEAD',
    },
  ])(
    'resolves $baseRevision..$headRevision and policy $policyRevision to immutable SHAs',
    async ({ policyRevision, baseRevision, headRevision }) => {
      const repo = await fixture();
      await execGit([
        '-C',
        repo.root,
        'update-ref',
        'refs/remotes/origin/main',
        repo.base,
      ]);

      await expect(
        selection(repo.root, ['codex-reviewer'], policyRevision).resolve(
          request(baseRevision, headRevision),
          {},
        ),
      ).resolves.toMatchObject({
        kind: 'selected',
        target: {
          baseRevision,
          headRevision,
          baseSha: repo.base,
          headSha: repo.head,
        },
      });
    },
  );

  it('does not allocate an Agent outside the trusted project scope', async () => {
    const repo = await fixture();
    await expect(
      selection(repo.root, []).resolve(request(repo.base, repo.head), {}),
    ).resolves.toMatchObject({
      kind: 'unavailable',
      unavailableLenses: ['ui'],
    });
  });
});
