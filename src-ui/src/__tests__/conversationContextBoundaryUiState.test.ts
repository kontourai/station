// @vitest-environment jsdom

import { afterEach, describe, expect, test } from 'vitest';
import {
  contextBoundaryUiStorageKey,
  readConversationContextBoundaryUiState,
  writeConversationContextBoundaryUiState,
} from '../components/chat-dock/conversationContextBoundaryUiState';

afterEach(() => localStorage.clear());

const boundary = (
  status: 'reserved' | 'claimed' | 'consumed' | 'cancelled',
) => ({
  boundaryId: 'boundary-a',
  conversationId: 'conversation-a',
  predecessorSessionId: 'session-a',
  successorSessionId: 'session-b',
  policy: 'empty-next-cold-start' as const,
  status,
  actorId: 'user-a',
  createdAt: '2026-08-25T00:00:00.000Z',
  priorTranscriptInjected: false,
  omitted: ['provider-native history'],
  preserved: ['canonical transcript'],
  retryable: status === 'reserved',
});

describe('conversation context-boundary UI state', () => {
  test('persists only the opaque key and safe boundary projection', () => {
    writeConversationContextBoundaryUiState('key-a', boundary('reserved'));
    const raw = localStorage.getItem(
      contextBoundaryUiStorageKey('conversation-a'),
    );
    expect(raw).toContain('key-a');
    expect(raw).toContain('boundary-a');
    expect(raw).not.toContain('provider-native history');
    expect(raw).not.toContain('canonical transcript');
    expect(
      readConversationContextBoundaryUiState('conversation-a'),
    ).toMatchObject({
      idempotencyKey: 'key-a',
      status: 'reserved',
    });
  });

  test('keeps uncertain state for another tab to reconcile and clears only consumed/cancelled terminal state', () => {
    writeConversationContextBoundaryUiState('key-a', boundary('claimed'));
    expect(
      readConversationContextBoundaryUiState('conversation-a'),
    ).toMatchObject({
      status: 'claimed',
    });
    writeConversationContextBoundaryUiState('key-a', boundary('consumed'));
    expect(readConversationContextBoundaryUiState('conversation-a')).toBeNull();

    writeConversationContextBoundaryUiState('key-b', boundary('reserved'));
    writeConversationContextBoundaryUiState('key-b', boundary('cancelled'));
    expect(readConversationContextBoundaryUiState('conversation-a')).toBeNull();
  });
});
