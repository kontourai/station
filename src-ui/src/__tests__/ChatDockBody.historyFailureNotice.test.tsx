/**
 * @vitest-environment jsdom
 *
 * station#3427 review round 2. Nothing exercised `ChatDockBody`'s history
 * failure notice before this file — an independent review deleted the
 * notice's whole CSS block and 13 files / 172 tests stayed green. This pins
 * the behavior and markup a class-name assertion can reach (see
 * `session-history-error-css.test.ts` for the CSS-shaped half): the notice
 * renders exactly when the bounded history read failed, names the recorded
 * cause verbatim (or the upgrade copy), carries the shared secondary-button
 * treatment, and Retry re-issues the read.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({ current: [] as any[] }));
const transcriptStateMock = vi.hoisted(() => ({
  current: {
    enabled: false,
    messages: [] as any[],
    events: [] as any[],
    hasMore: false,
    loading: false,
    upgradeRequired: false,
    error: null as Error | null,
    loadOlder: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  },
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
  }),
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agentsMock.current,
  // station#3764: the empty-transcript filler renders `ChatEmptyState`.
  useAgentsLoaded: () => true,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { alias: 'operator' } }),
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

vi.mock('../hooks/orchestration/useActiveChatTranscript', () => ({
  useActiveChatTranscript: () => transcriptStateMock.current,
}));

vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: () => <div data-testid="chat-input-area" />,
}));

vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));

import { ChatDockBody } from '../components/chat-dock/ChatDockBody';
import type { ChatSession } from '../types';

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
    id: 'thread-alpha',
    agentSlug: agentId('codex'),
    agentName: 'Codex',
    title: 'A session whose history failed to load',
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

function buildOrchestrationSession(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'thread-alpha',
    provider: 'codex',
    status: 'idle',
    lifecycleState: 'idle',
    ...overrides,
  } as any;
}

function renderDock() {
  agentsMock.current = [{ slug: agentId('codex'), name: 'Codex' }];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatDockBody
        activeSession={buildSession()}
        activeOrchestrationSession={buildOrchestrationSession()}
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
    </QueryClientProvider>,
  );
}

describe('ChatDockBody history-failure notice (station#3427)', () => {
  beforeEach(() => {
    agentsMock.current = [];
    transcriptStateMock.current = {
      enabled: false,
      messages: [],
      events: [],
      hasMore: false,
      loading: false,
      upgradeRequired: false,
      error: null,
      loadOlder: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    };
  });

  test('says nothing when history is enabled and healthy', () => {
    transcriptStateMock.current.enabled = true;
    renderDock();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('says nothing when history is simply disabled for this session', () => {
    transcriptStateMock.current.enabled = false;
    transcriptStateMock.current.error = new Error('would be moot');
    renderDock();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('renders the recorded cause verbatim, with the shared secondary-button Retry affordance', () => {
    transcriptStateMock.current.enabled = true;
    transcriptStateMock.current.error = new Error('ECONNREFUSED host:8443');
    // The banner (as opposed to the empty-state variant handed to the
    // lazy-loaded message list) renders only once the pane already has
    // history to sit above — a subsequent page failing, not a cold arrival.
    transcriptStateMock.current.messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
    ] as any;
    renderDock();

    const notice = screen.getByRole('alert');
    expect(notice.className).toBe('session-history-error');
    expect(notice.textContent).toBe(
      'Session history is unavailable. ECONNREFUSED host:8443Retry',
    );

    const retry = screen.getByRole('button', { name: 'Retry' });
    // The shared class the rest of this surface's affordances use
    // (`.session-history-controls__more` two rules above in index.css) —
    // not a bespoke, unhovered button.
    expect(retry.className).toContain('button--secondary');

    fireEvent.click(retry);
    expect(transcriptStateMock.current.reload).toHaveBeenCalledOnce();
  });

  test('renders the upgrade copy, not the raw error, when an upgrade is required', () => {
    transcriptStateMock.current.enabled = true;
    transcriptStateMock.current.upgradeRequired = true;
    transcriptStateMock.current.error = new Error('should not print');
    transcriptStateMock.current.messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
    ] as any;
    renderDock();

    const notice = screen.getByRole('alert');
    expect(notice.textContent).toContain(
      'Update Station to use bounded managed-session history.',
    );
    expect(notice.textContent).not.toContain('should not print');
  });
});
