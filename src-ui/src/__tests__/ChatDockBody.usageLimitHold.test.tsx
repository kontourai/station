/**
 * @vitest-environment jsdom
 *
 * #3157: the "Held until the usage limit resets" hint reaches the real dock.
 * `usageLimitStopped` lives in the active-chats store; the dock reads it off
 * the session `useDerivedSessions` builds. This test drives that whole path
 * (store -> real `useDerivedSessions` -> real `ChatDockBody` -> real
 * `QueuedMessages`) instead of handing the dock a prop, because the earlier
 * wiring put the field on the persisted shape and the hint never rendered.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
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

const SESSION = 'usage-limit-session';
const HINT = 'Held because of the usage limit. Send now to send anyway.';

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

describe('ChatDockBody usage-limit hold hint (#3157)', () => {
  beforeEach(() => {
    clearChats();
    activeChatsStore.initChat(SESSION, {
      agentSlug: 'agent-one',
      agentName: 'Agent One',
      title: 'Stopped on a usage limit',
    });
    activeChatsStore.updateChat(SESSION, {
      queuedMessages: ['carry on'],
      queuedMessageMetadata: [{ id: 'queued-1', mode: 'queue' }],
    });
  });

  afterEach(() => {
    cleanup();
    clearChats();
  });

  test('the derived session carries usageLimitStopped from the store', () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));
    expect(
      result.current.find((s) => s.id === SESSION)?.usageLimitStopped,
    ).toBe(undefined);
    act(() => {
      activeChatsStore.updateChat(SESSION, { usageLimitStopped: true });
    });
    expect(
      result.current.find((s) => s.id === SESSION)?.usageLimitStopped,
    ).toBe(true);
  });

  test('a store-held usage-limit stop shows the hint on the queue, and clearing it removes it', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <DerivedDock />
      </QueryClientProvider>,
    );
    expect(screen.queryByText(HINT)).toBeNull();

    act(() => {
      activeChatsStore.updateChat(SESSION, { usageLimitStopped: true });
    });
    // The queue is a lazy chunk, so it arrives asynchronously.
    const hint = await screen.findByText(HINT);
    expect(hint.closest('[role="status"]')).not.toBeNull();
    // A normal wait is not styled as the queue's failure row.
    expect(hint.closest('.queued-messages__failure')).toBeNull();

    act(() => {
      activeChatsStore.updateChat(SESSION, { usageLimitStopped: undefined });
    });
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
