/** @vitest-environment jsdom */

/**
 * A reload restores the conversation `?chat=` names by hydrating it cold
 * (`useChatDockActiveChatSync`), and that hydration is not a reveal: the URL's
 * own `dock` and `maximize` stand.
 *
 * Found on Android (pane workspace native review): from a full-screen Chat, a
 * reload with a file preview open over it restored the preview, and leaving
 * it came back docked with `maximize` gone. After the reload Chat's pane
 * first mounts when the preview is left, the conversation has no hydrated tab
 * yet, and the cold open's reveal wrote `setDockState(true, false)`. A
 * desktop browser kept its locally hydrated tab and never took the cold path.
 *
 * This mounts the real `ChatWorkspacePane` with the real sync hook, the real
 * `useChatDockActions` and the real navigation store; only the network
 * lookup, the conversation fetch and contexts unrelated to dock state are
 * stubbed.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatWorkspacePane } from '../components/chat-dock/ChatDock';
import { DockShell } from '../components/chat-dock/DockShell';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';

const fetchConversationById = vi.hoisted(() => vi.fn());
const openConversationAction = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'test', name: 'Test Station' },
    captureCredentialEvidence: () => undefined,
  }),
}));

vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => vi.fn(),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));

vi.mock('../contexts/AgentsContext', () => {
  const agents = [{ slug: 'claude', name: 'Claude' }];
  return { useAgents: () => agents, useAgentsLoaded: () => true };
});

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

// The conversation fetch the cold open delegates to: it hands back the tab
// it created, which is all the dock-state decision after it depends on.
vi.mock('../hooks/useActiveChatSessions', () => ({
  useRehydrateSessions: () => () => {},
  useCancelMessage: () => vi.fn(),
  useCreateChatSession: () => vi.fn(),
  useOpenConversation: () => openConversationAction,
}));

vi.mock('../hooks/useActiveProject', () => ({
  useActiveProject: () => ({ projectSlug: undefined }),
}));

vi.mock('../hooks/useBackgroundTasks', () => ({
  useChatBackgroundTasksRunningCount: () => 0,
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

// No hydrated tab: the reload's state, which is what sends the sync cold.
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
    activeSession: null,
    activeChatAgent: undefined,
    activeChatModelLabel: undefined,
    activeSessionForHook: null,
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

vi.mock('../components/chat/ShareIntakeController', () => ({
  ShareIntakeController: () => null,
}));

// `ChatDock.tsx` pre-warms this chunk at module load; nothing here needs it.
vi.mock('../workspace-panes/RegionPaneHost', () => ({
  RegionPaneHost: () => null,
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    fetchConversationById: (...args: unknown[]) =>
      fetchConversationById(...args),
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

function params() {
  return new URLSearchParams(window.location.search);
}

beforeEach(() => {
  window.localStorage.clear();
  fetchConversationById.mockReset();
  openConversationAction.mockReset();
  fetchConversationById.mockResolvedValue({
    id: 'conversation-cold',
    agentSlug: 'claude',
    projectSlug: null,
  });
  openConversationAction.mockImplementation(
    async (
      _conversationId: string,
      _agentSlug: string,
      ..._rest: unknown[]
    ) => {
      const lifecycle = _rest[6] as
        | { initialized?: (id: string) => void }
        | undefined;
      lifecycle?.initialized?.('session-cold');
      return 'session-cold';
    },
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', { dock: null, maximize: null, chat: null });
});

function mountChat() {
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
}

describe('a cold conversation pointer hydrates without moving the dock', () => {
  test('a full-screen Chat stays full screen while its conversation hydrates', async () => {
    window.history.replaceState(
      {},
      '',
      '/?chat=conversation-cold&dock=open&maximize=true',
    );
    navigationStore.navigate('/', {
      chat: 'conversation-cold',
      dock: 'open',
      maximize: 'true',
    });

    mountChat();

    // The cold path has to have actually run, or the URL below would hold
    // its maximize for the wrong reason.
    await waitFor(() =>
      expect(openConversationAction).toHaveBeenCalledWith(
        'conversation-cold',
        'claude',
        'Claude',
        undefined,
        undefined,
        expect.anything(),
        undefined,
        undefined,
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'conversation-cold',
      ),
    );
    expect(params().get('dock')).toBe('open');
    expect(params().get('maximize')).toBe('true');
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
    expect(navigationStore.lastDockMaximized).toBe(true);
  });

  test('a closed dock stays closed while its conversation hydrates', async () => {
    window.history.replaceState({}, '', '/?chat=conversation-cold');
    navigationStore.navigate('/', {
      chat: 'conversation-cold',
      dock: null,
      maximize: null,
    });

    mountChat();

    await waitFor(() => expect(openConversationAction).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'conversation-cold',
      ),
    );
    expect(params().get('dock')).toBeNull();
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);
  });
});
