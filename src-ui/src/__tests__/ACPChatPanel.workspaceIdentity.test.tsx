// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const panelState = vi.hoisted(() => ({
  chat: {
    status: 'idle',
    conversationId: 'global-conversation',
    orchestrationSessionStarted: true,
  } as Record<string, unknown>,
  updateChat: vi.fn(),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection: null }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useAgentConnectionsQuery: () => ({ data: [] }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'codex', name: 'Codex' }],
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({ updateChat: panelState.updateChat }),
  useActiveChatState: () => panelState.chat,
  useActiveChatSelector: (
    _sessionId: string,
    selector: (state: typeof panelState.chat | null) => unknown,
  ) => selector(panelState.chat),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => () => 'acp-session',
}));
vi.mock('../hooks/useChatInput', () => ({
  useChatInput: () => ({}),
}));
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: () => <div data-testid="acp-composer" />,
}));
vi.mock('../components/chat/ChatMessageList', () => ({
  ChatMessageList: () => <div data-testid="acp-messages" />,
}));

import { ACPChatPanel } from '../components/acp-connections/ACPChatPanel';

describe('ACPChatPanel workspace identity', () => {
  beforeEach(() => {
    panelState.updateChat.mockReset();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  test('does not replace a rehydrated global conversation with the panel Project', () => {
    panelState.chat = {
      status: 'idle',
      conversationId: 'global-conversation',
      orchestrationSessionStarted: true,
    };

    render(
      <ACPChatPanel projectSlug="station" agentSlug="codex" tabId="tab" />,
    );

    expect(panelState.updateChat).not.toHaveBeenCalled();
  });

  test('sets the panel Project for a new untouched chat', async () => {
    panelState.chat = { status: 'idle' };

    render(
      <ACPChatPanel projectSlug="station" agentSlug="codex" tabId="tab" />,
    );

    await waitFor(() => {
      expect(panelState.updateChat).toHaveBeenCalledWith('acp-session', {
        projectSlug: 'station',
        projectName: undefined,
      });
    });
  });
});
