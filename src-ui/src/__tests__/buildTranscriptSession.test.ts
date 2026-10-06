/**
 * @vitest-environment jsdom
 *
 * Regression coverage for the archive#726 "ACP id fix": before this fix,
 * ACPChatPanel passed the raw ChatUIState (which has no `id` field) into
 * ChatMessageList via `as any`, so `.id` was `undefined` at runtime and
 * every message key namespaced under the literal "undefined" string. That
 * only showed up at runtime (the `as any` bypassed the type system), so
 * pin it down with a direct assertion rather than relying on type-checking
 * alone.
 */

import { describe, expect, test } from 'vitest';
import { buildTranscriptSession } from '../components/acp-connections/ACPChatPanel';
import type { ChatUIState } from '../contexts/active-chats-state';
import { requestsWaitingOnUser } from '../utils/waiting-approvals';

function baseState(overrides: Partial<ChatUIState> = {}): ChatUIState {
  return {
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    agentSlug: 'codex',
    agentName: 'Codex',
    messages: [],
    ...overrides,
  };
}

describe('buildTranscriptSession', () => {
  test("#2304: carries what the working clock reads — the turn start and the sender's send time", () => {
    const session = buildTranscriptSession(
      'acp-session-42',
      'codex',
      baseState({
        status: 'sending',
        openTurnId: 'turn-1',
        openTurnStartedAt: 2_000,
        messages: [
          {
            role: 'user',
            content: 'go',
            clientId: 'composer-row',
            turnId: 'turn-1',
            timestamp: 1_000,
          },
        ],
      }),
    );
    expect(session.openTurnStartedAt).toBe(2_000);
  });

  test('id is the real sessionId, not undefined', () => {
    const session = buildTranscriptSession(
      'acp-session-42',
      'codex',
      baseState(),
    );
    expect(session.id).toBe('acp-session-42');
    expect(session.id).not.toBe('undefined');
    expect(session.id).not.toBeUndefined();
  });

  test('carries both approval lists, so the transcript can subtract the answered ones', () => {
    const session = buildTranscriptSession(
      'acp-session-42',
      'codex',
      baseState({
        pendingApprovals: ['req-1', 'req-2'],
        answeredApprovals: ['req-1'],
      }),
    );
    expect(session.pendingApprovals).toEqual(['req-1', 'req-2']);
    expect(session.answeredApprovals).toEqual(['req-1']);
    expect(requestsWaitingOnUser(session)).toEqual(['req-2']);
  });
});
