import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import type { ChatMessage } from '../../../types';
import { unansweredApprovalRequests } from '../pendingRequestRows';

function requestOpened(
  threadId: string,
  requestId: string,
  eventId: string,
): CanonicalRuntimeEvent {
  return {
    provider: 'claude',
    threadId,
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'request.opened',
    eventId,
    requestId,
    requestType: 'approval',
    title: 'Run a command',
    payload: { toolCallId: 'call-1' },
  } as unknown as CanonicalRuntimeEvent;
}

function boundMessage(
  turnId: string,
  approvalThreadId: string,
  approvalId: string,
): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    turnId,
    contentParts: [
      {
        type: 'tool-invocation',
        toolCallId: 'call-1',
        needsApproval: true,
        approvalId,
        approvalThreadId,
      },
    ],
  };
}

describe('unansweredApprovalRequests', () => {
  test('an approval bound only on the OPEN turn still reaches the strip, and the transcript row keeps its own card as a fallback', () => {
    const events = [requestOpened('thread-1', 'req-1', 'evt-1')];
    const messages = [boundMessage('turn-open', 'thread-1', 'req-1')];

    const strip = unansweredApprovalRequests(messages, events, 'turn-open');

    expect(strip).toHaveLength(1);
    expect(strip[0]).toMatchObject({
      approvalId: 'req-1',
      approvalThreadId: 'thread-1',
      needsApproval: true,
      state: 'awaiting-approval',
    });
    // The transcript's own copy of the card is untouched — both the strip's
    // card (above) and the expanded transcript row can still render an
    // Allow/Deny control for the same request.
    expect(messages[0].contentParts?.[0]).toMatchObject({
      needsApproval: true,
      approvalId: 'req-1',
      approvalThreadId: 'thread-1',
    });
  });

  test('an approval bound on a SETTLED (non-open) turn is answered by that row and drops out of the strip', () => {
    const events = [requestOpened('thread-1', 'req-2', 'evt-2')];
    const messages = [boundMessage('turn-settled', 'thread-1', 'req-2')];

    // No turn is open right now (or a DIFFERENT turn is), so bound-detection
    // is not suppressed for this message: its own durable row already
    // answers the request, and the strip must not duplicate it.
    expect(unansweredApprovalRequests(messages, events, undefined)).toEqual(
      [],
    );
    expect(unansweredApprovalRequests(messages, events, 'turn-open')).toEqual(
      [],
    );
  });

  test('no open requests at all yields no strip cards', () => {
    expect(unansweredApprovalRequests([], [], 'turn-open')).toEqual([]);
  });
});
