/**
 * @vitest-environment jsdom
 *
 * An Agent or engine picked "for next message" turns the composer's ordinary
 * Send into the handoff's first turn. ChatDockBody owns that routing: with a
 * target armed, Send hands the exact draft to the handoff and never reaches
 * the ordinary sender; a slash command stays local; with nothing armed, Send
 * is the ordinary send.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));
const composerSeen = vi.hoisted(() => ({
  onSend: undefined as undefined | (() => Promise<void>),
  nextMessageHandoff: undefined as
    | undefined
    | { label: string; onUndo: () => void },
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agentsMock.current,
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
  StreamingMessage: () => null,
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
vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
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
// The composer's Send is the seam: capture what ChatDockBody wires to it.
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: ({
    onSend,
    nextMessageHandoff,
  }: {
    onSend: () => Promise<void>;
    nextMessageHandoff?: { label: string; onUndo: () => void };
  }) => {
    composerSeen.onSend = onSend;
    composerSeen.nextMessageHandoff = nextMessageHandoff;
    return <div data-testid="chat-input-area" />;
  },
}));
vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
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
    canModelSelect: true,
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

const session = {
  id: 'engine-session',
  agentSlug: agentId('station'),
  agentName: 'Station',
  conversationId: 'conversation-engine',
  title: 'Engine switch',
  source: 'manual',
  input: '',
  attachments: [],
  queuedMessages: [],
  inputHistory: [],
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
} as unknown as ChatSession;

async function renderBody({
  input,
  nextMessageHandoff,
}: {
  input: string;
  nextMessageHandoff?: {
    label: string;
    onSend: (message: string) => void;
    onUndo: () => void;
  };
}) {
  agentsMock.current = [
    { slug: agentId('station'), name: 'Station', available: true },
  ];
  composerSeen.onSend = undefined;
  const chatInput = { ...buildChatInput(), input };
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
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
        nextMessageHandoff={nextMessageHandoff}
        chatInput={chatInput as any}
        setShowStatsPanel={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await screen.findByTestId('chat-input-area');
  return chatInput;
}

describe('ChatDockBody next-message handoff', () => {
  test('an armed target receives the exact draft and the ordinary sender does not', async () => {
    const armed = { label: 'Codex · GPT-5', onSend: vi.fn(), onUndo: vi.fn() };
    const chatInput = await renderBody({
      input: 'Pick this up\nplease',
      nextMessageHandoff: armed,
    });
    expect(composerSeen.nextMessageHandoff?.label).toBe('Codex · GPT-5');
    await composerSeen.onSend?.();
    expect(armed.onSend).toHaveBeenCalledWith('Pick this up\nplease');
    expect(chatInput.handleSend).not.toHaveBeenCalled();
    composerSeen.nextMessageHandoff?.onUndo();
    expect(armed.onUndo).toHaveBeenCalledOnce();
  });

  test('a slash command stays local while a target is armed', async () => {
    const armed = { label: 'Codex', onSend: vi.fn(), onUndo: vi.fn() };
    const chatInput = await renderBody({
      input: '/model',
      nextMessageHandoff: armed,
    });
    await composerSeen.onSend?.();
    expect(armed.onSend).not.toHaveBeenCalled();
    expect(chatInput.handleSend).toHaveBeenCalledOnce();
  });

  test('with nothing armed, Send is the ordinary send', async () => {
    const chatInput = await renderBody({ input: 'hello' });
    expect(composerSeen.nextMessageHandoff).toBeUndefined();
    await composerSeen.onSend?.();
    expect(chatInput.handleSend).toHaveBeenCalledOnce();
  });
});
