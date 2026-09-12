import type { PullRequest } from '@kontourai/station-contracts/pull-request-provider';
import { expect, test } from 'vitest';
import { derivePullRequestDependencyStacks } from '../pull-request-dependency-stacks';

const request = (
  ref: string,
  sourceBranch: string,
  targetBranch: string,
  host = 'forge.test',
): PullRequest => ({
  provider: 'github',
  host,
  repository: { owner: 'team', name: 'repo' },
  ref,
  nativeId: ref,
  url: `https://${host}/team/repo/pull/${ref}`,
  title: `Change ${ref}`,
  body: null,
  state: ref === '3' ? 'DRAFT' : 'OPEN',
  author: { login: 'author' },
  sourceBranch,
  targetBranch,
  headSha: ref.repeat(40),
  commits: 1,
  reviewStatus: 'NONE',
  comments: 0,
  mergeability: 'unknown',
});

test('orders provider-reported branch dependencies and keeps disconnected repositories separate', () => {
  const stacks = derivePullRequestDependencyStacks(
    [
      request('3', 'layer-3', 'layer-2'),
      request('1', 'layer-1', 'main'),
      request('2', 'layer-2', 'layer-1'),
      request('4', 'other', 'main', 'other.test'),
    ],
    '2026-09-12T00:00:00Z',
  );
  expect(stacks).toHaveLength(2);
  expect(stacks[0].layers.map((layer) => layer.pullRequest.ref)).toEqual([
    '1',
    '2',
    '3',
  ]);
  expect(stacks[0].layers[2].pullRequest.state).toBe('DRAFT');
  expect(stacks[1].layers[0].pullRequest.host).toBe('other.test');
});

test('reports ambiguous source branches instead of inventing an order', () => {
  const stacks = derivePullRequestDependencyStacks(
    [
      request('1', 'shared', 'main'),
      request('2', 'shared', 'main'),
      request('3', 'top', 'shared'),
    ],
    '2026-09-12T00:00:00Z',
  );
  expect(stacks.some((stack) => stack.state === 'ambiguous')).toBe(true);
  expect(stacks.flatMap((stack) => stack.layers)).toHaveLength(3);
});

test('reports cycles without dropping either exact layer', () => {
  const stacks = derivePullRequestDependencyStacks(
    [request('1', 'one', 'two'), request('2', 'two', 'one')],
    '2026-09-12T00:00:00Z',
  );
  expect(stacks).toMatchObject([
    { state: 'cyclic', layers: [{ position: 0 }, { position: 1 }] },
  ]);
});
