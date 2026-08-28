import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOutgoingUserMessage,
  buildPostSendState,
  buildRehydratedInputHistory,
  normalizeConversationMessages,
  resolveConversationUpdatedAt,
} from '../hooks/useActiveChatSessions.helpers';

describe('useActiveChatSessions helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds outgoing user messages with text and file parts without mutating the source array', () => {
    const currentMessages = [{ role: 'assistant', content: 'hi' }] as any[];
    const attachments = [
      {
        id: 'file-1',
        name: 'diagram.png',
        type: 'image/png',
        size: 42,
        data: 'data:image/png;base64,abc',
      },
    ];

    const result = buildOutgoingUserMessage(
      currentMessages as any,
      'hello',
      attachments as any,
    );

    expect(result).toEqual({
      messages: [
        { role: 'assistant', content: 'hi' },
        {
          role: 'user',
          content: 'hello',
// archive#1293: a stable client-only id for rollback-by-id.
          clientId: expect.any(String),
          contentParts: [
            { type: 'text', content: 'hello' },
            {
              type: 'file',
              mediaType: 'image/png',
              name: 'diagram.png',
            },
          ],
          timestamp: Date.now(),
        },
      ],
      contentParts: [
        { type: 'text', content: 'hello' },
        {
          type: 'file',
          mediaType: 'image/png',
          name: 'diagram.png',
        },
      ],
      clientId: expect.any(String),
    });
    expect(result.clientId).toBe(result.messages[1].clientId);
    expect(JSON.stringify(result)).not.toContain('data:image/png;base64,abc');

    expect(currentMessages).toEqual([{ role: 'assistant', content: 'hi' }]);
  });

// archive#1295: no normal write path stamped a user-send message before —
// pin that the outgoing message now carries a real timestamp so a healthy
// chat's inbox recency isn't derived from an epoch 0.
  it('stamps the outgoing user message with a real timestamp, not 0', () => {
    const result = buildOutgoingUserMessage(undefined, 'hello');
    expect(result.messages[result.messages.length - 1].timestamp).toBe(
      Date.now(),
    );
    expect(result.messages[result.messages.length - 1].timestamp).not.toBe(0);
  });

  it('classifies post-send completion state from backend messages and finish reason', () => {
    const toolCalls = buildPostSendState(
      [
        {
          role: 'assistant',
          content: 'done',
          contentParts: [{ type: 'text', content: 'done' }],
          finishReason: 'tool-calls',
        },
      ] as any,
      undefined,
    );

    expect(toolCalls).toEqual({
      messages: [
        {
          role: 'assistant',
          content: 'done',
          contentParts: [{ type: 'text', content: 'done' }],
          timestamp: Date.now(),
        },
      ],
      noticeKind: 'tool-calls',
      effectiveFinishReason: 'tool-calls',
    });

    expect(
      buildPostSendState(
        [{ role: 'assistant', content: 'done', contentParts: [] }] as any,
        'length',
      ).noticeKind,
    ).toBe('length');

    expect(
      buildPostSendState(
        [{ role: 'assistant', content: 'done', contentParts: [] }] as any,
        'rate-limit-exceeded',
      ).noticeKind,
    ).toBe('unexpected');
  });

// archive#1295: the backend rarely supplies a per-message timestamp today
// (no normal write path persisted one), but when it does, the mapper must
// prefer it over the batch fallback rather than overwriting it.
  it('prefers a real backend timestamp over the fallback when present', () => {
    const result = buildPostSendState([
      {
        role: 'assistant',
        content: 'done',
        timestamp: '2020-01-01T00:00:00.000Z',
      },
    ] as any);
    expect(result.messages[0].timestamp).toBe(
      Date.parse('2020-01-01T00:00:00.000Z'),
    );
  });

// archive#1295 regression: fixtures used to hardcode plausible stamps —
// this pins the genuinely-absent case, which is the actual historical
 // shape (no write path ever set `timestamp`). archive#1311 update:
// with no `conversationUpdatedAt` anchor supplied, the fallback is still
// "now" for the newest message (never 0), but earlier un-timestamped
// messages back off from it to stay in order rather than all sharing one
// instant.
  it('falls back to now (not 0) when the backend message has no timestamp at all and no anchor is given', () => {
    const result = normalizeConversationMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'there' },
    ] as any);
    expect(result[1].timestamp).toBe(Date.now());
    expect(result[0].timestamp).toBeLessThan(result[1].timestamp!);
    expect(result[0].timestamp).not.toBe(0);
    expect(result[1].timestamp).not.toBe(0);
  });

// archive#1311: normalizing the SAME
// backend messages hours apart used to yield a newer `Date.now` stamp
// each time — an old, already-read conversation would jump to the top of
// recency on nothing more than a reopen or an SSE-reconnect catchup
// sweep. Anchoring to the conversation's real `updatedAt` (resolved by
// the caller, see `resolveConversationUpdatedAt`) makes this idempotent.
  describe("anchoring to the conversation's real updatedAt (station#1311 review)", () => {
    const backendMessages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'there' },
    ] as any;
    const conversationUpdatedAt = Date.parse('2026-01-01T00:00:00.000Z');

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rehydrating the same old conversation twice hours apart yields the SAME updatedAt (newest message timestamp)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T05:00:00.000Z'));
      const first = normalizeConversationMessages(
        backendMessages,
        conversationUpdatedAt,
      );

      vi.setSystemTime(new Date('2026-01-01T10:00:00.000Z'));
      const second = normalizeConversationMessages(
        backendMessages,
        conversationUpdatedAt,
      );

      expect(first[first.length - 1].timestamp).toBe(conversationUpdatedAt);
      expect(second[second.length - 1].timestamp).toEqual(
        first[first.length - 1].timestamp,
      );
// Neither call re-inflated recency toward whatever `Date.now`
// happened to be at call time.
      expect(first[first.length - 1].timestamp).not.toBe(
        Date.parse('2026-01-01T05:00:00.000Z'),
      );
      expect(second[second.length - 1].timestamp).not.toBe(
        Date.parse('2026-01-01T10:00:00.000Z'),
      );
    });

    it('a reconnect catchup sweep (repeated calls with the same anchor) does not change recency ordering', () => {
      vi.useFakeTimers();
      const oldConversation = normalizeConversationMessages(
        [{ role: 'user', content: 'old' }] as any,
        Date.parse('2020-01-01T00:00:00.000Z'),
      );
      const recentConversation = normalizeConversationMessages(
        [{ role: 'user', content: 'recent' }] as any,
        Date.parse('2026-01-01T00:00:00.000Z'),
      );
// Old stays older than recent regardless of how many times either is
// re-normalized, or when — no Date.now read leaks into the result
// when a real anchor is supplied.
      vi.setSystemTime(new Date('2026-07-29T00:00:00.000Z'));
      const oldConversationAgain = normalizeConversationMessages(
        [{ role: 'user', content: 'old' }] as any,
        Date.parse('2020-01-01T00:00:00.000Z'),
      );
      expect(oldConversationAgain[0].timestamp).toBe(
        oldConversation[0].timestamp,
      );
      expect(oldConversationAgain[0].timestamp!).toBeLessThan(
        recentConversation[0].timestamp!,
      );
    });

    it('a real per-message timestamp still wins over the anchor when present', () => {
      const result = normalizeConversationMessages(
        [
          {
            role: 'user',
            content: 'hi',
            timestamp: '2019-06-01T00:00:00.000Z',
          },
        ] as any,
        conversationUpdatedAt,
      );
      expect(result[0].timestamp).toBe(Date.parse('2019-06-01T00:00:00.000Z'));
    });
  });

  describe('resolveConversationUpdatedAt (station#1311 review)', () => {
    it('returns undefined without touching the network when no queryClient is supplied', () => {
      expect(
        resolveConversationUpdatedAt(undefined, 'agent-1', 'conv-1'),
      ).toBeUndefined();
    });

    it('returns undefined (never fetches) when the conversations list cache has nothing for this agent', () => {
      const getQueryData = vi.fn().mockReturnValue(undefined);
      expect(
        resolveConversationUpdatedAt(
          { getQueryData } as any,
          'agent-1',
          'conv-1',
        ),
      ).toBeUndefined();
      expect(getQueryData).toHaveBeenCalledWith(['conversations', 'agent-1']);
    });

    it("resolves the matching conversation's updatedAt from the cached list, parsed to epoch ms", () => {
      const getQueryData = vi.fn().mockReturnValue([
        { id: 'conv-other', updatedAt: '2019-01-01T00:00:00.000Z' },
        { id: 'conv-1', updatedAt: '2020-06-15T12:00:00.000Z' },
      ]);
      expect(
        resolveConversationUpdatedAt(
          { getQueryData } as any,
          'agent-1',
          'conv-1',
        ),
      ).toBe(Date.parse('2020-06-15T12:00:00.000Z'));
    });

    it('returns undefined when the cached list has other conversations but not this one', () => {
      const getQueryData = vi
        .fn()
        .mockReturnValue([
          { id: 'conv-other', updatedAt: '2019-01-01T00:00:00.000Z' },
        ]);
      expect(
        resolveConversationUpdatedAt(
          { getQueryData } as any,
          'agent-1',
          'conv-1',
        ),
      ).toBeUndefined();
    });
  });

  it('rehydrates input history from user backend messages and slash commands only', () => {
    expect(
      buildRehydratedInputHistory(
        [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Ignored' },
          { role: 'user', content: '/ask status' },
        ] as any,
        ['draft', '/help', '/status'],
      ),
    ).toEqual(['Hello', '/ask status', '/help', '/status']);
  });
});
