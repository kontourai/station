// @vitest-environment jsdom

import { afterEach, describe, expect, test } from 'vitest';
import {
  observeContextBoundary,
  rememberContextBoundaryIntent,
} from '../components/chat-dock/conversationContextBoundaryUiState';

afterEach(() => localStorage.clear());

const scope = {
  namespace: 'station-a:user-a',
  actorId: 'user-a',
  conversationId: 'conversation-a',
  sessionId: 'session-a',
  isCurrent: () => true,
};
const intent = {
  idempotencyKey: 'key-a',
  policy: 'empty-next-cold-start' as const,
};
const boundary = (
  status: 'reserved' | 'claimed' | 'consumed' | 'cancelled',
) => ({
  boundaryId: 'boundary-a',
  conversationId: scope.conversationId,
  predecessorSessionId: scope.sessionId,
  successorSessionId: 'session-b',
  policy: intent.policy,
  status,
  actorId: scope.actorId,
  createdAt: '2026-08-25T00:00:00.000Z',
  priorTranscriptInjected: false,
  omitted: ['provider-native history'],
  preserved: ['canonical transcript'],
  retryable: status === 'reserved',
});

describe('conversation context-boundary UI state', () => {
  test('retains intent and the confirmed opaque reservation identity without copying the projection', () => {
    expect(rememberContextBoundaryIntent(scope, intent)).toBe(true);
    const key = localStorage.key(0)!;
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      ...intent,
      recordedAt: expect.any(Number),
    });
    expect(observeContextBoundary(scope, intent, boundary('reserved'))).toBe(
      true,
    );
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      ...intent,
      boundaryId: 'boundary-a',
      recordedAt: expect.any(Number),
    });
  });

  test('only a matching terminal observation retires the scope’s intent', () => {
    expect(rememberContextBoundaryIntent(scope, intent)).toBe(true);
    expect(observeContextBoundary(scope, intent, boundary('claimed'))).toBe(
      true,
    );
    const terminal = boundary('consumed');
    for (const mismatched of [
      { ...terminal, actorId: 'other-author' },
      { ...terminal, predecessorSessionId: 'other-session' },
    ]) {
      expect(observeContextBoundary(scope, intent, mismatched)).toBe(false);
    }
    expect(
      observeContextBoundary(
        { ...scope, namespace: 'station-b:user-a' },
        intent,
        terminal,
      ),
    ).toBe(false);
    expect(localStorage.length).toBe(1);
    expect(observeContextBoundary(scope, intent, terminal)).toBe(true);
    expect(localStorage.length).toBe(0);
  });
});
