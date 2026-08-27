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
            author: { login: 'brian', url: 'https://github.com/brian' },
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
        author: { login: 'brian' },
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
