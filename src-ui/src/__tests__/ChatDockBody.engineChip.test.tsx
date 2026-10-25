/**
 * @vitest-environment jsdom
 *
 * The composer's engine chip names the engine the conversation's Session
 * actually runs on. Repointing the chat's Agent at another connection does not
 * move an open Session (`resolveConversationContinuation` keeps the next turn
 * on it), so the Agent's configured connection must not relabel it. Renders
 * the real ChatDockBody -> ChatInputArea path.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agentsMock.current,
  // archive#3764: the empty-transcript filler renders `ChatEmptyState`.
  useAgentsLoaded: () => true,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
  useHostRequestAuthorityScope: () => undefined,
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock('../contexts/NavigationContext', () => {
  // NavigationContext publishes two read hooks: `useNavigation` (subscribes to
  // the store, optionally through a selector) and `useNavigationActions` (the
  // memoized actions, no subscription). This mock answers both from one value.
  const navigation = () => ({ navigate: navigateSpy });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { alias: 'operator' } }),
}));

vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
}));

vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));

vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => <div data-testid="streaming-message">Streaming</div>,
}));

vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    updateChat: vi.fn(),
    clearEphemeralMessages: vi.fn(),
    addEphemeralMessage: vi.fn(),
  }),
}));

vi.mock('../contexts/MessageContextContext', () => ({
  useMessageContextContext: () => ({ getComposedContext: () => '' }),
}));

const acpConnectionsMock = vi.hoisted(() => ({ current: [] as any[] }));
vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: acpConnectionsMock.current }),
}));
vi.mock('../hooks/useShareReceiver', () => ({
  useShareReceiver: () => {},
}));

vi.mock('../hooks/useSTT', () => ({
  useSTT: () => ({
    supported: false,
    state: 'idle',
    transcript: '',
    startListening: vi.fn(),
    stopListening: vi.fn(),
  }),
}));

vi.mock('../hooks/useTTS', () => ({
  useTTS: () => ({
    supported: false,
    speaking: false,
    speak: vi.fn(),
    cancel: vi.fn(),
  }),
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import { PreviewProvider } from '../contexts/PreviewContext';
import type { ChatSession } from '../types';

function buildChatInput() {
  return {
    quotes: [],
    quotedDraftText: '',
    removeQuote: vi.fn(),
    input: '',
    attachments: [],
    textareaRef: { current: null },
    currentModel: undefined,
    canModelSelect: false,
    modelQuery: null,
    commandQuery: null,
    slashCommands: [],
    handleInputChange: vi.fn(),
    handleSend: vi.fn(async () => {}),
    handleCancel: vi.fn(),
    handleClearInput: vi.fn(),
    handleAddAttachments: vi.fn(),
    handleRemoveAttachment: vi.fn(),
    handleClearAttachments: vi.fn(),
    handleModelSelect: vi.fn(),
    handleModelReset: vi.fn(),
    handleModelClose: vi.fn(),
    handleModelOpen: vi.fn(),
    handleModelRuntimeOptionChange: vi.fn(),
    handleApprovalModeChange: vi.fn(),
    handleCommandSelect: vi.fn(async () => {}),
    handleCommandClose: vi.fn(),
    handleHistoryUp: vi.fn(),
    handleHistoryDown: vi.fn(),
    updateFromInput: vi.fn(),
    closeAll: vi.fn(),
  };
}

function buildSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'engine-chip-session',
    agentSlug: agentId('station'),
    agentName: 'Station',
    title: 'Continue',
    source: 'manual',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    conversationId: 'conversation-engine-chip',
    model: 'gpt-6.1-sol',
    ...overrides,
  } as ChatSession;
}

const OPENCODE = {
  id: 'opencode',
  kind: 'agent',
  type: 'acp',
  name: 'OpenCode',
  enabled: true,
  status: 'ready',
};

function renderDock(
  session: ChatSession,
  agentConnection: { id: string; name: string },
) {
  // The Agent as `/api/agents` enriches it NOW: repointed at a connection.
  agentsMock.current = [
    {
      slug: agentId('station'),
      name: 'Station',
      available: true,
      engineId: agentConnection.id,
      engineDisplayName: agentConnection.name,
      execution: { agentConnectionId: agentConnection.id },
    },
  ];
  acpConnectionsMock.current = [OPENCODE];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PreviewProvider>
        <ChatDockBody
          activeSession={session}
          chatFontSize={14}
          dockHeight={400}
          showStatsPanel={false}
          showReasoning={false}
          showToolDetails={false}
          modelSupportsAttachments={false}
          fileAttachmentsSupported={false}
          availableModels={[]}
          chatInput={buildChatInput() as any}
          setShowStatsPanel={vi.fn()}
        />
      </PreviewProvider>
    </QueryClientProvider>,
  );
}

async function engineChip() {
  const button = await screen.findByRole('button', {
    name: /^Engine & model:/,
  });
  const caption = button.querySelector('.chat-input__chip-caption');
  return { button, caption: caption?.textContent ?? '' };
}

describe('ChatDockBody composer engine chip', () => {
  test('a Codex session keeps naming Codex after its Agent is repointed to OpenCode', async () => {
    renderDock(
      buildSession({
        provider: 'codex',
        orchestrationProvider: 'codex',
        agentConnectionId: 'codex',
        orchestrationSessionStarted: true,
      } as Partial<ChatSession>),
      { id: 'opencode', name: 'OpenCode' },
    );
    const { button, caption } = await engineChip();
    expect(caption).toMatch(/^Codex\b/);
    // The repoint is stated as a fact about the Agent, never as the engine.
    expect(caption).toBe('Codex · Agent now on OpenCode');
    expect(button.getAttribute('aria-label')).toContain(
      'This conversation runs on Codex. Its Agent now uses OpenCode',
    );
  });

  test("an ACP session is named by its own connection, not the Agent's new one", async () => {
    renderDock(
      buildSession({
        provider: 'acp',
        orchestrationProvider: 'acp',
        agentConnectionId: 'opencode',
        orchestrationSessionStarted: true,
      } as Partial<ChatSession>),
      { id: 'codex', name: 'Codex' },
    );
    expect((await engineChip()).caption).toBe('OpenCode · Agent now on Codex');
  });

  test("a session on the Agent's own engine carries no repoint hint", async () => {
    renderDock(
      buildSession({
        provider: 'acp',
        orchestrationProvider: 'acp',
        agentConnectionId: 'opencode',
        orchestrationSessionStarted: true,
      } as Partial<ChatSession>),
      { id: 'opencode', name: 'OpenCode' },
    );
    const { button, caption } = await engineChip();
    expect(caption).toBe('OpenCode');
    expect(button.getAttribute('aria-label')).not.toContain('Agent now uses');
  });

  test("before any Session exists the chip names the Agent's configured engine", async () => {
    renderDock(buildSession({ conversationId: undefined, model: undefined }), {
      id: 'opencode',
      name: 'OpenCode',
    });
    expect((await engineChip()).caption).toBe('OpenCode');
  });
});
