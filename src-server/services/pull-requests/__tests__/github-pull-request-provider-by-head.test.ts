/**
 * The GitHub provider's Task-branch discovery read: the argv gh receives
 * (`--repo` names the host, `--head` the exact branch, open only, at most
 * 5) and the normalization of a recorded `gh pr list --json` answer
 * (scrubbed to `acme/widgets`; keys and types are gh's own, from a live
 * read of a public repository). A fork's pull request from a branch of the
 * same name is listed with where it lives, never dropped or merged in.
 */
import { describe, expect, it } from 'vitest';
import { GitHubPullRequestProvider } from '../github-pull-request-provider.js';
import recordedFixture from './fixtures/github-pull-requests-by-head.json' with {
  type: 'json',
};

const CONTEXT = {
  host: 'github.example.com',
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

describe('GitHub pull requests by head', () => {
  it('reads once with the host and exact branch named, and keeps where each head lives', async () => {
    const { github, calls } = provider(async () => ({
      stdout: JSON.stringify(recordedFixture),
    }));
    const result = await github.findOpenPullRequestsByHead(
      CONTEXT,
      'station/task/t-91',
    );
    expect(calls).toEqual([
      [
        'pr',
        'list',
        '--repo',
        'github.example.com/acme/widgets',
        '--head',
        'station/task/t-91',
        '--state',
        'open',
        '--limit',
        '5',
        '--json',
        'number,headRefName,headRepositoryOwner,isCrossRepository,url',
      ],
    ]);
    expect(result).toEqual({
      state: 'read',
      pullRequests: [
        {
          ref: '42',
          headRefName: 'station/task/t-91',
          headOwner: 'acme',
          crossRepository: false,
          url: 'https://github.com/acme/widgets/pull/42',
        },
        {
          ref: '57',
          headRefName: 'station/task/t-91',
          headOwner: 'mallory',
          crossRepository: true,
          url: 'https://github.com/acme/widgets/pull/57',
        },
      ],
    });
  });

  it('never passes a branch gh could read as a flag', async () => {
    const { github, calls } = provider(async () => ({ stdout: '[]' }));
    const result = await github.findOpenPullRequestsByHead(CONTEXT, '--web');
    expect(result.state).toBe('unavailable');
    expect(calls).toEqual([]);
  });

  it('reads a rate limit from gh as rate-limited', async () => {
    const { github } = provider(async () => {
      throw Object.assign(new Error('gh failed'), {
        stderr: 'API rate limit exceeded for user',
      });
    });
    expect(
      await github.findOpenPullRequestsByHead(CONTEXT, 'station/task/t-91'),
    ).toMatchObject({ state: 'unavailable', cause: 'rate-limited' });
  });
});
