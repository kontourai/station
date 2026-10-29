// @vitest-environment jsdom

import { ORCHESTRATION_STREAM_CAUGHT_UP_EVENT } from '@kontourai/station-contracts/runtime-events';

/** Dock and mobile inbox freshness share real observation, query and stream owners. */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  ConversationListItem,
  ConversationOpenResolution,
  OrchestrationConversationEventWindow,
} from '@kontourai/station-contracts/orchestration';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
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

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../hooks/useIsMobile', async (importActual) => ({
  ...(await importActual<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => false,
}));
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
import {
  openConversationForDock,
  resolveConversationOpenAuthoritatively,
  retryActiveConversationForDock,
} from '../components/chat-dock/conversationOpenController';
import { MobileTaskSwitcher } from '../components/chat-dock/MobileTaskSwitcher';
import { activeChatsStore } from '../contexts/active-chats-store';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { workObservation } from '../contexts/work-observation';
import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';
import { useConversationActivityFeed } from '../hooks/orchestration/useConversationActivityFeed';
import { useSessionEventWindow } from '../hooks/orchestration/useSessionEventWindow';
import { useSessionTranscriptEvents } from '../hooks/orchestration/useSessionTranscriptEvents';
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

describe('open chat approval status in the dock and mobile inbox', () => {
  it('the dock shows the session approval status and the chat project', async () => {
    const dock = renderWithProviders(<DockInbox />);
    const dockRow = await within(dock.container).findByRole('button', {
      name: ROW_NAME,
    });

    expect(statusTextIn(dock.container)).toBe('Needs approval');
    expect(within(dock.container).getByTestId('inbox-row').dataset.lane).toBe(
      'needsYou',
    );
    expect(dockRow.getAttribute('aria-label')).toBe(ROW_NAME);
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

  it('merges the open chat with its session once', () => {
    // The merged item carries the session it was merged with; a chat-only
    // item carries none.
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
    <>
      <button type="button" onClick={() => void history.reload()}>
        Read history
      </button>
      {history.error && <p role="alert">{history.error.message}</p>}
    </>
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
  it('a failed history read marks dock and mobile rows last known, and a successful read restores them', async () => {
    historyRead
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(historyPage);
    renderWithProviders(
      <>
        <HistoryReader />
        <MobileSwitcher />
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

it('inventory omission preserves a failed open chat until its final mounted reader leaves', async () => {
  const client = new QueryClient();
  const observation = workObservation(client);
  historyRead.mockRejectedValueOnce(new Error('history offline'));
  const reader = renderWithProviders(<HistoryReader />, client);
  const dock = renderWithProviders(<DockInbox />, client);
  await screen.findByText('Last known: Needs approval');
  await act(async () => {
    await client.fetchQuery({
      queryKey: ['conversation-inventory'],
      queryFn: async () => ({
        pages: [{ items: [], hasMore: true, nextCursor: 'older' }],
      }),
    });
  });
  expect(screen.getByRole('button', { name: ROW_NAME })).toBeTruthy();
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  dock.unmount();
  // A mounted history reader still owns the failure even without a status row.
  expect(observation.unavailable('T')).toBe(true);
  expect(screen.getByRole('alert').textContent).toBe('history offline');
  reader.unmount();
  expect(observation.unavailable('T')).toBeUndefined();
  client.clear();
});

it('stream evidence supersedes each failed reader at its own watermark', async () => {
  const client = new QueryClient();
  const observation = workObservation(client);
  historyRead.mockResolvedValueOnce({
    ...historyPage,
    watermark: 10,
    session: {
      ...SESSIONS[0]!,
      conversationActivity: {
        ...SESSIONS[0]!.conversationActivity!,
        asOfSequence: 10,
      },
    },
  });
  renderWithProviders(
    <>
      <HistoryReader />
      <DockInbox />
    </>,
    client,
  );
  await waitFor(() => expect(historyRead).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      activeChatsStore.getSnapshot()[CHAT_TAB]?.conversationActivity
        ?.asOfSequence,
    ).toBe(10),
  );
  historyRead.mockRejectedValueOnce(new Error('history offline'));
  await act(async () => screen.getByText('Read history').click());
  await screen.findByText('Last known: Needs approval');
  const resolution = {
    status: 'resolved',
    conversation: {
      id: 'T',
      source: 'runtime',
      agentSlug: agentId('demo-agent'),
      title: 'Mismatch demo chat',
      createdAt: FOLD_SESSION_CREATED_AT,
      updatedAt: FOLD_SESSION_CREATED_AT,
      messageCount: 1,
      mutable: false,
      answerability: { answerable: true },
    },
    currentSessionId: 'T',
    activity: { ...SESSIONS[0]!.conversationActivity!, asOfSequence: 20 },
    transcript: { available: true, owner: 'runtime', messageCount: 1 },
    canContinue: true,
    answerability: { answerable: true },
    recoveryActions: [],
  } satisfies ConversationOpenResolution;
  openRead.mockResolvedValueOnce(resolution);
  await act(async () => {
    await resolveConversationOpenAuthoritatively(
      'T',
      'http://test.local',
      observation,
    );
  });
  // A successful open read at 20 does not recover history's failure at 10.
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  openRead.mockRejectedValueOnce(new Error('open offline'));
  await act(async () => {
    await expect(
      resolveConversationOpenAuthoritatively(
        'T',
        'http://test.local',
        observation,
      ),
    ).rejects.toThrow('open offline');
  });
  const release = ensureOrchestrationEventStream('http://test.local', client);
  const stream = (sequence: number) =>
    streams.get('http://test.local')!({
      event: 'orchestration:activity',
      data: JSON.stringify({
        conversation: {
          conversationId: 'T',
          currentSessionId: 'T',
          activity: {
            ...SESSIONS[0]!.conversationActivity!,
            asOfSequence: sequence,
          },
        },
      }),
    });
  try {
    act(() => stream(15));
    expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
    openRead.mockResolvedValueOnce(resolution);
    await act(async () => {
      await resolveConversationOpenAuthoritatively(
        'T',
        'http://test.local',
        observation,
      );
    });
    expect(screen.queryByText('Last known: Needs approval')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('history offline');
    // With both sources failing again, 25 exceeds both failure watermarks.
    historyRead.mockRejectedValueOnce(new Error('history offline'));
    await act(async () => screen.getByText('Read history').click());
    openRead.mockRejectedValueOnce(new Error('open offline'));
    await act(async () => {
      await expect(
        resolveConversationOpenAuthoritatively(
          'T',
          'http://test.local',
          observation,
        ),
      ).rejects.toThrow('open offline');
    });
    expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
    act(() => stream(25));
    expect(screen.queryByText('Last known: Needs approval')).toBeNull();
    expect(screen.getByText('Needs approval')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('history offline');
  } finally {
    release();
    client.clear();
  }
});

it('a released open reader cannot recreate a record after dock and picker release', async () => {
  const client = new QueryClient();
  const o = workObservation(client);
  let rejectOpen!: (e: Error) => void;
  openRead.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOpen = reject;
      }),
  );
  const open = renderWithProviders(
    <ConversationOpenRevalidator
      sessionId={CHAT_TAB}
      conversationId="T"
      apiBase="http://test.local"
      updateChat={vi.fn()}
    />,
    client,
  );
  const dock = renderWithProviders(<DockInbox />, client);
  const picker = renderWithProviders(<MobileSwitcher />, client);
  await waitFor(() => expect(openRead).toHaveBeenCalledOnce());
  act(() => o.failed('T', o.begin(), 'history', 10));
  await act(async () => {
    await client.fetchQuery({
      queryKey: ['conversation-inventory'],
      queryFn: async () => ({ pages: [{ items: [] }] }),
    });
  });
  dock.unmount();
  expect(o.unavailable('T')).toBe(true);
  open.unmount();
  expect(o.unavailable('T')).toBe(true);
  expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
  picker.unmount();
  expect(o.unavailable('T')).toBeUndefined();
  // Settle after the last reference was released: it must not recreate an orphan.
  await act(async () => rejectOpen(new Error('late open failure')));
  expect(o.unavailable('T')).toBeUndefined();
  // Module loading is asynchronous too: retirement before it resolves must
  // prevent both a new read and creation of a new observation token.
  for (const clearBeforeImport of [false, true]) {
    openRead.mockClear();
    openRead.mockRejectedValueOnce(new Error('retired before controller load'));
    const deferred = renderWithProviders(
      <ConversationOpenRevalidator
        sessionId={CHAT_TAB}
        conversationId="T"
        apiBase="http://test.local"
        updateChat={vi.fn()}
      />,
      client,
    );
    if (clearBeforeImport) act(() => client.clear());
    else deferred.unmount();
    await act(async () => {});
    expect(openRead).not.toHaveBeenCalled();
    expect(o.unavailable('T')).toBeUndefined();
    if (clearBeforeImport) deferred.unmount();
  }
  client.clear();
});

it('pending history and partial stream produce the same current status in both completion orders', async () => {
  const finalStates = [];
  for (const reader of ['history', 'older-history'] as const) {
    for (const settleAfterStream of [false, true]) {
      activeChatsStore.clearConversationActivity();
      activeChatsStore.updateChat(CHAT_TAB, {
        conversationActivity: undefined,
      });
      const client = new QueryClient();
      const o = workObservation(client);
      function OlderReader() {
        const history = useSessionEventWindow('http://test.local', 'T');
        return (
          <>
            <button
              type="button"
              onClick={() =>
                void (reader === 'history'
                  ? history.reload()
                  : history.loadOlder())
              }
            >
              Probe pending older
            </button>
            {history.error && <p role="alert">{history.error.message}</p>}
          </>
        );
      }
      historyRead.mockResolvedValueOnce({
        ...historyPage,
        watermark: 10,
        hasMore: true,
        nextCursor: 'older',
        session: {
          ...SESSIONS[0]!,
          conversationActivity: {
            ...SESSIONS[0]!.conversationActivity!,
            asOfSequence: 10,
          },
        },
      });
      const mounted = renderWithProviders(
        <>
          <OlderReader />
          <DockInbox />
        </>,
        client,
      );
      await waitFor(() =>
        expect(
          activeChatsStore.getSnapshot()[CHAT_TAB]?.conversationActivity
            ?.asOfSequence,
        ).toBe(10),
      );
      act(() => o.failed('T', o.begin(), reader, 10));
      let rejectOlder!: (e: Error) => void;
      historyRead.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOlder = reject;
          }),
      );
      await act(async () => screen.getByText('Probe pending older').click());
      await waitFor(() => expect(historyRead).toHaveBeenCalledTimes(2));
      act(() => o.failed('T', o.begin(), 'open', 20));
      const release = ensureOrchestrationEventStream(
        'http://test.local',
        client,
      );
      try {
        if (!settleAfterStream)
          await act(async () => rejectOlder(new Error('late older failure')));
        act(() =>
          streams.get('http://test.local')!({
            event: 'orchestration:activity',
            data: JSON.stringify({
              conversation: {
                conversationId: 'T',
                currentSessionId: 'T',
                activity: {
                  ...SESSIONS[0]!.conversationActivity!,
                  asOfSequence: 15,
                },
              },
            }),
          }),
        );
        expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
        if (settleAfterStream)
          await act(async () => rejectOlder(new Error('late older failure')));
        act(() => o.observed('T', 20, 'open'));
        expect(screen.getByRole('alert').textContent).toBe(
          'late older failure',
        );
        expect(screen.queryByText('Last known: Needs approval')).toBeNull();
        finalStates.push({
          unavailable: o.unavailable('T'),
          status: screen.getByText('Needs approval').textContent,
          historyError: screen.getByRole('alert').textContent,
        });
      } finally {
        release();
        mounted.unmount();
        act(() => client.clear());
      }
      historyRead.mockClear();
    }
  }
  for (const finalState of finalStates)
    expect(finalState).toEqual(finalStates[0]);
});

describe('stream epoch changes', () => {
  function sendSnapshot(epoch: string, sequence: number, withActivity = true) {
    streams.get('http://test.local')!({
      event: 'orchestration:snapshot',
      id: String(sequence),
      data: JSON.stringify({
        epoch,
        sessions: [
          {
            ...SESSIONS[0]!,
            conversationId: 'T',
            conversationActivity: withActivity
              ? {
                  ...SESSIONS[0]!.conversationActivity!,
                  asOfSequence: sequence,
                }
              : undefined,
          },
        ],
      }),
    });
  }
  function sendActivity(sequence: number) {
    streams.get('http://test.local')!({
      event: 'orchestration:activity',
      data: JSON.stringify({
        conversation: {
          conversationId: 'T',
          currentSessionId: 'T',
          activity: {
            ...SESSIONS[0]!.conversationActivity!,
            asOfSequence: sequence,
          },
        },
      }),
    });
  }

  it('new-epoch stream activity supersedes a new-epoch history failure at a lower sequence', async () => {
    const client = new QueryClient();
    const dock = renderWithProviders(<DockInbox />, client);
    const release = ensureOrchestrationEventStream('http://test.local', client);
    let history: ReturnType<typeof renderWithProviders> | undefined;
    try {
      act(() => sendSnapshot('recovery-old', 100));
      act(() => sendSnapshot('recovery-new', 1));
      expect(
        activeChatsStore.getSnapshot()[CHAT_TAB]?.conversationActivity
          ?.asOfSequence,
      ).toBe(1);
      historyRead.mockRejectedValueOnce(new Error('new epoch history offline'));
      history = renderWithProviders(<HistoryReader />, client);
      await screen.findByText('Last known: Needs approval');
      act(() => sendActivity(2));
      expect(
        activeChatsStore.getSnapshot()[CHAT_TAB]?.conversationActivity
          ?.asOfSequence,
      ).toBe(2);
      expect(screen.queryByText('Last known: Needs approval')).toBeNull();
      expect(screen.getByText('Needs approval')).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toBe(
        'new epoch history offline',
      );
    } finally {
      history?.unmount();
      release();
      dock.unmount();
      act(() => client.clear());
    }
  });

  it.each(['success', 'failure'] as const)(
    'an old-epoch history %s cannot publish after replacement',
    async (outcome) => {
      const client = new QueryClient();
      const dock = renderWithProviders(<DockInbox />, client);
      const release = ensureOrchestrationEventStream(
        'http://test.local',
        client,
      );
      let oldHistory: ReturnType<typeof renderWithProviders> | undefined;
      let newHistory: ReturnType<typeof renderWithProviders> | undefined;
      try {
        act(() => sendSnapshot(`pending-${outcome}-old`, 100));
        let resolveOld!: (page: OrchestrationConversationEventWindow) => void;
        let rejectOld!: (error: Error) => void;
        historyRead.mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              resolveOld = resolve;
              rejectOld = reject;
            }),
        );
        oldHistory = renderWithProviders(<HistoryReader />, client);
        await waitFor(() => expect(historyRead).toHaveBeenCalledOnce());
        act(() => sendSnapshot(`pending-${outcome}-new`, 1));
        if (outcome === 'success') {
          historyRead.mockRejectedValueOnce(new Error('new epoch failure'));
          newHistory = renderWithProviders(<HistoryReader />, client);
          await screen.findByText('Last known: Needs approval');
          await act(async () => resolveOld({ ...historyPage, watermark: 100 }));
          expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
        } else {
          expect(screen.queryByText('Last known: Needs approval')).toBeNull();
          await act(async () => rejectOld(new Error('old epoch failure')));
          expect(screen.queryByText('Last known: Needs approval')).toBeNull();
          expect(screen.getByText('Needs approval')).toBeTruthy();
        }
      } finally {
        oldHistory?.unmount();
        newHistory?.unmount();
        release();
        dock.unmount();
        act(() => client.clear());
      }
    },
  );

  it('retains an unrecovered visible failure across replacement until a new-epoch observation arrives', async () => {
    const client = new QueryClient();
    const dock = renderWithProviders(<DockInbox />, client);
    const release = ensureOrchestrationEventStream('http://test.local', client);
    let history: ReturnType<typeof renderWithProviders> | undefined;
    try {
      act(() => sendSnapshot('retained-old', 100));
      historyRead.mockRejectedValueOnce(new Error('unrecovered history'));
      history = renderWithProviders(<HistoryReader />, client);
      await screen.findByText('Last known: Needs approval');
      // The replacement snapshot carries no activity for this conversation.
      act(() => sendSnapshot('retained-new', 1, false));
      expect(screen.getByText('Last known: Needs approval')).toBeTruthy();
      act(() => sendActivity(2));
      expect(screen.queryByText('Last known: Needs approval')).toBeNull();
      expect(screen.getByText('Needs approval')).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toBe('unrecovered history');
    } finally {
      history?.unmount();
      release();
      dock.unmount();
      act(() => client.clear());
    }
  });

  function oldPage() {
    return {
      ...historyPage,
      watermark: 100,
      nextCursor: 'older',
      session: {
        ...SESSIONS[0]!,
        conversationActivity: {
          ...SESSIONS[0]!.conversationActivity!,
          asOfSequence: 100,
        },
      },
    };
  }

  // Each path owns a different publication point; use coherent old-epoch activity,
  // then exercise the next read's fence rather than only checking token callbacks.
  it.each(['history', 'older-history'] as const)(
    'late old-epoch %s activity cannot poison the next read fence',
    async (source) => {
      const client = new QueryClient();
      const dock = renderWithProviders(<DockInbox />, client);
      const release = ensureOrchestrationEventStream(
        'http://test.local',
        client,
      );
      function TranscriptReader() {
        const history = useSessionTranscriptEvents(
          'http://test.local',
          { threadId: 'T', conversationId: 'T' },
          true,
        );
        return (
          <button type="button" onClick={() => void history.loadOlder()}>
            Read older epoch page
          </button>
        );
      }
      let oldHistory: ReturnType<typeof renderWithProviders> | undefined;
      let newHistory: ReturnType<typeof renderWithProviders> | undefined;
      try {
        act(() => sendSnapshot(`late-${source}-old`, 100));
        let resolveOld!: (page: OrchestrationConversationEventWindow) => void;
        if (source === 'older-history')
          historyRead.mockResolvedValueOnce(oldPage());
        historyRead.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOld = resolve;
            }),
        );
        oldHistory = renderWithProviders(<TranscriptReader />, client);
        if (source === 'older-history') {
          await waitFor(() => expect(historyRead).toHaveBeenCalledTimes(1));
          await act(async () =>
            screen.getByText('Read older epoch page').click(),
          );
        }
        await waitFor(() =>
          expect(historyRead).toHaveBeenCalledTimes(
            source === 'history' ? 1 : 2,
          ),
        );
        act(() => sendSnapshot(`late-${source}-new`, 1));
        await act(async () => resolveOld(oldPage()));
        historyRead.mockRejectedValueOnce(new Error('fresh history failed'));
        newHistory = renderWithProviders(<HistoryReader />, client);
        await screen.findByText('Last known: Needs approval');
        act(() => sendActivity(2));
        expect(screen.queryByText('Last known: Needs approval')).toBeNull();
        expect(
          activeChatsStore.getSnapshot()[CHAT_TAB]?.conversationActivity
            ?.asOfSequence,
        ).toBe(2);
      } finally {
        oldHistory?.unmount();
        newHistory?.unmount();
        release();
        dock.unmount();
        act(() => client.clear());
      }
    },
  );

  it.each(['retry', 'picker', 'revalidator'] as const)(
    'late old-epoch open resolution cannot publish through %s',
    async (consumer) => {
      const client = new QueryClient();
      const dock = renderWithProviders(<DockInbox />, client);
      const release = ensureOrchestrationEventStream(
        'http://test.local',
        client,
      );
      let revalidator: ReturnType<typeof renderWithProviders> | undefined;
      let history: ReturnType<typeof renderWithProviders> | undefined;
      try {
        act(() => sendSnapshot(`open-${consumer}-old`, 100));
        let resolveOld!: (resolution: ConversationOpenResolution) => void;
        openRead.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOld = resolve;
            }),
        );
        const updateChat = (
          id: string,
          patch: Parameters<typeof activeChatsStore.updateChat>[1],
        ) => activeChatsStore.updateChat(id, patch);
        const observation = workObservation(client);
        let opening: Promise<unknown> | undefined;
        if (consumer === 'retry') {
          opening = retryActiveConversationForDock(
            CHAT_TAB,
            'T',
            'http://test.local',
            updateChat,
            vi.fn(),
            (id) => activeChatsStore.getSnapshot()[id],
            observation,
          );
        } else if (consumer === 'picker') {
          opening = openConversationForDock('T', {
            apiBase: 'http://test.local',
            observation,
            open: async () => true,
            projectName: () => undefined,
            findTab: () => CHAT_TAB,
            readChat: (id) => activeChatsStore.getSnapshot()[id],
            updateChat,
            setRecovery: vi.fn(),
          });
        } else {
          revalidator = renderWithProviders(
            <ConversationOpenRevalidator
              sessionId={CHAT_TAB}
              conversationId="T"
              apiBase="http://test.local"
              updateChat={updateChat}
            />,
            client,
          );
        }
        await waitFor(() => expect(openRead).toHaveBeenCalledOnce());
        act(() => sendSnapshot(`open-${consumer}-new`, 1));
        await act(async () => {
          resolveOld({
            status: 'resolved',
            conversation: {
              id: 'T',
              source: 'runtime',
              agentSlug: agentId('demo-agent'),
              title: 'Mismatch demo chat',
              createdAt: FOLD_SESSION_CREATED_AT,
              updatedAt: FOLD_SESSION_CREATED_AT,
              messageCount: 1,
              mutable: false,
              answerability: { answerable: true },
            },
            currentSessionId: 'T',
            activity: oldPage().session.conversationActivity,
            transcript: { available: true, owner: 'runtime', messageCount: 1 },
            canContinue: true,
            answerability: { answerable: true },
            recoveryActions: [],
          });
          await opening;
        });
        historyRead.mockRejectedValueOnce(new Error('fresh history failed'));
        history = renderWithProviders(<HistoryReader />, client);
        await screen.findByText('Last known: Needs approval');
        act(() => sendActivity(2));
        expect(screen.queryByText('Last known: Needs approval')).toBeNull();
        expect(
          activeChatsStore.getSnapshot()[CHAT_TAB]?.conversationActivity
            ?.asOfSequence,
        ).toBe(2);
      } finally {
        revalidator?.unmount();
        history?.unmount();
        release();
        dock.unmount();
        act(() => client.clear());
      }
    },
  );

  it.each(['inventory', 'sessions'] as const)(
    'cached %s and its pending refetch cannot restore old-epoch activity',
    async (source) => {
      const client = new QueryClient();
      const dock = renderWithProviders(<DockInbox />, client);
      const release = ensureOrchestrationEventStream(
        'http://test.local',
        client,
      );
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
        activity: oldPage().session.conversationActivity,
      };
      const inventoryPage = { items: [conversation], hasMore: false };
      const sessions = [oldPage().session];
      const key =
        source === 'inventory'
          ? ['conversation-inventory']
          : ['orchestration-sessions'];
      let settleOld!: () => void;
      const fetchInventory = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              settleOld = () => resolve(inventoryPage);
            }),
        )
        .mockImplementation(() => new Promise(() => {}));
      const fetchSessions = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              settleOld = () => resolve(sessions);
            }),
        )
        .mockImplementation(() => new Promise(() => {}));
      function Feed() {
        const inventory = useInfiniteQuery({
          queryKey: ['conversation-inventory'],
          queryFn: fetchInventory,
          initialPageParam: undefined,
          getNextPageParam: () => undefined,
          enabled: source === 'inventory',
          retry: false,
        });
        const sessionQuery = useQuery({
          queryKey: ['orchestration-sessions'],
          queryFn: fetchSessions,
          enabled: source === 'sessions',
          retry: false,
        });
        useConversationActivityFeed({
          sessions: sessionQuery.data ?? [],
          sessionsFetchedAfterMount: sessionQuery.isFetchedAfterMount,
          conversations: inventory.data?.pages.flatMap((page) => page.items),
          conversationsFetchedAfterMount: inventory.isFetchedAfterMount,
        });
        return null;
      }
      function RetiredFeed() {
        useConversationActivityFeed({
          sessions,
          sessionsFetchedAfterMount: source === 'sessions',
          conversations: [conversation],
          conversationsFetchedAfterMount: source === 'inventory',
        });
        return null;
      }
      let retiredFeed: ReturnType<typeof renderWithProviders> | undefined;
      let feed: ReturnType<typeof renderWithProviders> | undefined;
      let history: ReturnType<typeof renderWithProviders> | undefined;
      try {
        act(() => sendSnapshot(`cache-${source}-old`, 100));
        client.setQueryData(
          key,
          source === 'inventory'
            ? { pages: [inventoryPage], pageParams: [undefined] }
            : sessions,
        );
        feed = renderWithProviders(<Feed />, client);
        await waitFor(() =>
          expect(
            source === 'inventory' ? fetchInventory : fetchSessions,
          ).toHaveBeenCalledOnce(),
        );
        act(() => sendSnapshot(`cache-${source}-new`, 1));
        await act(async () => settleOld());
        // Reconcile a render that retained the pre-reset query result. The query
        // reset cannot retract props already captured by a mounted consumer.
        retiredFeed = renderWithProviders(<RetiredFeed />, client);
        historyRead.mockRejectedValueOnce(new Error('fresh history failed'));
        history = renderWithProviders(<HistoryReader />, client);
        await screen.findByText('Last known: Needs approval');
        act(() => sendActivity(2));
        expect(screen.queryByText('Last known: Needs approval')).toBeNull();
        expect(
          activeChatsStore.getSnapshot()[CHAT_TAB]?.conversationActivity
            ?.asOfSequence,
        ).toBe(2);
        expect(client.getQueryData(key)).toBeUndefined();
      } finally {
        retiredFeed?.unmount();
        feed?.unmount();
        history?.unmount();
        release();
        dock.unmount();
        act(() => client.clear());
      }
    },
  );
});

function delta6Page(seq: number) {
  return {
    ...historyPage,
    watermark: seq,
    nextCursor: 'older',
    session: {
      ...SESSIONS[0]!,
      conversationActivity: {
        ...SESSIONS[0]!.conversationActivity!,
        asOfSequence: seq,
      },
    },
  };
}
function delta6Resolution(seq: number): ConversationOpenResolution {
  return {
    status: 'resolved',
    conversation: {
      id: 'T',
      source: 'runtime',
      agentSlug: agentId('demo-agent'),
      title: 'Mismatch demo chat',
      createdAt: FOLD_SESSION_CREATED_AT,
      updatedAt: FOLD_SESSION_CREATED_AT,
      messageCount: 1,
      mutable: false,
      answerability: { answerable: true },
    },
    currentSessionId: 'T',
    activity: delta6Page(seq).session.conversationActivity,
    transcript: { available: true, owner: 'runtime', messageCount: 1 },
    canContinue: true,
    answerability: { answerable: true },
    recoveryActions: [],
  };
}
it('DELTA6 same-epoch picker survives an unrelated inventory first-page refresh while opening an unmounted conversation', async () => {
  const client = new QueryClient();
  const observation = workObservation(client);
  activeChatsStore.removeChat(CHAT_TAB);
  client.setQueryData(['conversation-inventory'], {
    pages: [
      {
        items: [delta6Resolution(1).conversation],
        hasMore: true,
        nextCursor: 'page2',
      },
    ],
    pageParams: [undefined],
  });
  const open = vi.fn(async () => true);
  const update = vi.fn();
  let finish!: (resolution: ConversationOpenResolution) => void;
  openRead.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const opening = openConversationForDock(delta6Resolution(1).conversation, {
      apiBase: 'http://test.local',
      observation,
      open,
      projectName: () => undefined,
      findTab: () => CHAT_TAB,
      updateChat: update,
      setRecovery: vi.fn(),
    });
    await waitFor(() => expect(openRead).toHaveBeenCalledOnce());
    await client.fetchQuery({
      queryKey: ['conversation-inventory'],
      queryFn: async () => ({
        pages: [
          {
            items: [
              { ...delta6Resolution(1).conversation, id: 'newer-conversation' },
            ],
            hasMore: true,
            nextCursor: 'page2',
          },
        ],
        pageParams: [undefined],
      }),
    });
    finish(delta6Resolution(2));
    const opened = await opening;
    expect.soft(opened).toBe(true);
    expect.soft(open).toHaveBeenCalledOnce();
    expect.soft(update).toHaveBeenCalledOnce();
    expect(observation.unavailable('T')).toBeUndefined();
  } finally {
    client.clear();
  }
});

it('same-epoch active retry survives an unrelated inventory first-page refresh without a mounted reader', async () => {
  const client = new QueryClient();
  const observation = workObservation(client);
  client.setQueryData(['conversation-inventory'], {
    pages: [{ items: [delta6Resolution(1).conversation], hasMore: true }],
    pageParams: [undefined],
  });
  let finish!: (resolution: ConversationOpenResolution) => void;
  openRead.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const onUnavailable = vi.fn();
  try {
    const retrying = retryActiveConversationForDock(
      CHAT_TAB,
      'T',
      'http://test.local',
      (id, patch) => activeChatsStore.updateChat(id, patch),
      onUnavailable,
      (id) => activeChatsStore.getSnapshot()[id],
      observation,
    );
    await waitFor(() => expect(openRead).toHaveBeenCalledOnce());
    await client.fetchQuery({
      queryKey: ['conversation-inventory'],
      queryFn: async () => ({
        pages: [
          {
            items: [
              { ...delta6Resolution(1).conversation, id: 'newer-conversation' },
            ],
            hasMore: true,
          },
        ],
        pageParams: [undefined],
      }),
    });
    finish(delta6Resolution(2));
    await retrying;
    expect(
      activeChatsStore.getSnapshot()[CHAT_TAB]?.conversationActivity
        ?.asOfSequence,
    ).toBe(2);
    expect(onUnavailable).not.toHaveBeenCalled();
    // A pruned observation does not suppress the chat update or get resurrected.
    expect(observation.unavailable('T')).toBeUndefined();
  } finally {
    client.clear();
  }
});

it('older read begun after epoch replacement captures the current activity fence', async () => {
  const client = new QueryClient();
  const dock = renderWithProviders(<DockInbox />, client);
  const release = ensureOrchestrationEventStream('http://test.local', client);
  let history!: ReturnType<typeof useSessionTranscriptEvents>;
  function Reader() {
    history = useSessionTranscriptEvents(
      'http://test.local',
      { threadId: 'T', conversationId: 'T' },
      true,
    );
    return null;
  }
  const snapshot = (epoch: string, seq: number) =>
    streams.get('http://test.local')!({
      event: 'orchestration:snapshot',
      id: String(seq),
      data: JSON.stringify({ epoch, sessions: [delta6Page(seq).session] }),
    });
  let view: ReturnType<typeof renderWithProviders> | undefined;
  try {
    act(() => snapshot('older-fence-old', 100));
    historyRead.mockResolvedValueOnce(delta6Page(100));
    view = renderWithProviders(<Reader />, client);
    await waitFor(() => expect(history.hasMore).toBe(true));
    expect(historyRead).toHaveBeenCalledOnce();
    act(() => snapshot('older-fence-new', 1));
    expect(historyRead).toHaveBeenCalledOnce();
    historyRead.mockRejectedValueOnce(new Error('new epoch older read failed'));
    await act(async () => {
      await history.loadOlder();
    });
    await screen.findByText('Last known: Needs approval');
    act(() =>
      streams.get('http://test.local')!({
        event: 'orchestration:activity',
        data: JSON.stringify({
          conversation: {
            conversationId: 'T',
            currentSessionId: 'T',
            activity: delta6Page(2).session.conversationActivity,
          },
        }),
      }),
    );
    expect(screen.queryByText('Last known: Needs approval')).toBeNull();
    expect(
      activeChatsStore.getSnapshot()[CHAT_TAB]?.conversationActivity
        ?.asOfSequence,
    ).toBe(2);
  } finally {
    view?.unmount();
    release();
    dock.unmount();
    client.clear();
  }
});
