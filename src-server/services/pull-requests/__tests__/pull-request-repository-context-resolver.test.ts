import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { PullRequestRepositoryContextResolver } from '../pull-request-repository-context-resolver.js';

const makeTempDir = trackTempDirs();

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

  /**
   * #1536 G5: an ordinary local repository is not a failure, and the panel
   * cannot tell it from one by reading the sentence. A read that could not be
   * performed deliberately carries no cause.
   */
  test('classifies a remote-less checkout as no-remote, and an unreadable one as neither', async () => {
    const noRemotes = new PullRequestRepositoryContextResolver({
      git: git() as any,
      readRemotes: (async () => ({ ok: true as const, remotes: [] })) as any,
    });
    await expect(
      noRemotes.resolve({ projectWorkingDirectory: '/checkout' }),
    ).resolves.toEqual({
      available: false,
      reason: 'Checkout has no remote',
      cause: 'no-remote',
    });

    const unreadable = new PullRequestRepositoryContextResolver({
      git: git() as any,
      readRemotes: (async () => ({
        ok: false as const,
        reason: 'git could not be run',
      })) as any,
    });
    await expect(
      unreadable.resolve({ projectWorkingDirectory: '/checkout' }),
    ).resolves.toEqual({
      available: false,
      reason: 'git could not be run',
    });
  });

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

  /**
   * #2474: reading pull request #N needs the repository, not a pushed branch.
   * The same refusals still hold for opening one from the current branch.
   */
  test.each([
    [
      'detached HEAD',
      ['HEAD\n', 'origin/feature\n', '0\t0\n', 'origin/main\n'],
    ],
    [
      'unpushed branch',
      ['feature\n', 'origin/feature\n', '1\t0\n', 'origin/main\n'],
    ],
    ['no recorded base', ['feature\n', 'origin/feature\n', '0\t0\n', '\n']],
  ])('a read resolves a %s checkout on identity alone', async (_name, out) => {
    const make = () =>
      new PullRequestRepositoryContextResolver({
        git: git(...out) as any,
        readRemotes: remote as any,
      });
    await expect(
      make().resolve({
        projectWorkingDirectory: '/checkout',
        requireBranchState: false,
      }),
    ).resolves.toEqual({
      available: true,
      context: {
        repository: {
          owner: 'kontourai',
          name: 'station',
          remote: 'https://github.com/kontourai/station.git',
        },
        workingDirectory: '/checkout',
      },
    });
    await expect(
      make().resolve({ projectWorkingDirectory: '/checkout' }),
    ).resolves.toMatchObject({ available: false });
  });

  /**
   * #2475: an umbrella project directory is not a repository; the pull
   * request's own identity picks the one child checkout it belongs to.
   */
  test('an umbrella project resolves to the one child whose remote names the repository', async () => {
    let outside: string | undefined;
    const umbrella = realpathSync(makeTempDir('station-umbrella-'));
    try {
      // Checkouts carry a `.git` entry; a plain folder is never asked.
      for (const name of ['station', 'flow', 'notes', '.hidden'])
        mkdirSync(join(umbrella, name, '.git'), { recursive: true });
      mkdirSync(join(umbrella, 'plain-folder'));
      // A symlinked child points outside the project and is never followed.
      outside = realpathSync(makeTempDir('station-outside-'));
      mkdirSync(join(outside, '.git'));
      symlinkSync(outside, join(umbrella, 'linked'));
      const asked: string[] = [];
      const remotesByPath: Record<string, { name: string; url: string }[]> = {
        [join(umbrella, 'station')]: [
          { name: 'origin', url: 'https://github.com/kontourai/station.git' },
        ],
        [join(umbrella, 'flow')]: [
          { name: 'origin', url: 'https://github.com/kontourai/flow.git' },
        ],
        [join(umbrella, '.hidden')]: [
          { name: 'origin', url: 'https://github.com/kontourai/station.git' },
        ],
      };
      remotesByPath[join(umbrella, 'linked')] = [
        { name: 'origin', url: 'https://github.com/kontourai/station.git' },
      ];
      remotesByPath[join(umbrella, 'plain-folder')] = [
        { name: 'origin', url: 'https://github.com/kontourai/station.git' },
      ];
      const readRemotes = async (path: string) => {
        asked.push(path);
        return { ok: true as const, remotes: remotesByPath[path] ?? [] };
      };
      const make = () =>
        new PullRequestRepositoryContextResolver({
          git: git() as any,
          readRemotes: readRemotes as any,
        });
      await expect(
        make().resolve({
          projectWorkingDirectory: umbrella,
          requireBranchState: false,
          repository: {
            host: 'github.com',
            owner: 'KontourAI',
            name: 'station',
          },
        }),
      ).resolves.toMatchObject({
        available: true,
        context: {
          workingDirectory: join(umbrella, 'station'),
          repository: { owner: 'kontourai', name: 'station' },
        },
      });
      // Neither the symlink nor the folder without `.git` was asked — each
      // claims the same repository, so asking would have made it ambiguous.
      expect(asked).not.toContain(join(umbrella, 'linked'));
      expect(asked).not.toContain(join(umbrella, 'plain-folder'));

      // A repository no child holds, or a request naming none, stays refused.
      for (const repository of [
        { host: 'github.com', owner: 'kontourai', name: 'absent' },
        undefined,
      ])
        await expect(
          make().resolve({
            projectWorkingDirectory: umbrella,
            requireBranchState: false,
            ...(repository ? { repository } : {}),
          }),
        ).resolves.toMatchObject({ available: false, cause: 'no-remote' });
      // Two children claiming the same repository are ambiguous, not a pick.
      remotesByPath[join(umbrella, 'notes')] = [
        { name: 'origin', url: 'git@github.com:kontourai/station.git' },
      ];
      await expect(
        make().resolve({
          projectWorkingDirectory: umbrella,
          requireBranchState: false,
          repository: {
            host: 'github.com',
            owner: 'kontourai',
            name: 'station',
          },
        }),
      ).resolves.toMatchObject({ available: false });
    } finally {
      rmSync(umbrella, { recursive: true, force: true });
      if (outside) rmSync(outside, { recursive: true, force: true });
    }
  });

  /**
   * The owner's own checkout: an https `origin` and an ssh `public` for the
   * SAME repository. Counting remotes rather than repositories made every
   * pull-request read for that project 404 as "ambiguous".
   */
  test('an umbrella lookup is reused for a short while, then read again', async () => {
    const umbrella = realpathSync(makeTempDir('station-umbrella-'));
    try {
      mkdirSync(join(umbrella, 'station', '.git'), { recursive: true });
      let reads = 0;
      let clock = 1_000;
      const resolver = new PullRequestRepositoryContextResolver({
        git: git() as any,
        now: () => clock,
        readRemotes: (async (path: string) => {
          if (path === umbrella) return { ok: true as const, remotes: [] };
          reads += 1;
          return {
            ok: true as const,
            remotes: [
              {
                name: 'origin',
                url: 'https://github.com/kontourai/station.git',
              },
            ],
          };
        }) as any,
      });
      const ask = () =>
        resolver.resolve({
          projectWorkingDirectory: umbrella,
          requireBranchState: false,
          repository: {
            host: 'github.com',
            owner: 'kontourai',
            name: 'station',
          },
        });
      await Promise.all([ask(), ask()]);
      await ask();
      expect(reads).toBe(1);
      clock += 30_001;
      await expect(ask()).resolves.toMatchObject({ available: true });
      expect(reads).toBe(2);
    } finally {
      rmSync(umbrella, { recursive: true, force: true });
    }
  });

  test('an umbrella lookup runs at most eight git reads at once', async () => {
    const umbrella = realpathSync(makeTempDir('station-umbrella-'));
    try {
      for (let index = 0; index < 20; index += 1)
        mkdirSync(join(umbrella, `repo-${index}`, '.git'), { recursive: true });
      let inFlight = 0;
      let peak = 0;
      const readRemotes = async (path: string) => {
        if (path === umbrella) return { ok: true as const, remotes: [] };
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((done) => setTimeout(done, 5));
        inFlight -= 1;
        return { ok: true as const, remotes: [] };
      };
      await new PullRequestRepositoryContextResolver({
        git: git() as any,
        readRemotes: readRemotes as any,
      }).resolve({
        projectWorkingDirectory: umbrella,
        requireBranchState: false,
        repository: { host: 'github.com', owner: 'o', name: 'r' },
      });
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(8);
    } finally {
      rmSync(umbrella, { recursive: true, force: true });
    }
  });

  test('several remotes for one repository are one identity, not an ambiguity', async () => {
    const twoRemotes = async () => ({
      ok: true as const,
      remotes: [
        { name: 'public', url: 'git@github.com:kontourai/station.git' },
        { name: 'origin', url: 'https://github.com/KontourAI/Station.git' },
      ],
    });
    const runGit = git('main\n', 'origin/main\n', '0\t0\n', 'origin/main\n');
    const resolver = new PullRequestRepositoryContextResolver({
      git: runGit as any,
      readRemotes: twoRemotes as any,
    });
    await expect(
      resolver.resolve({ projectWorkingDirectory: '/checkout' }),
    ).resolves.toMatchObject({
      available: true,
      context: {
        repository: {
          owner: 'KontourAI',
          name: 'Station',
          remote: 'https://github.com/KontourAI/Station.git',
        },
      },
    });
    // `origin` is the remote whose HEAD names the base branch.
    expect(runGit.mock.calls.map(([args]) => args.join(' '))).toContain(
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD',
    );

    const exact = new PullRequestRepositoryContextResolver({
      git: git(`${realpathSync(tmpdir())}\n`) as any,
      readRemotes: twoRemotes as any,
    });
    await expect(
      exact.resolveExactIdentity({ workingDirectory: realpathSync(tmpdir()) }),
    ).resolves.toEqual({
      available: true,
      context: {
        host: 'github.com',
        repository: { owner: 'KontourAI', name: 'Station' },
      },
    });
  });

  test('credentials in a remote URL are not part of its host', async () => {
    const resolver = new PullRequestRepositoryContextResolver({
      git: git('main\n', 'origin/main\n', '0\t0\n', 'origin/main\n') as any,
      readRemotes: (async () => ({
        ok: true as const,
        remotes: [
          { name: 'origin', url: 'https://token@github.com/o/r.git' },
          { name: 'push', url: 'git@github.com:o/r.git' },
        ],
      })) as any,
    });
    await expect(
      resolver.resolve({ projectWorkingDirectory: '/checkout' }),
    ).resolves.toMatchObject({ available: true });
  });

  test('several remotes for one Bitbucket repository are still an unsupported forge', async () => {
    const resolver = new PullRequestRepositoryContextResolver({
      git: git() as any,
      readRemotes: (async () => ({
        ok: true as const,
        remotes: [
          { name: 'origin', url: 'https://bitbucket.org/o/r.git' },
          { name: 'ssh', url: 'git@bitbucket.org:o/r.git' },
        ],
      })) as any,
    });
    await expect(
      resolver.resolve({ projectWorkingDirectory: '/checkout' }),
    ).resolves.toEqual({
      available: false,
      reason: 'Checkout uses unsupported forge bitbucket.org',
    });
  });

  test('remotes naming two repositories, or one that does not parse, stay ambiguous', async () => {
    for (const remotes of [
      [
        { name: 'origin', url: 'https://github.com/kontourai/station.git' },
        { name: 'fork', url: 'https://github.com/someone/station.git' },
      ],
      [
        { name: 'origin', url: 'https://github.com/kontourai/station.git' },
        { name: 'mirror', url: '/srv/mirror/station.git' },
      ],
    ]) {
      const resolver = new PullRequestRepositoryContextResolver({
        git: git() as any,
        readRemotes: (async () => ({ ok: true as const, remotes })) as any,
      });
      await expect(
        resolver.resolve({ projectWorkingDirectory: '/checkout' }),
      ).resolves.toMatchObject({
        available: false,
        reason: 'Checkout forge host is ambiguous or unsupported',
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

describe('the branch a pull request opens from (#2363 round 4)', () => {
  /** A git that answers by command; an unknown command fails like an unset key. */
  const answering = (answers: Record<string, string>) =>
    vi.fn(async (args: string[]) => {
      const key = args.join(' ');
      if (key in answers) return { stdout: `${answers[key]}\n` };
      throw Object.assign(new Error(`unset: ${key}`), { code: 1 });
    });
  const base = {
    'rev-parse --abbrev-ref HEAD': 'fx',
    'rev-parse --abbrev-ref @{upstream}': 'origin/feature-x',
    'rev-list --left-right --count HEAD...@{upstream}': '0\t0',
    'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/main',
  };
  const resolveWith = (answers: Record<string, string>) =>
    new PullRequestRepositoryContextResolver({
      git: answering({ ...base, ...answers }) as any,
      readRemotes: remote,
    }).resolve({ projectWorkingDirectory: '/checkout' });

  test('no recorded upstream branch: the local branch applies', async () => {
    const result = await resolveWith({});
    expect(result).toMatchObject({
      available: true,
      context: { branch: 'fx' },
    });
    expect(
      (result as { context: { head?: unknown } }).context.head,
    ).toBeUndefined();
  });

  test('the same name upstream: that branch', async () => {
    await expect(
      resolveWith({
        'rev-parse --abbrev-ref HEAD': 'feature',
        'config --get branch.feature.remote': 'origin',
        'config --get branch.feature.merge': 'refs/heads/feature',
      }),
    ).resolves.toMatchObject({ context: { head: { branch: 'feature' } } });
  });

  test('a renamed upstream: the pushed name, not the local one', async () => {
    const result = await resolveWith({
      'config --get branch.fx.remote': 'origin',
      'config --get branch.fx.merge': 'refs/heads/feature-x',
    });
    expect(result).toMatchObject({
      context: { branch: 'fx', head: { branch: 'feature-x' } },
    });
    expect((result as { context: { head: object } }).context.head).toEqual({
      branch: 'feature-x',
    });
  });

  test("a fork upstream: the fork's owner and name, from its configured address", async () => {
    await expect(
      resolveWith({
        'config --get branch.fx.remote': 'fork',
        'config --get branch.fx.merge': 'refs/heads/feature-x',
        'config --get remote.fork.url': 'git@github.com:someone/station.git',
      }),
    ).resolves.toMatchObject({
      context: {
        head: { branch: 'feature-x', owner: 'someone', repository: 'station' },
      },
    });
  });

  test('a fork on another host, or with no address, is refused rather than guessed', async () => {
    for (const url of ['https://gitlab.com/someone/station.git', undefined]) {
      await expect(
        resolveWith({
          'config --get branch.fx.remote': 'fork',
          'config --get branch.fx.merge': 'refs/heads/feature-x',
          ...(url ? { 'config --get remote.fork.url': url } : {}),
        }),
      ).resolves.toMatchObject({
        available: false,
        reason: expect.stringContaining('Cannot tell which repository'),
      });
    }
  });
});
