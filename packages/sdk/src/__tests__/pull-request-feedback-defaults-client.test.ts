import { beforeEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ mutateJson: vi.fn(), getJson: vi.fn() }));
// Only the transport is replaced: the client reads the body with the real
// helpers.
vi.mock('../client/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/http')>()),
  ...transport,
}));

import {
  getProjectPullRequestFeedbackDefaults,
  removeDerivedPullRequest,
  writeProjectPullRequestFeedbackDefaults,
} from '../client/pull-request-feedback';

const options = {
  requestScope: { apiBase: 'http://station.test', authorityKey: 'owner' },
};
const ok = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const defaults = {
  projectSlug: 'my project',
  settings: {
    fixFailingChecks: true,
    addressReviewComments: false,
    reviewEachHead: false,
  },
  canChange: true,
  stillOn: 0,
};
beforeEach(() => vi.resetAllMocks());

test("reads a Project's defaults by its slug", async () => {
  transport.getJson.mockResolvedValue(ok(defaults));
  await expect(
    getProjectPullRequestFeedbackDefaults(
      'http://station.test',
      'my project',
      options,
    ),
  ).resolves.toEqual(defaults);
  expect(transport.getJson).toHaveBeenCalledWith(
    'http://station.test/api/pull-request-feedback/projects/my%20project/defaults',
    options,
  );
});

test('writes only the two switches, so a stored third is kept', async () => {
  transport.mutateJson.mockResolvedValue(ok(defaults));
  await writeProjectPullRequestFeedbackDefaults(
    'http://station.test',
    'my project',
    { fixFailingChecks: true, addressReviewComments: false },
    options,
  );
  expect(transport.mutateJson).toHaveBeenCalledWith(
    'http://station.test/api/pull-request-feedback/projects/my%20project/defaults',
    'PUT',
    options,
    { settings: { fixFailingChecks: true, addressReviewComments: false } },
  );
  // "Review each new head" goes only when given.
  transport.mutateJson.mockResolvedValue(ok(defaults));
  await writeProjectPullRequestFeedbackDefaults(
    'http://station.test',
    'my project',
    {
      fixFailingChecks: true,
      addressReviewComments: false,
      reviewEachHead: true,
    },
    options,
  );
  expect(transport.mutateJson).toHaveBeenLastCalledWith(
    'http://station.test/api/pull-request-feedback/projects/my%20project/defaults',
    'PUT',
    options,
    {
      settings: {
        fixFailingChecks: true,
        addressReviewComments: false,
        reviewEachHead: true,
      },
    },
  );
});

test('refuses an answer for another Project', async () => {
  transport.getJson.mockResolvedValue(
    ok({ ...defaults, projectSlug: 'other' }),
  );
  await expect(
    getProjectPullRequestFeedbackDefaults('http://station.test', 'my project'),
  ).rejects.toThrow('wrong identity');
});

test("removes a Task branch's pull request from its chat", async () => {
  const identity = {
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'acme', name: 'widgets' },
    ref: '42',
  };
  transport.mutateJson.mockResolvedValue(ok({ conversationId: 'chat/a' }));
  await removeDerivedPullRequest(
    'http://station.test',
    'chat/a',
    identity,
    options,
  );
  expect(transport.mutateJson).toHaveBeenCalledWith(
    'http://station.test/api/pull-request-feedback/conversations/chat%2Fa/derived',
    'DELETE',
    options,
    { identity },
  );
});
