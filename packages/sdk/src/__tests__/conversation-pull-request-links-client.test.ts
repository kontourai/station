import { beforeEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ getJson: vi.fn(), mutateJson: vi.fn() }));
vi.mock('../client/http', () => transport);

import {
  getConversationPullRequestLinks,
  linkConversationPullRequest,
  unlinkConversationPullRequest,
} from '../client/conversation-pull-request-links';

const options = {
  requestScope: { apiBase: 'http://station.test', authorityKey: 'owner' },
};
const identity = {
  provider: 'github',
  host: 'forge.test',
  repository: { owner: 'team/nested', name: 'repo' },
  ref: '17',
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
beforeEach(() => vi.resetAllMocks());

test('encodes the Conversation id and preserves exact link identity', async () => {
  transport.getJson.mockResolvedValue(
    response({
      conversationId: 'conversation/a',
      observedAt: '2026-09-12T00:00:00Z',
      links: [],
    }),
  );
  await getConversationPullRequestLinks(
    'http://station.test',
    'conversation/a',
    options,
  );
  expect(transport.getJson).toHaveBeenCalledWith(
    'http://station.test/api/conversation-pull-requests/conversation%2Fa',
    options,
  );
  transport.mutateJson.mockImplementation(async () =>
    response({ conversationId: 'conversation/a' }),
  );
  await linkConversationPullRequest(
    'http://station.test',
    'conversation/a',
    identity,
    options,
  );
  await unlinkConversationPullRequest(
    'http://station.test',
    'conversation/a',
    identity,
    options,
  );
  expect(
    transport.mutateJson.mock.calls.map((call) => call.slice(1, 4)),
  ).toEqual([
    ['POST', options, identity],
    ['DELETE', options, identity],
  ]);
});

test('rejects a response for another Conversation', async () => {
  transport.getJson.mockResolvedValue(
    response({
      conversationId: 'different',
      observedAt: '2026-09-12T00:00:00Z',
      links: [],
    }),
  );
  await expect(
    getConversationPullRequestLinks(
      'http://station.test',
      'conversation/a',
      options,
    ),
  ).rejects.toThrow('wrong identity');
});
