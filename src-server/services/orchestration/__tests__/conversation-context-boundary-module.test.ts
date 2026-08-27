import { describe, expect, test, vi } from 'vitest';
import type { ConversationContextBoundaryMarker } from '../conversation-context-boundary-module.js';
import {
  ConversationContextBoundaryConflictError,
  createConversationContextBoundaryModule,
  projectConversationContextBoundary,
} from '../conversation-context-boundary-module.js';

const marker = {
  boundaryId: 'boundary-a',
  conversationId: 'conversation-a',
  predecessorSessionId: 'session-a',
  successorSessionId: 'session-b',
  idempotencyKey: 'request-a',
  policy: 'empty-next-cold-start' as const,
  status: 'reserved' as const,
  actorId: 'user-a',
  createdAt: '2026-08-25T00:00:00.000Z',
};

describe('ConversationContextBoundaryModule', () => {
  test('claims only a cold start and consumes only its accepted evidence', () => {
    let current: ConversationContextBoundaryMarker = marker;
    const module = createConversationContextBoundaryModule({
      persistence: {
        reserve: (input) => ({ marker: input, outcome: 'created' as const }),
        bySuccessor: () => current,
        byKey: () => current,
        listForConversation: () => [current],
        update: (_id, from, status, at, startCommandId) => {
          if (!from.includes(current.status)) return undefined;
          current = {
            ...current,
            status,
            ...(status === 'claimed' ? { claimedAt: at } : {}),
            ...(status === 'claimed' ? { startCommandId } : {}),
            ...(status === 'consumed' ? { consumedAt: at } : {}),
          } as typeof current;
          return current;
        },
        cancelReserved: (_id, at) => {
          if (current.status !== 'reserved') return undefined;
          current = {
            ...current,
            status: 'cancelled',
            cancelledAt: at,
          } as typeof current;
          return current;
        },
        reconcile: () => {},
      },
    });
    expect(module.forSuccessor('session-b')).toMatchObject({
      status: 'reserved',
    });
    expect(() =>
      module.consumeAcceptedStart('boundary-a', 'start-a', 'now'),
    ).toThrow(ConversationContextBoundaryConflictError);
    expect(
      module.claimColdStart('boundary-a', 'start-a', 'claim'),
    ).toMatchObject({
      status: 'claimed',
      startCommandId: 'start-a',
    });
    expect(
      module.consumeAcceptedStart('boundary-a', 'start-a', 'consume'),
    ).toMatchObject({
      status: 'consumed',
    });
    expect(projectConversationContextBoundary(current)).toMatchObject({
      priorTranscriptInjected: false,
      omitted: expect.arrayContaining(['provider-native history']),
      preserved: expect.arrayContaining(['canonical transcript']),
    });
  });

  test('does not release an indeterminate claim or make a marker mutable', () => {
    const module = createConversationContextBoundaryModule({
      persistence: {
        reserve: (input) => ({ marker: input, outcome: 'existing' as const }),
        bySuccessor: () => marker,
        byKey: () => marker,
        listForConversation: () => [marker],
        update: (_id, _from, status) => ({ ...marker, status }),
        cancelReserved: () => ({ ...marker, status: 'cancelled' }),
        reconcile: () => {},
      },
    });
    const projected = projectConversationContextBoundary({
      ...marker,
      status: 'indeterminate',
    });
    expect(projected.retryable).toBe(false);
    expect(() => {
      (projected as { actorId: string }).actorId = 'spoofed';
    }).toThrow();
    expect(module.markIndeterminate('boundary-a', 'now')).toMatchObject({
      status: 'indeterminate',
    });
  });

  test('cancels only the unclaimed reservation through the atomic retirement seam', () => {
    let current: ConversationContextBoundaryMarker = marker;
    const cancelReserved = vi.fn((_id: string, at: string) => {
      if (current.status !== 'reserved') return undefined;
      current = {
        ...current,
        status: 'cancelled',
        cancelledAt: at,
      } as typeof current;
      return current;
    });
    const module = createConversationContextBoundaryModule({
      persistence: {
        reserve: (input) => ({ marker: input, outcome: 'created' as const }),
        bySuccessor: () => current,
        byKey: () => current,
        listForConversation: () => [current],
        update: () => undefined,
        cancelReserved,
        reconcile: () => {},
      },
    });
    expect(module.cancelReserved('boundary-a', 'cancelled-at')).toMatchObject({
      status: 'cancelled',
    });
    expect(cancelReserved).toHaveBeenCalledWith('boundary-a', 'cancelled-at');
    expect(() => module.cancelReserved('boundary-a', 'again')).toThrow(
      ConversationContextBoundaryConflictError,
    );
  });
});
