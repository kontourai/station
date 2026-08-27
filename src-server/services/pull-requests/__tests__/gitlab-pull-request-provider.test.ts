import { describe, expect, test, vi } from 'vitest';
import {
  GitLabPullRequestProvider,
  normalizeGitLabMergeRequest,
  UnsupportedGitLabPullRequestStateError,
} from '../gitlab-pull-request-provider.js';

const context = {
  repository: {
    owner: 'kontourai',
    name: 'station',
    remote: 'https://gitlab.com/kontourai/station.git',
  },
  workingDirectory: '/checkout',
  branch: 'feature',
  baseRef: 'main',
};

const mergeRequest = {
  iid: 7,
  web_url: 'https://gitlab.com/kontourai/station/-/merge_requests/7',
  title: 'Title',
  description: null,
  state: 'opened',
  author: { username: 'brian', web_url: 'https://gitlab.com/brian' },
  source_branch: 'feature',
  target_branch: 'main',
  commits_count: 2,
  detailed_merge_status: 'mergeable',
  user_notes_count: 3,
};

describe('GitLabPullRequestProvider', () => {
  test('repository project JSON narrows merge methods and labels the source', async () => {
    const provider = new GitLabPullRequestProvider(
      vi.fn().mockResolvedValue({ stdout: '' }),
      vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          merge_method: 'rebase_merge',
          squash_option: 'never',
        }),
      }),
    );
    await expect(provider.getAvailability(context)).resolves.toMatchObject({
      effectiveMergeMethods: ['rebase'],
      mergeMethodsSource: 'repository',
    });
  });

  test.each([[new Error('settings failed')], [undefined]])(
    'failed or incomplete repository settings retain provider-default provenance',
    async (failure) => {
      const settingsTransport = failure
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue({
            stdout: JSON.stringify({ merge_method: 'merge' }),
          });
      const provider = new GitLabPullRequestProvider(
        vi.fn().mockResolvedValue({ stdout: '' }),
        settingsTransport,
      );
      await expect(provider.getAvailability(context)).resolves.toMatchObject({
        effectiveMergeMethods: ['merge', 'squash', 'rebase'],
        mergeMethodsSource: 'provider-default',
      });
    },
  );

  test('host-qualifies an immediate merge without an observation read', async () => {
    const transport = vi.fn().mockResolvedValue({ stdout: '' });
    const result = await new GitLabPullRequestProvider(
      transport,
    ).mergePullRequest(context, '7', { method: 'squash', autoMerge: false });
    expect(transport.mock.calls[1]?.[0]).toEqual([
      'mr',
      'merge',
      '7',
      '--repo',
      'https://gitlab.com/kontourai/station',
      '--squash',
      '--auto-merge=false',
      '--yes',
    ]);
    expect(result.data).toEqual({ status: 'merged' });
  });

  test('reads a declared-output identity without inventing checkout fields', async () => {
    const identity = {
      host: 'gitlab.com',
      repository: { owner: 'kontourai', name: 'station' },
    };
    const transport = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(mergeRequest),
    });

    await expect(
      new GitLabPullRequestProvider(transport).getPullRequestByIdentity(
        identity,
        '7',
      ),
    ).resolves.toMatchObject({
      available: true,
      data: { host: 'gitlab.com', ref: '7' },
    });
    expect(transport).toHaveBeenCalledWith(
      expect.arrayContaining([
        'mr',
        'view',
        '7',
        '--repo',
        'https://gitlab.com/kontourai/station',
      ]),
      identity,
    );
    expect(transport.mock.calls[0]?.[1]).not.toHaveProperty('workingDirectory');
  });

  test.each([
    [{ state: 'merged' }, { status: 'merged' }],
    [
      { state: 'opened', merge_when_pipeline_succeeds: true },
      { status: 'queued-auto-merge' },
    ],
    [
      { state: 'opened', auto_merge_enabled: true },
      { status: 'queued-auto-merge' },
    ],
    [
      { state: 'opened', merge_when_pipeline_succeeds: false },
      {
        status: 'indeterminate',
        observed: {
          state: 'opened',
          merge_when_pipeline_succeeds: false,
          auto_merge_enabled: null,
        },
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
      const result = await new GitLabPullRequestProvider(
        transport,
      ).mergePullRequest(context, '7', { method: 'squash', autoMerge: true });
      expect(transport.mock.calls[1]?.[0]).toEqual([
        'mr',
        'merge',
        '7',
        '--repo',
        'https://gitlab.com/kontourai/station',
        '--squash',
        '--auto-merge',
        '--yes',
      ]);
      expect(transport.mock.calls[2]?.[0]).toEqual([
        'mr',
        'view',
        '7',
        '--repo',
        'https://gitlab.com/kontourai/station',
        '--output',
        'json',
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
      new GitLabPullRequestProvider(transport).mergePullRequest(context, '7', {
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

  test('carries a glab refusal reason', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValueOnce(
        Object.assign(new Error('exit 1'), { stderr: 'Pipeline must succeed' }),
      );
    await expect(
      new GitLabPullRequestProvider(transport).mergePullRequest(context, '7', {
        method: 'merge',
      }),
    ).resolves.toMatchObject({
      data: { status: 'refused', reason: 'Pipeline must succeed' },
    });
  });

  test.each([
    ['can_be_merged', undefined, 'mergeable'],
    ['cannot_be_merged', undefined, 'conflicting'],
    ['unchecked', undefined, 'unknown'],
    [undefined, undefined, 'unknown'],
  ])(
    'derives merge_status %s as %s',
    (merge_status, detailed_merge_status, expected) => {
      expect(
        normalizeGitLabMergeRequest(
          { ...mergeRequest, merge_status, detailed_merge_status },
          'gitlab.com',
        ).mergeability,
      ).toBe(expected);
    },
  );
  test.each([
    ['checking', 'cannot_be_merged', 'unknown'],
    ['mergeable', 'cannot_be_merged', 'mergeable'],
    ['conflict', 'can_be_merged', 'conflicting'],
  ])(
    'treats detailed status %s as authoritative over legacy %s',
    (detailed_merge_status, merge_status, expected) => {
      expect(
        normalizeGitLabMergeRequest(
          { ...mergeRequest, detailed_merge_status, merge_status },
          'gitlab.com',
        ).mergeability,
      ).toBe(expected);
    },
  );
  test('reports a missing glab binary by name', async () => {
    const provider = new GitLabPullRequestProvider(
      vi.fn().mockRejectedValue(new Error('ENOENT')),
    );
    await expect(provider.getAvailability(context)).resolves.toMatchObject({
      available: false,
      reason:
        'glab CLI is unavailable or not authenticated for host gitlab.com',
      effectiveCapabilities: {
        list: false,
        detail: false,
        open: false,
        comment: false,
        approve: false,
      },
    });
  });

  test.each([
    ['https://gitlab.com/kontourai/station.git', 'gitlab.com'],
    ['git@gitlab.example.com:kontourai/station.git', 'gitlab.example.com'],
  ])('derives host %s as %s', (remote, host) => {
    const provider = new GitLabPullRequestProvider();
    expect(
      provider.getHost({
        ...context,
        repository: { ...context.repository, remote },
      }),
    ).toBe(host);
  });

  test('keeps effective capabilities within the offered set', async () => {
    for (const transport of [
      vi.fn().mockResolvedValue({ stdout: '' }),
      vi.fn().mockRejectedValue(new Error('not authenticated')),
    ]) {
      const provider = new GitLabPullRequestProvider(transport);
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
    }
  });

  test('maps GitLab JSON and uses iid as the contract ref', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([mergeRequest]) });
    const result = await new GitLabPullRequestProvider(
      transport,
    ).listPullRequests(context, {});
    expect(result).toMatchObject({
      available: true,
      data: [
        {
          provider: 'gitlab',
          host: 'gitlab.com',
          ref: '7',
          nativeId: '7',
          state: 'OPEN',
          repository: { owner: 'kontourai', name: 'station' },
          sourceBranch: 'feature',
          targetBranch: 'main',
          commits: 2,
          comments: 3,
          reviewStatus: 'mergeable',
        },
      ],
    });
  });

  test.each([
    ['opened', []],
    [undefined, []],
    ['closed', ['--closed']],
    ['merged', ['--merged']],
    ['all', ['--all']],
  ])('maps list state %s to glab flags', async (state, expected) => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '[]' });
    await new GitLabPullRequestProvider(transport).listPullRequests(context, {
      state,
    });
    const args = transport.mock.calls[1]?.[0] as string[];
    const expectedFlags = expected as string[];
    expect(args).not.toContain('--state');
    for (const flag of expectedFlags) expect(args).toContain(flag);
    for (const flag of ['--closed', '--merged', '--all'].filter(
      (x) => !expectedFlags.includes(x),
    )) {
      expect(args).not.toContain(flag);
    }
  });

  test('rejects an unsupported list state with a typed error', async () => {
    await expect(
      new GitLabPullRequestProvider(vi.fn()).listPullRequests(context, {
        state: 'draft',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'UnsupportedGitLabPullRequestStateError',
        message: 'Unsupported GitLab pull request state: draft',
      }),
    );
    await expect(
      new GitLabPullRequestProvider(vi.fn()).listPullRequests(context, {
        state: 'draft',
      }),
    ).rejects.toBeInstanceOf(UnsupportedGitLabPullRequestStateError);
  });

  test.each([
    ['opened', 'OPEN'],
    ['closed', 'CLOSED'],
    ['merged', 'MERGED'],
    ['locked', 'LOCKED'],
  ])('normalizes GitLab state %s to %s', async (state, normalized) => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ ...mergeRequest, state }]),
      });
    const result = await new GitLabPullRequestProvider(
      transport,
    ).listPullRequests(context, {});
    expect(result.data?.[0]?.state).toBe(normalized);
  });

  test('uses the full subgroup URL for iid operations', async () => {
    const subgroupContext = {
      ...context,
      repository: {
        owner: 'group/subgroup',
        name: 'station',
        remote: 'https://gitlab.com/group/subgroup/station.git',
      },
    };
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(mergeRequest) });
    await new GitLabPullRequestProvider(transport).getPullRequest(
      subgroupContext,
      '7',
    );
    expect(transport.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        '7',
        '--repo',
        'https://gitlab.com/group/subgroup/station',
      ]),
    );
  });

  test.each([
    ['list', (p: GitLabPullRequestProvider) => p.listPullRequests(context, {})],
    [
      'detail',
      (p: GitLabPullRequestProvider) => p.getPullRequest(context, '7'),
    ],
    [
      'open',
      (p: GitLabPullRequestProvider) =>
        p.openPullRequest(context, { title: 'Title' }),
    ],
    [
      'comment',
      (p: GitLabPullRequestProvider) =>
        p.createComment(context, '7', { body: 'ok' }),
    ],
    [
      'approve',
      (p: GitLabPullRequestProvider) => p.approvePullRequest(context, '7'),
    ],
  ])('host-qualifies every %s operation', async (_name, run) => {
    const transport = vi.fn(async (args: string[]) => {
      if (args[0] === 'auth') return { stdout: '' };
      if (args[1] === 'list') return { stdout: '[]' };
      if (args[1] === 'view') return { stdout: JSON.stringify(mergeRequest) };
      return { stdout: '' };
    });
    await run(new GitLabPullRequestProvider(transport));
    expect(transport).toHaveBeenNthCalledWith(
      1,
      ['auth', 'status', '--hostname', 'gitlab.com'],
      context,
    );
    expect(transport.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        '--repo',
        'https://gitlab.com/kontourai/station',
      ]),
    );
  });
});
