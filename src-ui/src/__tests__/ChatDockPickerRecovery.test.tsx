/** @vitest-environment jsdom */

/**
 * The picker path through the REAL chat dock: a conversation chosen from the
 * open-chats picker whose open read comes back unavailable renders the
 * recovery notice. Start new chat follows the server's per-caller answer on
 * that read (`callerAccess.startChat`), and a Retry that then fails keeps
 * that answer rather than offering the action again.
 *
 * Mounts the real `ChatWorkspacePane` (so the `ChatDock` line that hands the
 * recovery to `ConversationPickerRecovery`, and its `lastCallerAccess`
 * wiring, are both in the path), with the same context stubs as
 * `ChatDockColdChatHydration.test.tsx`; only the SDK open read is scripted.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatWorkspacePane } from '../components/chat-dock/ChatDock';
import { DockShell } from '../components/chat-dock/DockShell';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';

type RegisteredNavigation = {
  openConversation: (conversation: unknown) => Promise<boolean>;
};
const registeredNavigation = vi.hoisted(() => ({
  current: null as RegisteredNavigation | null,
}));
const resolveConversationOpen = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk/conversation-open', () => ({
  resolveConversationOpen: (...args: unknown[]) =>
    resolveConversationOpen(...args),
}));
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
  useProject: () => ({ project: undefined, isLoading: false }),
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
    registerNavigation: (navigation: unknown) => {
      registeredNavigation.current = navigation as RegisteredNavigation;
      return () => {};
    },
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
  useChatDockViewModel: () => {
    return {
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
    };
  },
}));

vi.mock('../components/chat/ShareIntakeController', () => ({
  ShareIntakeController: () => null,
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

const conversation = {
  id: 'conversation-picked',
  source: 'runtime',
  agentSlug: 'claude',
  title: 'Picked chat',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:01:00.000Z',
  messageCount: 2,
  mutable: false,
  answerability: { answerable: true },
};

function unavailable(callerAccess: { continue: boolean; startChat: boolean }) {
  return {
    status: 'unavailable',
    conversation,
    transcript: { available: false, owner: 'runtime' },
    canContinue: false,
    answerability: { answerable: true },
    recoveryActions: ['retry', 'start-new'],
    callerAccess,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  registeredNavigation.current = null;
  resolveConversationOpen.mockReset();
  navigationStore.navigate('/', { dock: 'open', maximize: null, chat: null });
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

async function pick(picked: { id: string } = conversation) {
  await waitFor(() => expect(registeredNavigation.current).not.toBeNull());
  await act(async () => {
    await registeredNavigation.current?.openConversation(picked);
  });
}

describe('ChatDock picker recovery follows the server on Start new chat', () => {
  test('a caller the server refused a new chat is not offered one, even after a failed Retry', async () => {
    resolveConversationOpen.mockResolvedValueOnce(
      unavailable({ continue: false, startChat: false }),
    );
    mountChat();
    await pick();

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByRole('button', { name: 'Start new chat' })).toBeNull();

    // The retry's read fails outright: it says nothing new about access.
    resolveConversationOpen.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() =>
      expect(resolveConversationOpen).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start new chat' })).toBeNull();
  });

  // The answer is per conversation: a refusal for one chat must not follow
  // the caller to a different chat whose own read failed.
  test("a failed read of another conversation does not inherit the first one's refusal", async () => {
    resolveConversationOpen.mockResolvedValueOnce(
      unavailable({ continue: false, startChat: false }),
    );
    mountChat();
    await pick();
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByRole('button', { name: 'Start new chat' })).toBeNull();

    resolveConversationOpen.mockRejectedValueOnce(new Error('offline'));
    await pick({
      ...conversation,
      id: 'conversation-other',
      title: 'Other chat',
    } as typeof conversation);
    await waitFor(() =>
      expect(resolveConversationOpen).toHaveBeenCalledTimes(2),
    );
    // Nothing is known about this caller here, so the action shows.
    expect(
      await screen.findByRole('button', { name: 'Start new chat' }),
    ).toBeTruthy();
  });

  test('a caller the server allows is offered Start new chat', async () => {
    resolveConversationOpen.mockResolvedValueOnce(
      unavailable({ continue: false, startChat: true }),
    );
    mountChat();
    await pick();

    expect(
      await screen.findByRole('button', { name: 'Start new chat' }),
    ).toBeTruthy();
  });
});
