/** @vitest-environment jsdom */

/**
 * The Agent-handoff and context-reset dialogs are ONE on-demand chunk
 * (`ConversationBoundaryDialogs`), and `ChatWorkspacePane` mounts it only
 * while `handoffSource` or `contextResetSource` is set. A dock with neither
 * — including one in the middle of a fork, which renders nothing here — must
 * not have that subtree in its tree at all; a dock with either must.
 *
 * Both directions run against the REAL guard, the REAL `LazyBoundary` and the
 * REAL hook: only the one source field under test is forced over the hook's
 * own result, so every hook in the pane still runs in its real order.
 *
 * Waiting, in both directions, is bounded real time rather than a microtask
 * chain, so a loader slower than a few microtasks cannot turn either
 * direction into a false green: the present cases poll for the marker until
 * it appears, and the absent cases poll for the same window and require that
 * it never does.
 *
 * What this does NOT prove: which chunk the code lands in. It would pass just
 * as well against a static import of the wrapper — that shape is exactly what
 * put the entry 66 bytes over its ceiling — and it is the entry-bundle
 * ceiling (`scripts/check-prepush-ui-bundle.mjs`) that proves the chunking.
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
 * The one boundary source a test forces over the REAL hook's result. `null`
 * leaves the hook untouched. Only the named field is replaced, so the pane's
 * hooks all still run — this drives the guard, not a stand-in for it.
 */
type BoundarySourceOverride =
  | { kind: 'fork'; value: { id: string; agentSlug: string } }
  | { kind: 'handoff'; value: { id: string; agentSlug: string } }
  | { kind: 'contextReset'; value: { id: string } };

const sourceOverride = vi.hoisted(() => ({
  value: null as BoundarySourceOverride | null,
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
        const override = sourceOverride.value;
        if (!override) return real;
        if (override.kind === 'fork')
          return {
            ...real,
            forkSource: {
              turnId: 'turn-1',
              idempotencyKey: 'fork-idem-1',
              ...override.value,
            },
          };
        if (override.kind === 'handoff')
          return { ...real, handoffSource: override.value };
        return { ...real, contextResetSource: override.value };
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
  sourceOverride.value = null;
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', { dock: null, maximize: null });
});

/**
 * How long a wrapper that IS mounted gets to resolve its chunk and paint.
 * The absent cases poll for the whole window and require the marker never to
 * appear, so a slower loader makes them stricter, never flakier.
 */
const RESOLVE_WINDOW_MS = 1_000;

function renderDockedChat() {
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
}

/** Load the chunk so the window below measures rendering, not the import. */
async function settleChunk() {
  await act(async () => {
    await import('../components/chat-dock/ConversationBoundaryDialogs');
  });
}

async function expectWrapperAbsent() {
  await settleChunk();
  await expect(
    screen.findByTestId(BOUNDARY_MARKER, undefined, {
      timeout: RESOLVE_WINDOW_MS,
    }),
  ).rejects.toThrow();
}

async function expectWrapperPresent() {
  await settleChunk();
  expect(
    await screen.findByTestId(BOUNDARY_MARKER, undefined, {
      timeout: RESOLVE_WINDOW_MS,
    }),
  ).not.toBeNull();
}

describe('conversation-boundary dialogs are on demand', () => {
  test('a dock with no fork, handoff or context reset never mounts them', async () => {
    renderDockedChat();
    await expectWrapperAbsent();
  });

  test('a fork in progress does not mount them either', async () => {
    sourceOverride.value = {
      kind: 'fork',
      value: { id: 'conversation-under-fork', agentSlug: 'codex' },
    };
    renderDockedChat();
    await expectWrapperAbsent();
  });

  test('a context reset in progress mounts them', async () => {
    sourceOverride.value = {
      kind: 'contextReset',
      value: { id: 'conversation-under-reset' },
    };
    renderDockedChat();
    await expectWrapperPresent();
  });

  test('a handoff in progress mounts them', async () => {
    sourceOverride.value = {
      kind: 'handoff',
      value: { id: 'conversation-under-handoff', agentSlug: 'codex' },
    };
    renderDockedChat();
    await expectWrapperPresent();
  });
});
