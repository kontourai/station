import { beforeEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ mutateJson: vi.fn() }));
// Only the transport is replaced: the client reads the body with the real
// helpers.
vi.mock('../client/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/http')>()),
  ...transport,
}));

import {
  pullRequestHeadReviewRefusal,
  reviewPullRequestHeadAgain,
  sendPullRequestHeadReviewFindings,
  turnOffPullRequestFeedback,
} from '../client/pull-request-feedback';

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

test("Review again and Send to agent post to the chat's head review", async () => {
  const ok = () =>
    new Response(
      JSON.stringify({ success: true, data: { conversationId: 'chat/a' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  transport.mutateJson.mockImplementation(async () => ok());
  await reviewPullRequestHeadAgain(
    'http://station.test',
    'chat/a',
    identity,
    options,
  );
  await sendPullRequestHeadReviewFindings(
    'http://station.test',
    'chat/a',
    identity,
    options,
  );
  expect(transport.mutateJson.mock.calls).toEqual([
    [
      'http://station.test/api/pull-request-feedback/conversations/chat%2Fa/head-review/again',
      'POST',
      options,
      { identity },
    ],
    [
      'http://station.test/api/pull-request-feedback/conversations/chat%2Fa/head-review/send',
      'POST',
      options,
      { identity },
    ],
  ]);
  transport.mutateJson.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: false,
        code: 'pull_request_head_review_not_started',
        error: 'Station already ran 10 reviews in this Project today.',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ),
  );
  const refused = await reviewPullRequestHeadAgain(
    'http://station.test',
    'chat-a',
    identity,
  ).catch((error: unknown) => error);
  // Station's own sentence, shown as it comes.
  expect(pullRequestHeadReviewRefusal(refused)).toBe(
    'Station already ran 10 reviews in this Project today.',
  );
  // Any other failure is described as usual.
  expect(pullRequestHeadReviewRefusal(new Error('boom'))).toBeUndefined();
});
