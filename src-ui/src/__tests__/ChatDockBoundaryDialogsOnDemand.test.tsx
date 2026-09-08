/** @vitest-environment jsdom */

/**
 * The Agent-handoff and context-reset dialogs are ONE on-demand chunk
 * (`ConversationBoundaryDialogs`), and `ChatWorkspacePane` mounts it only
 * while `handoffSource` or `contextResetSource` is set. A dock with neither
 * — including one in the middle of a fork, which renders nothing here — must
 * not have that subtree in its tree at all.
 *
 * What this proves and what it does not. It asserts the ABSENCE direction
 * only, after a full flush of the lazy import and its Suspense resolution, so
 * "not yet loaded" cannot pass for "not mounted". It says nothing about which
 * chunk the code lands in: it would pass just as well against a static import
 * of the wrapper, and it is the entry-bundle ceiling
 * (`scripts/check-prepush-ui-bundle.mjs`) that proves the chunking. The
 * present direction — a set source renders its dialog — is unchanged JSX and
 * is not exercised here; no test in this repo drives the dock that far.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatWorkspacePane } from '../components/chat-dock/ChatDock';
import { DockShell } from '../components/chat-dock/DockShell';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';

const BOUNDARY_MARKER = 'boundary-dialogs-chunk';

// Stands in for the real chunk so its presence in the tree is observable
// without mounting two dialogs' worth of graph. Mocking it does not weaken the
// assertion: the subject is whether the dock RENDERS this subtree, not what
// the subtree draws.
vi.mock('../components/chat-dock/ConversationBoundaryDialogs', () => ({
  ConversationBoundaryDialogs: () => <div data-testid={BOUNDARY_MARKER} />,
}));

/**
 * A fork in progress, injected over the REAL hook's result so every hook in
 * the pane still runs in its real order and only the one field under test is
 * forced. `null` leaves the hook untouched.
 */
const forkOverride = vi.hoisted(() => ({
  value: null as { id: string; agentSlug: string } | null,
}));

vi.mock(
  '../components/chat-dock/useConversationBoundaryDialogs',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../components/chat-dock/useConversationBoundaryDialogs')
      >();
    return {
      ...actual,
      useConversationBoundaryDialogs: (
        args: Parameters<typeof actual.useConversationBoundaryDialogs>[0],
      ) => {
        const real = actual.useConversationBoundaryDialogs(args);
        return forkOverride.value
          ? {
              ...real,
              forkSource: {
                turnId: 'turn-1',
                idempotencyKey: 'fork-idem-1',
                ...forkOverride.value,
              },
            }
          : real;
      },
    };
  },
);

// --- Everything NOT under test: mocked to the lightest shape that lets the
// real ChatWorkspacePane mount without crashing. Navigation, device settings
// (a real store, no provider needed) and the keyboard-shortcut registry stay
// real — those are exactly what the shortcut registry exercises.

// `RegionModelProvider` wraps the whole application, so `useShowSurface`
// requires it. This harness mounts a fragment of that tree, and nothing
// here asserts a surface reveal, so the command hook is supplied directly.
const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
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
  useProject: () => undefined,
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../contexts/ActiveChatsContext', () => ({
  activeChatsStore: { getState: () => ({}), subscribe: () => () => {} },
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

vi.mock('../components/chat-dock/useChatDockActiveChatSync', () => ({
  useChatDockActiveChatSync: () => {},
}));

vi.mock('../components/chat/ShareIntakeController', () => ({
  ShareIntakeController: () => null,
}));

// `ChatDock.tsx` pre-warms `AmbientChatDockPaneHost`'s lazy chunk at module
// load (`void loadAmbientChatDockPaneHost`), which this test never
// actually needs (it imports `DockShell` directly, not through the ambient
// host). Left real, that dynamic import cascades into `HomeWorkspacePane` /
// `HomeSurface` and can resolve AFTER this test file's environment tears
// down, throwing an unhandled rejection that Vitest warns can produce false
// positives elsewhere. Stubbed to a no-op component so the prewarm has
// nothing async to chase.
vi.mock('../workspace-panes/AmbientChatDockPaneHost', () => ({
  AmbientChatDockPaneHost: () => null,
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

function DockedChat() {
  return (
    <DockShell>
      {(shellChrome) => (
        <ChatWorkspacePane placement="dock" shellChrome={shellChrome} />
      )}
    </DockShell>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
});

afterEach(() => {
  forkOverride.value = null;
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', { dock: null, maximize: null });
});

describe('conversation-boundary dialogs are on demand', () => {
  test('a dock with no fork, handoff or context reset never mounts them', async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <KeyboardShortcutsProvider>
          <NavigationProvider>
            <DockedChat />
          </NavigationProvider>
        </KeyboardShortcutsProvider>
      </QueryClientProvider>,
    );

    expect(document.querySelector('.chat-dock')).not.toBeNull();

    // Resolve the chunk and flush: a wrapper mounted at dock mount would have
    // finished its lazy import and painted by now, so absence after this is
    // absence of the mount, not of the load.
    await act(async () => {
      await import('../components/chat-dock/ConversationBoundaryDialogs');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId(BOUNDARY_MARKER)).toBeNull();
  });

  test('a fork in progress does not mount them either', async () => {
    forkOverride.value = { id: 'conversation-under-fork', agentSlug: 'codex' };

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <KeyboardShortcutsProvider>
          <NavigationProvider>
            <DockedChat />
          </NavigationProvider>
        </KeyboardShortcutsProvider>
      </QueryClientProvider>,
    );

    expect(document.querySelector('.chat-dock')).not.toBeNull();

    await act(async () => {
      await import('../components/chat-dock/ConversationBoundaryDialogs');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId(BOUNDARY_MARKER)).toBeNull();
  });
});
