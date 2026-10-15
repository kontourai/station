// @vitest-environment jsdom

import { ORCHESTRATION_STREAM_CAUGHT_UP_EVENT } from '@kontourai/station-contracts/runtime-events';

/**
 * #3077: one chat, two inboxes, one status line.
 *
 * The sidebar's Open-chats mini-inbox and the dock inbox both render the
 * shared row, but a row only says what its ITEM says, and the sidebar used
 * to build its own item from the chat store (`useOpenChats` alone) while the
 * dock merged the chat with its server session. For a chat whose session
 * awaits an approval that read "Needs approval" in the dock and "Idle" in
 * the sidebar at the same moment (the `overlay-dock-project-mismatch`
 * gallery screen caught it). Both surfaces now read the one derivation
 * (`useInboxWorkItems`); this renders both from one store state and one
 * real-fold session and requires the same words.
 *
 * The sidebar is the real `ProjectSidebar` (its mocks mirror
 * `ProjectSidebar.test.tsx`, minus the open-chats mock: the store and the
 * derivation are real here). The dock side is `ChatDockInboxPanel` fed by
 * the same hook and facts `ChatDock.tsx` hands it; `ChatDock` itself is too
 * large to mount here, so its three-line wiring to the hook is the one
 * thing this file takes on trust.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  ConversationListItem,
  OrchestrationConversationEventWindow,
} from '@kontourai/station-contracts/orchestration';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createRef, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLD_FIXTURES,
  FOLD_SESSION_CREATED_AT,
} from '../../../tests/helpers/session-summary-fold-fixtures';
import type { AgentSummary } from '../types';

const NOW = Date.parse('2026-09-30T10:01:15.000Z');
const CHAT_TAB = 'tab-1';
const AGENTS: AgentSummary[] = [
  { slug: agentId('demo-agent'), name: 'Demo agent' },
];
/** The row's accessible name: its title and its project. The chat is bound
 *  to Project B and the session reports no slug, so the merge must name the
 *  chat's project, not the session side's "No project" fallback. */
const ROW_NAME = 'Mismatch demo chat, Project B';

/** The server's own fold of a turn that opened an approval (#3042). */
const SESSIONS: OrchestrationSessionSummary[] = [
  {
    provider: 'claude',
    threadId: 'T',
    status: 'running',
    createdAt: FOLD_SESSION_CREATED_AT,
    updatedAt: '2026-09-30T10:00:05.000Z',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 3,
    assignedAgentSlug: agentId('demo-agent'),
    ...FOLD_FIXTURES.approvalInOpenTurn.summary,
  },
];

const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
  useShowSurfacePage: () => showSurfaceStub,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => null,
}));
vi.mock('../build-info', () => ({
  buildInfo: { version: '0.1.2', commit: 'test' },
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [], isLoading: false }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => AGENTS,
}));
vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({
    selectedProject: null,
    selectedProjectLayout: null,
    navigate: vi.fn(),
    setProject: vi.fn(),
    setLayout: vi.fn(),
    pathname: '/',
  });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});
vi.mock('../hooks/useBranding', () => ({
  useBranding: () => ({ appName: 'Station' }),
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({
    isTauri: false,
    productName: undefined,
    channel: undefined,
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../hooks/useIsMobile', async (importActual) => ({
  ...(await importActual<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => false,
}));
// The sessions the sidebar reads, and the sidebar footer's and Boards
// section's reads, answered the way `ProjectSidebar.test.tsx` answers them.
const historyRead = vi.hoisted(() => vi.fn());
const openRead = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk/conversation-open', () => ({
  resolveConversationOpen: openRead,
}));
const streams = vi.hoisted(
  () =>
    new Map<
      string,
      (raw: { event: string; data: string; id?: string }) => void
    >(),
);
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  fetchSessionEventWindowCapability: async () => true,
  fetchOrchestrationConversationEventWindow: (...args: unknown[]) =>
    historyRead(...args),
  fetchSSE: (
    url: string,
    options: {
      onMessage: (raw: { event: string; data: string; id?: string }) => void;
    },
  ) => {
    streams.set(new URL(url).origin, options.onMessage);
    const controller = new AbortController();
    return {
      close: () => controller.abort(),
      signal: controller.signal,
      completed: new Promise<void>(() => {}),
      retry: vi.fn(),
    };
  },
  useOrchestrationSessionsQuery: () => ({ data: SESSIONS }),
  useProjectLayoutsQuery: () => ({ data: [] }),
  useReorderProjectsMutation: () => ({ mutate: vi.fn() }),
  useFeaturePreviewsQuery: () => ({ data: [] }),
  useBoardAvailabilityQuery: () => ({ data: undefined }),
  useAttentionQuery: () => ({ data: { pendingCount: 0 } }),
  usePersonalLayoutsQuery: () => ({ data: [] }),
  useCreatePersonalLayoutMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdatePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  useDeletePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  usePromotePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
}));

import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { ConversationOpenRevalidator } from '../components/chat-dock/ConversationOpenRevalidator';
import { MobileTaskSwitcher } from '../components/chat-dock/MobileTaskSwitcher';
import { ProjectSidebar } from '../components/project-sidebar/ProjectSidebar';
import { activeChatsStore } from '../contexts/active-chats-store';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { workObservation } from '../contexts/work-observation';
import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';
import { useSessionEventWindow } from '../hooks/orchestration/useSessionEventWindow';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { useInboxWorkItems } from '../views/home/useInboxWorkItems';
import { useWorkFacts } from '../views/home/useWorkFacts';

/** The dock inbox the way `ChatDock.tsx` mounts it: the shared items and
 *  the facts derived beside them. */
function DockInbox({
  sessions = SESSIONS,
}: {
  sessions?: OrchestrationSessionSummary[];
}) {
  const items = useInboxWorkItems(AGENTS, sessions);
  const workFacts = useWorkFacts(items, sessions);
  return (
    <ChatDockInboxPanel
      items={items}
      workFacts={workFacts}
      activeChatSessionId={null}
      openChatSessionIds={[CHAT_TAB]}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      onOpenHistory={vi.fn()}
      now={NOW}
    />
  );
}

/** The mobile task switcher the way `ChatDock.tsx` mounts it: the same
 *  items and facts as the dock panel. It portals its sheet, so its rows are
 *  found on the document rather than in a container. */
function MobileSwitcher() {
  const items = useInboxWorkItems(AGENTS, SESSIONS);
  const workFacts = useWorkFacts(items, SESSIONS);
  return (
    <MobileTaskSwitcher
      open
      tasks={items}
      workFacts={workFacts}
      activeChatSessionId={null}
      openChatSessionIds={[CHAT_TAB]}
      visualViewportStyle={{}}
      triggerRef={createRef<HTMLButtonElement>()}
      onClose={vi.fn()}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      now={NOW}
    />
  );
}

function renderWithProviders(
  ui: ReactElement,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <KeyboardShortcutsProvider>{ui}</KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

/** The status line as drawn, without screen-reader-only text. */
function statusTextIn(root: HTMLElement): string {
  const clone = within(root)
    .getByTestId('inbox-row-status')
    .cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('.sr-only')) hidden.remove();
  return clone.textContent ?? '';
}

beforeEach(() => {
  historyRead.mockReset();
  openRead.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  // ONE store state: the chat this tab holds open, on the folded session's
  // conversation. On its own the chat store says nothing about the open
  // approval; only the session does.
  activeChatsStore.clearConversationActivity();
  activeChatsStore.initChat(CHAT_TAB, {
    agentSlug: 'demo-agent',
    agentName: 'Demo agent',
    title: 'Mismatch demo chat',
    conversationId: 'T',
    currentSessionId: 'T',
    projectSlug: 'project-b',
    projectName: 'Project B',
  });
});

afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(CHAT_TAB);
  vi.useRealTimers();
});

describe('a chat open in this tab reads the same status in the sidebar and the dock', () => {
  it('both say "Needs approval" for a session awaiting one', async () => {
    const sidebar = renderWithProviders(<ProjectSidebar />);
    const sidebarRow = await within(sidebar.container).findByRole('button', {
      name: ROW_NAME,
    });
    const sidebarSection = sidebarRow.closest(
      '#sidebar-open-chats',
    ) as HTMLElement;
    expect(sidebarSection).not.toBeNull();

    const dock = renderWithProviders(<DockInbox />);
    const dockRow = await within(dock.container).findByRole('button', {
      name: ROW_NAME,
    });

    const sidebarStatus = statusTextIn(sidebarSection);
    const dockStatus = statusTextIn(dock.container);
    // Pinned to the word, not only to each other: two surfaces agreeing on
    // "Idle" for a session that awaits an approval would still be wrong.
    expect(dockStatus).toBe('Needs approval');
    expect(sidebarStatus).toBe(dockStatus);
    // The lane they file it in agrees.
    expect(within(sidebarSection).getByTestId('inbox-row').dataset.lane).toBe(
      'needsYou',
    );
    expect(within(dock.container).getByTestId('inbox-row').dataset.lane).toBe(
      'needsYou',
    );
    // And it is the same item: the accessible name (title and project) too.
    expect(dockRow.getAttribute('aria-label')).toBe(ROW_NAME);
    expect(sidebarRow.getAttribute('aria-label')).toBe(ROW_NAME);
    expect(
      within(dock.container).getByText('Project B', {
        selector: '.inbox-row__project',
      }),
    ).toBeTruthy();
  });

  it('the mobile task switcher shows the same row', async () => {
    renderWithProviders(<MobileSwitcher />);
    const row = await screen.findByRole('button', { name: ROW_NAME });
    const sheet = row.closest('[data-testid="inbox-row"]') as HTMLElement;
    expect(within(sheet).getByText('Needs approval')).toBeTruthy();
    expect(sheet.dataset.lane).toBe('needsYou');
  });

  it('the sidebar row is the dock item for that chat, not a second derivation', () => {
    // The merged item carries the session it was merged with; a chat-only
    // item carries none. Both surfaces read this one.
    let items: ReturnType<typeof useInboxWorkItems> = [];
    function Probe() {
      items = useInboxWorkItems(AGENTS, SESSIONS);
      return null;
    }
    render(<Probe />);
    const row = items.find((item) => item.chatSessionId === CHAT_TAB);
    expect(row).toMatchObject({
      id: 'T',
      kind: 'chat',
      lifecycleLabel: 'Needs attention',
      orchestrationThreadId: 'T',
    });
    // Every open chat has its one item here; nothing is invented for it.
    expect(
      items.filter((item) => item.chatSessionId === CHAT_TAB),
    ).toHaveLength(1);
  });
});

function HistoryReader({
  station = 'http://test.local',
  conversation = 'T',
}: {
  station?: string;
  conversation?: string;
}) {
  const history = useSessionEventWindow(station, conversation);
  return (
    <button type="button" onClick={() => void history.reload()}>
      Read history
    </button>
  );
}

const historyPage = {
  protocolVersion: 1,
  conversationId: 'T',
  currentSessionId: 'T',
  session: SESSIONS[0]!,
  events: [],
  hasMore: false,
  watermark: 3,
  handoffs: [],
  contextBoundaries: [],
} satisfies OrchestrationConversationEventWindow;

// These assertions cross the failed reader, shared items, and actual row renderer.
describe('inbox observation freshness', () => {
  it('a failed history read marks dock and sidebar rows last known, and a successful read restores them', async () => {
    historyRead
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(historyPage);
    renderWithProviders(
      <>
        <HistoryReader />
        <ProjectSidebar />
        <DockInbox />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByText('Last known: Needs approval')).toHaveLength(2),
    );
    for (const row of screen.getAllByTestId('inbox-row-status')) {
      const tone =
        row.getAttribute('data-tone') ??
        row.parentElement?.getAttribute('data-tone');
      expect(tone).toBe('neutral');
      expect(row.querySelector('.inbox-row__elapsed')).toBeNull();
    }
    await act(async () => screen.getByText('Read history').click());
    await waitFor(() =>
      expect(screen.queryByText('Last known: Needs approval')).toBeNull(),
    );
    expect(screen.getAllByText('Needs approval')).toHaveLength(2);
  });

  it('a newer stream activity clears the failed read and stays current when an older pending read fails', async () => {
    historyRead.mockRejectedValueOnce(new Error('offline'));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const release = ensureOrchestrationEventStream('http://test.local', client);
    const deliver = (sequence: number) =>
      streams.get('http://test.local')!({
        event: 'orchestration:activity',
        data: JSON.stringify({
          conversation: {
            conversationId: 'T',
            currentSessionId: 'T',
            activity: {
              ...SESSIONS[0]!.conversationActivity,
              asOfSequence: sequence,
            },
          },
        }),
      });
    deliver(3);
    renderWithProviders(
      <>
        <HistoryReader />
        <DockInbox />
      </>,
      client,
    );
    await screen.findByText('Last known: Needs approval');
    act(() => deliver(3));
    expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
    let rejectRead!: (reason: Error) => void;
    historyRead.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    await act(async () => screen.getByText('Read history').click());
    try {
      act(() => deliver(4));
      await waitFor(() =>
        expect(screen.queryByText('Last known: Needs approval')).toBeNull(),
      );
      await act(async () => rejectRead(new Error('late failure')));
      expect(screen.getByText('Needs approval')).toBeTruthy();
    } finally {
      release();
    }
  });

  it('a fresh caught-up snapshot verifies the retained row without a list refresh', async () => {
    historyRead.mockRejectedValueOnce(new Error('offline'));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderWithProviders(
      <>
        <HistoryReader />
        <DockInbox />
      </>,
      client,
    );
    await screen.findByText('Last known: Needs approval');
    const release = ensureOrchestrationEventStream('http://test.local', client);
    try {
      act(() =>
        streams.get('http://test.local')!({
          event: ORCHESTRATION_STREAM_CAUGHT_UP_EVENT,
          id: '20',
          data: JSON.stringify({
            sessions: [
              {
                ...SESSIONS[0]!,
                conversationId: 'T',
                conversationActivity: {
                  ...SESSIONS[0]!.conversationActivity,
                  asOfSequence: 4,
                },
              },
            ],
          }),
        }),
      );
      await waitFor(() =>
        expect(screen.queryByText('Last known: Needs approval')).toBeNull(),
      );
      expect(screen.getByText('Needs approval')).toBeTruthy();
    } finally {
      release();
    }
  });

  it('another conversation and another Station authority remain current', async () => {
    historyRead.mockRejectedValue(new Error('offline'));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = renderWithProviders(
      <>
        <HistoryReader conversation="other" />
        <DockInbox />
      </>,
      client,
    );
    await waitFor(() =>
      expect(workObservation(client).unavailable('other')).toBe(true),
    );
    // The failed reader belongs to another conversation, so T stays live.
    expect(within(first.container).getByText('Needs approval')).toBeTruthy();
    first.unmount();
    // AuthorityQueryProvider creates a distinct client for each verified
    // Station/principal/grant namespace; endpoint aliases are not authority.
    const otherStation = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const second = renderWithProviders(
      <>
        <HistoryReader station="http://other-station.test" />
        <DockInbox />
      </>,
      otherStation,
    );
    await within(second.container).findByText('Last known: Needs approval');
    const originalStation = renderWithProviders(<DockInbox />, client);
    expect(
      within(originalStation.container).getByText('Needs approval'),
    ).toBeTruthy();
    const otherAuthority = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const third = renderWithProviders(<DockInbox />, otherAuthority);
    expect(within(third.container).getByText('Needs approval')).toBeTruthy();
  });

  it('a failed inbox read marks retained rows; appending a page keeps them last known until refresh', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderWithProviders(<DockInbox />, client);
    const conversation: ConversationListItem = {
      id: 'T',
      source: 'runtime',
      agentSlug: agentId('demo-agent'),
      title: 'Mismatch demo chat',
      createdAt: FOLD_SESSION_CREATED_AT,
      updatedAt: FOLD_SESSION_CREATED_AT,
      messageCount: 1,
      mutable: false,
      answerability: { answerable: true },
      activity: SESSIONS[0]!.conversationActivity,
    };
    const page = {
      items: [conversation],
      nextCursor: 'older' as string | undefined,
    };
    client.setQueryData(['conversation-inventory'], {
      pages: [page],
      pageParams: [undefined],
    });
    await act(async () => {
      await client
        .fetchQuery({
          queryKey: ['conversation-inventory'],
          queryFn: async () => {
            throw new Error('offline');
          },
        })
        .catch(() => {});
    });
    expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['conversation-inventory'],
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage: typeof page) => lastPage.nextCursor,
      queryFn: async ({ pageParam }) =>
        pageParam
          ? {
              items: [
                {
                  ...conversation,
                  id: 'other',
                  activity: { conversationId: 'other', asOfSequence: 5 },
                },
              ],
              nextCursor: undefined,
            }
          : page,
    });
    await act(async () => {
      await observer.fetchNextPage();
    });
    expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
    await act(async () => {
      await observer.refetch();
    });
    expect(screen.getByText('Needs approval')).toBeTruthy();
  });

  it.each([false, true])(
    'a failed open read preserves an independently newer stream observation: %s',
    async (newerStream) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      let rejectOpen!: (error: Error) => void;
      openRead.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOpen = reject;
          }),
      );
      const release = ensureOrchestrationEventStream(
        'http://test.local',
        client,
      );
      streams.get('http://test.local')!({
        event: 'orchestration:activity',
        data: JSON.stringify({
          conversation: {
            conversationId: 'T',
            currentSessionId: 'T',
            activity: { ...SESSIONS[0]!.conversationActivity, asOfSequence: 3 },
          },
        }),
      });
      try {
        renderWithProviders(
          <>
            <ConversationOpenRevalidator
              sessionId={CHAT_TAB}
              conversationId="T"
              apiBase="http://test.local"
              updateChat={(id, patch) => activeChatsStore.updateChat(id, patch)}
            />
            <DockInbox />
          </>,
          client,
        );
        await waitFor(() => expect(openRead).toHaveBeenCalledOnce());
        if (newerStream)
          act(() =>
            streams.get('http://test.local')!({
              event: 'orchestration:activity',
              data: JSON.stringify({
                conversation: {
                  conversationId: 'T',
                  currentSessionId: 'T',
                  activity: {
                    ...SESSIONS[0]!.conversationActivity,
                    asOfSequence: 4,
                  },
                },
              }),
            }),
          );
        await act(async () => rejectOpen(new Error('open unavailable')));
        await waitFor(() =>
          expect(
            activeChatsStore.getSnapshot()[CHAT_TAB]?.conversationOpenFailed,
          ).toBe(true),
        );
        expect(
          screen.getByText(
            newerStream ? 'Needs approval' : 'Last known: Needs approval',
          ),
        ).toBeTruthy();
      } finally {
        release();
      }
    },
  );
});

it('a failed history read removes the running row clock until recovery', async () => {
  historyRead.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
    ...historyPage,
    session: { ...SESSIONS[0]!, ...FOLD_FIXTURES.runningTool.summary },
  });
  const sessions = [{ ...SESSIONS[0]!, ...FOLD_FIXTURES.runningTool.summary }];
  const view = renderWithProviders(
    <>
      <HistoryReader />
      <DockInbox sessions={sessions} />
    </>,
  );
  await screen.findByText('Last known: Running');
  expect(view.container.querySelector('.inbox-row__elapsed')).toBeNull();
  expect(screen.getByTestId('inbox-row-status').getAttribute('data-tone')).toBe(
    'neutral',
  );
  await act(async () => screen.getByText('Read history').click());
  await within(screen.getByTestId('inbox-row-status')).findByText('Running');
  expect(view.container.querySelector('.inbox-row__elapsed')).not.toBeNull();
});

it('successful older-history retry clears last-known rows', async () => {
  historyRead
    .mockResolvedValueOnce({
      ...historyPage,
      hasMore: true,
      nextCursor: 'older',
    })
    .mockRejectedValueOnce(new Error('older page offline'))
    .mockResolvedValueOnce({ ...historyPage, hasMore: false });
  function OlderReader() {
    const history = useSessionEventWindow('http://older-probe.test', 'T');
    return (
      <button type="button" onClick={() => void history.loadOlder()}>
        {history.hasMore ? 'Older available' : 'Older exhausted'}
        {history.error && <span>{history.error.message}</span>}
      </button>
    );
  }
  renderWithProviders(
    <>
      <OlderReader />
      <DockInbox />
    </>,
  );
  await screen.findByText('Older available');
  await act(async () => screen.getByText('Older available').click());
  await screen.findByText('Last known: Needs approval');
  await act(async () => screen.getByText('Older available').click());
  await screen.findByText('Older exhausted');
  expect(historyRead).toHaveBeenCalledTimes(3);
  expect(screen.queryByText('older page offline')).toBeNull();
  expect(screen.queryByText('Last known: Needs approval')).toBeNull();
});

it('inventory notifications stay linear across conversation subscribers', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const observation = workObservation(client);
  const conversations = 1000;
  const subscribers = 1000;
  let calls = 0;
  const releases = Array.from({ length: subscribers }, (_, i) =>
    observation.subscribe(`conversation-${i}`, () => {
      calls += 1;
    }),
  );
  try {
    await client.fetchQuery({
      queryKey: ['conversation-inventory'],
      queryFn: async () => ({
        pages: [
          {
            items: Array.from({ length: conversations }, (_, i) => ({
              id: `conversation-${i}`,
              activity: {
                conversationId: `conversation-${i}`,
                asOfSequence: i,
              },
            })),
          },
        ],
      }),
    });
    // Before scoped, batched publishing this inventory caused 1,001,000 callbacks.
    expect(calls).toBeLessThanOrEqual(conversations + subscribers);
    const beforeFailure = calls;
    observation.failed('conversation-0');
    expect(calls - beforeFailure).toBe(1);
  } finally {
    for (const release of releases) release();
    client.clear();
  }
});

it('a failed row stays last known across unmount and same-sequence replay', async () => {
  historyRead.mockResolvedValueOnce(historyPage);
  const client = new QueryClient();
  const observation = workObservation(client);
  const view = renderWithProviders(
    <>
      <HistoryReader />
      <DockInbox />
    </>,
    client,
  );
  await waitFor(() => expect(historyRead).toHaveBeenCalledTimes(1));
  historyRead.mockRejectedValueOnce(new Error('offline'));
  await act(async () => screen.getByText('Read history').click());
  await screen.findByText('Last known: Needs approval');
  view.unmount();
  renderWithProviders(<DockInbox />, client);
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  act(() =>
    observation.streamObserved({
      ...SESSIONS[0]!.conversationActivity!,
      conversationId: 'T',
      asOfSequence: 3,
    }),
  );
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  act(() =>
    observation.streamObserved({
      ...SESSIONS[0]!.conversationActivity!,
      conversationId: 'T',
      asOfSequence: 4,
    }),
  );
  expect(screen.queryByText('Last known: Needs approval')).toBeNull();
});

it('older-history recovery cannot clear a failing main history reader', async () => {
  historyRead.mockResolvedValueOnce({
    ...historyPage,
    hasMore: true,
    nextCursor: 'older',
  });
  function OlderReader() {
    const history = useSessionEventWindow('http://test.local', 'T');
    return (
      <button type="button" onClick={() => void history.loadOlder()}>
        {history.hasMore ? 'Probe older' : 'Probe waiting'}
      </button>
    );
  }
  const client = new QueryClient();
  renderWithProviders(
    <>
      <OlderReader />
      <DockInbox />
    </>,
    client,
  );
  await screen.findByText('Probe older');
  historyRead.mockRejectedValueOnce(new Error('independent reader offline'));
  renderWithProviders(<HistoryReader />, client);
  await screen.findByText('Last known: Needs approval');
  historyRead.mockRejectedValueOnce(new Error('older offline'));
  await act(async () => screen.getByText('Probe older').click());
  historyRead.mockResolvedValueOnce(historyPage);
  await act(async () => screen.getByText('Probe older').click());
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  historyRead.mockResolvedValueOnce(historyPage);
  await act(async () => screen.getByText('Read history').click());
  expect(screen.queryByText('Last known: Needs approval')).toBeNull();
});

it('inventory removal drops tracked records and refresh leaves untracked conversations alone', async () => {
  const client = new QueryClient();
  const observation = workObservation(client);
  const view = renderWithProviders(<DockInbox />, client);
  act(() => observation.failed('T'));
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  view.unmount();
  await client.fetchQuery({
    queryKey: ['conversation-inventory'],
    queryFn: async () => ({
      pages: [
        {
          items: [
            {
              id: 'untracked',
              activity: { conversationId: 'untracked', asOfSequence: 100 },
            },
          ],
        },
      ],
    }),
  });
  expect(observation.unavailable('T')).toBeUndefined();
  expect(observation.unavailable('untracked')).toBeUndefined();
  const remount = renderWithProviders(<DockInbox />, client);
  expect(screen.queryByText('Last known: Needs approval')).toBeNull();
  remount.unmount();
  client.clear();
});

it('clearing the query cache releases retained observation failures and fences', async () => {
  const client = new QueryClient();
  const observation = workObservation(client);
  const view = renderWithProviders(<DockInbox />, client);
  act(() => {
    observation.observed('T', 100);
    observation.failed('T');
  });
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  view.unmount();
  client.clear();
  expect(observation.unavailable('T')).toBeUndefined();
  renderWithProviders(<DockInbox />, client);
  expect(screen.queryByText('Last known: Needs approval')).toBeNull();
  act(() => observation.failed('T'));
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  act(() => client.clear());
  expect(observation.unavailable('T')).toBeUndefined();
  expect(screen.queryByText('Last known: Needs approval')).toBeNull();
});

it('a healthy inventory read cannot clear a failed sessions observation', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  renderWithProviders(<DockInbox />, client);
  await act(async () => {
    await client
      .fetchQuery({
        queryKey: ['orchestration-sessions'],
        queryFn: async () => {
          throw new Error('sessions offline');
        },
      })
      .catch(() => {});
  });
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  await act(async () => {
    await client.fetchQuery({
      queryKey: ['conversation-inventory'],
      queryFn: async () => ({
        pages: [
          { items: [{ id: 'T', activity: SESSIONS[0]!.conversationActivity }] },
        ],
      }),
    });
  });
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  await act(async () => {
    await client.fetchQuery({
      queryKey: ['orchestration-sessions'],
      queryFn: async () => SESSIONS,
    });
  });
  expect(screen.queryByText('Last known: Needs approval')).toBeNull();
  client.clear();
});
