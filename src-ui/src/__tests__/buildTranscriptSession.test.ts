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

  test('a different sessionId produces a different id (not hardcoded)', () => {
    const state = baseState();
    expect(buildTranscriptSession('session-a', 'codex', state).id).toBe(
      'session-a',
    );
    expect(buildTranscriptSession('session-b', 'codex', state).id).toBe(
      'session-b',
    );
  });

  test('message anchor keys derived from this session id are namespaced correctly', () => {
    const session = buildTranscriptSession(
      'acp-session-42',
      'codex',
      baseState({
        messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
      }),
    );
    // Mirrors ChatMessageList's content-derived key closely enough to
    // catch the "undefined" regression without importing a private helper.
    const anchorKey = `${session.id}:message:${session.messages[0].timestamp}:${session.messages[0].role}:${session.messages[0].content}`;
    expect(anchorKey.startsWith('undefined:')).toBe(false);
    expect(anchorKey).toBe('acp-session-42:message:1:user:hi');
  });
});
