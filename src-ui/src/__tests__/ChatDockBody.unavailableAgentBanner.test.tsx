/**
 * @vitest-environment jsdom
 *
 * archive#3136. The dock's unavailable-agent banner used to open with
 * "This agent can't launch with its current model." for EVERY unavailable
 * agent and then interpolate the server's `unavailableReason` — which, for an
 * engine-default alias (archive#3027), says the row has no authored Agent
 * definition at all. The banner asserted one cause and quoted another.
 *
 * These tests pin the lead-in to the machine-readable `enable` signal the
 * new-chat picker already keys on, and — the load-bearing one — prove the
 * derivation is NOT reading `unavailableReason` prose: an agent carrying the
 * alias reason text WITHOUT the signal keeps the model wording, and an agent
 * carrying the signal with model-flavoured prose still reads as "not set up".
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
  }),
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agentsMock.current,
  // archive#3764: the empty-transcript filler renders `ChatEmptyState`.
  useAgentsLoaded: () => true,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: navigateSpy }),
}));

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

vi.mock('../hooks/useMessageContext', () => ({
  useMessageContext: () => ({ getComposedContext: () => '' }),
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

vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: () => <div data-testid="chat-input-area" />,
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import type { ChatSession } from '../types';

/**
 * Byte-for-byte the string `enriched-agents.ts` builds for an engine-default
 * alias (`unresolvedReason`). 249 characters — this is what the old banner
 * pasted under a model headline, and what the new alias branch must NOT paste.
 */
const ALIAS_SERVER_REASON =
  "Agent 'codex' has no authored Agent definition, so Station cannot start new sessions or continue existing conversations with it. Enable this engine by creating an Agent for it — new chats will run as that Agent; existing conversations stay readable.";

const MODEL_PROBLEM_REASON =
  'Model connection "bedrock-prod" is in error, so this agent cannot start.';

const MODEL_LEAD_IN = "This agent can't launch with its current model.";
const NOT_SET_UP_LEAD_IN = "This agent isn't set up yet.";

function buildChatInput() {
  return {
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
    id: 'unavailable-banner-session',
    agentSlug: agentId('codex'),
    agentName: 'Codex',
    title: 'Unavailable agent chat',
    source: 'manual',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    ...overrides,
  } as ChatSession;
}

function renderDock({
  agent,
  session = buildSession(),
  onNewChat,
}: {
  agent: Record<string, unknown>;
  session?: ChatSession;
  onNewChat?: () => void;
}) {
  agentsMock.current = [agent];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
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
        onNewChat={onNewChat}
      />
    </QueryClientProvider>,
  );
}

function aliasAgent(overrides: Record<string, unknown> = {}) {
  return {
    slug: agentId('codex'),
    name: 'Codex',
    engineDefault: true,
    engineDisplayName: 'Codex',
    available: false,
    unavailableReason: ALIAS_SERVER_REASON,
    enable: { engineConnectionId: 'codex' },
    ...overrides,
  };
}

function modelProblemAgent(overrides: Record<string, unknown> = {}) {
  return {
    slug: agentId('codex'),
    name: 'Codex',
    available: false,
    unavailableReason: MODEL_PROBLEM_REASON,
    ...overrides,
  };
}

describe('ChatDockBody unavailable-agent banner (station#3136)', () => {
  beforeEach(() => {
    navigateSpy.mockClear();
    agentsMock.current = [];
  });

  test('an engine-default alias reads as "not set up" — never as a model problem', () => {
    renderDock({ agent: aliasAgent(), onNewChat: vi.fn() });

    expect(screen.getByText(NOT_SET_UP_LEAD_IN)).toBeTruthy();
    // The false cause is gone, and so is the model remedy that went with it.
    expect(screen.queryByText(MODEL_LEAD_IN)).toBeNull();
    expect(document.body.textContent).not.toContain('current model');
    expect(
      screen.queryByRole('button', { name: "edit the agent's model setting" }),
    ).toBeNull();
  });

  test('the alias banner does not paste the 249-character server reason', () => {
    renderDock({ agent: aliasAgent(), onNewChat: vi.fn() });

    expect(document.body.textContent).not.toContain(ALIAS_SERVER_REASON);
    // …but it still says the two things that reason was carrying: there is no
    // Agent for this engine, and the thread survives as reading material.
    expect(document.body.textContent).toContain(
      'No Agent has been created for this engine',
    );
    expect(document.body.textContent).toContain('it stays readable');
  });

  test('the alias remedy opens the picker where Enable lives — with no migrated draft', () => {
    const onNewChat = vi.fn();
    renderDock({ agent: aliasAgent(), onNewChat });

    fireEvent.click(
      screen.getByRole('button', { name: 'Enable it in a new chat' }),
    );
    // No arguments: `handleStartNewChatWithMessage` opens the New Chat modal
    // (where the Enable affordance is) rather than starting a chat directly.
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNewChat).toHaveBeenCalledWith();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  test('with no new-chat handler wired the copy still stands, minus the action', () => {
    renderDock({ agent: aliasAgent() });

    expect(screen.getByText(NOT_SET_UP_LEAD_IN)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Enable it in a new chat' }),
    ).toBeNull();
  });

  test('a genuine model problem keeps the existing wording, reason and remedy', () => {
    renderDock({ agent: modelProblemAgent(), onNewChat: vi.fn() });

    expect(screen.getByText(MODEL_LEAD_IN)).toBeTruthy();
    expect(document.body.textContent).toContain(MODEL_PROBLEM_REASON);
    expect(document.body.textContent).toContain(
      'Select a model from the picker to start chatting',
    );
    expect(screen.queryByText(NOT_SET_UP_LEAD_IN)).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: "edit the agent's model setting" }),
    );
    expect(navigateSpy).toHaveBeenCalledWith('/agents/codex');
  });

  /**
   * The two halves of "keyed on the signal, not on the prose". Either one
   * alone would pass against a `unavailableReason.includes('authored Agent')`
   * implementation; together they cannot.
   */
  test('the alias REASON text without the `enable` signal does NOT get the not-set-up lead-in', () => {
    renderDock({
      agent: modelProblemAgent({ unavailableReason: ALIAS_SERVER_REASON }),
      onNewChat: vi.fn(),
    });

    expect(screen.getByText(MODEL_LEAD_IN)).toBeTruthy();
    expect(screen.queryByText(NOT_SET_UP_LEAD_IN)).toBeNull();
  });

  test('the `enable` signal wins even when the reason talks about models', () => {
    renderDock({
      agent: aliasAgent({
        unavailableReason: 'No model connection is configured for this agent.',
      }),
      onNewChat: vi.fn(),
    });

    expect(screen.getByText(NOT_SET_UP_LEAD_IN)).toBeTruthy();
    expect(screen.queryByText(MODEL_LEAD_IN)).toBeNull();
    expect(document.body.textContent).not.toContain(
      'No model connection is configured for this agent.',
    );
  });

  test('an available agent renders no banner at all', () => {
    renderDock({ agent: { slug: agentId('codex'), name: 'Codex' } });

    expect(screen.queryByText(NOT_SET_UP_LEAD_IN)).toBeNull();
    expect(screen.queryByText(MODEL_LEAD_IN)).toBeNull();
  });

  test('a session-override model suppresses the banner for the alias too', () => {
    renderDock({
      agent: aliasAgent(),
      session: buildSession({ modelSource: 'session override' } as any),
      onNewChat: vi.fn(),
    });

    expect(screen.queryByText(NOT_SET_UP_LEAD_IN)).toBeNull();
    expect(screen.queryByText(MODEL_LEAD_IN)).toBeNull();
  });
});
