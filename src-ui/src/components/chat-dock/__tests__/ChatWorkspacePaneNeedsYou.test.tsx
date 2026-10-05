/** @vitest-environment jsdom */

/**
 * #3046 round: the full-screen Chat publishes how many conversations need
 * the reader — the inbox's own "Needs you" lane, from the same partition the
 * inbox panel renders — so a host that folds the inbox can still say that
 * something is waiting. The REAL `ChatWorkspacePane` and its derivation,
 * with the dock's providers; only transport and the session list are mocked.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { ActiveChatsProvider } from '../../../contexts/ActiveChatsContext';
import { ConversationsProvider } from '../../../contexts/ConversationsContext';
import { KeyboardShortcutsProvider } from '../../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../../contexts/NavigationContext';
import { navigationStore } from '../../../contexts/navigation-store';
import { RegionModelProvider } from '../../../contexts/RegionModelContext';
import { ToastProvider } from '../../../contexts/ToastContext';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import { clearSnooze, writeSnooze } from '../../../utils/activity-snooze-store';

const { createChatSession, sendMessage, updateChat, pickerProps, dockProbe } =
  vi.hoisted(() => ({
    createChatSession: vi.fn(() => 'new-session'),
    sendMessage: vi.fn(),
    updateChat: vi.fn(),
    pickerProps: [] as Record<string, any>[],
    dockProbe: {
      mobile: false,
      sessions: [] as Record<string, any>[],
      agents: [{ slug: 'assistant', name: 'Assistant' }],
    },
  }));

const projects = [
  { slug: 'pulse', name: 'Pulse', workingDirectory: '/work/pulse' },
  { slug: 'other', name: 'Other', workingDirectory: '/work/other' },
];

// Honours the Agent argument the way the real hook does, so a pane that
// passed a route-selected Agent would lose other Agents' chats.
vi.mock('../../../hooks/useDerivedSessions', () => ({
  useDerivedSessions: (_apiBase: string, agentSlug: string | null) =>
    agentSlug
      ? dockProbe.sessions.filter((session) => session.agentSlug === agentSlug)
      : dockProbe.sessions,
}));
vi.mock('../../../hooks/useDockShellChrome', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../hooks/useDockShellChrome')>();
  return {
    ...actual,
    useDockShellChrome: (
      ...args: Parameters<typeof actual.useDockShellChrome>
    ) => ({
      ...actual.useDockShellChrome(...args),
      isMobile: dockProbe.mobile,
    }),
  };
});
vi.mock('../ChatDockMobileHeader', () => ({
  ChatDockMobileHeader: ({
    activeCount,
    projectSwitcher,
  }: {
    activeCount: number;
    projectSwitcher?: { projectName: string };
  }) => (
    <>
      <div data-testid="mobile-dock-work-badge">{activeCount}</div>
      <div data-testid="mobile-dock-project-name">
        {projectSwitcher?.projectName}
      </div>
    </>
  ),
}));

vi.mock('../../modals/NewChatModal', () => ({
  NewChatModal: (props: Record<string, any>) => {
    pickerProps.push(props);
    return <div role="dialog" aria-label="New chat picker" />;
  },
}));
vi.mock('../../../hooks/useActiveChatSessions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCreateChatSession: () => createChatSession,
  useSendMessage: () => sendMessage,
  useCancelMessage: () => vi.fn(),
  useRehydrateSessions: () => vi.fn(),
  useOpenConversation: () => vi.fn(),
}));
vi.mock('../../../contexts/ActiveChatsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useActiveChatActions: () => ({
    updateChat,
    removeChat: vi.fn(),
    initChat: vi.fn(),
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../../../contexts/ProjectsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjects: () => ({
    projects,
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: (slug: string) => ({
    project: projects.find((project) => project.slug === slug),
    isLoading: false,
  }),
}));
vi.mock('../../../contexts/AgentsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgents: () => dockProbe.agents,
  useAgentsLoaded: () => true,
}));

// The active chat's transcript and composer are stood in for: the file-drop
// test asks only which pane owns attachments, and the marker shows a chat is
// active.
vi.mock('../ChatDockBody', () => ({
  ChatDockBody: () => <div data-testid="active-chat-body" />,
}));

// A chat's own Project facts: its layouts and the git state of its directory.
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjectLayoutsQuery: (projectSlug: string) => ({
    data:
      projectSlug === 'other'
        ? [{ slug: 'other-code', name: 'Code', type: 'coding' }]
        : [],
  }),
  useGitStatusQuery: (location: { workingDir?: string } | null) => ({
    data:
      location?.workingDir === '/work/other'
        ? { isRepo: true, branch: 'other-branch', changes: [] }
        : null,
  }),
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useConnections: () => ({ captureCredentialEvidence: () => null }),
}));

const { ChatWorkspacePane } = await import('../ChatDock');
const { activeChatsStore } = await import(
  '../../../contexts/active-chats-store'
);

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ success: true, data: [] })),
  );
});

afterEach(() => {
  cleanup();
  pickerProps.length = 0;
  createChatSession.mockClear();
  sendMessage.mockClear();
  updateChat.mockClear();
  dockProbe.mobile = false;
  dockProbe.sessions = [];
  dockProbe.agents = [{ slug: 'assistant', name: 'Assistant' }];
  deviceSettingsStore.reset('chatDockProjectSlug');
  navigationStore.navigate('/', { chat: null, dock: null });
});

function renderInProviders(pane: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <ToastProvider>
            <ConversationsProvider>
              <ActiveChatsProvider>
                <RegionModelProvider>{pane}</RegionModelProvider>
              </ActiveChatsProvider>
            </ConversationsProvider>
          </ToastProvider>
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

function session(overrides: Record<string, unknown>) {
  return {
    id: 'chat',
    agentSlug: 'assistant',
    agentName: 'Assistant',
    title: 'A chat',
    projectSlug: 'pulse',
    status: 'idle',
    source: 'manual',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    messages: [],
    orchestrationSessionStarted: true,
    ...overrides,
  };
}

test('publishes the inbox’s Needs-you count from its own lane: an approval owed is one, none owed is none', async () => {
  // The inbox's items are the open chats (`openChatsStore` over the active
  // chats store): an approval owed on one of them is the "Needs you" lane.
  for (const [id, title] of [
    ['idle-chat', 'Idle'],
    ['owed', 'Waiting on you'],
  ] as const) {
    activeChatsStore.initChat(id, {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title,
      conversationId: `conv-${id}`,
      projectSlug: 'pulse',
      projectName: 'Pulse',
    });
  }
  activeChatsStore.updateChat('owed', {
    orchestrationStatus: 'awaiting-approval',
  });
  dockProbe.sessions = [
    session({ id: 'idle-chat', title: 'Idle' }),
    session({ id: 'owed', title: 'Waiting on you' }),
  ];
  const onInboxNeedsYouChange = vi.fn();
  renderInProviders(
    <ChatWorkspacePane
      placement="fullscreen"
      projectSlug="pulse"
      layoutSlug="coding"
      onInboxNeedsYouChange={onInboxNeedsYouChange}
    />,
  );
  await act(async () => undefined);
  expect(onInboxNeedsYouChange).toHaveBeenLastCalledWith(1);

  // The approval answered: the lane empties and the count follows it.
  act(() => {
    activeChatsStore.updateChat('owed', { orchestrationStatus: 'idle' });
  });
  await act(async () => undefined);
  expect(onInboxNeedsYouChange).toHaveBeenLastCalledWith(0);
  activeChatsStore.removeChat('idle-chat');
  activeChatsStore.removeChat('owed');
});

/**
 * The bar's inbox toggle is the one keyboard and screen-reader control for a
 * hidden inbox, so it names what the inbox holds for you — from the same
 * live groups the inbox panel renders (`useInboxGroups`), so a snooze written
 * while the inbox is hidden takes the row out of the count at once.
 */
test('a hidden inbox’s toggle says how many need you, and a snooze takes the row out of that count at once', async () => {
  for (const [id, title] of [
    ['idle-chat', 'Idle'],
    ['owed', 'Waiting on you'],
  ] as const) {
    activeChatsStore.initChat(id, {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title,
      conversationId: `conv-${id}`,
      projectSlug: 'pulse',
      projectName: 'Pulse',
    });
  }
  activeChatsStore.updateChat('owed', {
    orchestrationStatus: 'awaiting-approval',
  });
  dockProbe.sessions = [
    session({ id: 'idle-chat', title: 'Idle' }),
    session({ id: 'owed', title: 'Waiting on you' }),
  ];
  deviceSettingsStore.set('inboxOpen', false);
  try {
    renderInProviders(
      <ChatWorkspacePane
        placement="fullscreen"
        projectSlug="pulse"
        layoutSlug="coding"
      />,
    );
    const toggle = await screen.findByRole(
      'button',
      { name: 'Show inbox, 1 needs you' },
      { timeout: 15_000 },
    );
    expect(toggle.getAttribute('title')).toBe('Show inbox, 1 needs you');

    // The panel's snooze writes this store; the toggle reads the same live
    // groups, so the count drops without waiting for the item list to move.
    act(() => {
      writeSnooze('conv-owed', Date.now() + 60 * 60_000, Date.now());
    });
    expect(
      await screen.findByRole('button', { name: 'Show inbox' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Show inbox, / })).toBeNull();
  } finally {
    clearSnooze('conv-owed', Date.now());
    deviceSettingsStore.reset('inboxOpen');
    activeChatsStore.removeChat('idle-chat');
    activeChatsStore.removeChat('owed');
  }
});
