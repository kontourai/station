/**
 * @vitest-environment jsdom
 *
 * A queued steer says it waits for tools only while a call is executing by
 * the rule the tool rows use (`isToolCallActive`). A live part still marked
 * `running` that is waiting on approval reads "Awaiting approval" in its row,
 * so the steer waits for the turn, not for tools. Drives store -> real
 * `useDerivedSessions` -> real `ChatDockBody` -> real `QueuedMessages`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const STABLE_AGENTS = [{ slug: 'agent-one', name: 'Agent One' }];

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => STABLE_AGENTS,
  useAgentsLoaded: () => true,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({ navigate: vi.fn() });
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
  StreamingMessage: () => <div data-testid="streaming-message" />,
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));
vi.mock('../contexts/ActiveChatsContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/ActiveChatsContext')>();
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  return {
    ...actual,
    useActiveChatActions: () => ({
      removeQueuedMessage:
        activeChatsStore.removeQueuedMessage.bind(activeChatsStore),
      editQueuedMessage:
        activeChatsStore.editQueuedMessage.bind(activeChatsStore),
      reorderQueuedMessage:
        activeChatsStore.reorderQueuedMessage.bind(activeChatsStore),
      updateChat: vi.fn(),
      clearEphemeralMessages: vi.fn(),
      addEphemeralMessage: vi.fn(),
    }),
  };
});
vi.mock('../contexts/MessageContextContext', () => ({
  useMessageContextContext: () => ({ getComposedContext: () => '' }),
}));
vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
}));
vi.mock('../hooks/useShareReceiver', () => ({ useShareReceiver: () => {} }));
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
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: () => <div data-testid="chat-input-area" />,
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useDerivedSessions } from '../hooks/useDerivedSessions';

const SESSION = 'steer-waiting-session';

function streamingWith(part: Record<string, unknown>) {
  return {
    role: 'assistant' as const,
    content: '',
    contentParts: [
      {
        type: 'tool-invocation',
        toolCallId: 'call-1',
        toolName: 'Bash',
        args: { command: 'npm test' },
        state: 'running',
        ...part,
      },
    ] as any,
  };
}
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

/** The dock as ChatDock builds it: its session comes from the derivation hook. */
function DerivedDock() {
  const session = useDerivedSessions('', null, null).find(
    (s) => s.id === SESSION,
  );
  if (!session) return null;
  return (
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
  );
}

function clearChats() {
  for (const id of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.removeChat(id);
  }
}

describe('ChatDockBody steer status follows the tool rows', () => {
  beforeEach(() => {
    clearChats();
    activeChatsStore.initChat(SESSION, {
      agentSlug: 'agent-one',
      agentName: 'Agent One',
      title: 'Steering a running turn',
    });
    activeChatsStore.updateChat(SESSION, {
      queuedMessages: ['use the other port'],
      queuedMessageMetadata: [{ id: 'queued-1', mode: 'steer' }],
    });
  });

  afterEach(() => {
    cleanup();
    clearChats();
  });

  function mountDock() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <DerivedDock />
      </QueryClientProvider>,
    );
  }

  test('an executing call holds the steer for tools', async () => {
    activeChatsStore.updateChat(SESSION, {
      streamingMessage: streamingWith({}),
    });
    mountDock();
    expect(
      await screen.findByText('Steer · Waiting for tools to finish'),
    ).toBeTruthy();
  });

  test('a running-state call that is waiting on approval does not', async () => {
    activeChatsStore.updateChat(SESSION, {
      streamingMessage: streamingWith({
        needsApproval: true,
        approvalId: 'approval-1',
      }),
    });
    mountDock();
    expect(
      await screen.findByText('Steer · Waiting for this turn to finish'),
    ).toBeTruthy();
    expect(
      screen.queryByText('Steer · Waiting for tools to finish'),
    ).toBeNull();
  });
});
