import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useApiQuery: vi.fn() }));

vi.mock('../query-core', () => ({
  useApiMutation: vi.fn(),
  useApiQuery: mocks.useApiQuery,
}));

import {
  usePullRequestContextQuery,
  usePullRequestQuery,
} from '../query-domains/pullRequests';

describe('usePullRequestQuery', () => {
  beforeEach(() => {
    mocks.useApiQuery.mockReset();
  });

  test.each([
    ['', 'ghe.example.com', 'owner', 'repo', '12'],
    ['github', '', 'owner', 'repo', '12'],
    ['github', 'ghe.example.com', '', 'repo', '12'],
    ['github', 'ghe.example.com', 'owner', '', '12'],
    ['github', 'ghe.example.com', 'owner', 'repo', ''],
  ])(
    'stays disabled with an incomplete repository identity',
    (provider, host, owner, repo, ref) => {
      usePullRequestQuery(provider, host, owner, repo, ref, {
        project: 'project',
      });

      expect(mocks.useApiQuery.mock.calls[0]?.[2]).toMatchObject({
        enabled: false,
      });
    },
  );

  test('enables with a complete repository identity and project', () => {
    usePullRequestQuery('github', 'ghe.example.com', 'owner', 'repo', '12', {
      project: 'project',
    });

    expect(mocks.useApiQuery.mock.calls[0]?.[2]).toMatchObject({
      enabled: true,
    });
  });

  test('keys context resolution by the requested working directory', () => {
    usePullRequestContextQuery({
      project: 'project',
      workingDirectory: '/repos/a',
    });
    usePullRequestContextQuery({
      project: 'project',
      workingDirectory: '/repos/b',
    });

    expect(mocks.useApiQuery.mock.calls[0]?.[0]).toEqual([
      'pull-request-context',
      'project',
      '',
      '/repos/a',
    ]);
    expect(mocks.useApiQuery.mock.calls[1]?.[0]).toEqual([
      'pull-request-context',
      'project',
      '',
      '/repos/b',
    ]);
  });
});
