/**
 * @vitest-environment jsdom
 *
 * An Agent or engine picked "for next message" turns the composer's ordinary
 * Send into the handoff's first turn. ChatDockBody owns that routing: with a
 * target armed, every send out of the composer (Send, Enter and a busy-turn
 * Queue) hands the prepared draft (mentions, quotes and checks applied) to the
 * handoff and never reaches the ordinary sender; nothing goes while the
 * handoff dispatches or is blocked; a slash command stays local; with nothing
 * armed, Send is the ordinary send.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));
const composerSeen = vi.hoisted(() => ({
  onSend: undefined as undefined | (() => Promise<void>),
  onQueueFollowUp: undefined as undefined | (() => Promise<void>),
  sendBlockedReason: undefined as string | undefined,
  nextMessageHandoff: undefined as
    | undefined
    | { label: string; kind: string; onUndo: () => void },
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
    onQueueFollowUp,
    sendBlockedReason,
    nextMessageHandoff,
  }: {
    onSend: () => Promise<void>;
    onQueueFollowUp?: () => Promise<void>;
    sendBlockedReason?: string;
    nextMessageHandoff?: { label: string; kind: string; onUndo: () => void };
  }) => {
    composerSeen.onSend = onSend;
    composerSeen.onQueueFollowUp = onQueueFollowUp;
    composerSeen.sendBlockedReason = sendBlockedReason;
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

type Prepared = { text: string; draft: string; quotes: never[] };
type Armed = {
  label: string;
  kind: 'agent' | 'engine';
  pending: boolean;
  phase?: 'sending' | 'attention';
  blockedReason?: string;
  onSend: ReturnType<typeof vi.fn>;
  onUndo: ReturnType<typeof vi.fn>;
};
const armed = (overrides: Partial<Armed> = {}): Armed => ({
  label: 'Codex · GPT-5',
  kind: 'agent',
  pending: false,
  onSend: vi.fn(),
  onUndo: vi.fn(),
  ...overrides,
});

async function renderBody({
  input,
  nextMessageHandoff,
  prepared,
  attachments = [],
}: {
  input: string;
  nextMessageHandoff?: Armed;
  prepared?: Prepared | null;
  attachments?: unknown[];
}) {
  agentsMock.current = [
    { slug: agentId('station'), name: 'Station', available: true },
  ];
  composerSeen.onSend = undefined;
  composerSeen.onQueueFollowUp = undefined;
  const chatInput = {
    ...buildChatInput(),
    input,
    attachments,
    prepareOutgoingText: vi.fn(async () =>
      prepared === undefined
        ? { text: input, draft: input, quotes: [] }
        : prepared,
    ),
  };
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
        nextMessageHandoff={nextMessageHandoff as never}
        chatInput={chatInput as any}
        setShowStatsPanel={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await screen.findByTestId('chat-input-area');
  return chatInput;
}

describe('ChatDockBody next-message handoff', () => {
  test('an armed target receives the prepared draft and the ordinary sender does not', async () => {
    const target = armed();
    const prepared = {
      text: '> the quoted answer\n\nPick this up',
      draft: 'Pick this up',
      quotes: [] as never[],
    };
    const chatInput = await renderBody({
      input: 'Pick this up',
      nextMessageHandoff: target,
      prepared,
    });
    expect(composerSeen.nextMessageHandoff?.label).toBe('Codex · GPT-5');
    await composerSeen.onSend?.();
    expect(chatInput.prepareOutgoingText).toHaveBeenCalledOnce();
    expect(target.onSend).toHaveBeenCalledWith(prepared);
    expect(chatInput.handleSend).not.toHaveBeenCalled();
    composerSeen.nextMessageHandoff?.onUndo();
    expect(target.onUndo).toHaveBeenCalledOnce();
  });

  test('a send the preparation refuses goes nowhere', async () => {
    const target = armed();
    const chatInput = await renderBody({
      input: 'too long',
      nextMessageHandoff: target,
      prepared: null,
    });
    await composerSeen.onSend?.();
    expect(target.onSend).not.toHaveBeenCalled();
    expect(chatInput.handleSend).not.toHaveBeenCalled();
  });

  test('a busy-turn Queue while armed is the handoff too, never a queued send to the current agent', async () => {
    const target = armed();
    const chatInput = await renderBody({
      input: 'Queued text',
      nextMessageHandoff: target,
    });
    await composerSeen.onQueueFollowUp?.();
    expect(target.onSend).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Queued text' }),
    );
    expect(chatInput.handleSend).not.toHaveBeenCalled();
  });

  test('while the armed send dispatches, a second Send or Queue sends nothing', async () => {
    const target = armed({ pending: true, phase: 'sending' });
    const chatInput = await renderBody({
      input: 'Same draft',
      nextMessageHandoff: target,
    });
    expect(composerSeen.sendBlockedReason).toBe('Switching to Codex · GPT-5…');
    await composerSeen.onSend?.();
    await composerSeen.onQueueFollowUp?.();
    expect(target.onSend).not.toHaveBeenCalled();
    expect(chatInput.prepareOutgoingText).not.toHaveBeenCalled();
    expect(chatInput.handleSend).not.toHaveBeenCalled();
  });

  test('a blocked handoff holds the send with its reason instead of sending to the current agent', async () => {
    const target = armed({
      blockedReason: 'Wait for the current turn to finish.',
    });
    const chatInput = await renderBody({
      input: 'Later',
      nextMessageHandoff: target,
    });
    expect(composerSeen.sendBlockedReason).toBe(
      'Wait for the current turn to finish.',
    );
    await composerSeen.onQueueFollowUp?.();
    await composerSeen.onSend?.();
    expect(target.onSend).not.toHaveBeenCalled();
    expect(chatInput.handleSend).not.toHaveBeenCalled();
  });

  test('an armed send with attachments says to remove them and sends nothing', async () => {
    const target = armed();
    const chatInput = await renderBody({
      input: '',
      nextMessageHandoff: target,
      attachments: [{ id: 'a', name: 'a.png' }],
    });
    expect(composerSeen.sendBlockedReason).toBe(
      'Remove attachments, or undo the switch to send them.',
    );
    await composerSeen.onSend?.();
    expect(target.onSend).not.toHaveBeenCalled();
    expect(chatInput.prepareOutgoingText).not.toHaveBeenCalled();
  });

  test('an armed send that needs the person says so instead of "Switching"', async () => {
    await renderBody({
      input: 'x',
      nextMessageHandoff: armed({ pending: true, phase: 'attention' }),
    });
    expect(composerSeen.sendBlockedReason).toBe(
      'Finish the switch to Codex · GPT-5 first.',
    );
  });

  test('a slash command stays local while a target is armed', async () => {
    const target = armed();
    const chatInput = await renderBody({
      input: '/model',
      nextMessageHandoff: target,
    });
    await composerSeen.onSend?.();
    expect(target.onSend).not.toHaveBeenCalled();
    expect(chatInput.handleSend).toHaveBeenCalledOnce();
  });

  test('with nothing armed, Send is the ordinary send', async () => {
    const chatInput = await renderBody({ input: 'hello' });
    expect(composerSeen.nextMessageHandoff).toBeUndefined();
    await composerSeen.onSend?.();
    expect(chatInput.handleSend).toHaveBeenCalledOnce();
  });
});
