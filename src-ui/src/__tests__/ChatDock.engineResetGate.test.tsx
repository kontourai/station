/** @vitest-environment jsdom */

/**
 * "Use Agent defaults" on a conversation with an engine override goes through
 * the engine change, so it is refused wherever that change is: when the
 * server's open resolution does not let this caller change the conversation,
 * `ChatWorkspacePane` withholds the engine change, and the reset must not
 * fall through to a model-only reset that leaves the override in place.
 *
 * The REAL pane, content area, chat body and boundary-dialog hook run; only
 * the composer is replaced so the reset it is handed is observable, and the
 * view model is fixed to one conversation whose open resolution the test
 * chooses.
 */

import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatWorkspacePane } from '../components/chat-dock/ChatDock';
import { DockShell } from '../components/chat-dock/DockShell';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';
import type { ChatSession } from '../types';

type ComposerProps = {
  modelResetDisabledReason?: string;
  modelResetOffered?: boolean;
  onModelReset: () => void;
};
const composer = vi.hoisted(() => ({
  props: null as null | ComposerProps,
}));
const viewSession = vi.hoisted(() => ({ current: null as unknown }));
const handleModelReset = vi.hoisted(() => vi.fn());

vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: (props: ComposerProps) => {
    composer.props = props;
    return <div data-testid="chat-input-area" />;
  },
}));
vi.mock('../components/chat/QueuedMessages', () => ({
  QueuedMessages: () => null,
}));
vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => null,
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { alias: 'operator' } }),
}));
vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
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

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));
vi.mock('../components/chat-dock/ConversationBoundaryDialogs', () => ({
  ConversationBoundaryDialogs: () => null,
}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => vi.fn(),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgentsLoaded: () => true,
}));
vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => ({ defaultChatFontSize: 14, defaultModel: undefined }),
  CONFIG_DEFAULTS: { defaultChatFontSize: 14 },
}));
vi.mock('../contexts/ModelsContext', () => ({
  useModelsCatalog: () => ({
    models: [],
    isLiveConfirmed: true,
    modelsLoading: false,
  }),
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [] }),
  useScopedProjectsQuery: () => ({ data: [], isSuccess: true }),
  useScopedProjectQuery: () => ({ data: undefined, isSuccess: true }),
  useScopedProjectChatDefaultsQuery: () => ({
    data: undefined,
    isFetching: false,
    isPending: false,
  }),
  useProject: () => undefined,
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  activeChatsStore: {
    getState: () => ({}),
    getSnapshot: () => ({}),
    subscribe: () => () => {},
  },
  useActiveChatActions: () => ({
    initChat: vi.fn(),
    removeChat: vi.fn(),
    updateChat: vi.fn(),
    addEphemeralMessage: vi.fn(),
    clearEphemeralMessages: vi.fn(),
  }),
}));
vi.mock('../contexts/open-chats-store', () => ({
  openChatsStore: {
    getState: () => ({}),
    subscribe: () => () => {},
    registerNavigation: () => () => {},
  },
  useOpenChats: () => [],
  useOpenChatInbox: () => ({
    items: [],
    currentSessionIdByConversation: new Map(),
  }),
  countOpenChatAttention: () => 0,
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useRehydrateSessions: () => () => {},
  useCancelMessage: () => vi.fn(),
  useSendMessage: () => vi.fn(),
}));
vi.mock('../hooks/useActiveProject', () => ({
  useActiveProject: () => ({ projectSlug: undefined }),
}));
vi.mock('../hooks/useBackgroundTasks', () => ({
  useChatBackgroundTasksRunningCount: () => 0,
}));
vi.mock('../hooks/useChatDockActions', () => ({
  useChatDockActions: () => ({}),
}));
vi.mock('../hooks/useChatInput', () => ({
  useChatInput: () => ({
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
    handleModelReset,
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
    setAttachmentError: vi.fn(),
    selectAttachmentFiles: vi.fn(async () => {}),
  }),
}));
// The real snapshot lazily imports the outbound queue, which can land after
// a short test tears its environment down. No queued turns is the case here.
vi.mock('../hooks/useOutboundQueueSnapshot', () => ({
  useOutboundQueueSnapshot: () => ({ status: 'ready', turns: [] }),
}));
vi.mock('../hooks/useDerivedSessions', () => ({
  useDerivedSessions: () => [],
}));
vi.mock('../hooks/useExitTransition', () => ({
  useExitTransition: (open: boolean) => ({ mounted: open, exiting: false }),
}));
vi.mock('../hooks/orchestration/ensureOrchestrationEventStream', () => ({
  ensureOrchestrationEventStream: () => {},
}));
vi.mock('../components/chat-dock/useChatDockViewModel', () => ({
  useChatDockViewModel: () => ({
    activeSession: viewSession.current,
    activeChatAgent: undefined,
    activeChatModelLabel: undefined,
    activeSessionForHook: viewSession.current,
    gitStatus: undefined,
    sessionProjectName: undefined,
    sessionDisplayCwd: undefined,
    sessionCodingLayout: undefined,
    dockProjectSlug: undefined,
    mobileProjectName: undefined,
    availableModels: [],
    modelSupportsAttachments: false,
    fileAttachmentsSupported: false,
  }),
}));
vi.mock('../components/chat-dock/useChatDockActiveChatSync', () => ({
  useChatDockActiveChatSync: () => {},
}));
vi.mock('../components/chat/ShareIntakeController', () => ({
  ShareIntakeController: () => null,
}));
vi.mock('../workspace-panes/RegionPaneHost', () => ({
  RegionPaneHost: () => null,
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    telemetry: { track: () => {} },
    useAcknowledgeConversationMutation: () => ({ mutate: () => {} }),
    useEngineConnectionsQuery: () => ({ data: [] }),
    useConversationInventoryQuery: () => ({ data: [] }),
    useGenerateSessionSummaryMutation: () => ({ mutate: () => {} }),
    useInvalidateQuery: () => () => {},
    useOrchestrationSessionsQuery: () => ({
      data: [],
      status: 'success',
      refetch: () => {},
    }),
  };
});

function session(
  conversationOpenState?: ConversationOpenResolution,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id: 'chat-reset',
    agentSlug: 'station',
    agentName: 'Station',
    // An engine override: "Use Agent defaults" means changing the engine.
    executionAgentId: 'codex-proxy',
    conversationId: 'conversation-reset',
    currentSessionId: 'session-reset',
    status: 'idle',
    messages: [],
    input: '',
    inputHistory: [],
    attachments: [],
    queuedMessages: [],
    title: 'Reset',
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    hasUnread: false,
    ...(conversationOpenState ? { conversationOpenState } : {}),
    ...overrides,
  } as unknown as ChatSession;
}

function pane() {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <DockShell>
            {(shellChrome) => (
              <ChatWorkspacePane placement="dock" shellChrome={shellChrome} />
            )}
          </DockShell>
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>
  );
}

// Re-read through the holder's declared type: a reset narrows the field to
// `null`, but the mocked composer assigns it on every render.
const composerProps = () => (composer as { props: null | ComposerProps }).props;

async function renderPane(active: ChatSession) {
  viewSession.current = active;
  composer.props = null;
  const view = render(pane());
  await screen.findByTestId('chat-input-area');
  return { props: composerProps(), view };
}

beforeEach(() => {
  handleModelReset.mockClear();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
});

afterEach(() => {
  viewSession.current = null;
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', { dock: null, maximize: null });
});

/** The shape the open-conversation read returns for a resolved Session. */
function resolved(overrides: {
  canContinue: boolean;
  continuationPending?: boolean;
}): ConversationOpenResolution {
  return {
    status: 'resolved',
    conversation: {
      id: 'conversation-reset',
      source: 'runtime',
      agentSlug: 'station',
      title: 'Reset',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:01:00.000Z',
      messageCount: 2,
      mutable: overrides.canContinue,
      answerability: { answerable: true },
    },
    currentSessionId: 'session-reset',
    transcript: { available: true, owner: 'runtime', messageCount: 2 },
    answerability: { answerable: true },
    recoveryActions: [],
    ...overrides,
  } as unknown as ConversationOpenResolution;
}

const SERVER_REFUSAL = 'This conversation can’t change its engine right now.';

describe('ChatWorkspacePane engine-override reset gate', () => {
  test('a conversation this caller may change is offered the reset', async () => {
    const { props } = await renderPane(
      session(resolved({ canContinue: true })),
    );
    expect(props?.modelResetDisabledReason).toBeUndefined();
    expect(props?.modelResetOffered).toBe(true);
    props?.onModelReset();
    // An engine override resets through the engine change, never model-only.
    expect(handleModelReset).not.toHaveBeenCalled();
  });

  test('without an engine override the reset is the plain model reset', async () => {
    const { props } = await renderPane(
      session(resolved({ canContinue: true }), { executionAgentId: undefined }),
    );
    expect(props?.modelResetDisabledReason).toBeUndefined();
    props?.onModelReset();
    expect(handleModelReset).toHaveBeenCalledOnce();
  });

  test('its own running turn keeps the chip in place but unavailable', async () => {
    const { props } = await renderPane(
      session(resolved({ canContinue: true }), { status: 'sending' }),
    );
    expect(props?.modelResetOffered).toBe(true);
    expect(props?.modelResetDisabledReason).toBe(
      'Wait for the current turn to finish.',
    );
    props?.onModelReset();
    expect(handleModelReset).not.toHaveBeenCalled();
  });

  test.each([
    ['read-only', session(resolved({ canContinue: false }))],
    [
      'server-busy',
      session(resolved({ canContinue: false, continuationPending: true })),
    ],
    [
      'still-loading',
      session(resolved({ canContinue: true }), {
        conversationOpenPending: true,
      }),
    ],
    ['check-failed', session(undefined, { conversationOpenFailed: true })],
  ])(
    'a %s conversation offers no reset and never resets only the model',
    async (_label, active) => {
      const { props } = await renderPane(active);
      expect(props?.modelResetOffered).toBe(false);
      expect(props?.modelResetDisabledReason).toBe(SERVER_REFUSAL);
      props?.onModelReset();
      expect(handleModelReset).not.toHaveBeenCalled();
    },
  );

  test('the refusal clears once the conversation resolves as writable', async () => {
    const { view } = await renderPane(
      session(resolved({ canContinue: true }), {
        conversationOpenPending: true,
      }),
    );
    expect(composerProps()?.modelResetOffered).toBe(false);
    viewSession.current = session(resolved({ canContinue: true }));
    view.rerender(pane());
    await waitFor(() => expect(composerProps()?.modelResetOffered).toBe(true));
    expect(composerProps()?.modelResetDisabledReason).toBeUndefined();
  });
});
