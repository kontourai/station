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
 * Stop asks first, and a failed session shows exactly one failure card.
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

vi.mock('@kontourai/station-sdk', () => ({
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

// The conversation's own source is covered by SessionTranscript.test.tsx;
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

function renderDetail(session: any, events: CanonicalRuntimeEvent[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (nextEvents: CanonicalRuntimeEvent[]) => (
    <QueryClientProvider client={queryClient}>
      <MutableSessionDetail
        apiBase="http://station.test"
        session={session}
        onTaskChanged={vi.fn()}
        events={nextEvents as any}
        connected
        visualViewport={{ style: {}, height: 900 } as any}
      />
    </QueryClientProvider>
  );
  const rendered = render(tree(events));
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
  test('the reply composer names the agent and says why it is disabled only while a turn runs', () => {
    const view = renderDetail(baseSession());
    const box = screen.getByLabelText('Send input to session');
    expect(box.getAttribute('placeholder')).toBe('Reply to Code Reviewer…');
    expect((box as HTMLTextAreaElement).disabled).toBe(true);
    expect(
      screen.getByText('You can reply when the current turn finishes.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Turn-based:/)).toBeNull();
    view.unmount();

    renderDetail(baseSession({ lifecycleState: 'idle', hasActiveTurn: false }));
    expect(
      screen.queryByText('You can reply when the current turn finishes.'),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  test('a delegated task asks for a follow-up, not a reply to the agent', () => {
    renderDetail(
      baseSession({
        lifecycleState: 'idle',
        hasActiveTurn: false,
        delegation: { taskId: 'task:parent-42', mode: 'isolated-child' },
      }),
    );
    expect(
      screen
        .getByLabelText('Continue delegated task')
        .getAttribute('placeholder'),
    ).toBe('Add a follow-up for this task…');
  });
});

describe('header meta line', () => {
  test('names the model the session runs, preferring the one the runtime reported', () => {
    const metaText = () =>
      (
        screen
          .getByTestId('session-detail')
          .querySelector('.sessions-detail__meta-line') as HTMLElement
      ).textContent;
    const configured = renderDetail(baseSession());
    expect(metaText()).toContain('fixture-model');
    configured.unmount();
    renderDetail(baseSession({ reportedModel: 'reported-model' }));
    expect(metaText()).toContain('reported-model');
    expect(metaText()).not.toContain('fixture-model');
  });
});

describe('header', () => {
  test('Open in chat reopens the real conversation through the shared open policy', () => {
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });
    try {
      renderDetail(baseSession());
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

  test('offers no Open in chat when the chat cannot rehydrate the session', () => {
    renderDetail(baseSession({ assignedAgentSlug: undefined }));
    expect(screen.queryByRole('button', { name: 'Open in chat' })).toBeNull();
  });

  test('Stop… asks first; only the confirmation stops the turn', async () => {
    renderDetail(baseSession());
    fireEvent.click(screen.getByRole('button', { name: 'Stop…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Stop this task?' });
    expect(interruptOrchestrationTurn).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Keep running' }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(interruptOrchestrationTurn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop…' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Stop task',
      }),
    );
    await waitFor(() =>
      expect(interruptOrchestrationTurn).toHaveBeenCalledWith({
        threadId: THREAD,
        apiBase: 'http://station.test',
      }),
    );
    expect(interruptOrchestrationTurn).toHaveBeenCalledTimes(1);
  });

  test('keeps the raw thread id out of the header; it lives in ⋯ and Details', () => {
    renderDetail(baseSession(), [
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
    ).toEqual(['Copy session ID']);
    const details = screen.getByTestId('session-details-disclosure');
    expect(details.textContent).toContain(THREAD);
  });

  test('a delegated task offers Delegate subtask with itself as the parent', () => {
    renderDetail(
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

  test('a disconnected feed says Connecting… only while the session is live', () => {
    const queryClient = new QueryClient();
    const tree = (session: any) => (
      <QueryClientProvider client={queryClient}>
        <MutableSessionDetail
          apiBase="http://station.test"
          session={session}
          onTaskChanged={vi.fn()}
          events={[]}
          connected={false}
          visualViewport={{ style: {}, height: 900 } as any}
        />
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

  test('a failed session shows its failure once, with no self-pointing Open session link', () => {
    attention.items = [failedItem];
    renderDetail(
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
    renderDetail(
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

  test("the failure card's Dismiss acknowledges that exact attention item", () => {
    attention.items = [failedItem];
    renderDetail(
      baseSession({ lifecycleState: 'failed', hasActiveTurn: false }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(acknowledge).toHaveBeenCalledWith(failedItem.id);
  });

  test('with nothing to acknowledge, the failure card offers no Dismiss', () => {
    renderDetail(
      baseSession({ lifecycleState: 'failed', hasActiveTurn: false }),
    );
    expect(screen.getByTestId('session-failure')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});

describe('fix round', () => {
  test('Details mounts linked pull requests with the manual link form collapsed', async () => {
    renderDetail(baseSession());
    const stub = await screen.findByTestId('pr-links-stub');
    expect(stub.getAttribute('data-link-form-collapsed')).toBe('true');
  });

  test('a peer (paired-Station) record offers no local controls and says where its transcript lives', () => {
    const focus = vi.fn();
    const unregister = openChatsStore.registerNavigation({
      focus,
      openCollection: vi.fn(),
    });
    try {
      renderDetail(
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
      expect(screen.queryByLabelText('Continue delegated task')).toBeNull();
      expect(screen.queryByTestId('session-transcript')).toBeNull();
      expect(
        screen.getByTestId('session-peer-transcript-note').textContent,
      ).toContain('remain on the paired Station');
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

  test('a peer record runs no local run probes and offers no inline answer to its attention item', () => {
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
    renderDetail(
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

  test('a local delegated task still probes its runs (control)', () => {
    runProbes.flow.mockClear();
    renderDetail(
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

  test('an already-acknowledged failure offers no Dismiss', () => {
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
    renderDetail(
      baseSession({ lifecycleState: 'failed', hasActiveTurn: false }),
    );
    expect(screen.getByTestId('session-failure')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  test('a turn that ends while Stop is being confirmed withdraws the question and never interrupts', () => {
    const queryClient = new QueryClient();
    const tree = (session: any) => (
      <QueryClientProvider client={queryClient}>
        <MutableSessionDetail
          apiBase="http://station.test"
          session={session}
          onTaskChanged={vi.fn()}
          events={[]}
          connected
          visualViewport={{ style: {}, height: 900 } as any}
        />
      </QueryClientProvider>
    );
    const view = render(tree(baseSession()));
    fireEvent.click(screen.getByRole('button', { name: 'Stop…' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    view.rerender(
      tree(baseSession({ lifecycleState: 'idle', hasActiveTurn: false })),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(interruptOrchestrationTurn).not.toHaveBeenCalled();
  });

  test('a turn that ends while Stop is being confirmed lands focus on Open in chat, not <body>', async () => {
    const queryClient = new QueryClient();
    const tree = (session: any) => (
      <QueryClientProvider client={queryClient}>
        <MutableSessionDetail
          apiBase="http://station.test"
          session={session}
          onTaskChanged={vi.fn()}
          events={[]}
          connected
          visualViewport={{ style: {}, height: 900 } as any}
        />
      </QueryClientProvider>
    );
    const view = render(tree(baseSession()));
    const stop = screen.getByRole('button', { name: 'Stop…' });
    stop.focus();
    fireEvent.click(stop);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    view.rerender(
      tree(baseSession({ lifecycleState: 'idle', hasActiveTurn: false })),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Open in chat' }),
      ),
    );
  });

  test.each([
    ['a heading in another pane', 'outside'],
    ["this detail's evidence region (deep link)", 'evidence'],
  ])(
    'when a turn ends, focus deliberately on %s is left where it is',
    (_label, where) => {
      const queryClient = new QueryClient();
      const tree = (session: any) => (
        <QueryClientProvider client={queryClient}>
          <MutableSessionDetail
            apiBase="http://station.test"
            session={session}
            onTaskChanged={vi.fn()}
            events={[]}
            connected
            visualViewport={{ style: {}, height: 900 } as any}
          />
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

  test('when Stop… goes away with focus on nothing, focus lands on Open in chat, not <body>', () => {
    const queryClient = new QueryClient();
    const tree = (session: any) => (
      <QueryClientProvider client={queryClient}>
        <MutableSessionDetail
          apiBase="http://station.test"
          session={session}
          onTaskChanged={vi.fn()}
          events={[]}
          connected
          visualViewport={{ style: {}, height: 900 } as any}
        />
      </QueryClientProvider>
    );
    const view = render(tree(baseSession()));
    const stop = screen.getByRole('button', { name: 'Stop…' });
    stop.focus();
    view.rerender(
      tree(baseSession({ lifecycleState: 'idle', hasActiveTurn: false })),
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Open in chat' }),
    );
  });

  test('an unknown client surface is left out of the meta line (a known one is named)', () => {
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
    const known = renderDetail(baseSession());
    expect(metaText()).toContain('from CLI');
    known.unmount();
    receipts.data = origin('unknown');
    renderDetail(baseSession());
    expect(metaText()).not.toMatch(/Unknown surface|from /);
  });
});
