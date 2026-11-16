import { beforeEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ mutateJson: vi.fn() }));
// Only the transport is replaced: the client reads the body with the real
// helpers.
vi.mock('../client/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/http')>()),
  ...transport,
}));

import { turnOffPullRequestFeedback } from '../client/pull-request-feedback';

const options = {
  requestScope: { apiBase: 'http://station.test', authorityKey: 'owner' },
};
const identity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
beforeEach(() => vi.resetAllMocks());

test('turning feedback off deletes it for the pull request in its own chat', async () => {
  const view = { identity, ownedHere: true, owner: null };
  transport.mutateJson.mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: view }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(
    turnOffPullRequestFeedback(
      'http://station.test',
      'chat/a',
      identity,
      options,
    ),
  ).resolves.toEqual(view);
  expect(transport.mutateJson).toHaveBeenCalledWith(
    'http://station.test/api/pull-request-feedback/conversations/chat%2Fa',
    'DELETE',
    options,
    { identity },
  );
});

test('a refusal is an error, not a view', async () => {
  transport.mutateJson.mockResolvedValue(
    new Response(
      JSON.stringify({ success: false, error: 'Conversation unavailable' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ),
  );
  await expect(
    turnOffPullRequestFeedback('http://station.test', 'chat-a', identity),
  ).rejects.toThrow();
});
