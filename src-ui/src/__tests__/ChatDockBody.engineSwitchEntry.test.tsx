/**
 * @vitest-environment jsdom
 *
 * The composer's model picker is the entry point to "Change engine for this
 * conversation". At the pane (ChatDockBody) it must not offer what the caller
 * cannot do: an engine this client cannot start is not listed, no engine
 * switch is listed when the dock withholds the engine-change action (the
 * server's open resolution denies changes), and while a turn or queued
 * message blocks the switch the engines stay listed but disabled with the
 * reason, so the dialog never opens on a form it would refuse.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { SelectableModel } from '../utils/modelCapabilities';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));
const pickerModelsSeen = vi.hoisted(() => ({
  current: undefined as SelectableModel[] | undefined,
  resetDisabledReason: undefined as string | undefined,
  onModelReset: undefined as undefined | (() => void),
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
// The picker renders exactly the list ChatDockBody hands ChatInputArea, so
// that list is the seam: capture it.
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: ({
    pickerModels,
    modelResetDisabledReason,
    onModelReset,
  }: {
    pickerModels?: SelectableModel[];
    modelResetDisabledReason?: string;
    onModelReset: () => void;
  }) => {
    pickerModelsSeen.current = pickerModels;
    pickerModelsSeen.resetDisabledReason = modelResetDisabledReason;
    pickerModelsSeen.onModelReset = onModelReset;
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
  hasUnread: false,
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
} as unknown as ChatSession;

// The same shape `executionModelsForAgent` produces: the Agent's own models
// carry no `executionAgentId`; each alternative engine's carry its binding.
const executionModels: SelectableModel[] = [
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'gpt-6', name: 'GPT 6.1 Sol', executionAgentId: 'codex-proxy' },
  {
    id: 'kiro',
    name: 'Kiro default',
    executionAgentId: 'kiro',
    available: false,
    unavailableReason: 'Engine connection is not ready.',
  },
];

async function renderBody({
  onExecutionModelSelect,
  handoffDisabledReason,
  activeSession = session,
}: {
  onExecutionModelSelect?: (model?: SelectableModel) => void;
  handoffDisabledReason?: string;
  activeSession?: ChatSession;
}) {
  agentsMock.current = [
    { slug: agentId('station'), name: 'Station', available: true },
  ];
  pickerModelsSeen.current = undefined;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ChatDockBody
        activeSession={activeSession}
        chatFontSize={14}
        dockHeight={400}
        showStatsPanel={false}
        showReasoning={false}
        showToolDetails={false}
        modelSupportsAttachments={false}
        fileAttachmentsSupported={false}
        availableModels={[]}
        executionModels={executionModels}
        onExecutionModelSelect={onExecutionModelSelect}
        secondaryActions={
          {
            handoffDisabled: Boolean(handoffDisabledReason),
            handoffDisabledReason,
          } as never
        }
        chatInput={buildChatInput() as any}
        setShowStatsPanel={vi.fn()}
      />
    </QueryClientProvider>,
  );
  // The composer is a lazy chunk; wait for the mocked area to mount.
  await screen.findByTestId('chat-input-area');
  return pickerModelsSeen.current ?? [];
}

const summary = (models: SelectableModel[]) =>
  models.map((model) => [
    model.id,
    model.available !== false,
    model.unavailableReason,
  ]);

describe('ChatDockBody engine-switch entry point', () => {
  test('lists only the engines this client can start', async () => {
    expect(
      summary(await renderBody({ onExecutionModelSelect: vi.fn() })),
    ).toEqual([
      ['sonnet', true, undefined],
      ['gpt-6', true, undefined],
    ]);
  });

  test('lists no engine switch when the dock withholds it', async () => {
    expect(summary(await renderBody({}))).toEqual([
      ['sonnet', true, undefined],
    ]);
  });

  test('a turn in flight disables every engine switch with its reason', async () => {
    expect(
      summary(
        await renderBody({
          onExecutionModelSelect: vi.fn(),
          handoffDisabledReason: 'Wait for the current turn to finish.',
        }),
      ),
    ).toEqual([
      ['sonnet', true, undefined],
      ['gpt-6', false, 'Wait for the current turn to finish.'],
    ]);
  });

  test('a turn in flight also refuses "Use Agent defaults" on an engine override', async () => {
    const onExecutionModelSelect = vi.fn();
    const overridden = {
      ...session,
      executionAgentId: 'codex-proxy',
    } as ChatSession;
    await renderBody({
      onExecutionModelSelect,
      handoffDisabledReason: 'Wait for the current turn to finish.',
      activeSession: overridden,
    });
    expect(pickerModelsSeen.resetDisabledReason).toBe(
      'Wait for the current turn to finish.',
    );
    pickerModelsSeen.onModelReset?.();
    expect(onExecutionModelSelect).not.toHaveBeenCalled();
  });

  test('an unblocked "Use Agent defaults" opens the engine change', async () => {
    const onExecutionModelSelect = vi.fn();
    await renderBody({
      onExecutionModelSelect,
      activeSession: {
        ...session,
        executionAgentId: 'codex-proxy',
      } as ChatSession,
    });
    expect(pickerModelsSeen.resetDisabledReason).toBeUndefined();
    pickerModelsSeen.onModelReset?.();
    expect(onExecutionModelSelect).toHaveBeenCalledWith();
  });
});
