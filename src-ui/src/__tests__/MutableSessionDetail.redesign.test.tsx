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
  useSessionFlowRunQuery: () => ({ data: null }),
  useSessionBuilderRunQuery: () => ({ data: null }),
  useOrchestrationCommandReceiptsQuery: () => ({
    data: [],
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

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

// Lazily mounted inside Details; its own contract is covered by
// tests/conversation-pull-request-links.spec.ts.
vi.mock('../components/pull-requests/ConversationPullRequestLinks', () => ({
  ConversationPullRequestLinks: () => null,
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
  attention.items = [];
  interruptOrchestrationTurn.mockClear();
  acknowledge.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('conversation (replaces the Result card)', () => {
  test('shows the user prompt and the answer as it streams, before any turn.completed', () => {
    const started = ev({
      method: 'turn.started',
      turnId: 't1',
      prompt: 'Summarise the release notes',
    });
    const first = ev({
      method: 'content.text-delta',
      turnId: 't1',
      itemId: 'i1',
      delta: 'The release adds ',
    });
    const view = renderDetail(baseSession(), [started, first]);

    const transcript = screen.getByTestId('session-transcript');
    const rows = within(transcript).getAllByTestId(
      'session-transcript-message',
    );
    expect(rows.map((row) => row.getAttribute('data-role'))).toEqual([
      'user',
      'assistant',
    ]);
    expect(rows[0].textContent).toContain('You');
    expect(rows[0].textContent).toContain('Summarise the release notes');
    expect(rows[1].textContent).toContain('Code Reviewer');
    expect(rows[1].textContent).toContain('The release adds');
    expect(rows[1].getAttribute('aria-busy')).toBe('true');

    // More of the same turn arrives: the same row grows, live.
    view.rerenderEvents([
      started,
      first,
      ev({
        method: 'content.text-delta',
        turnId: 't1',
        itemId: 'i1',
        delta: 'a new dock.',
      }),
    ]);
    const grown = within(
      screen.getByTestId('session-transcript'),
    ).getAllByTestId('session-transcript-message');
    expect(grown).toHaveLength(2);
    expect(grown[1].textContent).toContain('The release adds a new dock.');
    // The retired standalone card is gone for good.
    expect(screen.queryByTestId('session-final-output')).toBeNull();
    expect(screen.queryByText('Result')).toBeNull();
  });

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
