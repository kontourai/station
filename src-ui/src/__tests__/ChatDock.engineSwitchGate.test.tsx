/** @vitest-environment jsdom */

/**
 * The engine switch ("Change engine for this conversation") is offered only
 * when the server's open resolution lets this caller change the
 * conversation. `ChatWorkspacePane` owns that gate: it hands the content
 * area `onExecutionModelSelect` only while `conversationCanMutate` holds, the
 * same gate that offers the composer menu's Agent change. Without the
 * callback the picker lists no engine switch (ChatDockBody, covered in
 * `ChatDockBody.engineSwitchEntry.test.tsx`).
 *
 * The REAL pane and the REAL boundary-dialog hook run; only the content area
 * is replaced so the prop it receives is observable, and the view model is
 * fixed to one active conversation whose open resolution the test chooses.
 */

import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatWorkspacePane } from '../components/chat-dock/ChatDock';
import { DockShell } from '../components/chat-dock/DockShell';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';
import type { ChatSession } from '../types';

const contentArea = vi.hoisted(() => ({
  props: null as null | { onExecutionModelSelect?: unknown },
}));
const viewSession = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../components/chat-dock/ChatDockContentArea', () => ({
  ChatDockContentArea: (props: { onExecutionModelSelect?: unknown }) => {
    contentArea.props = props;
    return <div data-testid="content-area" />;
  },
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
): ChatSession {
  return {
    id: 'chat-gate',
    agentSlug: 'station',
    agentName: 'Station',
    conversationId: 'conversation-gate',
    currentSessionId: 'session-gate',
    status: 'idle',
    messages: [],
    input: '',
    inputHistory: [],
    attachments: [],
    queuedMessages: [],
    title: 'Gate',
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    hasUnread: false,
    ...(conversationOpenState ? { conversationOpenState } : {}),
  } as unknown as ChatSession;
}

async function renderPane(active: ChatSession) {
  viewSession.current = active;
  contentArea.props = null;
  render(
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
    </QueryClientProvider>,
  );
  await screen.findByTestId('content-area');
  // Re-read through the holder's declared type: the reset above narrowed the
  // field to `null`, but the mocked area has assigned it since.
  return (contentArea as { props: null | { onExecutionModelSelect?: unknown } })
    .props;
}

beforeEach(() => {
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

describe('ChatWorkspacePane engine-switch gate', () => {
  test('a conversation this caller may change is offered the engine switch', async () => {
    const props = await renderPane(session());
    expect(typeof props?.onExecutionModelSelect).toBe('function');
  });

  test('a conversation the server resolved as not continuable offers none', async () => {
    const props = await renderPane(
      session({
        status: 'resolved',
        canContinue: false,
      } as ConversationOpenResolution),
    );
    expect(props).not.toBeNull();
    expect(props?.onExecutionModelSelect).toBeUndefined();
  });
});
