import { beforeEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ getJson: vi.fn(), mutateJson: vi.fn() }));
vi.mock('../client/http', () => transport);

import {
  getPullRequestReview,
  submitPullRequestReview,
} from '../client/pull-request-review';

const target = {
  provider: 'gitlab',
  host: 'forge.test',
  owner: 'group/nested',
  repository: 'repo',
  ref: '17',
  project: 'my project',
  repositoryRootHint: '/private/worktree',
};
const options = {
  requestScope: { apiBase: 'http://station.test', authorityKey: 'owner' },
};
const sha = 'a'.repeat(40);
const snapshot = {
  pullRequest: {
    provider: target.provider,
    host: target.host,
    repository: { owner: target.owner, name: target.repository },
    ref: target.ref,
  },
  headSha: sha,
  baseSha: 'b'.repeat(40),
  discussion: [],
  diff: { state: 'available', patch: '', completeness: 'provider-output' },
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
beforeEach(() => vi.resetAllMocks());
test('encodes every exact identity segment and forwards captured authority', async () => {
  transport.getJson.mockResolvedValue(
    response({ available: true, data: snapshot }),
  );
  await getPullRequestReview('http://station.test', target, options);
  expect(transport.getJson).toHaveBeenCalledWith(
    'http://station.test/api/pull-requests/gitlab/forge.test/group%2Fnested/repo/17/review?project=my+project&workingDirectory=%2Fprivate%2Fworktree',
    options,
  );
});
test.each(['host', 'ref', 'provider'])(
  'refuses a response for a different %s',
  async (field) => {
    transport.getJson.mockResolvedValue(
      response({
        available: true,
        data: {
          ...snapshot,
          pullRequest: { ...snapshot.pullRequest, [field]: 'different' },
        },
      }),
    );
    await expect(
      getPullRequestReview('http://station.test', target, options),
    ).rejects.toThrow('different or incomplete target');
  },
);
test('forwards exact revision and refuses a mismatched approval acknowledgement', async () => {
  transport.mutateJson.mockResolvedValue(
    response({
      available: true,
      data: {
        status: 'confirmed',
        actor: 'operator',
        nativeId: '1',
        headSha: 'c'.repeat(40),
      },
    }),
  );
  const input = { action: 'approve' as const, expectedHeadSha: sha };
  await expect(
    submitPullRequestReview('http://station.test', target, input, options),
  ).rejects.toThrow('acknowledgement');
  expect(transport.mutateJson).toHaveBeenCalledWith(
    expect.stringContaining('/17/review?'),
    'POST',
    options,
    input,
  );
});
test('retains provider uncertainty without retrying a write', async () => {
  const result = {
    available: true,
    data: { status: 'indeterminate', reason: 'Response lost' },
  };
  transport.mutateJson.mockResolvedValue(response(result));
  await expect(
    submitPullRequestReview(
      'http://station.test',
      target,
      { action: 'comment', expectedHeadSha: sha, body: 'Check this' },
      options,
    ),
  ).resolves.toEqual(result);
  expect(transport.mutateJson).toHaveBeenCalledOnce();
});
