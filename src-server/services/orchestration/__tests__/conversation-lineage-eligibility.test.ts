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

/**
 * The exact answerability decoration `projectRequestAnswerability` produces
 * for a stopped-then-unloaded current child: detached + a lifecycle past
 * resume. #834's defect was fixture-invisible because no denial fixture
 * carried this REAL shape.
 */
const stoppedUnloadedPatch = (
  lifecycleState: 'canceled' | 'completed' = 'canceled',
) => ({
  lifecycleState,
  status: 'closed' as const,
  isLoaded: false,
  answerability: {
    answerable: false as const,
    qualification: 'past_resume' as const,
    observedBy: 'conversation-lineage-test',
    observedAt: '2026-08-29T00:00:01.000Z',
  },
});

describe('#749 shared continuation control eligibility', () => {
  test.each([
    ['read-only', { controlMode: 'read-only-attached' as const }],
    ['pending review', { pendingReview: true }],
    [
      // A coherent unanswerable-but-not-stopped shape: the child could still
      // resume, but no adapter in this process can drive it. The successor
      // reserve path is not the recovery for this, so it stays denied.
      'provider-absent unanswerable',
      {
        answerability: {
          answerable: false as const,
          qualification: 'provider_absent' as const,
          observedBy: 'conversation-lineage-test',
          observedAt: '2026-08-29T00:00:01.000Z',
        },
      },
    ],
    [
      // Unanswerable while the lifecycle is NOT past resume (running): #834's
      // recovery is scoped to genuinely stopped children only.
      'unanswerable without a stopped lifecycle',
      {
        answerability: {
          answerable: false as const,
          qualification: 'past_resume' as const,
          observedBy: 'conversation-lineage-test',
          observedAt: '2026-08-29T00:00:01.000Z',
        },
      },
    ],
    [
      // #834 both-directions: a genuinely stopped child stays denied when it
      // is read-only or pending review — the recovery never overrides those.
      'stopped but read-only',
      {
        ...stoppedUnloadedPatch(),
        controlMode: 'read-only-attached' as const,
      },
    ],
    [
      'stopped but pending review',
      { ...stoppedUnloadedPatch(), pendingReview: true },
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

  // #834: pressing Stop detaches and ends the current child, whose
  // answerability decoration is then permanently `past_resume` — but the
  // conversation is exactly what the stopped-predecessor reserve path (the
  // #765 A1 / PR #796 recovery) was built for. Both the read-side predicate
  // and the mutating command must treat it as continuable.
  test.each([
    ['canceled (user stop)', stoppedUnloadedPatch('canceled')],
    ['completed then unloaded', stoppedUnloadedPatch('completed')],
  ])(
    'a stopped, unloaded child (%s) is continuable through the successor reserve path',
    async (_, patch) => {
      const current = detail(patch);
      const { lineage, reserveNextConversationSession } = lineageFor(current);
      reserveNextConversationSession.mockImplementation(
        (input: { proposedSessionId: string }) => ({
          outcome: 'created',
          lineage: {
            conversationId: 'conversation-policy',
            sessionId: input.proposedSessionId,
            predecessorSessionId: 'conversation-policy',
            ordinal: 1,
            createdAt: '2026-08-29T00:00:02.000Z',
          },
        }),
      );

      expect(canResolveConversationContinuation(current)).toBe(true);
      const resolved = await lineage.resolveConversationContinuation(
        'conversation-policy',
        INTERNAL_SESSION_READ_SCOPE,
        { provider: 'claude' },
      );
      expect(reserveNextConversationSession).toHaveBeenCalledOnce();
      expect(resolved.startRequired).toBe(true);
      expect(resolved.sessionId).not.toBe('conversation-policy');
      // The reserved child must carry a continuation context — the
      // predecessor here has no trusted cursor, so the bounded transcript
      // seed is the path that makes the recovery real.
      expect(resolved.transcriptSeed).toEqual(expect.any(String));
    },
  );

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
