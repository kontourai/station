import { describe, expect, test } from 'vitest';
import {
  GITHUB_READ_CACHE_TTL_MS,
  GitHubPullRequestProvider,
} from '../github-pull-request-provider.js';

// #2937: every visible Sessions row observes its repository's open pull
// requests. These drive the real provider through a fake `gh` that counts
// each invocation, so a regression to one `gh` spawn per request fails here.

const contextFor = (owner: string, name: string, workingDirectory = '/a') => ({
  repository: {
    owner,
    name,
    remote: `https://github.com/${owner}/${name}.git`,
  },
  workingDirectory,
  branch: 'feature',
  baseRef: 'main',
});
const station = contextFor('kontourai', 'station');

const openPullRequest = {
  number: 7,
  url: 'https://github.com/kontourai/station/pull/7',
  title: 'Seven',
  body: null,
  state: 'OPEN',
  author: { login: 'casey' },
  headRefName: 'feature',
  baseRefName: 'main',
  commits: [],
  reviews: [],
  comments: [],
  mergeable: 'CONFLICTING',
};

type Step = { fail?: boolean; stdout?: string };

/** A fake gh: counts argv shapes and can hold or fail the next call of a kind. */
function fakeGh() {
  const calls: string[][] = [];
  const held: Array<() => void> = [];
  let hold = false;
  const next: Record<string, Step[]> = {};
  const queue = (name: string, step: Step) => {
    next[name] = [...(next[name] ?? []), step];
  };
  const kind = (args: string[]) =>
    args[0] === 'auth'
      ? 'auth'
      : args[0] === 'repo'
        ? 'repo view'
        : `pr ${args[1]}`;
  const run = async (args: string[]) => {
    calls.push(args);
    if (hold) await new Promise<void>((resolve) => held.push(resolve));
    const step = next[kind(args)]?.shift();
    if (step?.fail) throw Object.assign(new Error('gh failed'), { stderr: '' });
    if (step?.stdout !== undefined) return { stdout: step.stdout };
    switch (kind(args)) {
      case 'repo view':
        return {
          stdout: JSON.stringify({
            mergeCommitAllowed: false,
            squashMergeAllowed: true,
            rebaseMergeAllowed: false,
          }),
        };
      case 'pr list':
        return { stdout: JSON.stringify([openPullRequest]) };
      case 'pr view':
        return { stdout: JSON.stringify(openPullRequest) };
      default:
        return { stdout: '' };
    }
  };
  return {
    calls,
    count: (name: string) => calls.filter((args) => kind(args) === name).length,
    listCalls: () => calls.filter((args) => kind(args) === 'pr list'),
    holdAll: () => {
      hold = true;
    },
    releaseAll: () => {
      hold = false;
      for (const resolve of held.splice(0)) resolve();
    },
    failNext: (name: string) => {
      queue(name, { fail: true });
    },
    stdoutNext: (name: string, stdout: string) => {
      queue(name, { stdout });
    },
    run,
  };
}

function providerWith(gh: ReturnType<typeof fakeGh>) {
  const clock = { now: 1_000_000 };
  const provider = new GitHubPullRequestProvider(gh.run, gh.run, {
    now: () => clock.now,
  });
  return { provider, clock };
}

const openQuery = { state: 'OPEN' };

describe('GitHubPullRequestProvider forge read coalescing (#2937)', () => {
  test('N concurrent open-PR observations of one repository spawn one list and one availability probe', async () => {
    const gh = fakeGh();
    const { provider } = providerWith(gh);
    gh.holdAll();
    // Distinct checkouts of the same repository, as distinct session rows.
    const pending = Array.from({ length: 12 }, (_, index) =>
      provider.listPullRequests(
        contextFor('kontourai', 'station', `/row-${index}`),
        openQuery,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    gh.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gh.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gh.releaseAll();
    const results = await Promise.all(pending);

    expect(gh.count('auth')).toBe(1);
    expect(gh.count('repo view')).toBe(1);
    expect(gh.count('pr list')).toBe(1);
    for (const result of results)
      expect(result).toMatchObject({
        available: true,
        effectiveMergeMethods: ['squash'],
        data: [{ ref: '7', mergeability: 'conflicting' }],
      });
    // Each caller owns its result: one caller's mutation is not another's.
    (results[0].data as any[])[0].title = 'mutated';
    expect((results[1].data as any[])[0].title).toBe('Seven');
  });

  test('N sequential observations within the TTL reuse the answer; expiry refetches', async () => {
    const gh = fakeGh();
    const { provider, clock } = providerWith(gh);
    for (let row = 0; row < 8; row += 1) {
      await expect(
        provider.listPullRequests(station, openQuery),
      ).resolves.toMatchObject({ available: true, data: [{ ref: '7' }] });
      clock.now += 1_000;
    }
    expect(gh.count('pr list')).toBe(1);
    expect(gh.count('auth')).toBe(1);
    expect(gh.count('repo view')).toBe(1);

    clock.now += GITHUB_READ_CACHE_TTL_MS;
    await provider.listPullRequests(station, openQuery);
    expect(gh.count('pr list')).toBe(2);
    expect(gh.count('auth')).toBe(2);
    expect(gh.count('repo view')).toBe(2);
  });

  test('a different repository or query shape is its own forge read', async () => {
    const gh = fakeGh();
    const { provider } = providerWith(gh);
    await provider.listPullRequests(station, openQuery);
    await provider.listPullRequests(
      contextFor('kontourai', 'other'),
      openQuery,
    );
    await provider.listPullRequests(station, { state: 'CLOSED' });
    await provider.listPullRequests(station, { state: 'OPEN', limit: 5 });
    await provider.listPullRequests(station, openQuery);

    expect(gh.listCalls().map((args) => args.slice(3))).toEqual([
      expect.arrayContaining(['github.com/kontourai/station', 'open']),
      expect.arrayContaining(['github.com/kontourai/other', 'open']),
      expect.arrayContaining(['github.com/kontourai/station', 'closed']),
      expect.arrayContaining(['github.com/kontourai/station', '--limit', '5']),
    ]);
    // Availability is per repository, not per query shape.
    expect(gh.count('auth')).toBe(2);
  });

  test('a failed list is shared only in flight and never served as success', async () => {
    const gh = fakeGh();
    const { provider } = providerWith(gh);
    gh.failNext('pr list');
    gh.holdAll();
    const concurrent = [
      provider.listPullRequests(station, openQuery),
      provider.listPullRequests(station, openQuery),
    ];
    for (let turn = 0; turn < 3; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gh.releaseAll();
    }
    for (const result of await Promise.all(concurrent))
      expect(result).toMatchObject({
        available: false,
        reason: 'GitHub CLI request failed',
      });
    expect(gh.count('pr list')).toBe(1);

    // The next observation, well within the TTL, asks the forge again.
    await expect(
      provider.listPullRequests(station, openQuery),
    ).resolves.toMatchObject({ available: true, data: [{ ref: '7' }] });
    expect(gh.count('pr list')).toBe(2);
  });

  test('malformed list output is a failure, not a retained answer', async () => {
    const gh = fakeGh();
    const { provider } = providerWith(gh);
    gh.stdoutNext('pr list', JSON.stringify([{ number: 7 }]));
    await expect(
      provider.listPullRequests(station, openQuery),
    ).resolves.toMatchObject({ available: false });
    await expect(
      provider.listPullRequests(station, openQuery),
    ).resolves.toMatchObject({ available: true, data: [{ ref: '7' }] });
    expect(gh.count('pr list')).toBe(2);
  });

  test('an unauthenticated or unnarrowed availability probe is not retained', async () => {
    const gh = fakeGh();
    const { provider } = providerWith(gh);
    gh.failNext('auth');
    await expect(provider.getAvailability(station)).resolves.toMatchObject({
      available: false,
    });
    await expect(provider.getAvailability(station)).resolves.toMatchObject({
      available: true,
      mergeMethodsSource: 'repository',
    });
    expect(gh.count('auth')).toBe(2);

    const narrowingFailed = fakeGh();
    const second = providerWith(narrowingFailed).provider;
    narrowingFailed.failNext('repo view');
    await expect(second.getAvailability(station)).resolves.toMatchObject({
      available: true,
      mergeMethodsSource: 'provider-default',
    });
    await expect(second.getAvailability(station)).resolves.toMatchObject({
      mergeMethodsSource: 'repository',
    });
    expect(narrowingFailed.count('repo view')).toBe(2);
  });

  test.each([
    [
      'merge',
      (provider: GitHubPullRequestProvider) =>
        provider.mergePullRequest(station, '7', { method: 'squash' }),
      // One fresh probe; a write that reused the cached probe would make 2.
      3,
    ],
    [
      'comment',
      (provider: GitHubPullRequestProvider) =>
        provider.createComment(station, '7', { body: 'ok' }),
      // A fresh probe, then the read-back after invalidation probes again.
      4,
    ],
    [
      'review',
      (provider: GitHubPullRequestProvider) =>
        provider.approvePullRequest(station, '7'),
      4,
    ],
  ])(
    'a %s write probes afresh and invalidates the repository reads',
    async (_name, write, probesAfterWrite) => {
      const gh = fakeGh();
      const { provider } = providerWith(gh);
      const other = contextFor('kontourai', 'other');
      await provider.listPullRequests(station, openQuery);
      await provider.listPullRequests(other, openQuery);
      expect(gh.count('auth')).toBe(2);

      await write(provider);
      expect(gh.count('auth')).toBe(probesAfterWrite);

      await provider.listPullRequests(station, openQuery);
      expect(gh.listCalls().at(-1)).toContain('github.com/kontourai/station');
      expect(gh.count('pr list')).toBe(3);
      // Another repository's cached reads are untouched.
      const before = gh.calls.length;
      await provider.listPullRequests(other, openQuery);
      expect(gh.calls.length).toBe(before);
    },
  );

  test('a failed write still invalidates the repository reads', async () => {
    const gh = fakeGh();
    const { provider } = providerWith(gh);
    await provider.listPullRequests(station, openQuery);
    gh.failNext('pr merge');
    await expect(
      provider.mergePullRequest(station, '7', { method: 'squash' }),
    ).resolves.toMatchObject({ data: { status: 'refused' } });
    await provider.listPullRequests(station, openQuery);
    expect(gh.count('pr list')).toBe(2);
  });

  test('a list in flight when a write lands is not retained past it', async () => {
    const gh = fakeGh();
    const { provider } = providerWith(gh);
    await provider.getAvailability(station);
    gh.holdAll();
    const before = provider.listPullRequests(station, openQuery);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const merge = provider.mergePullRequest(station, '7', {
      method: 'squash',
    });
    for (let turn = 0; turn < 6; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gh.releaseAll();
    }
    await Promise.all([before, merge]);
    await provider.listPullRequests(station, openQuery);
    expect(gh.count('pr list')).toBe(2);
  });
  test('the conflict indicator read is one narrow list per repository, never the review fields', async () => {
    const gh = fakeGh();
    const { provider } = providerWith(gh);
    gh.holdAll();
    const pending = Array.from({ length: 6 }, (_, index) =>
      provider.listOpenPullRequestMergeability(
        contextFor('kontourai', 'station', `/row-${index}`),
      ),
    );
    for (let turn = 0; turn < 4; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gh.releaseAll();
    }
    for (const result of await Promise.all(pending))
      expect(result).toMatchObject({
        available: true,
        data: [
          { ref: '7', sourceBranch: 'feature', mergeability: 'conflicting' },
        ],
      });
    expect(gh.listCalls()).toEqual([
      [
        'pr',
        'list',
        '--repo',
        'github.com/kontourai/station',
        '--state',
        'open',
        '--limit',
        // Pinned literal: the limit is 100, and one more row is requested
        // so a longer list is refused rather than served partially.
        '101',
        '--json',
        'number,headRefName,mergeable,headRepositoryOwner',
      ],
    ]);
    expect(gh.count('auth')).toBe(1);

    // The review list is a separate read with its own fields.
    await provider.listPullRequests(station, openQuery);
    expect(gh.count('pr list')).toBe(2);
    expect(gh.listCalls()[1]).toContain(
      'number,url,title,body,state,author,headRefName,baseRefName,headRefOid,baseRefOid,commits,reviews,comments,mergeable,mergeStateStatus',
    );
    // A write invalidates the narrow read too.
    await provider.mergePullRequest(station, '7', { method: 'squash' });
    await provider.listOpenPullRequestMergeability(station);
    expect(gh.count('pr list')).toBe(3);
  });

  test('malformed narrow output is a failure, not a retained answer', async () => {
    const gh = fakeGh();
    const { provider } = providerWith(gh);
    gh.stdoutNext('pr list', JSON.stringify([{ number: 7 }]));
    await expect(
      provider.listOpenPullRequestMergeability(station),
    ).resolves.toMatchObject({ available: false });
    await expect(
      provider.listOpenPullRequestMergeability(station),
    ).resolves.toMatchObject({ available: true, data: [{ ref: '7' }] });
    expect(gh.count('pr list')).toBe(2);
  });
  test.each([
    // Pinned literals: the narrow read serves at most 100 open pull requests.
    [100, true],
    [101, false],
  ])(
    '%i open pull requests: served = %s, never a partial list',
    async (rows, served) => {
      const gh = fakeGh();
      const { provider } = providerWith(gh);
      gh.stdoutNext(
        'pr list',
        JSON.stringify(
          Array.from({ length: rows }, (_, index) => ({
            number: index + 1,
            headRefName: `branch-${index + 1}`,
            mergeable: 'MERGEABLE',
          })),
        ),
      );
      const result = await provider.listOpenPullRequestMergeability(station);
      if (served) {
        expect(result).toMatchObject({ available: true });
        expect(result.data).toHaveLength(100);
      } else {
        expect(result).toEqual(
          expect.objectContaining({
            available: false,
            reason:
              'More than 100 open pull requests; branch mergeability is not observed',
          }),
        );
        expect(result.data).toBeUndefined();
      }
    },
  );

  test('one repository name under two owners is two availability probes with their own merge methods', async () => {
    const calls: string[][] = [];
    const settingsFor: Record<string, object> = {
      'github.com/o1/r': {
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
      },
      'github.com/o2/r': {
        mergeCommitAllowed: true,
        squashMergeAllowed: false,
        rebaseMergeAllowed: false,
      },
    };
    const transport = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'repo')
        return { stdout: JSON.stringify(settingsFor[args[2] as string]) };
      return { stdout: args[0] === 'pr' ? '[]' : '' };
    };
    const provider = new GitHubPullRequestProvider(transport, transport, {
      now: () => 0,
    });
    await expect(
      provider.getAvailability(contextFor('o1', 'r')),
    ).resolves.toMatchObject({ effectiveMergeMethods: ['squash'] });
    await expect(
      provider.getAvailability(contextFor('o2', 'r')),
    ).resolves.toMatchObject({ effectiveMergeMethods: ['merge'] });
    expect(
      calls.filter((args) => args[0] === 'repo').map((args) => args[2]),
    ).toEqual(['github.com/o1/r', 'github.com/o2/r']);
  });
});
