/**
 * The GitHub provider's one feedback read: the argv gh receives (host
 * named, strings raw, only the number typed) and the normalization of a
 * recorded GraphQL answer (scrubbed to `acme/widgets`; every key and type is
 * GitHub's own, from a live `gh api graphql` of this query).
 */
import { describe, expect, it } from 'vitest';
import { GITHUB_FEEDBACK_QUERY } from '../github-feedback-observation.js';
import { GitHubPullRequestProvider } from '../github-pull-request-provider.js';
import recordedFixture from './fixtures/github-feedback-observation.json' with {
  type: 'json',
};

const recorded = JSON.stringify(recordedFixture);
const CONTEXT = {
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
};

function provider(answer: (args: string[]) => Promise<{ stdout: string }>) {
  const calls: string[][] = [];
  const github = new GitHubPullRequestProvider(
    async (args) => {
      calls.push(args);
      return answer(args);
    },
    undefined,
    { readCacheTtlMs: 0 },
  );
  return { github, calls };
}

describe('GitHub feedback observation', () => {
  it('reads once, with the host named, and normalizes threads, checks and reviews', async () => {
    const { github, calls } = provider(async () => ({ stdout: recorded }));
    const result = await github.getFeedbackObservation(CONTEXT, '42');
    expect(calls).toEqual([
      [
        'api',
        'graphql',
        '--hostname',
        'github.com',
        '-f',
        `query=${GITHUB_FEEDBACK_QUERY}`,
        '-f',
        'owner=acme',
        '-f',
        'name=widgets',
        '-F',
        'number=42',
      ],
    ]);
    expect(result.state).toBe('observed');
    if (result.state !== 'observed') return;
    const observation = result.observation;
    expect(observation).toMatchObject({
      state: 'OPEN',
      headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      baseSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
      headRefName: 'station/task/t-91',
      headOwner: 'acme',
      mergeable: 'conflicting',
      reviewDecision: 'CHANGES_REQUESTED',
      viewerLogin: 'station-bot',
      threadsTotal: 4,
      checksTruncated: false,
    });
    expect(
      observation.threads.map(({ id, resolved, outdated, subject, line }) => ({
        id,
        resolved,
        outdated,
        subject,
        line,
      })),
    ).toEqual([
      {
        id: 'PRRT_open1',
        resolved: false,
        outdated: false,
        subject: 'line',
        line: 42,
      },
      {
        id: 'PRRT_resolved',
        resolved: true,
        outdated: false,
        subject: 'line',
        line: 7,
      },
      {
        id: 'PRRT_outdated',
        resolved: false,
        outdated: true,
        subject: 'line',
        line: 3,
      },
      {
        id: 'PRRT_file',
        resolved: false,
        outdated: false,
        subject: 'file',
        line: null,
      },
    ]);
    expect(observation.threads[0]).toMatchObject({
      totalComments: 2,
      comments: [
        {
          id: '9001',
          author: 'alice',
          body: 'The null check is missing here.',
        },
        { id: '9002', author: 'bob' },
      ],
    });
    expect(observation.checks).toEqual([
      expect.objectContaining({
        name: 'ci / unit-tests',
        conclusion: 'FAILURE',
        completed: true,
        required: true,
        excerpt: 'Process completed with exit code 1.',
      }),
      expect.objectContaining({
        name: 'ci / e2e',
        conclusion: null,
        completed: false,
        required: false,
      }),
      expect.objectContaining({
        name: 'ci / lint',
        conclusion: 'SUCCESS',
        required: true,
      }),
      expect.objectContaining({
        name: 'release / publish',
        conclusion: 'CANCELLED',
      }),
      // A commit status's ERROR reads as a failure.
      expect.objectContaining({
        name: 'security/scan',
        conclusion: 'FAILURE',
        completed: true,
      }),
    ]);
    expect(observation.reviews).toEqual([
      expect.objectContaining({
        id: '7001',
        author: 'alice',
        state: 'CHANGES_REQUESTED',
        body: 'Please add the null check before merging.',
      }),
    ]);
  });

  it('keeps check and review feedback when the host does not support merge queue fields', async () => {
    const answer = JSON.parse(recorded);
    answer.data.repository.pullRequest.title = 'Fix the unit test';
    const { github, calls } = provider(async (args) => {
      if (args.includes(`query=${GITHUB_FEEDBACK_QUERY}`))
        return { stdout: JSON.stringify(answer) };
      throw Object.assign(new Error('Unsupported GraphQL field'), {
        stderr:
          "gh: Field 'isInMergeQueue' doesn't exist on type 'PullRequest'",
      });
    });
    const result = await github.getFeedbackObservation(
      { ...CONTEXT, host: 'github.enterprise.test' },
      '42',
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.join(' ')).not.toContain('isInMergeQueue');
    expect(result).toMatchObject({
      state: 'observed',
      observation: {
        snapshot: { title: 'Fix the unit test', landing: undefined },
        checks: expect.arrayContaining([
          expect.objectContaining({ conclusion: 'FAILURE' }),
        ]),
        reviews: expect.arrayContaining([
          expect.objectContaining({ id: '7001' }),
        ]),
      },
    });
  });

  it('a merged pull request reads MERGED; a missing one is not-found', async () => {
    const merged = JSON.parse(recorded);
    merged.data.repository.pullRequest.state = 'MERGED';
    merged.data.repository.pullRequest.merged = true;
    const one = provider(async () => ({ stdout: JSON.stringify(merged) }));
    expect(
      await one.github.getFeedbackObservation(CONTEXT, '42'),
    ).toMatchObject({
      state: 'observed',
      observation: { state: 'MERGED' },
    });
    const missing = provider(async () => ({
      stdout: JSON.stringify({
        data: { viewer: { login: 'x' }, repository: { pullRequest: null } },
      }),
    }));
    expect(
      await missing.github.getFeedbackObservation(CONTEXT, '42'),
    ).toMatchObject({ state: 'unavailable', cause: 'not-found' });
  });

  it('classifies sign-in and rate limits from gh stderr', async () => {
    const failing = (stderr: string) =>
      provider(async () => {
        throw Object.assign(new Error('Command failed'), { stderr });
      }).github.getFeedbackObservation(CONTEXT, '42');
    expect(
      await failing(
        'To get started with GitHub CLI, please run:  gh auth login',
      ),
    ).toMatchObject({ state: 'unavailable', cause: 'credentials' });
    expect(
      await failing('GraphQL: API rate limit already exceeded for user ID 1.'),
    ).toMatchObject({ state: 'unavailable', cause: 'rate-limited' });
    expect(await failing('something else')).toMatchObject({
      state: 'unavailable',
      cause: 'error',
    });
  });

  it('refuses an identity that is not plainly one, starting no gh', async () => {
    const { github, calls } = provider(async () => ({ stdout: recorded }));
    expect(
      await github.getFeedbackObservation(
        { host: 'github.com', repository: { owner: '@etc/passwd', name: 'x' } },
        '42',
      ),
    ).toMatchObject({ state: 'unavailable', cause: 'error' });
    expect(calls).toEqual([]);
  });

  it('cuts forge text as it is read: comment and review bodies, check titles and descriptions', async () => {
    const long = JSON.parse(recorded);
    const pull = long.data.repository.pullRequest;
    pull.reviewThreads.nodes[0].comments.nodes[0].body = 'c'.repeat(5000);
    pull.latestReviews.nodes[0].body = 'r'.repeat(5000);
    const contexts =
      pull.commits.nodes[0].commit.statusCheckRollup.contexts.nodes;
    contexts[0].title = 't'.repeat(5000);
    contexts[0].name = 'n'.repeat(5000);
    contexts.at(-1).description = 'd'.repeat(5000);
    const { github } = provider(async () => ({ stdout: JSON.stringify(long) }));
    const result = await github.getFeedbackObservation(CONTEXT, '42');
    if (result.state !== 'observed') throw new Error('not observed');
    const observation = result.observation;
    expect(observation.threads[0]!.comments[0]!.body.length).toBe(1000);
    expect(observation.reviews[0]!.body.length).toBe(1000);
    expect(observation.checks[0]!.excerpt!.length).toBe(600);
    expect(observation.checks[0]!.name.length).toBe(300);
    expect(observation.checks.at(-1)!.excerpt!.length).toBe(600);
  });
});
