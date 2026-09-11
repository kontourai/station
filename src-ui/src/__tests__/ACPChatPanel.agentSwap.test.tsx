// @vitest-environment jsdom

/**
 * `ACPChatPanel` selects its transcript through a MEMOIZED selector —
 * `useCallback(..., [sessionId, agentSlug])` — and `agentSlug` reaches
 * `buildTranscriptSession` as the fallback identity for a chat whose own
 * state carries none. That dependency is the only thing that gives the
 * selector a new identity when the agent changes, and `useActiveChatSelector`
 * re-selects on selector identity: drop the dep and the panel keeps rendering
 * the previous agent's transcript until something else writes to the store.
 *
 * Nothing pinned that. The selector hook's own test passes an INLINE selector
 * (a fresh identity every render), so it stays green with the dependency
 * removed — a fixture that cannot fail for the defect it names. This one
 * drives the real panel with the real `ActiveChatsProvider` and store, so the
 * subject is the panel's own `useCallback` dependency list.
 */

import { render } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChatSession } from '../types';

const SESSION_ID = 'acp-agent-swap-session';

const capture = vi.hoisted(() => ({
  sessions: [] as Array<ChatSession | null>,
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection: null }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: [] }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [
    { slug: 'codex', name: 'Codex' },
    { slug: 'claude', name: 'Claude' },
  ],
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => () => SESSION_ID,
}));
vi.mock('../hooks/useChatInput', () => ({
  useChatInput: () => ({}),
}));
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: () => <div data-testid="acp-composer" />,
}));
vi.mock('../components/chat/ChatMessageList', () => ({
  ChatMessageList: ({
    activeSession,
  }: {
    activeSession: ChatSession | null;
  }) => {
    capture.sessions.push(activeSession);
    return <div data-testid="acp-messages" />;
  },
}));

// ActiveChatsContext is deliberately NOT mocked: the real
// `useActiveChatSelector` and the real store are the subject.
import { ACPChatPanel } from '../components/acp-connections/ACPChatPanel';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';

describe('ACPChatPanel transcript identity across an agent swap', () => {
  beforeEach(() => {
    for (const id of Object.keys(activeChatsStore.getSnapshot())) {
      activeChatsStore.removeChat(id);
    }
    capture.sessions.length = 0;
    sessionStorage.clear();
    // No agentSlug/agentName of its own, so `buildTranscriptSession` falls
    // back to the panel's prop — the value the dependency list carries. No
    // conversationId, which keeps the provider's `usePruneActiveChats` a
    // no-op (mirrors useActiveChatSelector.test.tsx).
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: '',
      agentName: '',
      title: '',
      projectSlug: 'station',
    });
  });

  test('a new agentSlug re-selects the transcript with no store write', () => {
    const { rerender } = render(
      <ActiveChatsProvider>
        <ACPChatPanel projectSlug="station" agentSlug="codex" tabId="tab-1" />
      </ActiveChatsProvider>,
    );

    const first = capture.sessions[capture.sessions.length - 1];
    expect(first?.agentSlug).toBe('codex');
    expect(first?.agentName).toBe('codex');

    // The premise this test rests on: nothing writes to the store across the
    // swap, so re-selection can only come from the selector identity.
    const snapshotBefore = activeChatsStore.getSnapshot()[SESSION_ID];

    rerender(
      <ActiveChatsProvider>
        <ACPChatPanel projectSlug="station" agentSlug="claude" tabId="tab-1" />
      </ActiveChatsProvider>,
    );

    expect(activeChatsStore.getSnapshot()[SESSION_ID]).toBe(snapshotBefore);

    const last = capture.sessions[capture.sessions.length - 1];
    expect(last?.agentSlug).toBe('claude');
    expect(last?.agentName).toBe('claude');
    // Same chat throughout — this is a swap, not a remount onto another
    // session, which would re-select for an uninteresting reason.
    expect(last?.id).toBe(SESSION_ID);
    expect(first?.id).toBe(SESSION_ID);
  });
});
