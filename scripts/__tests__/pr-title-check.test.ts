import { describe, expect, test } from 'vitest';
import { checkLivePullRequestTitle } from '../pr-title-check.mjs';

const head = 'a'.repeat(40);
const event = {
  pull_request: {
    number: 42,
    head: { sha: head },
    title: 'invalid stale title',
  },
};
const live = {
  title: 'fix(ci): validate current titles',
  head: { sha: head },
  base: { ref: 'main' },
};

describe('live PR title check', () => {
  test('a delayed event accepts a live correction with exactly one metadata read', async () => {
    const calls: string[] = [];
    await checkLivePullRequestTitle({
      repository: 'kontourai/station',
      event,
      request: async (path: string) => {
        calls.push(path);
        return live;
      },
    });
    expect(calls).toEqual(['repos/kontourai/station/pulls/42']);
  });

  test('a body edit or stale valid event cannot clear a failed live title', async () => {
    await expect(
      checkLivePullRequestTitle({
        repository: 'kontourai/station',
        event: {
          ...event,
          pull_request: { ...event.pull_request, title: live.title },
        },
        request: async () => ({ ...live, title: 'invalid' }),
      }),
    ).rejects.toThrow('Pull-request title:');
  });

  test.each([
    { ...live, head: { sha: 'b'.repeat(40) } },
    { ...live, base: { ref: 'release' } },
  ])('a moved head or target fails closed', async (pr) => {
    await expect(
      checkLivePullRequestTitle({
        repository: 'kontourai/station',
        event,
        request: async () => pr,
      }),
    ).rejects.toThrow('another head or target');
  });

  test('API failure is never a passing title check', async () => {
    await expect(
      checkLivePullRequestTitle({
        repository: 'kontourai/station',
        event,
        request: async () => {
          throw new Error('GitHub API 403');
        },
      }),
    ).rejects.toThrow('GitHub API 403');
  });
});
