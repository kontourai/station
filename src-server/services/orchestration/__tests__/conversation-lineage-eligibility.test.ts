import type { OrchestrationSessionDetail } from '@kontourai/station-contracts/orchestration';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import {
  ConversationLineage,
  canResolveConversationContinuation,
} from '../conversation-lineage.js';

function detail(
  overrides: Partial<OrchestrationSessionDetail['session']> = {},
): OrchestrationSessionDetail {
  return {
    session: {
      threadId: 'conversation-policy',
      provider: 'claude',
      status: 'ready',
      lifecycleState: 'running',
      controlMode: 'station-owned',
      answerability: { answerable: true },
      isLoaded: true,
      isPersisted: true,
      eventCount: 0,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:01.000Z',
      ...overrides,
    },
    events: [],
  };
}

function lineageFor(current: OrchestrationSessionDetail) {
  const reserveNextConversationSession = vi.fn();
  const lineage = new ConversationLineage({
    eventStore: {
      conversationSessions: () => [
        {
          conversationId: 'conversation-policy',
          sessionId: 'conversation-policy',
          ordinal: 0,
          createdAt: '2026-08-29T00:00:00.000Z',
        },
      ],
      reserveNextConversationSession,
    } as any,
    logger: { warn: vi.fn() },
    readSession: async () => current,
    readSessionMessages: () => [],
    listSessionReadModel: async () => [],
    canReadSession: () => true,
  });
  return { lineage, reserveNextConversationSession };
}

describe('#749 shared continuation control eligibility', () => {
  test.each([
    ['read-only', { controlMode: 'read-only-attached' as const }],
    ['pending review', { pendingReview: true }],
    [
      'unanswerable',
      {
        answerability: {
          answerable: false as const,
          qualification: 'past_resume' as const,
          observedBy: 'conversation-lineage-test',
          observedAt: '2026-08-29T00:00:01.000Z',
        },
      },
    ],
  ])('%s is denied by both open and the mutating command', async (_, patch) => {
    const current = detail(patch);
    const { lineage, reserveNextConversationSession } = lineageFor(current);

    expect(canResolveConversationContinuation(current)).toBe(false);
    await expect(
      lineage.resolveConversationContinuation(
        'conversation-policy',
        INTERNAL_SESSION_READ_SCOPE,
        { provider: 'claude' },
      ),
    ).rejects.toThrow('not writable');
    expect(reserveNextConversationSession).not.toHaveBeenCalled();
  });

  test('an active turn is read-only to reopen but remains on the current command session', async () => {
    const current = detail({ hasActiveTurn: true });
    const { lineage, reserveNextConversationSession } = lineageFor(current);

    expect(canResolveConversationContinuation(current)).toBe(false);
    await expect(
      lineage.resolveConversationContinuation(
        'conversation-policy',
        INTERNAL_SESSION_READ_SCOPE,
        { provider: 'claude' },
      ),
    ).resolves.toEqual({
      sessionId: 'conversation-policy',
      startRequired: false,
    });
    expect(reserveNextConversationSession).not.toHaveBeenCalled();
  });
});
