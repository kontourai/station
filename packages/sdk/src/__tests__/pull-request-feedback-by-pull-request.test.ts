import { beforeEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ getJson: vi.fn() }));
// Only the transport is replaced: the client reads the body with the real
// helpers.
vi.mock('../client/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/http')>()),
  ...transport,
}));

import { StationHttpError } from '../client/api-error-message';
import {
  getPullRequestFeedbackByPullRequest,
  pullRequestFeedbackOwnerOf,
} from '../client/pull-request-feedback';

const identity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
beforeEach(() => vi.resetAllMocks());

test('reads one pull request by its identity, in the query', async () => {
  const data = { identity, owner: { readable: false } };
  transport.getJson.mockResolvedValue(json({ success: true, data }));
  await expect(
    getPullRequestFeedbackByPullRequest('http://station.test', identity),
  ).resolves.toEqual(data);
  const url = new URL(transport.getJson.mock.calls[0]![0] as string);
  expect(url.pathname).toBe('/api/pull-request-feedback/by-pull-request');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    name: 'widgets',
    ref: '42',
  });
});

test('an answer about another pull request is refused', async () => {
  transport.getJson.mockResolvedValue(
    json({
      success: true,
      data: { identity: { ...identity, ref: '43' }, owner: null },
    }),
  );
  await expect(
    getPullRequestFeedbackByPullRequest('http://station.test', identity),
  ).rejects.toThrow('wrong identity');
});

test('a 409 owner the reader may not read is still a conflict, naming nothing', () => {
  const conflict = (owner: unknown) =>
    new StationHttpError(409, 'Feedback goes to another chat.', {
      code: 'pull_request_feedback_owned_elsewhere',
      details: { owner },
    });
  expect(pullRequestFeedbackOwnerOf(conflict({}))).toEqual({});
  expect(
    pullRequestFeedbackOwnerOf(
      conflict({ conversationId: 'chat-a', title: 'Fix the parser' }),
    ),
  ).toEqual({ conversationId: 'chat-a', title: 'Fix the parser' });
});
