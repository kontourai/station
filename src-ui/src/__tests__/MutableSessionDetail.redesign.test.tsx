import { ChatHttpError } from '@kontourai/station-sdk/client';
import { PreviewProvider } from '../contexts/PreviewContext';
// @vitest-environment jsdom

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The Activity redesign of the Station-owned session detail, driven through
 * the REAL `useMutableSessionDetailState` (only the SDK network edge, the
 * toast host, and two heavy lazily-mounted children are stubbed): the
 * conversation replaces the Result card and is live while a turn streams,
 * Open in chat reopens the real conversation through the shared open policy,
 * Stop interrupts the current turn immediately; a failed session shows one failure card.
 */

const interruptOrchestrationTurn = vi.hoisted(() =>
  vi.fn().mockResolvedValue({}),
);
const acknowledge = vi.hoisted(() => vi.fn());
const attention = vi.hoisted(() => ({ items: [] as unknown[] }));
const receipts = vi.hoisted(() => ({ data: [] as unknown[] }));
const runProbes = vi.hoisted(() => ({
  flow: vi.fn((..._args: unknown[]) => ({ data: null })),
  builder: vi.fn((..._args: unknown[]) => ({ data: null })),
}));
const agents = vi.hoisted(() => ({
  list: [{ slug: 'reviewer', name: 'Code Reviewer' }] as unknown[],
}));

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  interruptTurn: (apiBase: string, input: { threadId: string }) =>
    interruptOrchestrationTurn({ ...input, apiBase }),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useAttentionQuery: () => ({
    data: { items: attention.items },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useWorkflowTasksQuery: () => ({ data: [] }),
  useSessionFlowRunQuery: runProbes.flow,
  useSessionBuilderRunQuery: runProbes.builder,
  useOrchestrationCommandReceiptsQuery: () => ({
    data: receipts.data,
    isLoading: false,
    isError: false,
  }),
  useAcknowledgeAttentionItemMutation: () => ({
    mutate: acknowledge,
    mutateAsync: acknowledge,
    isPending: false,
    error: null,
  }),
  useAgentsQuery: () => ({ data: agents.list, error: null }),
  sendOrchestrationTurn: vi.fn(),
  resolveOrchestrationRequest: vi.fn(),
  interruptOrchestrationTurn,
}));

// The conversation's own source is covered by ConversationReader.test.tsx;
// here the durable window is an empty, settled read.
vi.mock('../hooks/orchestration/useSessionEventWindow', () => ({
  useSessionEventWindow: () => ({
    events: [],
    watermark: 0,
    handoffs: [],
    contextBoundaries: [],
    hasMore: false,
    loadOlder: vi.fn(),
    reload: vi.fn(),
    upgradeRequired: false,
    loading: false,
    settled: true,
    catchingUp: false,
  }),
}));

vi.mock('../hooks/orchestration/ensureOrchestrationEventStream', () => ({
  ensureOrchestrationEventStream: () => () => {},
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

// Lazily mounted inside Details; its own contract is covered by
// tests/conversation-pull-request-links.spec.ts.
vi.mock('../components/pull-requests/ConversationPullRequestLinks', () => ({
  ConversationPullRequestLinks: (props: { linkFormCollapsed?: boolean }) => (
    <div
      data-testid="pr-links-stub"
      data-link-form-collapsed={String(props.linkFormCollapsed)}
    />
  ),
}));

// The attention card's own actions are covered by SessionsView.test.tsx; here
// it only has to exist, with the self-pointing link the real session-failed
// card renders, so a duplicate is observable.
vi.mock('../components/attention/AttentionCard', () => ({
  AttentionCard: ({ item }: { item: { title: string; openHref?: string } }) => (
    <article data-testid="attention-item">
      {item.title}
      {item.openHref && <a href={item.openHref}>Open session</a>}
    </article>
  ),
}));

// The launcher is its own surface; this file only proves the detail opens it
// for the right parent.
vi.mock('../components/chat-dock/DelegationLauncher', () => ({
  DelegationLauncher: (props: { isOpen: boolean; parentTaskId?: string }) =>
    props.isOpen ? (
      <div role="dialog" aria-label="Delegate subtask">
        parent:{props.parentTaskId}
      </div>
    ) : null,
}));

import { MutableSessionDetail } from '../components/session-detail/MutableSessionDetail';
import { openChatsStore } from '../contexts/open-chats-store';
import {
  recordSequencedLiveEvent,
  resetSequencedLiveEventsForTests,
} from '../hooks/orchestration/sequencedLiveEvents';

const THREAD = 'station:thread-redesign';

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'station',
    threadId: THREAD,
    conversationId: 'conversation-redesign',
    assignedAgentSlug: 'reviewer',
    controlMode: 'station-owned',
    status: 'running',
    lifecycleState: 'running',
    hasActiveTurn: true,
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 2,
    projectSlug: 'demo',
    model: 'fixture-model',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:01.000Z',
    ...overrides,
  } as any;
}

let n = 0;
const ev = (
  event: Partial<CanonicalRuntimeEvent> & { method: string },
): CanonicalRuntimeEvent =>
  ({
    eventId: `e${n++}`,
    provider: 'station',
    threadId: THREAD,
    createdAt: '2026-09-28T00:00:00.000Z',
    ...event,
  }) as unknown as CanonicalRuntimeEvent;

async function renderDetail(
  session: any,
  events: CanonicalRuntimeEvent[] = [],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (nextEvents: CanonicalRuntimeEvent[]) => (
    <QueryClientProvider client={queryClient}>
      <PreviewProvider>
        <MutableSessionDetail
          apiBase="http://station.test"
          session={session}
          onTaskChanged={vi.fn()}
          events={nextEvents as any}
          connected
          visualViewport={{ style: {}, height: 900 } as any}
        />
      </PreviewProvider>
    </QueryClientProvider>
  );
  const rendered = render(tree(events));
  await screen.findByTestId('session-transcript');
  await waitFor(() =>
    expect(screen.queryByLabelText('Loading composer')).toBeNull(),
  );
  return {
    ...rendered,
    rerenderEvents: (next: CanonicalRuntimeEvent[]) =>
      rendered.rerender(tree(next)),
  };
}

beforeEach(() => {
  resetSequencedLiveEventsForTests();
  attention.items = [];
  receipts.data = [];
  interruptOrchestrationTurn.mockClear();
  acknowledge.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('composer', () => {
  test('the reply composer names the agent and says why it is disabled only while a turn runs', async () => {
    const view = await renderDetail(baseSession());
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box.getAttribute('placeholder')).toContain('Draft a follow-up');
    expect((box as HTMLTextAreaElement).disabled).toBe(false);
    expect(
      screen.getByText('You can reply when the current turn finishes.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Turn-based:/)).toBeNull();
    view.unmount();

    await renderDetail(
      baseSession({ lifecycleState: 'idle', hasActiveTurn: false }),
    );
    expect(
      screen.queryByText('You can reply when the current turn finishes.'),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  test('a delegated task asks for a follow-up, not a reply to the agent', async () => {
    await renderDetail(
      baseSession({
        lifecycleState: 'idle',
        hasActiveTurn: false,
        delegation: { taskId: 'task:parent-42', mode: 'isolated-child' },
      }),
    );
    expect(
      screen
        .getByRole('textbox', { name: 'Message' })
        .getAttribute('placeholder'),
    ).toContain('Type a message');
  });
});

describe('header meta line', () => {
  test('names the model the session runs, preferring the one the runtime reported', async () => {
    const metaText = () =>
      (
        screen
          .getByTestId('session-detail')
          .querySelector('.sessions-detail__meta-line') as HTMLElement
      ).textContent;
    const configured = await renderDetail(baseSession());
    expect(metaText()).toContain('fixture-model');
    configured.unmount();
    await renderDetail(baseSession({ reportedModel: 'reported-model' }));
    expect(metaText()).toContain('reported-model');
    expect(metaText()).not.toContain('fixture-model');
  });
});

describe('header', () => {
  test('Open in chat reopens the real conversation through the shared open policy', async () => {
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });
    try {
      await renderDetail(baseSession());
      fireEvent.click(screen.getByRole('button', { name: 'Open in chat' }));
      expect(focus).toHaveBeenCalledTimes(1);
      expect(focus).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conversation-redesign',
          agentSlug: 'reviewer',
          threadId: THREAD,
        }),
      );
    } finally {
      unregister();
    }
  });

  test('offers no Open in chat when the chat cannot rehydrate the session', async () => {
    await renderDetail(baseSession({ assignedAgentSlug: undefined }));
    expect(screen.queryByRole('button', { name: 'Open in chat' })).toBeNull();
  });

  test('a refused Stop request renders safe copy in the real detail and keeps replies writable', async () => {
    interruptOrchestrationTurn.mockRejectedValueOnce(
      new ChatHttpError(403, 'insufficient_scope private_diagnostic'),
    );
    await renderDetail(baseSession());
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop the current turn' }),
    );
    await screen.findByText("Station didn't accept this message.");
    const detail = screen.getByTestId('session-detail');
    expect(detail.textContent).not.toMatch(
      /insufficient_scope|private_diagnostic|could not confirm/i,
    );
    expect(
      screen.getByRole('textbox', { name: 'Message' }).hasAttribute('disabled'),
    ).toBe(false);
    expect(interruptOrchestrationTurn).toHaveBeenCalledTimes(1);
  });

  test('the shared Stop interrupts this turn immediately', async () => {
    await renderDetail(baseSession());
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop the current turn' }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() =>
      expect(interruptOrchestrationTurn).toHaveBeenCalledWith({
        threadId: THREAD,
        apiBase: 'http://station.test',
      }),
    );
    expect(interruptOrchestrationTurn).toHaveBeenCalledTimes(1);
  });

  test('keeps the raw thread id out of the header; it lives in ⋯ and Details', async () => {
    await renderDetail(baseSession(), [
      ev({ method: 'turn.started', turnId: 't1', prompt: 'Tidy the docs' }),
    ]);
    const header = screen
      .getByTestId('session-detail')
      .querySelector('.sessions-detail__header') as HTMLElement;
    expect(header.textContent).not.toContain(THREAD);
    expect(within(header).getByRole('heading', { level: 2 }).textContent).toBe(
      'Tidy the docs',
    );
    expect(header.querySelector('.status.tone-active')?.textContent).toBe(
      'Running',
    );
    fireEvent.click(
      within(header).getByRole('button', { name: 'More session actions' }),
    );
    const menu = screen.getByRole('menu', { name: 'More session actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['New Task from this', 'Copy session ID']);
    expect(menu.textContent).not.toContain(THREAD);
    const details = screen.getByTestId('session-details-disclosure');
    expect(details.textContent).toContain(THREAD);
  });

  test('a delegated task offers Delegate subtask with itself as the parent', async () => {
    await renderDetail(
      baseSession({
        delegation: { taskId: 'task:parent-42', mode: 'isolated-child' },
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'More session actions' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delegate subtask' }));
    expect(
      screen.getByRole('dialog', { name: 'Delegate subtask' }).textContent,
    ).toBe('parent:task:parent-42');
  });

  test('a disconnected feed says Connecting… only while the session is live', async () => {
    const queryClient = new QueryClient();
    const tree = (session: any) => (
      <QueryClientProvider client={queryClient}>
        <PreviewProvider>
          <MutableSessionDetail
            apiBase="http://station.test"
            session={session}
            onTaskChanged={vi.fn()}
            events={[]}
            connected={false}
            visualViewport={{ style: {}, height: 900 } as any}
          />
        </PreviewProvider>
      </QueryClientProvider>
    );
    const view = render(tree(baseSession()));
    expect(screen.getByText('Connecting…')).toBeTruthy();
    view.rerender(
      tree(baseSession({ lifecycleState: 'completed', hasActiveTurn: false })),
    );
    expect(screen.queryByText('Connecting…')).toBeNull();
  });
});

describe('needs you: one failure card', () => {
  const failedItem = {
    id: `session-failed:${THREAD}`,
    kind: 'session-failed',
    title: 'Code Reviewer task failed',
    createdAt: '2026-09-28T00:00:02.000Z',
    updatedAt: '2026-09-28T00:00:02.000Z',
    sessionId: THREAD,
    openHref: `/?surface=activity&session=${THREAD}`,
    source: { threadId: THREAD },
  };

  test('a failed session shows its failure once, with no self-pointing Open session link', async () => {
    attention.items = [failedItem];
    await renderDetail(
      baseSession({
        lifecycleState: 'failed',
        hasActiveTurn: false,
        blockedReason: 'The model provider returned an error (HTTP 500).',
      }),
    );
    expect(screen.getAllByTestId('session-failure')).toHaveLength(1);
    expect(screen.getByTestId('session-failure').textContent).toContain(
      'The model provider returned an error (HTTP 500).',
    );
    expect(screen.queryByTestId('session-attention')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open session' })).toBeNull();
  });

  test('the transcript does not repeat the failure the card already states', async () => {
    // The events a Station-agent failure records, as the live store holds
    // them: the prompt, the error, then the session's state change.
    const failure = 'The model provider returned an error (HTTP 500).';
    [
      ev({ method: 'turn.started', turnId: 't1', prompt: 'FAIL please' }),
      ev({
        method: 'runtime.error',
        turnId: 't1',
        severity: 'error',
        code: 'station_agent_turn_failed',
        message: failure,
      } as never),
      ev({
        method: 'session.state-changed',
        sessionId: THREAD,
        from: 'running',
        to: 'errored',
        sessionState: 'failed',
      } as never),
    ].forEach((event, index) =>
      recordSequencedLiveEvent('http://station.test', event, index + 1),
    );
    await renderDetail(
      baseSession({
        lifecycleState: 'failed',
        hasActiveTurn: false,
        blockedReason: failure,
      }),
    );
    expect(screen.getAllByTestId('session-failure')).toHaveLength(1);
    const roles = () =>
      screen
        .getAllByTestId('session-transcript-message')
        .map((node) => node.getAttribute('data-role'));
    await waitFor(() => expect(roles()).toEqual(['user']));
    expect(screen.getByTestId('session-transcript').textContent).toContain(
      'FAIL please',
    );
  });

  test.each([undefined, '2099-01-01T00:00:00.000Z'])(
    "the failure card's Dismiss acknowledges that exact attention item (snoozedUntil=%s)",
    async (snoozedUntil) => {
      attention.items = [
        { ...failedItem, ...(snoozedUntil ? { snoozedUntil } : {}) },
      ];
      await renderDetail(
        baseSession({ lifecycleState: 'failed', hasActiveTurn: false }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(acknowledge).toHaveBeenCalledWith(failedItem.id);
    },
  );

  test('with nothing to acknowledge, the failure card offers no Dismiss', async () => {
    await renderDetail(
      baseSession({ lifecycleState: 'failed', hasActiveTurn: false }),
    );
    expect(screen.getByTestId('session-failure')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});

describe('fix round', () => {
  test('Details mounts linked pull requests with the manual link form collapsed', async () => {
    await renderDetail(baseSession());
    const stub = await screen.findByTestId('pr-links-stub');
    expect(stub.getAttribute('data-link-form-collapsed')).toBe('true');
  });

  test('a peer (paired-Station) record offers no local controls and says where its transcript lives', async () => {
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });
    try {
      await renderDetail(
        baseSession({
          delegation: {
            taskId: 'task:peer-1',
            environmentKind: 'peer',
            mode: 'isolated-child',
          },
        }),
      );
      expect(screen.queryByRole('button', { name: 'Open in chat' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Stop…' })).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
      expect(screen.getByTestId('session-transcript')).toBeTruthy();
      expect(screen.queryByTestId('session-peer-transcript-note')).toBeNull();
      fireEvent.click(
        screen.getByRole('button', { name: 'More session actions' }),
      );
      expect(
        screen.getAllByRole('menuitem').map((item) => item.textContent),
      ).toEqual(['Copy session ID']);
      expect(focus).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  test('a peer record runs no local run probes and offers no inline answer to its attention item', async () => {
    runProbes.flow.mockClear();
    runProbes.builder.mockClear();
    attention.items = [
      {
        id: `needs-input:${THREAD}`,
        kind: 'needs_input',
        title: 'Planner is waiting on you',
        createdAt: '2026-09-28T00:00:02.000Z',
        updatedAt: '2026-09-28T00:00:02.000Z',
        sessionId: THREAD,
        source: { threadId: THREAD },
      },
    ];
    await renderDetail(
      baseSession({
        lifecycleState: 'needs_input',
        hasActiveTurn: false,
        delegation: {
          taskId: 'task:peer-2',
          environmentKind: 'peer',
          mode: 'isolated-child',
        },
      }),
    );
    for (const probe of [runProbes.flow, runProbes.builder]) {
      expect(probe).toHaveBeenCalled();
      expect(
        probe.mock.calls.every(
          (call) => (call[2] as { enabled?: boolean }).enabled === false,
        ),
      ).toBe(true);
    }
    expect(screen.queryByTestId('attention-item')).toBeNull();
    const elsewhere = screen.getByTestId('attention-item-elsewhere');
    expect(elsewhere.textContent).toContain('Planner is waiting on you');
    expect(elsewhere.textContent).toContain('paired Station');
    expect(within(elsewhere).queryByRole('textbox')).toBeNull();
  });

  test('a local delegated task still probes its runs (control)', async () => {
    runProbes.flow.mockClear();
    await renderDetail(
      baseSession({
        delegation: { taskId: 'task:local-1', mode: 'isolated-child' },
      }),
    );
    expect(
      runProbes.flow.mock.calls.some(
        (call) => (call[2] as { enabled?: boolean }).enabled === true,
      ),
    ).toBe(true);
  });

  test('an already-acknowledged failure offers no Dismiss', async () => {
    attention.items = [
      {
        id: `session-failed:${THREAD}`,
        kind: 'session-failed',
        title: 'Failed',
        createdAt: '2026-09-28T00:00:02.000Z',
        updatedAt: '2026-09-28T00:00:02.000Z',
        acknowledgedAt: '2026-09-28T00:00:03.000Z',
        sessionId: THREAD,
        source: { threadId: THREAD },
      },
    ];
    await renderDetail(
      baseSession({ lifecycleState: 'failed', hasActiveTurn: false }),
    );
    expect(screen.getByTestId('session-failure')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  test('an ending turn removes Stop without interrupting again', async () => {
    const queryClient = new QueryClient();
    const tree = (session: any) => (
      <QueryClientProvider client={queryClient}>
        <PreviewProvider>
          <MutableSessionDetail
            apiBase="http://station.test"
            session={session}
            onTaskChanged={vi.fn()}
            events={[]}
            connected
            visualViewport={{ style: {}, height: 900 } as any}
          />
        </PreviewProvider>
      </QueryClientProvider>
    );
    const view = render(tree(baseSession()));
    await screen.findByRole('textbox');
    await screen.findByRole('button', { name: 'Stop the current turn' });
    view.rerender(
      tree(baseSession({ lifecycleState: 'idle', hasActiveTurn: false })),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(interruptOrchestrationTurn).not.toHaveBeenCalled();
  });

  test('an ending turn returns Stop focus to the shared composer', async () => {
    const queryClient = new QueryClient();
    const tree = (session: any) => (
      <QueryClientProvider client={queryClient}>
        <PreviewProvider>
          <MutableSessionDetail
            apiBase="http://station.test"
            session={session}
            onTaskChanged={vi.fn()}
            events={[]}
            connected
            visualViewport={{ style: {}, height: 900 } as any}
          />
        </PreviewProvider>
      </QueryClientProvider>
    );
    const view = render(tree(baseSession()));
    await screen.findByRole('textbox');
    const stop = screen.getByRole('button', { name: 'Stop the current turn' });
    stop.focus();

    view.rerender(
      tree(baseSession({ lifecycleState: 'idle', hasActiveTurn: false })),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('textbox', { name: 'Message' }),
      ),
    );
  });

  test.each([
    ['a heading in another pane', 'outside'],
    ["this detail's evidence region (deep link)", 'evidence'],
  ])(
    'when a turn ends, focus deliberately on %s is left where it is',
    async (_label, where) => {
      const queryClient = new QueryClient();
      const tree = (session: any) => (
        <QueryClientProvider client={queryClient}>
          <PreviewProvider>
            <MutableSessionDetail
              apiBase="http://station.test"
              session={session}
              onTaskChanged={vi.fn()}
              events={[]}
              connected
              visualViewport={{ style: {}, height: 900 } as any}
            />
          </PreviewProvider>
        </QueryClientProvider>
      );
      const view = render(tree(baseSession()));
      const outside = document.createElement('h2');
      outside.tabIndex = -1;
      outside.textContent = 'Another pane';
      document.body.append(outside);
      try {
        const target =
          where === 'outside'
            ? outside
            : screen.getByTestId('session-evidence-region');
        target.focus();
        expect(document.activeElement).toBe(target);
        view.rerender(
          tree(baseSession({ lifecycleState: 'idle', hasActiveTurn: false })),
        );
        expect(document.activeElement).toBe(target);
      } finally {
        outside.remove();
      }
    },
  );

  test('when the shared Stop leaves, focus returns to the composer', async () => {
    const queryClient = new QueryClient();
    const tree = (session: any) => (
      <QueryClientProvider client={queryClient}>
        <PreviewProvider>
          <MutableSessionDetail
            apiBase="http://station.test"
            session={session}
            onTaskChanged={vi.fn()}
            events={[]}
            connected
            visualViewport={{ style: {}, height: 900 } as any}
          />
        </PreviewProvider>
      </QueryClientProvider>
    );
    const view = render(tree(baseSession()));
    await screen.findByRole('textbox');
    const stop = screen.getByRole('button', { name: 'Stop the current turn' });
    stop.focus();
    view.rerender(
      tree(baseSession({ lifecycleState: 'idle', hasActiveTurn: false })),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('textbox', { name: 'Message' }),
      ),
    );
  });

  test('an unknown client surface is left out of the meta line (a known one is named)', async () => {
    const origin = (surface: string) => [
      {
        createdAt: '2026-09-28T00:00:00.000Z',
        clientOrigin: { actor: { kind: 'operator' }, reported: { surface } },
      },
    ];
    const metaText = () =>
      (
        screen
          .getByTestId('session-detail')
          .querySelector('.sessions-detail__meta-line') as HTMLElement
      ).textContent;
    receipts.data = origin('cli');
    const known = await renderDetail(baseSession());
    expect(metaText()).toContain('from CLI (reported)');
    expect(screen.getByText(/^Operator · CLI \(reported\)/)).toBeTruthy();
    known.unmount();
    receipts.data = origin('unknown');
    await renderDetail(baseSession());
    expect(metaText()).not.toMatch(/Unknown surface|from /);
  });
});
