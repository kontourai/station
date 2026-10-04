import type {
  PullRequest,
  PullRequestRepositoryContext,
} from '@kontourai/station-contracts/pull-request-provider';
import { describe, expect, test, vi } from 'vitest';
import {
  readPullRequestReview,
  writePullRequestReview,
} from '../pull-request-review.js';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  changed = 'c'.repeat(40);
const context: PullRequestRepositoryContext = {
  repository: {
    owner: 'group/nested',
    name: 'repo',
    remote: 'https://forge.test/group/nested/repo.git',
  },
  workingDirectory: '/unused',
  branch: 'feature',
  baseRef: 'main',
};
const normalized: PullRequest = {
  provider: 'github',
  host: 'forge.test',
  ref: '17',
  url: 'https://forge.test/group/nested/repo/pull/17',
  repository: { owner: '', name: '' },
  title: 'Change',
  body: null,
  state: 'OPEN',
  author: { login: 'author' },
  sourceBranch: 'feature',
  targetBranch: 'main',
  commits: 1,
  reviewStatus: 'NONE',
  comments: 0,
  nativeId: '17',
  mergeability: 'unknown',
};
const raw = (forge: 'github' | 'gitlab', revision = head) =>
  forge === 'github'
    ? { headRefOid: revision, baseRefOid: base, comments: [], reviews: [] }
    : { diff_refs: { head_sha: revision, base_sha: base } };
const json = (value: unknown) => ({ stdout: JSON.stringify(value) });
for (const forge of ['github', 'gitlab'] as const)
  describe(forge, () => {
    test('reads only the named forge and refuses a diff whose head changed mid-read', async () => {
      let reads = 0;
      const run = vi.fn(async (args: string[]) => {
        if (args[1] === 'view')
          return json(raw(forge, ++reads === 1 ? head : changed));
        if (args[1].includes('notes?')) return json([]);
        return {
          stdout:
            'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n',
        };
      });
      await expect(
        readPullRequestReview(forge, 'forge.test', context, '17', run, () => ({
          ...normalized,
          provider: forge,
        })),
      ).rejects.toThrow('changed during');
      expect(
        run.mock.calls.every(
          ([args]) =>
            args.includes('forge.test') ||
            args.some((a) => a.includes('forge.test/')),
        ),
      ).toBe(true);
    });
    test('keeps discussion readable when a bounded diff is unavailable', async () => {
      // Each forge delivers its discussion newest-first; the snapshot reads
      // oldest-first across comments and reviews.
      const run = vi.fn(async (args: string[]) => {
        if (args[1] === 'view')
          return json(
            forge === 'github'
              ? {
                  ...raw(forge),
                  comments: [
                    {
                      id: 'IC_2',
                      author: { login: 'alice' },
                      body: 'Looks close.',
                      createdAt: '2026-01-02T00:00:00Z',
                    },
                  ],
                  reviews: [
                    {
                      id: 'PRR_1',
                      author: { login: 'bob' },
                      body: 'Needs a test.',
                      submittedAt: '2026-01-01T00:00:00Z',
                      state: 'CHANGES_REQUESTED',
                    },
                  ],
                }
              : raw(forge),
          );
        if (args[1].includes('notes?'))
          return json([
            {
              id: 12,
              author: { username: 'alice' },
              body: 'Looks close.',
              created_at: '2026-01-02T00:00:00Z',
            },
            {
              id: 11,
              author: { username: 'bob' },
              body: 'Needs a test.',
              created_at: '2026-01-01T00:00:00Z',
            },
          ]);
        if (args[1].endsWith('/approvals')) return json({ approved_by: [] });
        return { stdout: 'x'.repeat(262145) };
      });
      const result = await readPullRequestReview(
        forge,
        'forge.test',
        context,
        '17',
        run,
        () => ({ ...normalized, provider: forge }),
      );
      expect(result.diff).toMatchObject({ state: 'unavailable' });
      expect(result).toMatchObject({
        headSha: head,
        baseSha: base,
        pullRequest: { repository: { owner: 'group/nested', name: 'repo' } },
      });
      expect(result.discussionPartial).toBe(false);
      expect(result.discussion).toEqual(
        forge === 'github'
          ? [
              {
                id: 'PRR_1',
                author: 'bob',
                body: 'Needs a test.',
                createdAt: '2026-01-01T00:00:00Z',
                kind: 'review',
                state: 'CHANGES_REQUESTED',
              },
              {
                id: 'IC_2',
                author: 'alice',
                body: 'Looks close.',
                createdAt: '2026-01-02T00:00:00Z',
                kind: 'comment',
              },
            ]
          : [
              {
                id: '11',
                author: 'bob',
                body: 'Needs a test.',
                createdAt: '2026-01-01T00:00:00Z',
                kind: 'comment',
              },
              {
                id: '12',
                author: 'alice',
                body: 'Looks close.',
                createdAt: '2026-01-02T00:00:00Z',
                kind: 'comment',
              },
            ],
      );
    });
    test('changed revision refuses before any provider write', async () => {
      const run = vi.fn(async (args: string[]) =>
        json(
          args[1] === 'user'
            ? { id: 7, login: 'operator', username: 'operator' }
            : raw(forge, changed),
        ),
      );
      await expect(
        writePullRequestReview(
          forge,
          'forge.test',
          context,
          '17',
          { action: 'approve', expectedHeadSha: head },
          run,
        ),
      ).resolves.toMatchObject({
        status: 'refused',
        reason: expect.stringContaining('head changed'),
      });
      expect(run.mock.calls.some(([args]) => args.includes('POST'))).toBe(
        false,
      );
    });
    test('approval binds the provider write to the inspected SHA and verifies the actor', async () => {
      const run = vi.fn(async (args: string[]) => {
        if (args[1] === 'user')
          return json({ id: 7, login: 'operator', username: 'operator' });
        if (args[1] === 'view') return json(raw(forge));
        return json(
          forge === 'github'
            ? {
                id: 80,
                user: { id: 7, login: 'operator' },
                commit_id: head,
                state: 'APPROVED',
              }
            : { id: 80, approved_by: [{ user: { id: 7 } }] },
        );
      });
      await expect(
        writePullRequestReview(
          forge,
          'forge.test',
          context,
          '17',
          { action: 'approve', expectedHeadSha: head },
          run,
        ),
      ).resolves.toEqual({
        status: 'confirmed',
        nativeId: '80',
        actor: 'operator',
        headSha: head,
      });
      const write = run.mock.calls.find(([args]) => args.includes('POST'))![0];
      expect(write).toContain(
        `${forge === 'github' ? 'commit_id' : 'sha'}=${head}`,
      );
    });
    test('lost acknowledgement and wrong actor remain indeterminate', async () => {
      for (const failure of ['lost', 'actor']) {
        const run = vi.fn(async (args: string[]) => {
          if (args[1] === 'user')
            return json({ id: 7, login: 'operator', username: 'operator' });
          if (args[1] === 'view') return json(raw(forge));
          if (failure === 'lost') throw Error('response lost');
          return json(
            forge === 'github'
              ? { id: 80, user: { id: 8 }, commit_id: head, state: 'APPROVED' }
              : { id: 80, approved_by: [{ user: { id: 8 } }] },
          );
        });
        await expect(
          writePullRequestReview(
            forge,
            'forge.test',
            context,
            '17',
            { action: 'approve', expectedHeadSha: head },
            run,
          ),
        ).resolves.toMatchObject({ status: 'indeterminate' });
        expect(
          run.mock.calls.filter(([args]) => args.includes('POST')),
        ).toHaveLength(1);
      }
    });
  });

test('both provider merge transports carry the inspected SHA and observe completion', async () => {
  const { GitHubPullRequestProvider } = await import(
    '../github-pull-request-provider.js'
  );
  const { GitLabPullRequestProvider } = await import(
    '../gitlab-pull-request-provider.js'
  );
  for (const [Constructor, flag, state] of [
    [GitHubPullRequestProvider, '--match-head-commit', 'MERGED'],
    [GitLabPullRequestProvider, '--sha', 'merged'],
  ] as const) {
    const run = vi.fn(async (args: string[]) =>
      args[1] === 'view' ? json({ state }) : { stdout: '' },
    );
    const provider = new Constructor(run);
    const result = await provider.mergePullRequest(context, '17', {
      method: 'merge',
      expectedHeadSha: head,
    });
    expect(result.data).toEqual({ status: 'merged' });
    const call = run.mock.calls.find(([args]) => args[1] === 'merge')![0];
    expect(call).toContain(flag);
    expect(call[call.indexOf(flag) + 1]).toBe(head);
  }
});
test('a lost revision-bound merge acknowledgement is not reported as refusal or success', async () => {
  const { GitHubPullRequestProvider } = await import(
    '../github-pull-request-provider.js'
  );
  const { GitLabPullRequestProvider } = await import(
    '../gitlab-pull-request-provider.js'
  );
  for (const Constructor of [
    GitHubPullRequestProvider,
    GitLabPullRequestProvider,
  ]) {
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === 'merge') throw Error('connection lost');
      return { stdout: '' };
    });
    const result = await new Constructor(run).mergePullRequest(context, '17', {
      method: 'merge',
      expectedHeadSha: head,
    });
    expect(result.data).toMatchObject({ status: 'indeterminate' });
    expect(run.mock.calls.filter(([args]) => args[1] === 'merge')).toHaveLength(
      1,
    );
  }
});

test.each(['github', 'gitlab'] as const)(
  '%s rechecks Station authority before crossing the review effect boundary',
  async (forge) => {
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === 'user')
        return json({ id: 7, login: 'operator', username: 'operator' });
      if (args[1] === 'view') return json(raw(forge));
      throw new Error('review effect must not run');
    });
    await expect(
      writePullRequestReview(
        forge,
        'forge.test',
        context,
        '17',
        { action: 'approve', expectedHeadSha: head },
        run,
        { isCurrent: () => false },
      ),
    ).resolves.toMatchObject({ status: 'refused' });
    expect(run.mock.calls.some(([args]) => args.includes('POST'))).toBe(false);
  },
);

/**
 * Checks and inline review comments. GitHub fixtures are trimmed copies of
 * real `gh pr view --json statusCheckRollup` and
 * `gh api repos/{o}/{r}/pulls/{n}/comments` output (field names, casing and
 * nesting as gh returns them); GitLab fixtures follow the merge-request API's
 * `head_pipeline` and discussions shapes.
 */
describe('checks and inline review comments', () => {
  const PATCH =
    'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n';
  const githubRollup = [
    {
      __typename: 'CheckRun',
      completedAt: '2026-09-29T04:00:13Z',
      conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/kontourai/station/actions/runs/1/job/2',
      name: 'classify',
      startedAt: '2026-09-29T04:00:02Z',
      status: 'COMPLETED',
      workflowName: 'Build iOS verification artifact',
    },
    {
      __typename: 'CheckRun',
      completedAt: '2026-09-29T04:06:03Z',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/kontourai/station/actions/runs/3/job/4',
      name: 'Windows PR portable floor',
      startedAt: '2026-09-29T04:00:03Z',
      status: 'COMPLETED',
      workflowName: 'Windows PR Verification',
    },
    {
      __typename: 'CheckRun',
      completedAt: '0001-01-01T00:00:00Z',
      conclusion: '',
      detailsUrl: 'https://github.com/kontourai/station/actions/runs/5/job/6',
      name: 'fast-checks',
      startedAt: '2026-09-29T04:00:03Z',
      status: 'IN_PROGRESS',
      workflowName: 'CI',
    },
    {
      __typename: 'StatusContext',
      context: 'ci/legacy',
      state: 'ERROR',
      targetUrl: 'javascript:alert(1)',
    },
  ];
  const githubComments = [
    {
      id: 3936106037,
      in_reply_to_id: 3930895953,
      line: 2754,
      original_line: 2648,
      path: 'src-server/routes/plugins/plugin-install-shared.ts',
      side: 'RIGHT',
      subject_type: 'line',
      user: { login: 'reviewer' },
      body: 'Addressed.',
      created_at: '2026-09-04T16:43:39Z',
      html_url:
        'https://github.com/kontourai/station/pull/1408#discussion_r3936106037',
      commit_id: head,
    },
    {
      id: 3930000001,
      line: null,
      original_line: 12,
      path: 'src/old.ts',
      side: 'LEFT',
      subject_type: 'line',
      user: { login: 'reviewer' },
      body: 'Outdated.',
      created_at: '2026-09-03T10:00:00Z',
      html_url:
        'https://github.com/kontourai/station/pull/1408#discussion_r3930000001',
      commit_id: base,
    },
  ];

  function githubRun(extra: Record<string, unknown> = {}) {
    return vi.fn(async (args: string[]) => {
      if (args[1] === 'view') {
        const fields = args[args.indexOf('--json') + 1] ?? '';
        return json({
          ...raw('github'),
          ...(fields.includes('statusCheckRollup')
            ? { statusCheckRollup: githubRollup, ...extra }
            : {}),
        });
      }
      if (args[1].includes('/comments?')) return json(githubComments);
      return { stdout: PATCH };
    });
  }

  test('github: maps the rollup onto check states and drops unsafe links', async () => {
    const run = githubRun();
    const result = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      run,
      () => normalized,
    );
    expect(result.checks).toEqual({
      state: 'available',
      partial: false,
      checks: [
        {
          name: 'classify',
          state: 'success',
          group: 'Build iOS verification artifact',
          url: 'https://github.com/kontourai/station/actions/runs/1/job/2',
        },
        {
          name: 'Windows PR portable floor',
          state: 'failure',
          group: 'Windows PR Verification',
          url: 'https://github.com/kontourai/station/actions/runs/3/job/4',
        },
        {
          name: 'fast-checks',
          state: 'pending',
          group: 'CI',
          url: 'https://github.com/kontourai/station/actions/runs/5/job/6',
        },
        // An ERROR status is a failure; a non-https target is not a link.
        { name: 'ci/legacy', state: 'failure' },
      ],
    });
    // Checks are read on the closing detail, the one that confirmed the head.
    const views = run.mock.calls
      .map(([args]) => args)
      .filter((args) => args[1] === 'view');
    expect(views.at(-1)?.join(' ')).toContain('statusCheckRollup');
    expect(views[0].join(' ')).not.toContain('statusCheckRollup');
  });

  test('github: an unknown check kind makes the observation partial, not guessed', async () => {
    const result = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      githubRun({
        statusCheckRollup: [...githubRollup, { __typename: 'Mystery' }],
      }),
      () => normalized,
    );
    expect(result.checks).toMatchObject({ state: 'available', partial: true });
    expect(
      result.checks?.state === 'available' && result.checks.checks.length,
    ).toBe(4);
  });

  test('github: inline comments keep their diff side and line, outdated ones none', async () => {
    const result = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      githubRun(),
      () => normalized,
    );
    expect(result.reviewComments).toEqual({
      state: 'available',
      partial: false,
      comments: [
        {
          id: '3930000001',
          author: 'reviewer',
          body: 'Outdated.',
          createdAt: '2026-09-03T10:00:00Z',
          path: 'src/old.ts',
          side: 'deletions',
          subject: 'line',
          line: null,
          url: 'https://github.com/kontourai/station/pull/1408#discussion_r3930000001',
        },
        {
          id: '3936106037',
          author: 'reviewer',
          body: 'Addressed.',
          createdAt: '2026-09-04T16:43:39Z',
          path: 'src-server/routes/plugins/plugin-install-shared.ts',
          side: 'additions',
          subject: 'line',
          line: 2754,
          inReplyTo: '3930895953',
          url: 'https://github.com/kontourai/station/pull/1408#discussion_r3936106037',
        },
      ],
    });
  });

  test('a failed comments read is unavailable while the review still loads', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === 'view') return json(raw('github'));
      if (args[1].includes('/comments?')) throw new Error('HTTP 502');
      return { stdout: PATCH };
    });
    const result = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      run,
      () => normalized,
    );
    expect(result.diff.state).toBe('available');
    expect(result.reviewComments).toEqual({
      state: 'unavailable',
      reason: 'The provider could not supply inline review comments.',
    });
    // No rollup in the answer is "not reported", never "no checks".
    expect(result.checks).toEqual({
      state: 'unavailable',
      reason: 'The provider did not report checks.',
    });
  });

  /**
   * The shape `runGitCommand`'s runner rejects with (src-server/utils/
   * git-exec.ts): the message carries the argv, which names the field, and
   * stderr carries what gh said.
   */
  function runnerFailure(args: string[], stderr: string) {
    const error = new Error(
      `Command failed: ${['gh', ...args].join(' ')}\n${stderr}`,
    ) as Error & { stderr: string; code: number | null; cmd: string };
    error.stderr = stderr;
    error.code = 1;
    error.cmd = ['gh', ...args].join(' ');
    return error;
  }
  const OLD_GH =
    'This gh cannot report checks (it predates the statusCheckRollup field). Update gh to see them.';
  function failingChecksRead(stderr: string) {
    const views: string[] = [];
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === 'view') {
        const fields = args[args.indexOf('--json') + 1] ?? '';
        views.push(fields);
        if (fields.includes('statusCheckRollup'))
          throw runnerFailure(args, stderr);
        return json(raw('github'));
      }
      if (args[1].includes('/comments?')) return json(githubComments);
      return { stdout: PATCH };
    });
    return { run, views };
  }

  test('github: a gh that does not know statusCheckRollup still loads the review, with checks unavailable', async () => {
    const { run, views } = failingChecksRead(
      'Unknown JSON field: "statusCheckRollup"\nAvailable fields:\n  additions\n  author\n',
    );
    const result = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      run,
      () => normalized,
    );
    expect(result.pullRequest.ref).toBe('17');
    expect(result.diff.state).toBe('available');
    expect(result.reviewComments?.state).toBe('available');
    expect(result.checks).toEqual({ state: 'unavailable', reason: OLD_GH });
    // Asked with the field once, then without it.
    expect(views.filter((f) => f.includes('statusCheckRollup'))).toHaveLength(
      1,
    );
    expect(views.at(-1)).not.toContain('statusCheckRollup');
  });

  test.each([
    [
      'a 403 rate limit',
      'gh: API rate limit exceeded for user ID 1 (HTTP 403)\n',
    ],
    ['a timeout', ''],
    [
      'an auth failure',
      'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n',
    ],
  ])(
    'github: %s on the checks read is not "old gh": checks are unavailable with a neutral reason',
    async (_name, stderr) => {
      const { run } = failingChecksRead(stderr);
      const result = await readPullRequestReview(
        'github',
        'forge.test',
        context,
        '17',
        run,
        () => normalized,
      );
      expect(result.diff.state).toBe('available');
      expect(result.checks).toEqual({
        state: 'unavailable',
        reason:
          'The provider did not answer the checks read. Refresh to try again.',
      });
      expect(result.checks).not.toEqual({
        state: 'unavailable',
        reason: OLD_GH,
      });
    },
  );

  test('github: the refusal is read from stderr, not from the argv in the message', async () => {
    // A message that names the field (every runner message does) with a
    // stderr that is not gh's refusal must not read as the old-gh case.
    const { run } = failingChecksRead('HTTP 502: Bad Gateway\n');
    const result = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      run,
      () => normalized,
    );
    expect(result.checks).toMatchObject({ state: 'unavailable' });
    expect(
      result.checks?.state === 'unavailable' && result.checks.reason,
    ).not.toBe(OLD_GH);
  });

  const passed = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      __typename: 'CheckRun',
      conclusion: 'SUCCESS',
      name: `job ${i}`,
      status: 'COMPLETED',
    }));
  // gh pages the rollup itself (162 contexts came back for one upstream PR),
  // so an ordinary large rollup is complete; only one past the payload cap
  // is cut and marked partial.
  test.each([
    [162, false, 162],
    [1000, false, 1000],
    [1001, true, 1000],
  ])(
    'github: a rollup of %i contexts is partial=%s with %i kept (cap 1000, strict)',
    async (count, partial, kept) => {
      const result = await readPullRequestReview(
        'github',
        'forge.test',
        context,
        '17',
        githubRun({ statusCheckRollup: passed(count) }),
        () => normalized,
      );
      expect(result.checks).toMatchObject({ state: 'available', partial });
      expect(
        result.checks?.state === 'available' && result.checks.checks.length,
      ).toBe(kept);
    },
  );

  function githubCommentsRun(comments: unknown[]) {
    return vi.fn(async (args: string[]) => {
      if (args[1] === 'view') return json(raw('github'));
      if (args[1].includes('/comments?')) return json(comments);
      return { stdout: PATCH };
    });
  }
  const comment = (i: number, body = 'ok') => ({
    id: 1000 + i,
    line: 1,
    path: 'a',
    side: 'RIGHT',
    subject_type: 'line',
    user: { login: 'reviewer' },
    body,
    created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
  });

  test.each([
    [99, false],
    [100, true],
  ])('github: a comments page of %i is partial=%s', async (count, partial) => {
    const result = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      githubCommentsRun(Array.from({ length: count }, (_, i) => comment(i))),
      () => normalized,
    );
    expect(result.reviewComments).toMatchObject({
      state: 'available',
      partial,
    });
    expect(
      result.reviewComments?.state === 'available' &&
        result.reviewComments.comments.length,
    ).toBe(count);
  });

  test('github: a comment body of 8193 characters is cut to 8192 and marks the read partial', async () => {
    const result = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      githubCommentsRun([
        comment(0, 'x'.repeat(8192)),
        comment(1, 'y'.repeat(8193)),
      ]),
      () => normalized,
    );
    expect(result.reviewComments).toMatchObject({
      state: 'available',
      partial: true,
    });
    const bodies =
      result.reviewComments?.state === 'available'
        ? result.reviewComments.comments.map((c) => c.body.length)
        : [];
    expect(bodies).toEqual([8192, 8192]);
  });

  test('github: inline comment bodies past 65,536 characters in total are dropped and the read is partial', async () => {
    // Eight full bodies fill the total exactly; the ninth has no room.
    const result = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      githubCommentsRun(
        Array.from({ length: 9 }, (_, i) => comment(i, 'z'.repeat(8192))),
      ),
      () => normalized,
    );
    expect(result.reviewComments).toMatchObject({
      state: 'available',
      partial: true,
    });
    expect(
      result.reviewComments?.state === 'available' &&
        result.reviewComments.comments.length,
    ).toBe(8);
    const eight = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      githubCommentsRun(
        Array.from({ length: 8 }, (_, i) => comment(i, 'z'.repeat(8192))),
      ),
      () => normalized,
    );
    expect(eight.reviewComments).toMatchObject({
      state: 'available',
      partial: false,
    });
  });

  test('github: a file-level comment is a comment on the file, not an outdated line comment', async () => {
    const result = await readPullRequestReview(
      'github',
      'forge.test',
      context,
      '17',
      githubCommentsRun([
        {
          id: 77,
          line: null,
          path: 'README.md',
          side: 'RIGHT',
          subject_type: 'file',
          user: { login: 'reviewer' },
          body: 'Rename this file.',
          created_at: '2026-01-01T00:00:00Z',
        },
      ]),
      () => normalized,
    );
    expect(result.reviewComments).toEqual({
      state: 'available',
      partial: false,
      comments: [
        {
          id: '77',
          author: 'reviewer',
          body: 'Rename this file.',
          createdAt: '2026-01-01T00:00:00Z',
          path: 'README.md',
          side: 'additions',
          subject: 'file',
          line: null,
        },
      ],
    });
  });

  function gitlabRun(pipeline: unknown, discussions: unknown) {
    return vi.fn(async (args: string[]) => {
      if (args[1] === 'view')
        return json({ ...raw('gitlab'), head_pipeline: pipeline });
      if (args[1].includes('notes?')) return json([]);
      if (args[1].endsWith('/approvals')) return json({ approved_by: [] });
      if (args[1].includes('/discussions?')) return json(discussions);
      return { stdout: PATCH };
    });
  }

  test('gitlab: the head pipeline is the check, and only for the observed head', async () => {
    const current = await readPullRequestReview(
      'gitlab',
      'forge.test',
      context,
      '17',
      gitlabRun(
        {
          id: 991,
          sha: head,
          status: 'running',
          web_url: 'https://forge.test/group/nested/repo/-/pipelines/991',
        },
        [],
      ),
      () => ({ ...normalized, provider: 'gitlab' }),
    );
    expect(current.checks).toEqual({
      state: 'available',
      partial: false,
      checks: [
        {
          name: 'Pipeline 991',
          state: 'pending',
          url: 'https://forge.test/group/nested/repo/-/pipelines/991',
        },
      ],
    });
    const stale = await readPullRequestReview(
      'gitlab',
      'forge.test',
      context,
      '17',
      gitlabRun({ id: 990, sha: changed, status: 'success' }, []),
      () => ({ ...normalized, provider: 'gitlab' }),
    );
    expect(stale.checks).toEqual({
      state: 'unavailable',
      reason: 'The latest pipeline ran on a different revision.',
    });
    // A merged-results pipeline runs on a merge commit the MR payload never
    // names: it cannot be tied to the head, and the reason says why.
    const mergedResults = await readPullRequestReview(
      'gitlab',
      'forge.test',
      context,
      '17',
      gitlabRun(
        {
          id: 992,
          sha: changed,
          ref: 'refs/merge-requests/17/merge',
          source: 'merge_request_event',
          status: 'success',
        },
        [],
      ),
      () => ({ ...normalized, provider: 'gitlab' }),
    );
    expect(mergedResults.checks).toEqual({
      state: 'unavailable',
      reason:
        'The latest pipeline is a merged-results pipeline; it ran on a merge commit, not on the observed head. Open the forge to see it.',
    });
  });

  test('gitlab: diff notes become placed comments only on the observed head', async () => {
    const result = await readPullRequestReview(
      'gitlab',
      'forge.test',
      context,
      '17',
      gitlabRun(null, [
        {
          id: 'd1',
          notes: [
            {
              id: 501,
              type: 'DiffNote',
              body: 'Why?',
              author: { username: 'alice' },
              created_at: '2026-01-03T00:00:00Z',
              position: {
                head_sha: head,
                new_path: 'a',
                old_path: 'a',
                new_line: 1,
                old_line: null,
              },
            },
            {
              id: 502,
              type: 'DiffNote',
              body: 'Because.',
              author: { username: 'bob' },
              created_at: '2026-01-04T00:00:00Z',
              position: {
                head_sha: changed,
                new_path: 'a',
                old_path: 'a',
                new_line: null,
                old_line: 1,
              },
            },
          ],
        },
        { id: 'd2', notes: [{ id: 600, type: null, body: 'General' }] },
      ]),
      () => ({ ...normalized, provider: 'gitlab' }),
    );
    expect(result.checks).toEqual({
      state: 'available',
      checks: [],
      partial: false,
    });
    expect(result.reviewComments).toEqual({
      state: 'available',
      partial: false,
      comments: [
        {
          id: '501',
          author: 'alice',
          body: 'Why?',
          createdAt: '2026-01-03T00:00:00Z',
          path: 'a',
          side: 'additions',
          subject: 'line',
          line: 1,
        },
        {
          id: '502',
          author: 'bob',
          body: 'Because.',
          createdAt: '2026-01-04T00:00:00Z',
          path: 'a',
          side: 'deletions',
          subject: 'line',
          line: null,
          inReplyTo: '501',
        },
      ],
    });
  });
});
