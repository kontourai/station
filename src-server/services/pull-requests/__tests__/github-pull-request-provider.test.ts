import { describe, expect, test, vi } from 'vitest';
import {
  GitHubPullRequestProvider,
  normalizeGitHubPullRequest,
} from '../github-pull-request-provider.js';

const context = {
  repository: {
    owner: 'kontourai',
    name: 'station',
    remote: 'https://github.com/kontourai/station.git',
  },
  workingDirectory: '/checkout',
  branch: 'feature',
  baseRef: 'main',
};

describe('GitHubPullRequestProvider', () => {
  test('repository settings narrow offered merge methods and label the source', async () => {
    const provider = new GitHubPullRequestProvider(
      vi.fn().mockResolvedValue({ stdout: '' }),
      vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          mergeCommitAllowed: false,
          squashMergeAllowed: true,
          rebaseMergeAllowed: false,
        }),
      }),
    );
    await expect(provider.getAvailability(context)).resolves.toMatchObject({
      effectiveMergeMethods: ['squash'],
      mergeMethodsSource: 'repository',
    });
  });

  test('a failed repository-settings read keeps offered methods labeled provider-default', async () => {
    // The provenance label must be EARNED by a successful read — a failing
    // narrowing read that still claimed 'repository' would be a fabricated
    // derivation (caught by fault injection: forcing the label survived the
    // happy-path test above).
    const provider = new GitHubPullRequestProvider(
      vi.fn().mockResolvedValue({ stdout: '' }),
      vi.fn().mockRejectedValue(new Error('gh repo view failed')),
    );
    await expect(provider.getAvailability(context)).resolves.toMatchObject({
      effectiveMergeMethods: ['merge', 'squash', 'rebase'],
      mergeMethodsSource: 'provider-default',
    });
  });

  test('dispatches an immediate merge without an observation read', async () => {
    const transport = vi.fn().mockResolvedValue({ stdout: '' });
    const result = await new GitHubPullRequestProvider(
      transport,
    ).mergePullRequest(context, '7', { method: 'squash', autoMerge: false });
    expect(transport.mock.calls[1]?.[0]).toEqual([
      'pr',
      'merge',
      '7',
      '--repo',
      'github.com/kontourai/station',
      '--squash',
    ]);
    expect(result.data).toEqual({ status: 'merged' });
  });

  test.each([
    [{ state: 'MERGED', autoMergeRequest: null }, { status: 'merged' }],
    [
      { state: 'OPEN', autoMergeRequest: { enabledAt: 'now' } },
      { status: 'queued-auto-merge' },
    ],
    [
      { state: 'OPEN', autoMergeRequest: null },
      {
        status: 'indeterminate',
        observed: { state: 'OPEN', autoMergeRequest: null },
      },
    ],
  ])(
    'derives auto-merge outcome from observation %#',
    async (observation, expected) => {
      const transport = vi
        .fn()
        .mockResolvedValueOnce({ stdout: '' })
        .mockResolvedValueOnce({ stdout: '' })
        .mockResolvedValueOnce({ stdout: JSON.stringify(observation) });
      const result = await new GitHubPullRequestProvider(
        transport,
      ).mergePullRequest(context, '7', { method: 'squash', autoMerge: true });
      expect(transport.mock.calls[1]?.[0]).toEqual([
        'pr',
        'merge',
        '7',
        '--repo',
        'github.com/kontourai/station',
        '--squash',
        '--auto',
      ]);
      expect(transport.mock.calls[2]?.[0]).toEqual([
        'pr',
        'view',
        '7',
        '--repo',
        'github.com/kontourai/station',
        '--json',
        'state,autoMergeRequest',
      ]);
      expect(result.data).toMatchObject(expected);
    },
  );

  test('reports a failed post-dispatch observation as indeterminate', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValueOnce(new Error('view failed'));
    await expect(
      new GitHubPullRequestProvider(transport).mergePullRequest(context, '7', {
        method: 'merge',
        autoMerge: true,
      }),
    ).resolves.toMatchObject({
      data: {
        status: 'indeterminate',
        observed: { error: 'view failed' },
      },
    });
  });

  /** The runner's rejection shape (src-server/utils/git-exec.ts). */
  const runnerFailure = (args: string[], stderr: string) =>
    Object.assign(
      new Error(`Command failed: ${['gh', ...args].join(' ')}\n${stderr}`),
      { stderr, code: 1, cmd: ['gh', ...args].join(' ') },
    );

  test('an unavailable review snapshot carries gh stderr, never the argv', async () => {
    const args = ['pr', 'view', '17', '--repo', 'github.com/kontourai/station'];
    const transport = vi.fn(async (a: string[]) => {
      if (a[1] === 'view')
        throw runnerFailure(
          a,
          'GraphQL: Could not resolve to a PullRequest with the number of 17. (repository.pullRequest)\n',
        );
      return { stdout: '' };
    });
    const result = await new GitHubPullRequestProvider(
      transport,
      vi.fn().mockResolvedValue({ stdout: '{}' }),
    ).getReviewSnapshot(context, '17');
    expect(result.available).toBe(false);
    expect(result.reason).toBe(
      'GraphQL: Could not resolve to a PullRequest with the number of 17. (repository.pullRequest)',
    );
    expect(result.reason).not.toContain('Command failed');
    expect(result.reason).not.toContain(args.join(' '));
  });

  test('a timed-out review read (runner failure, empty stderr) gets a neutral sentence', async () => {
    const transport = vi.fn(async (a: string[]) => {
      if (a[1] === 'view') throw runnerFailure(a, '');
      return { stdout: '' };
    });
    const result = await new GitHubPullRequestProvider(
      transport,
      vi.fn().mockResolvedValue({ stdout: '{}' }),
    ).getReviewSnapshot(context, '17');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('The review could not be read from GitHub.');
  });

  test('maps a forge refusal without discarding its reason', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValueOnce(
        Object.assign(new Error('exit 1'), {
          stderr: 'Required review is missing',
        }),
      );
    await expect(
      new GitHubPullRequestProvider(transport).mergePullRequest(context, '7', {
        method: 'merge',
      }),
    ).resolves.toMatchObject({
      data: { status: 'refused', reason: 'Required review is missing' },
    });
  });

  test.each([
    ['MERGEABLE', 'mergeable'],
    ['CONFLICTING', 'conflicting'],
    ['UNKNOWN', 'unknown'],
    [undefined, 'unknown'],
  ])('derives mergeability %s as %s', (mergeable, expected) => {
    expect(
      normalizeGitHubPullRequest(
        {
          number: 1,
          url: 'https://github.com/o/r/pull/1',
          title: 't',
          state: 'OPEN',
          headRefName: 'h',
          baseRefName: 'b',
          mergeable,
        },
        'github.com',
      ).mergeability,
    ).toBe(expected);
  });
  test.each(['gh absent', 'gh unauthenticated'])(
    'reports %s without throwing',
    async () => {
      const provider = new GitHubPullRequestProvider(
        vi.fn().mockRejectedValue(new Error('no gh')),
      );
      await expect(provider.getAvailability(context)).resolves.toMatchObject({
        available: false,
        reason:
          'GitHub CLI is unavailable or not authenticated for host github.com',
        effectiveCapabilities: {
          list: false,
          detail: false,
          open: false,
          comment: false,
          approve: false,
        },
      });
    },
  );

  test.each([
    ['https://github.com/kontourai/station.git', 'github.com'],
    ['git@ghe.example.com:kontourai/station.git', 'ghe.example.com'],
  ])('derives host %s as %s', (remote, host) => {
    const provider = new GitHubPullRequestProvider();
    expect(
      provider.getHost({
        ...context,
        repository: { ...context.repository, remote },
      }),
    ).toBe(host);
  });

  test('derives effective capabilities as a subset of offered capabilities', async () => {
    const provider = new GitHubPullRequestProvider(
      vi.fn().mockResolvedValue({ stdout: '' }),
    );
    const availability = await provider.getAvailability(context);
    for (const capability of Object.keys(
      provider.offeredCapabilities,
    ) as (keyof typeof provider.offeredCapabilities)[]) {
      expect(
        availability.effectiveCapabilities[capability] &&
          !provider.offeredCapabilities[capability],
      ).toBe(false);
    }
    expect(availability.effectiveCapabilities).not.toBe(
      provider.offeredCapabilities,
    );

    const unavailableProvider = new GitHubPullRequestProvider(
      vi.fn().mockRejectedValue(new Error('not authenticated')),
    );
    const unavailable = await unavailableProvider.getAvailability(context);
    for (const capability of Object.keys(
      unavailableProvider.offeredCapabilities,
    ) as (keyof typeof unavailableProvider.offeredCapabilities)[]) {
      expect(unavailable.effectiveCapabilities[capability]).toBe(false);
      expect(
        unavailable.effectiveCapabilities[capability] &&
          !unavailableProvider.offeredCapabilities[capability],
      ).toBe(false);
    }
  });

  test('host-qualifies gh repository argv for a GitHub Enterprise remote', async () => {
    const enterpriseContext = {
      ...context,
      repository: {
        ...context.repository,
        remote: 'git@ghe.example.com:kontourai/station.git',
      },
    };
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '[]' });

    await new GitHubPullRequestProvider(transport).listPullRequests(
      enterpriseContext,
      {},
    );

    expect(transport).toHaveBeenNthCalledWith(
      1,
      ['auth', 'status', '--hostname', 'ghe.example.com'],
      enterpriseContext,
    );
    expect(transport.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(['--repo', 'ghe.example.com/kontourai/station']),
    );
  });

  test('reads a declared-output identity without inventing checkout fields', async () => {
    const identity = {
      host: 'github.com',
      repository: { owner: 'kontourai', name: 'station' },
    };
    const transport = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/kontourai/station/pull/7',
        title: 'Title',
        state: 'OPEN',
        headRefName: 'feature',
        baseRefName: 'main',
      }),
    });

    await expect(
      new GitHubPullRequestProvider(transport).getPullRequestByIdentity(
        identity,
        '7',
      ),
    ).resolves.toMatchObject({
      available: true,
      data: { host: 'github.com', ref: '7' },
    });
    expect(transport).toHaveBeenCalledWith(
      expect.arrayContaining([
        'pr',
        'view',
        '7',
        '--repo',
        'github.com/kontourai/station',
      ]),
      identity,
    );
    expect(transport.mock.calls[0]?.[1]).not.toHaveProperty('workingDirectory');
  });

  test('lists pull requests with summary fields and an explicit limit', async () => {
    const transport = vi.fn().mockResolvedValue({ stdout: '[]' });
    const provider = new GitHubPullRequestProvider(transport);

    await expect(provider.listPullRequests(context, {})).resolves.toMatchObject(
      {
        available: true,
        data: [],
      },
    );
    const args = transport.mock.calls.find(([argv]) => argv[0] === 'pr')?.[0];
    expect(args).toEqual(expect.arrayContaining(['list', '--limit', '30']));
    expect(args?.[args.indexOf('--json') + 1].split(',').sort()).toEqual([
      'additions',
      'author',
      'baseRefName',
      'changedFiles',
      'deletions',
      'headRefName',
      'headRefOid',
      'isDraft',
      'number',
      'reviewDecision',
      'state',
      'statusCheckRollup',
      'title',
      'updatedAt',
      'url',
    ]);
  });

  test('pages checkout summaries and only attributes checks to the observed head', async () => {
    const headSha = 'a'.repeat(40);
    const nextCursor = 'Y3Vyc29yOjE=';
    const summary = {
      number: 7,
      url: 'https://github.com/kontourai/station/pull/7',
      title: 'Title',
      state: 'OPEN',
      author: { login: 'casey', url: 'https://github.com/casey' },
      headRefName: 'feature',
      baseRefName: 'main',
      headRefOid: headSha,
      isDraft: true,
      reviewDecision: 'REVIEW_REQUIRED',
      updatedAt: '2026-11-25T20:00:00Z',
      additions: 4,
      deletions: 1,
      changedFiles: 2,
    };
    const transport = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'auth') return { stdout: '' };
      const following = args.includes(`after=${nextCursor}`);
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    ...summary,
                    ...(following
                      ? {
                          number: 6,
                          url: 'https://github.com/kontourai/station/pull/6',
                        }
                      : {}),
                    headRef: {
                      target: {
                        oid: following ? 'b'.repeat(40) : headSha,
                        statusCheckRollup: { state: 'PENDING' },
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: !following, endCursor: nextCursor },
              },
            },
          },
        }),
      };
    });
    const provider = new GitHubPullRequestProvider(transport);

    const first = await provider.listPullRequestPage(context, {
      state: 'OPEN',
    });
    expect(first.data).toMatchObject({
      nextCursor,
      items: [
        {
          ref: '7',
          draft: true,
          reviewDecision: 'review_required',
          snapshot: {
            checks: 'pending',
            additions: 4,
            deletions: 1,
            changedFiles: 2,
            updatedAt: '2026-11-25T20:00:00Z',
          },
        },
      ],
    });
    const args = transport.mock.calls.find(([argv]) => argv[0] === 'api')?.[0];
    expect(args).toEqual(
      expect.arrayContaining(['graphql', 'states[]=OPEN', 'first=30']),
    );
    const query = args?.find((arg: string) => arg.startsWith('query='));
    expect(query).toContain('statusCheckRollup { state }');
    expect(query).not.toMatch(
      /\b(body|commits|reviews|comments|mergeable|mergeStateStatus)\b/,
    );

    const following = await provider.listPullRequestPage(context, {
      state: 'OPEN',
      cursor: first.data?.nextCursor,
    });
    expect(following.data).toMatchObject({ items: [{ ref: '6' }] });
    expect(following.data?.items[0]).not.toHaveProperty('snapshot.checks');
    expect(following.data).not.toHaveProperty('nextCursor');
  });

  test.each(['checkout', 'identity'])(
    'reads full pull request detail by %s',
    async (target) => {
      const identity = {
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'station' },
      };
      const stdout = JSON.stringify({
        number: 7,
        url: 'https://github.com/kontourai/station/pull/7',
        title: 'Title',
        state: 'OPEN',
        headRefName: 'feature',
        baseRefName: 'main',
        body: 'Description',
        commits: [{ oid: 'a'.repeat(40) }],
        reviews: [{ state: 'APPROVED' }],
        comments: [{ body: 'Looks good' }],
        isDraft: false,
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
      });
      const transport = vi.fn().mockResolvedValue({ stdout });
      const provider = new GitHubPullRequestProvider(transport);
      const result = await (target === 'checkout'
        ? provider.getPullRequest(context, '7')
        : provider.getPullRequestByIdentity(identity, '7'));
      expect(result).toMatchObject({
        available: true,
        data: {
          body: 'Description',
          commits: 1,
          reviewStatus: 'APPROVED',
          comments: 1,
          draft: false,
          reviewDecision: 'approved',
          mergeReadiness: 'clean',
        },
      });
      const args = transport.mock.calls.find(([argv]) => argv[0] === 'pr')?.[0];
      expect(args?.[args.indexOf('--json') + 1].split(',')).toEqual(
        expect.arrayContaining([
          'body',
          'commits',
          'reviews',
          'comments',
          'isDraft',
          'reviewDecision',
          'mergeStateStatus',
        ]),
      );
    },
  );

  test.each([
    ['CLEAN', 'clean'],
    ['HAS_HOOKS', 'clean'],
    ['BLOCKED', 'blocked'],
    ['UNSTABLE', 'checks-not-passing'],
    ['DIRTY', 'conflicting'],
    ['BEHIND', 'behind'],
    ['DRAFT', 'draft'],
    ['UNKNOWN', 'unknown'],
  ])(
    'maps mergeStateStatus %s to readiness %s',
    (mergeStateStatus, readiness) => {
      expect(
        normalizeGitHubPullRequest(
          {
            number: 7,
            url: 'https://github.com/kontourai/station/pull/7',
            title: 'Title',
            state: 'OPEN',
            headRefName: 'feature',
            baseRefName: 'main',
            mergeStateStatus,
            isDraft: mergeStateStatus === 'DRAFT',
            reviewDecision: 'CHANGES_REQUESTED',
          },
          'github.com',
        ),
      ).toMatchObject({
        mergeReadiness: readiness,
        draft: mergeStateStatus === 'DRAFT',
        reviewDecision: 'changes_requested',
      });
    },
  );

  test('leaves draft, review decision and readiness absent when gh omits them', () => {
    const normalized = normalizeGitHubPullRequest(
      {
        number: 7,
        url: 'https://github.com/kontourai/station/pull/7',
        title: 'Title',
        state: 'OPEN',
        headRefName: 'feature',
        baseRefName: 'main',
        reviewDecision: '',
      },
      'github.com',
    );
    expect(normalized).not.toHaveProperty('draft');
    expect(normalized).not.toHaveProperty('reviewDecision');
    expect(normalized).not.toHaveProperty('mergeReadiness');
  });

  test('maps gh JSON into the normalized model', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 7,
            url: 'https://github.com/kontourai/station/pull/7',
            title: 'Title',
            body: null,
            state: 'OPEN',
            author: { login: 'casey', url: 'https://github.com/casey' },
            headRefName: 'feature',
            baseRefName: 'main',
            commits: [{ oid: 'a' }],
            reviews: [{ state: 'APPROVED' }],
            comments: [{ id: 'x' }],
          },
        ]),
      });
    const result = await new GitHubPullRequestProvider(
      transport,
    ).listPullRequests(context, {});
    expect(result).toMatchObject({
      available: true,
      data: [
        {
          provider: 'github',
          host: 'github.com',
          ref: '7',
          nativeId: '7',
          repository: { owner: 'kontourai', name: 'station' },
          sourceBranch: 'feature',
          targetBranch: 'main',
          commits: 1,
          comments: 1,
          reviewStatus: 'APPROVED',
        },
      ],
      effectiveCapabilities: {
        list: true,
        detail: true,
        open: true,
        comment: true,
        approve: true,
      },
    });
  });

  test('carries the enterprise host into normalized results', async () => {
    const enterpriseContext = {
      ...context,
      repository: {
        ...context.repository,
        remote: 'https://ghe.example.com/kontourai/station.git',
      },
    };
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 9,
            url: 'https://ghe.example.com/kontourai/station/pull/9',
            title: 'Enterprise PR',
            state: 'OPEN',
            headRefName: 'feature',
            baseRefName: 'main',
          },
        ]),
      });

    const result = await new GitHubPullRequestProvider(
      transport,
    ).listPullRequests(enterpriseContext, {});
    expect(result.data).toEqual([
      expect.objectContaining({ host: 'ghe.example.com', ref: '9' }),
    ]);
  });

  test.each([
    ['open', 'https://github.com/kontourai/station/pull/8\n', undefined],
    [
      'comment',
      'https://github.com/kontourai/station/pull/7#issuecomment-1\n',
      '7',
    ],
    ['approve', '', '7'],
  ])(
    'accepts successful %s output without parsing it as PR JSON',
    async (_operation, output, ref) => {
      const pullRequest = {
        number: Number(ref ?? '8'),
        url: `https://github.com/kontourai/station/pull/${ref ?? '8'}`,
        title: 'Title',
        state: 'OPEN',
        author: { login: 'casey' },
        headRefName: 'feature',
        baseRefName: 'main',
        commits: [],
        reviews: [],
        comments: [],
      };
      const transport = vi
        .fn()
        .mockResolvedValueOnce({ stdout: '' })
        .mockResolvedValueOnce({ stdout: output })
        .mockResolvedValueOnce({ stdout: '' })
        .mockResolvedValueOnce({ stdout: JSON.stringify(pullRequest) });
      const provider = new GitHubPullRequestProvider(transport);
      const result =
        _operation === 'open'
          ? await provider.openPullRequest(context, { title: 'Title' })
          : _operation === 'comment'
            ? await provider.createComment(context, '7', { body: 'ok' })
            : await provider.approvePullRequest(context, '7');
      expect(result).toMatchObject({
        available: true,
        data: { ref: ref ?? '8', title: 'Title' },
      });
    },
  );

  test('rejects incomplete gh JSON rather than exposing a malformed available record', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { number: 7, url: 'https://github.com/x/y/pull/7' },
        ]),
      });
    await expect(
      new GitHubPullRequestProvider(transport).listPullRequests(context, {}),
    ).resolves.toMatchObject({ available: false });
  });
});
