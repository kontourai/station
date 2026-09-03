/** @vitest-environment jsdom */

/**
 * archive#4460: `ChatWorkspacePane`'s local `useDockShellChrome`
 * call (rules-of-hooks forces it to exist even when Chat is DOCKED and
 * `DockShell` already owns the real chrome) must never register
 * `dock.toggle`/`dock.maximize` itself — the shared shortcut registry keys
 * by id, so a second live registration silently REPLACES the first, and
 * after an occupant switch away and back the dead local closure can end up
 * owning the id instead of `DockShell`'s.
 *
 * This mounts the REAL `ChatWorkspacePane` (Chat's actual call site, not a
 * mocked `renderChatPane` or hand-built `ChatDockHeader` props) docked
 * inside a REAL `DockShell`, under a REAL `KeyboardShortcutsProvider` and
 * `NavigationProvider`, and drives `dock.maximize` through the registry
 * itself — the same channel the ⌘M shortcut and the header's Maximize
 * button both go through. Switching to a placeholder occupant and back
 * (`DockShell` stays mounted; only the leaf swaps, exactly like a real
 * ambient occupant switch) reproduces the mount timing the bug depends on.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatWorkspacePane } from '../../components/chat-dock/ChatDock';
import { DockShell } from '../../components/chat-dock/DockShell';
import {
  KeyboardShortcutsProvider,
  useShortcutRegistry,
} from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';

// --- Everything NOT under test: mocked to the lightest shape that lets the
// real ChatWorkspacePane mount without crashing. Navigation, device settings
// (a real store, no provider needed) and the keyboard-shortcut registry stay
// real — those are exactly what the shortcut registry exercises.

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));

vi.mock('../../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgentsLoaded: () => true,
}));

vi.mock('../../contexts/ConfigContext', () => ({
  useConfig: () => ({ defaultChatFontSize: 14, defaultModel: undefined }),
  CONFIG_DEFAULTS: { defaultChatFontSize: 14 },
}));

vi.mock('../../contexts/ModelsContext', () => ({
  useModelsCatalog: () => ({
    models: [],
    isLiveConfirmed: true,
    modelsLoading: false,
  }),
}));

vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [] }),
  useProject: () => undefined,
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../contexts/ActiveChatsContext', () => ({
  activeChatsStore: { getState: () => ({}), subscribe: () => () => {} },
  useActiveChatActions: () => ({
    initChat: vi.fn(),
    removeChat: vi.fn(),
    updateChat: vi.fn(),
    addEphemeralMessage: vi.fn(),
    clearEphemeralMessages: vi.fn(),
  }),
}));

vi.mock('../../contexts/open-chats-store', () => ({
  openChatsStore: {
    getState: () => ({}),
    subscribe: () => () => {},
    registerNavigation: () => () => {},
  },
  useOpenChats: () => [],
  countOpenChatAttention: () => 0,
}));

vi.mock('../../hooks/useActiveChatSessions', () => ({
  useRehydrateSessions: () => () => {},
  useCancelMessage: () => vi.fn(),
}));

vi.mock('../../hooks/useActiveProject', () => ({
  useActiveProject: () => ({ projectSlug: undefined }),
}));

vi.mock('../../hooks/useBackgroundTasks', () => ({
  useChatBackgroundTasksRunningCount: () => 0,
}));

vi.mock('../../hooks/useChatDockActions', () => ({
  useChatDockActions: () => ({}),
}));

vi.mock('../../hooks/useChatInput', () => ({
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

vi.mock('../../hooks/useDerivedSessions', () => ({
  useDerivedSessions: () => [],
}));

vi.mock('../../hooks/useExitTransition', () => ({
  useExitTransition: (open: boolean) => ({ mounted: open, exiting: false }),
}));

vi.mock('../../hooks/orchestration/ensureOrchestrationEventStream', () => ({
  ensureOrchestrationEventStream: () => {},
}));

vi.mock('../../components/chat-dock/useChatDockViewModel', () => ({
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

vi.mock('../../components/chat-dock/useChatDockActiveChatSync', () => ({
  useChatDockActiveChatSync: () => {},
}));

vi.mock('../../components/chat/ShareIntakeController', () => ({
  ShareIntakeController: () => null,
}));

// `ChatDock.tsx` pre-warms `AmbientChatDockPaneHost`'s lazy chunk at module
// load (`void loadAmbientChatDockPaneHost`), which this test never
// actually needs (it imports `DockShell` directly, not through the ambient
// host). Left real, that dynamic import cascades into `HomeWorkspacePane` /
// `HomeSurface` and can resolve AFTER this test file's environment tears
// down, throwing an unhandled rejection that Vitest warns can produce false
// positives elsewhere. Stubbed to a no-op component so the prewarm has
// nothing async to chase; `AmbientDockShellApi` (the only thing this test
// imports FROM that module) is a type-only import and is erased at runtime.
vi.mock('../../workspace-panes/AmbientChatDockPaneHost', () => ({
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

let registryApi: ReturnType<typeof useShortcutRegistry> | null = null;

function RegistryProbe() {
  registryApi = useShortcutRegistry();
  return null;
}

function readDockHeightPx(): number {
  const el = document.querySelector('.chat-dock') as HTMLElement | null;
  const height = el?.style.height ?? '';
  const match = /^(\d+(?:\.\d+)?)px$/.exec(height);
  return match ? Number(match[1]) : Number.NaN;
}

function isMaximizedInDom(): boolean {
  return document.querySelector('.chat-dock.is-maximized') !== null;
}

/**
 * `DockShell` stays mounted across `occupant` changes (its React position
 * never moves) while its leaf swaps — the same shape a real occupant switch
 * has (`AmbientChatDockPaneHost` mounts `DockShell` once; `WorkspacePaneHost`
 * swaps which occupant renders inside it). A placeholder div stands in for
 * Home/Activity: this test is only proving Chat's OWN local instance stays
 * silent, which does not require the real Home/Activity stack.
 */
function DockedFixture({ occupant }: { occupant: 'chat' | 'other' }) {
  return (
    <DockShell>
      {(shellChrome) =>
        occupant === 'chat' ? (
          <ChatWorkspacePane
            placement="dock"
            shellChrome={{
              ...shellChrome,
              dockPane: () => {},
              dockPaneAsOnlyContent: () => {},
              occupantPicker: null,
            }}
          />
        ) : (
          <div data-testid="other-occupant" />
        )
      }
    </DockShell>
  );
}

let sharedQueryClient: QueryClient | null = null;

function renderFixture() {
  sharedQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // `rerenderWithOccupant` below re-renders this SAME tree shape (same
  // `QueryClient` instance) with a different `occupant` prop, so
  // `KeyboardShortcutsProvider` / `NavigationProvider` / `DockShell` all keep
  // their React identity across the swap — only `DockedFixture`'s leaf
  // changes.
  return render(
    <QueryClientProvider client={sharedQueryClient}>
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <RegistryProbe />
          <DockedFixture occupant="chat" />
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', { dock: null, maximize: null });
  registryApi = null;
});

function rerenderWithOccupant(
  rerender: (ui: ReactElement) => void,
  occupant: 'chat' | 'other',
) {
  rerender(
    <QueryClientProvider client={sharedQueryClient!}>
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <RegistryProbe />
          <DockedFixture occupant={occupant} />
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

describe('dock.maximize registration with Chat docked (station#4460 H1/H2)', () => {
  test('DockShell owns maximize but no longer registers the app-toolbar region toggle', async () => {
    renderFixture();
    await waitFor(() => {
      expect(document.querySelector('.chat-dock')).not.toBeNull();
    });

    const shortcuts = registryApi?.getAllShortcuts() ?? [];
    const maximizeEntries = shortcuts.filter((s) => s.id === 'dock.maximize');
    const toggleEntries = shortcuts.filter((s) => s.id === 'dock.toggle');
    // The registry map is keyed by id (one entry can only ever exist), so
    // this cannot itself catch "a second live registration silently
    // replaced the first" — the round-trip test below does. This asserts
    // the weaker, still-necessary fact: the registration exists at all.
    expect(maximizeEntries.length).toBe(1);
    expect(toggleEntries.length).toBe(0);
  });

  test('a maximize -> restore round trip through the registry survives a switch to Home and back', async () => {
    const { rerender } = renderFixture();
    await waitFor(() => {
      expect(document.querySelector('.chat-dock')).not.toBeNull();
    });

    const originalHeight = readDockHeightPx();
    expect(Number.isNaN(originalHeight)).toBe(false);

    const maximizeEntry = () =>
      registryApi?.getAllShortcuts().find((s) => s.id === 'dock.maximize');

    act(() => {
      maximizeEntry()?.handler();
    });
    await waitFor(() => expect(isMaximizedInDom()).toBe(true));

    // Switch to a placeholder occupant (Chat's local `useDockShellChrome`
    // instance unmounts, its registration cleanup runs) and back (a FRESH
    // local instance mounts) — `DockShell` never unmounts.
    rerenderWithOccupant(rerender, 'other');
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="other-occupant"]'),
      ).not.toBeNull();
    });
    rerenderWithOccupant(rerender, 'chat');
    await waitFor(() => {
      expect(document.querySelector('.chat-dock')).not.toBeNull();
    });

    act(() => {
      maximizeEntry()?.handler();
    });
    await waitFor(() => expect(isMaximizedInDom()).toBe(false));

    const restoredHeight = readDockHeightPx();
    expect(
      restoredHeight,
      `restore must return to the pre-maximize height (${originalHeight}px), not stay stuck at the maximized height or NaN — the station#4460 H1 concrete failure ("content squeezed to nothing")`,
    ).toBe(originalHeight);
  });
});
