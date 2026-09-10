import type {
  AttentionInputReplyContext,
  AttentionRequestReference,
} from '@kontourai/station-contracts/attention';
import { afterEach, expect, test, vi } from 'vitest';
import { getInputReplyContext } from '../client/input-reply';

const reference: AttentionRequestReference = {
  threadId: 'session-a',
  requestId: 'request-a',
  requestEventId: 'opened-a',
};
const context: AttentionInputReplyContext = {
  state: 'open',
  reference,
  agentId: 'agent-a',
  conversationId: 'conversation-a',
  provider: 'claude',
  engineId: 'claude',
  capabilities: ['file-input'],
};
afterEach(() => vi.unstubAllGlobals());
test('reads the exact input request and its current transport capability', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: context })),
    );
  vi.stubGlobal('fetch', fetch);
  await expect(
    getInputReplyContext('http://station.test', reference),
  ).resolves.toEqual(context);
  expect(String(fetch.mock.calls[0][0])).toContain(
    'input-requests/request-a?eventId=opened-a',
  );
});
test.each([
  { ...context, reference: { ...reference, requestEventId: 'other' } },
  { ...context, agentId: '' },
  { ...context, capabilities: ['unreported'] },
])('refuses an invalid or differently bound context', async (data) => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data }))),
  );
  await expect(
    getInputReplyContext('http://station.test', reference),
  ).rejects.toThrow();
});
