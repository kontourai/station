import {
  listConversationInbox,
  queueExecutionMessage,
} from '@kontourai/station-sdk/client';
import { describe, expect, test, vi } from 'vitest';
import {
  AGENT,
  CONVERSATION,
  createInboxHarness,
} from './helpers/thread-inbox-harness.js';

describe('inbox SDK route bridge', () => {
  const station = createInboxHarness();

  test('SDK clients exchange a queued follow-up through the real route', async () => {
    const world = station();
    await world.busy();
    // In-process HTTP transport: the SDK still builds and validates the request.
    vi.stubGlobal(
      'fetch',
      (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        world.app.request(new Request(input, init)),
    );
    try {
      const receipt = await queueExecutionMessage('http://inbox.station', {
        conversationId: CONVERSATION,
        clientTurnId: 'sdk-follow',
        message: 'then summarize',
        target: { environment: { kind: 'current' }, agent: AGENT },
      });
      expect(receipt.outcome).toBe('queued');
      const entries = await listConversationInbox(
        'http://inbox.station',
        CONVERSATION,
      );
      expect(entries).toMatchObject([
        {
          clientTurnId: 'sdk-follow',
          message: 'then summarize',
          state: 'queued',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
