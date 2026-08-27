import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { PullRequestRepositoryContextResolver } from '../pull-request-repository-context-resolver.js';

const remote = async () => ({
  ok: true as const,
  remotes: [
    { name: 'origin', url: 'https://github.com/kontourai/station.git' },
  ],
});
const git = (...values: string[]) =>
  vi.fn(async (_args: string[]) => ({ stdout: values.shift() ?? '' }));

describe('PullRequestRepositoryContextResolver', () => {
  test('rejects a requested repository outside the recorded project root', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'station-pr-context-'));
    const projectRoot = join(fixture, 'project');
    const outsideRoot = join(fixture, 'outside');
    mkdirSync(projectRoot);
    mkdirSync(outsideRoot);
    try {
      const readRemotes = vi.fn(remote);
      const resolver = new PullRequestRepositoryContextResolver({
        git: git() as any,
        readRemotes,
      });
      await expect(
        resolver.resolve({
          projectWorkingDirectory: projectRoot,
          requestedWorkingDirectory: outsideRoot,
        }),
      ).resolves.toEqual({
        available: false,
        reason: 'Requested repository is outside the project checkout',
      });
      expect(readRemotes).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('rejects a contained path that is not the git repository root', async () => {
    // The containment check is the security boundary; THIS check is the
    // correctness refinement — a subdirectory inside the checkout must not
    // resolve as a repository root (caught by fault injection: bypassing
    // the root-equality comparison survived the suite).
    const fixture = mkdtempSync(join(tmpdir(), 'station-pr-context-'));
    const repositoryRoot = join(fixture, 'repo');
    const subdirectory = join(repositoryRoot, 'packages');
    mkdirSync(repositoryRoot);
    mkdirSync(subdirectory);
    const canonicalRepositoryRoot = realpathSync(repositoryRoot);
    try {
      const runGit = git(`${canonicalRepositoryRoot}\n`);
      const resolver = new PullRequestRepositoryContextResolver({
        git: runGit as any,
        readRemotes: remote,
      });
      await expect(
        resolver.resolve({
          projectWorkingDirectory: fixture,
          requestedWorkingDirectory: subdirectory,
        }),
      ).resolves.toEqual({
        available: false,
        reason: 'Requested repository is not a recorded project root',
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('accepts an exact repository root inside the recorded project checkout', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'station-pr-context-'));
    const repositoryRoot = join(fixture, 'repo');
    mkdirSync(repositoryRoot);
    const canonicalRepositoryRoot = realpathSync(repositoryRoot);
    try {
      const runGit = git(
        `${canonicalRepositoryRoot}\n`,
        'feature\n',
        'origin/feature\n',
        '0\t0\n',
        'origin/main\n',
      );
      const resolver = new PullRequestRepositoryContextResolver({
        git: runGit as any,
        readRemotes: remote,
      });
      await expect(
        resolver.resolve({
          projectWorkingDirectory: fixture,
          requestedWorkingDirectory: repositoryRoot,
        }),
      ).resolves.toMatchObject({
        available: true,
        context: { workingDirectory: canonicalRepositoryRoot },
      });
      expect(runGit).toHaveBeenNthCalledWith(
        1,
        ['rev-parse', '--show-toplevel'],
        expect.objectContaining({
          cwd: canonicalRepositoryRoot,
          timeout: 5_000,
        }),
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test.each([
    [
      'detached HEAD',
      git('HEAD\n', 'origin/feature\n', '0\t0\n', 'origin/main\n'),
      remote,
    ],
    [
      'ambiguous forge host',
      git(),
      async () => ({
        ok: true as const,
        remotes: [
          { name: 'origin', url: 'https://github.com/a/b.git' },
          { name: 'gitlab', url: 'https://gitlab.com/a/b.git' },
        ],
      }),
    ],
    ['non-repo', git(), async () => ({ ok: true as const, remotes: [] })],
    [
      'unpushed branch',
      git('feature\n', 'origin/feature\n', '1\t0\n', 'origin/main\n'),
      remote,
    ],
  ])(
    'refuses %s without guessing a context',
    async (_name, runGit, readRemotes) => {
      const resolver = new PullRequestRepositoryContextResolver({
        git: runGit as any,
        readRemotes: readRemotes as any,
      });
      await expect(
        resolver.resolve({ projectWorkingDirectory: '/checkout' }),
      ).resolves.toMatchObject({ available: false });
    },
  );

  test('uses the recorded worktree rather than the project directory', async () => {
    const runGit = git('feature\n', 'origin/feature\n', '0\t0\n', 'main\n');
    const resolver = new PullRequestRepositoryContextResolver({
      git: runGit as any,
      readRemotes: remote,
    });
    const result = await resolver.resolve({
      projectWorkingDirectory: '/project',
      workspaceIsolation: {
        mode: 'worktree',
        repoPath: '/repo',
        path: '/recorded-worktree',
        branch: 'feature',
        baseRef: 'main',
        cleanupPolicy: 'preserve',
        preserveOnFailure: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(result).toMatchObject({
      available: true,
      context: {
        workingDirectory: '/recorded-worktree',
        baseRef: 'main',
        repository: {
          remote: 'https://github.com/kontourai/station.git',
        },
      },
    });
    expect(runGit).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ cwd: '/recorded-worktree' }),
    );
    for (const [, options] of runGit.mock.calls as unknown as [
      string[],
      any,
    ][]) {
      expect(options).toEqual(expect.objectContaining({ timeout: 5_000 }));
    }
  });

  test('routes gitlab.com as a supported provider candidate', async () => {
    const resolver = new PullRequestRepositoryContextResolver({
      git: git(
        'feature\n',
        'origin/feature\n',
        '0\t0\n',
        'origin/main\n',
      ) as any,
      readRemotes: async () => ({
        ok: true,
        remotes: [
          { name: 'origin', url: 'https://gitlab.com/kontourai/station.git' },
        ],
      }),
    });

    await expect(
      resolver.resolve({ projectWorkingDirectory: '/checkout' }),
    ).resolves.toMatchObject({
      available: true,
      context: {
        repository: {
          owner: 'kontourai',
          name: 'station',
          remote: 'https://gitlab.com/kontourai/station.git',
        },
      },
    });
  });

  test('preserves the full GitLab subgroup namespace as owner', async () => {
    const resolver = new PullRequestRepositoryContextResolver({
      git: git(
        'feature\n',
        'origin/feature\n',
        '0\t0\n',
        'origin/main\n',
      ) as any,
      readRemotes: async () => ({
        ok: true,
        remotes: [
          {
            name: 'origin',
            url: 'https://gitlab.com/group/subgroup/station.git',
          },
        ],
      }),
    });
    await expect(
      resolver.resolve({ projectWorkingDirectory: '/checkout' }),
    ).resolves.toMatchObject({
      available: true,
      context: { repository: { owner: 'group/subgroup', name: 'station' } },
    });
  });

  test('keeps bitbucket.org rejected after GitLab becomes supported', async () => {
    for (const url of [
      'https://bitbucket.org:443/kontourai/station.git',
      'https://bitbucket.org./kontourai/station.git',
    ]) {
      const resolver = new PullRequestRepositoryContextResolver({
        git: git() as any,
        readRemotes: async () => ({
          ok: true,
          remotes: [{ name: 'origin', url }],
        }),
      });
      await expect(
        resolver.resolve({ projectWorkingDirectory: '/checkout' }),
      ).resolves.toEqual({
        available: false,
        reason: 'Checkout uses unsupported forge bitbucket.org',
      });
    }
  });

  test('accepts a lone unknown host as a GitHub Enterprise candidate', async () => {
    const resolver = new PullRequestRepositoryContextResolver({
      git: git(
        'feature\n',
        'origin/feature\n',
        '0\t0\n',
        'origin/main\n',
      ) as any,
      readRemotes: async () => ({
        ok: true,
        remotes: [
          {
            name: 'origin',
            url: 'https://code.example.test/kontourai/station.git',
          },
        ],
      }),
    });

    await expect(
      resolver.resolve({ projectWorkingDirectory: '/checkout' }),
    ).resolves.toMatchObject({
      available: true,
      context: {
        repository: {
          owner: 'kontourai',
          name: 'station',
          remote: 'https://code.example.test/kontourai/station.git',
        },
      },
    });
  });
});
