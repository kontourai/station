/**
 * @vitest-environment jsdom
 *
 * The composer's engine chip names the engine the conversation's Session
 * actually runs on. Repointing the chat's Agent at another connection does not
 * move an open Session (`resolveConversationContinuation` keeps the next turn
 * on it), so the Agent's configured connection must not relabel it. Renders
 * the real ChatDockBody -> ChatInputArea path.
 */

import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
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

// The dock header's close-tab hint; the header renders beside the chip below.
vi.mock('../hooks/useKeyboardShortcut', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useKeyboardShortcut')>()),
  useShortcutDisplay: () => '⌘W',
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

import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { ChatDockActiveIdentity } from '../components/chat-dock/ChatDockActiveIdentity';
import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import { conversationOpenPatch } from '../components/chat-dock/conversationOpenController';
import { PreviewProvider } from '../contexts/PreviewContext';
import type { ChatSession } from '../types';
import { chatExecutionBinding } from '../utils/engine';

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

function agentOn(
  connection: { id: string; name: string },
  slug = 'station',
  extra: Record<string, unknown> = {},
) {
  return {
    slug: agentId(slug),
    name: slug === 'station' ? 'Station' : slug,
    available: true,
    engineId: connection.id,
    engineDisplayName: connection.name,
    execution: { agentConnectionId: connection.id },
    ...extra,
  };
}

function renderDock(
  session: ChatSession,
  agentConnection: { id: string; name: string },
  extraAgents: unknown[] = [],
) {
  // The Agent as `/api/agents` enriches it NOW: repointed at a connection.
  agentsMock.current = [agentOn(agentConnection), ...extraAgents];
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
  // jsdom applies no container query, so both hint variants are in the DOM;
  // the caption's own text node is the engine, each span one hint variant.
  const text = (selector: string) =>
    caption?.querySelector(selector)?.textContent ?? null;
  return {
    button,
    engine: caption?.firstChild?.textContent ?? '',
    hint: text('.chat-input__engine-moved--full'),
    shortHint: text('.chat-input__engine-moved--short'),
  };
}

/** A started Session whose connection was observed for that very Session. */
function observed(
  provider: string,
  connection: string,
  extra: Partial<ChatSession> = {},
): Partial<ChatSession> {
  return {
    provider,
    orchestrationProvider: provider,
    orchestrationSessionStarted: true,
    agentConnectionId: engineConnectionId(connection),
    currentSessionId: 'session-1',
    agentConnectionObservedFor: 'session-1',
    ...extra,
  } as Partial<ChatSession>;
}

describe('ChatDockBody composer engine chip', () => {
  test('a Codex session keeps naming Codex after its Agent is repointed to OpenCode', async () => {
    renderDock(buildSession(observed('codex', 'codex')), {
      id: 'opencode',
      name: 'OpenCode',
    });
    const { button, engine, hint, shortHint } = await engineChip();
    expect(engine).toBe('Codex');
    // The repoint is stated as a fact about the Agent, never as the engine.
    expect(hint).toBe(' · Agent now on OpenCode');
    expect(shortHint).toBe(' · Agent moved');
    const name = button.getAttribute('aria-label') ?? '';
    expect(name).toContain(
      'This conversation runs on Codex. Its Agent now uses OpenCode.',
    );
    // An open Session keeps its engine: nothing predicts the next turn moves.
    expect(name).not.toMatch(/new session|next turn/i);
  });

  test('once the Session has ended, the chip says the next turn starts on the new engine', async () => {
    renderDock(
      buildSession(
        observed('codex', 'codex', { orchestrationStatus: 'exited' }),
      ),
      { id: 'opencode', name: 'OpenCode' },
    );
    const { button, engine, hint, shortHint } = await engineChip();
    expect(engine).toBe('Codex');
    expect(hint).toBe(' · Next turn on OpenCode');
    expect(shortHint).toBe(' · Next: OpenCode');
    expect(button.getAttribute('aria-label')).toContain(
      "This conversation's Codex session has ended; its next turn starts on OpenCode",
    );
  });

  test("an ACP session is named by its own connection, not the Agent's new one", async () => {
    renderDock(buildSession(observed('acp', 'opencode')), {
      id: 'codex',
      name: 'Codex',
    });
    const { engine, hint } = await engineChip();
    expect(engine).toBe('OpenCode');
    expect(hint).toBe(' · Agent now on Codex');
  });

  test("a session on the Agent's own engine carries no repoint hint", async () => {
    renderDock(buildSession(observed('acp', 'opencode')), {
      id: 'opencode',
      name: 'OpenCode',
    });
    const { button, engine, hint } = await engineChip();
    expect(engine).toBe('OpenCode');
    expect(hint).toBeNull();
    expect(button.getAttribute('aria-label')).not.toContain('Agent now uses');
  });

  test("before any Session exists the chip names the Agent's configured engine", async () => {
    renderDock(buildSession({ conversationId: undefined, model: undefined }), {
      id: 'opencode',
      name: 'OpenCode',
    });
    const { engine, hint } = await engineChip();
    expect(engine).toBe('OpenCode');
    expect(hint).toBeNull();
  });

  test('an Agent still bound to the Session keeps its own connection name', async () => {
    renderDock(buildSession(observed('codex', 'codex-work')), {
      id: 'codex-work',
      name: 'Codex (work)',
    });
    const { engine, hint } = await engineChip();
    expect(engine).toBe('Codex (work)');
    expect(hint).toBeNull();
  });

  // #4162: a successor Session started on the Agent's new connection while
  // the chat still holds the connection observed for its predecessor.
  test('an ACP successor with a stale connection claims neither a name nor a move', async () => {
    renderDock(
      buildSession(
        observed('acp', 'codex', {
          currentSessionId: 'session-2',
          agentConnectionObservedFor: 'session-1',
        }),
      ),
      { id: 'opencode', name: 'OpenCode' },
    );
    const { button, engine, hint } = await engineChip();
    expect(engine).toBe('Engine & model');
    expect(hint).toBeNull();
    expect(button.getAttribute('aria-label')).not.toMatch(
      /Custom engine|Agent now uses/,
    );
  });

  test('a native successor with a stale connection names its product and claims no move', async () => {
    renderDock(
      buildSession(
        observed('claude', 'claude', {
          currentSessionId: 'session-2',
          agentConnectionObservedFor: 'session-1',
        }),
      ),
      { id: 'claude-work', name: 'Claude Code (work)' },
    );
    const { engine, hint } = await engineChip();
    expect(engine).toBe('Claude Code');
    expect(hint).toBeNull();
  });

  test("a successor whose own start was observed reads the Agent's connection", async () => {
    // What `session.started` (or the receipt of the send that started it)
    // records for the successor: its connection, observed for itself.
    renderDock(
      buildSession(
        observed('acp', 'opencode', {
          currentSessionId: 'session-2',
          agentConnectionObservedFor: 'session-2',
        }),
      ),
      { id: 'opencode', name: 'OpenCode' },
    );
    const { engine, hint } = await engineChip();
    expect(engine).toBe('OpenCode');
    expect(hint).toBeNull();
  });

  test('an engine with no product name reads neutrally, never its raw id', async () => {
    renderDock(buildSession(observed('grok', 'grok-cli')), {
      id: 'opencode',
      name: 'OpenCode',
    });
    const { engine } = await engineChip();
    expect(engine).toBe('Engine & model');
  });

  test('a conversation override is judged against its execution Agent', async () => {
    renderDock(
      buildSession(
        observed('codex', 'codex-work', {
          executionAgentId: 'codex-work-default',
        }),
      ),
      { id: 'opencode', name: 'OpenCode' },
      [
        agentOn(
          { id: 'codex-work', name: 'Codex (work)' },
          'codex-work-default',
          {
            executionDefault: true,
          },
        ),
      ],
    );
    const { engine, hint } = await engineChip();
    expect(engine).toBe('Codex (work)');
    expect(hint).toBeNull();
  });

  /** A fresh tab's state for a conversation the open read resolved. */
  function reopened(
    open: Partial<Extract<ConversationOpenResolution, { status: 'resolved' }>>,
  ): ChatSession {
    const resolution = {
      status: 'resolved',
      conversation: {
        id: 'conversation-engine-chip',
        title: 'Continue',
        agentSlug: agentId('station'),
        answerability: { answerable: true },
      },
      currentSessionId: 'session-1',
      execution: {
        sessionId: 'session-1',
        agentId: agentId('station'),
        provider: 'codex',
        engineConnectionId: engineConnectionId('codex'),
      },
      transcript: { available: true, owner: 'runtime', messageCount: 2 },
      canContinue: true,
      answerability: { answerable: true },
      recoveryActions: [],
      ...open,
    } as ConversationOpenResolution;
    // The real open patch: a fresh tab has no live status for the Session.
    const patch = conversationOpenPatch(resolution);
    expect(patch.orchestrationStatus).toBeUndefined();
    return buildSession(patch as Partial<ChatSession>);
  }

  test('#4179: a fresh open of an ended Session says the next turn starts on the new engine', async () => {
    renderDock(reopened({ nextTurnStartsSession: true }), {
      id: 'opencode',
      name: 'OpenCode',
    });
    const { engine, hint, shortHint } = await engineChip();
    expect(engine).toBe('Codex');
    expect(hint).toBe(' · Next turn on OpenCode');
    expect(shortHint).toBe(' · Next: OpenCode');
  });

  test.each([
    ['the Session takes the next turn', { nextTurnStartsSession: false }],
    ['an older host says nothing', {}],
  ] as const)(
    '#4179: a fresh open where %s keeps the Agent copy',
    async (_case, open) => {
      renderDock(reopened(open), { id: 'opencode', name: 'OpenCode' });
      const { engine, hint } = await engineChip();
      expect(engine).toBe('Codex');
      expect(hint).toBe(' · Agent now on OpenCode');
    },
  );

  test("#4179: the open fact stops applying once the chat's Session moves on", async () => {
    const session = reopened({ nextTurnStartsSession: true });
    renderDock(
      {
        ...session,
        // A later send started a successor; its own facts are not in yet.
        currentSessionId: 'session-2',
        agentConnectionObservedFor: 'session-2',
      },
      { id: 'opencode', name: 'OpenCode' },
    );
    const { hint } = await engineChip();
    expect(hint).not.toMatch(/Next turn/);
  });

  test('an override whose execution Agent is missing: the chip and the header name one engine', async () => {
    // The override's Agent was deleted (or has not loaded); the chat's own
    // Agent sits on the connection the Session runs on, under its own name.
    const session = buildSession(
      observed('codex', 'codex-work', {
        executionAgentId: agentId('codex-work-default'),
      }),
    );
    renderDock(session, { id: 'codex-work', name: 'Codex (work)' });
    const { engine } = await engineChip();
    render(
      <ChatDockActiveIdentity
        session={session}
        agent={agentsMock.current[0]}
        executionAgent={chatExecutionBinding(session, agentsMock.current)}
        acpConnections={acpConnectionsMock.current}
        onClose={vi.fn()}
      />,
    );
    const header = document.querySelector(
      '.chat-dock__active-identity-engine',
    )?.textContent;
    // Neither borrows the chat Agent's binding for the override: both name
    // the Session's own engine.
    expect(engine).toBe('Codex');
    expect(header).toBe(engine);
  });
});
