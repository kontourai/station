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
  body: vi.fn(),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: null,
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: [] }),
  useProjectQuery: (slug: string) => ({
    data: { slug, workingDirectory: `C:/work/${slug}` },
    isLoading: false,
  }),
  // #2144 slice 6: the panel reads the Station-scope default approval
  // mode through `useConfig`. No stored value is the neutral answer here.
  useConfigQuery: () => ({ data: undefined, dataUpdatedAt: 0 }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => undefined,
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
vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
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

// This adapter test observes the shared-body input; its real rendering is covered by ownerWiring.
vi.mock('../components/conversation/ConversationBody', () => ({
  ConversationBody: ({
    activeSession,
    workingDirectory,
  }: {
    activeSession: import('../types').ChatSession;
    workingDirectory?: string | null;
  }) => {
    panelState.body({ activeSession, workingDirectory });
    return (
      <>
        <div data-testid="acp-messages" />
        <div data-testid="acp-composer" />
      </>
    );
  },
}));

import { ACPChatPanel } from '../components/acp-connections/ACPChatPanel';

describe('ACPChatPanel workspace identity', () => {
  beforeEach(() => {
    panelState.updateChat.mockReset();
    panelState.body.mockReset();
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

  test('the shared body keeps file mentions in the restored conversation Project', () => {
    panelState.chat = {
      status: 'idle',
      conversationId: 'stored-conversation',
      orchestrationSessionStarted: true,
      projectSlug: 'stored-project',
      requestedModel: null,
    };
    render(
      <ACPChatPanel
        projectSlug="different-panel"
        agentSlug="codex"
        tabId="tab"
      />,
    );
    expect(panelState.body).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workingDirectory: 'C:/work/stored-project',
        activeSession: expect.objectContaining({
          projectSlug: 'stored-project',
          requestedModel: null,
        }),
      }),
    );
    expect(panelState.updateChat).not.toHaveBeenCalled();
  });
});
