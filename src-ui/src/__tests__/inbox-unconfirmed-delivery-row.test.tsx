// @vitest-environment jsdom
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLD_FIXTURES,
  FOLD_SESSION_CREATED_AT,
} from '../../../tests/helpers/session-summary-fold-fixtures';

const recheck = vi.hoisted(() => vi.fn());
vi.mock('../lib/deliveryLookup', () => ({ recheckOutboundTurn: recheck }));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [] }),
}));

import { InboxRow } from '../components/chat-dock/ChatDockInboxRows';
import {
  type ChatUIState,
  createDefaultChatState,
} from '../contexts/active-chats-state';
import { toastStore } from '../contexts/ToastContext';
import { outboundDispatch } from '../lib/outboundQueue';
import {
  buildActiveChatTaskItems,
  buildHomeWorkItems,
} from '../views/home/home-view-model';
import { buildWorkFacts, type WorkFacts } from '../views/home/work-facts';

/**
 * #5398: the shared inbox row (Home, the dock and the phone sheet) shows an
 * unconfirmed delivery as the flag "Last message may not have arrived"
 * beside the row's own status, and its Check asks Station once.
 */

const NOW = Date.parse('2026-09-30T10:01:15.000Z');
const CONVERSATION = 'station:1795332853880';
const TITLE = 'Say hello in one short line.';
const CHECK = `Check delivery in ${TITLE}`;

const completed: OrchestrationSessionSummary = {
  provider: 'station',
  threadId: CONVERSATION,
  conversationId: CONVERSATION,
  status: 'running',
  createdAt: FOLD_SESSION_CREATED_AT,
  updatedAt: '2026-09-30T10:00:02.000Z',
  controlMode: 'station-owned',
  answerability: { answerable: true },
  isLoaded: true,
  isPersisted: true,
  eventCount: FOLD_FIXTURES.turnCompleted.events.length,
  ...FOLD_FIXTURES.turnCompleted.summary,
};

function chatState(over: Partial<ChatUIState>): ChatUIState {
  return {
    ...createDefaultChatState(),
    agentSlug: 'station',
    title: TITLE,
    createdAt: NOW - 120_000,
    ...over,
  };
}

/** The real chain Home and the dock run: chat items, merge, then facts. */
function rowFor(
  chats: Record<string, ChatUIState>,
  sessions: OrchestrationSessionSummary[] = [completed],
) {
  const items = buildHomeWorkItems({
    chats: {},
    sessions,
    retainTaskChildren: true,
    agents: [],
    chatItems: buildActiveChatTaskItems({ chats, agents: [], sessions }),
  });
  const facts = buildWorkFacts({ items, chats, sessions });
  expect(items).toHaveLength(1);
  return { item: items[0]!, facts: facts.get(items[0]!.id) };
}

function renderRow(
  chats: Record<string, ChatUIState>,
  override: Partial<WorkFacts> = {},
) {
  const { item, facts } = rowFor(chats);
  const view = (rowFacts: WorkFacts | undefined) => (
    <InboxRow
      item={item}
      facts={rowFacts}
      isCurrent={false}
      isSnoozed={false}
      isOpenChat={false}
      now={NOW}
      onActivate={vi.fn()}
    />
  );
  const mounted = render(view({ ...facts, ...override }));
  return { ...mounted, item, facts, view };
}

const UNCONFIRMED: Partial<ChatUIState> = {
  status: 'queued',
  outboundQueuedTurns: [
    {
      clientTurnId: 'turn-unconfirmed',
      content: TITLE,
      createdAt: NOW - 110_000,
      status: 'may-have-started',
    },
  ],
};

/** A reopen minted a second chat key for one conversation; each chat holds
 *  its own unconfirmed message. */
const TWO_CHATS: Record<string, ChatUIState> = {
  [CONVERSATION]: chatState(UNCONFIRMED),
  'station:1795332999999': chatState({
    conversationId: CONVERSATION,
    createdAt: NOW - 10_000,
    status: 'queued',
    outboundQueuedTurns: [
      {
        clientTurnId: 'turn-newer',
        content: 'And one more.',
        createdAt: NOW - 5_000,
        status: 'may-have-started',
      },
    ],
  }),
};

beforeEach(() => {
  recheck.mockReset();
  toastStore.clear();
  vi.restoreAllMocks();
});

describe('the inbox row flag for an unconfirmed delivery (#5398)', () => {
  it('shows Done with the flag, and Check asks Station about that message', async () => {
    recheck.mockResolvedValueOnce('started');
    const { container } = renderRow({ [CONVERSATION]: chatState(UNCONFIRMED) });
    expect(container.querySelector('.inbox-row__word')?.textContent).toBe(
      'Done',
    );
    expect(
      container
        .querySelector('[data-testid="inbox-row"]')
        ?.getAttribute('data-lane'),
    ).toBe('finished');
    expect(
      screen.getByTestId('inbox-row-unconfirmed-flag').textContent,
    ).toContain('Last message may not have arrived');
    expect(screen.queryByText('Delivery unconfirmed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'The agent started this message.',
      ),
    );
    expect(recheck).toHaveBeenCalledWith('turn-unconfirmed');
  });

  it("the row's open button is described by the flag, so a screen reader hears it with the row", () => {
    const { container } = renderRow({ [CONVERSATION]: chatState(UNCONFIRMED) });
    const open =
      container.querySelector<HTMLButtonElement>('.inbox-row__open')!;
    const described = (open.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(described).toContain('Last message may not have arrived');
  });

  it('checks every message of a conversation two chats hold, and reports the most serious answer', async () => {
    // A reopen minted a second chat key for the same conversation; each chat
    // holds its own unconfirmed message.
    recheck.mockImplementation(async (clientTurnId: string) =>
      clientTurnId === 'turn-newer' ? 'indeterminate' : 'started',
    );
    renderRow({
      [CONVERSATION]: chatState(UNCONFIRMED),
      'station:1795332999999': chatState({
        conversationId: CONVERSATION,
        createdAt: NOW - 10_000,
        status: 'queued',
        outboundQueuedTurns: [
          {
            clientTurnId: 'turn-newer',
            content: 'And one more.',
            createdAt: NOW - 5_000,
            status: 'may-have-started',
          },
        ],
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Station still can’t confirm 1 of 2 messages. Open the chat to discard it.',
      ),
    );
    expect(recheck.mock.calls.map(([key]) => key)).toEqual([
      'turn-unconfirmed',
      'turn-newer',
    ]);
  });

  it('a Check that cannot reach Station says so in words, not the raw error', async () => {
    recheck.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderRow({ [CONVERSATION]: chatState(UNCONFIRMED) });
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Could not reach Station. Check the connection, then try again.',
      ),
    );
  });

  it('a Check that settles the message says its answer once more after the flag goes', async () => {
    recheck.mockResolvedValueOnce('not-received');
    const { rerender, view, facts } = renderRow({
      [CONVERSATION]: chatState(UNCONFIRMED),
    });
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Station did not receive it.',
      ),
    );
    // The answer settles the outbox message: the next facts list nothing
    // unconfirmed and the row loses its flag.
    const { unconfirmedDelivery: _gone, ...settled } = facts ?? {};
    rerender(view(settled));
    expect(screen.queryByTestId('inbox-row-unconfirmed-flag')).toBeNull();
    expect(toastStore.getSnapshot().map((toast) => toast.message)).toEqual([
      'Say hello in one short line: Station did not receive it. Retry sends it with the same message key.',
    ]);
  });

  it.each([
    ['older not received, newer started', ['not-received', 'started']],
    ['older started, newer not received', ['started', 'not-received']],
  ] as const)(
    'differing answers (%s) say how many Station did not receive',
    async (_name, answers) => {
      recheck.mockImplementation(async (clientTurnId: string) =>
        clientTurnId === 'turn-newer' ? answers[1] : answers[0],
      );
      renderRow(TWO_CHATS);
      fireEvent.click(screen.getByRole('button', { name: CHECK }));
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe(
          'Station did not receive 1 of 2 messages. Open the chat to retry it.',
        ),
      );
    },
  );

  it('one press checks the newest five messages and says how many are left', async () => {
    recheck.mockResolvedValue('indeterminate');
    renderRow({
      [CONVERSATION]: chatState({
        status: 'queued',
        outboundQueuedTurns: Array.from({ length: 6 }, (_, index) => ({
          clientTurnId: `turn-${index}`,
          content: `Message ${index}`,
          createdAt: NOW - 60_000 + index,
          status: 'may-have-started' as const,
        })),
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Station still can’t confirm 5 messages. Open the chat to discard them and check 1 more.',
      ),
    );
    expect(recheck.mock.calls.map(([key]) => key)).toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
      'turn-4',
      'turn-5',
    ]);
  });

  it.each([
    ['started', 'The agent started this message.'],
    [
      'not-received',
      'Station did not receive it. Retry sends it with the same message key.',
    ],
    [
      'indeterminate',
      'Station still can’t confirm it. Open the chat to discard it.',
    ],
    ['received', 'Station has the message. The agent has not started it yet.'],
  ] as const)(
    'Check never resends: an answer of %s makes the lookup and nothing else',
    async (outcome, sentence) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('no request expected'));
      const enqueue = vi.spyOn(outboundDispatch, 'enqueue');
      const flush = vi.spyOn(outboundDispatch, 'flush');
      const sendHeld = vi.spyOn(outboundDispatch, 'sendHeld');
      recheck.mockResolvedValue(outcome);
      renderRow({ [CONVERSATION]: chatState(UNCONFIRMED) });
      for (let press = 0; press < 2; press++) {
        fireEvent.click(screen.getByRole('button', { name: CHECK }));
        await waitFor(() =>
          expect(screen.getByRole('status').textContent).toBe(sentence),
        );
      }
      expect(recheck.mock.calls).toEqual([
        ['turn-unconfirmed'],
        ['turn-unconfirmed'],
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(sendHeld).not.toHaveBeenCalled();
    },
  );

  it('presses while Check runs are ignored, and Check keeps keyboard focus', async () => {
    const pending: ((outcome: string) => void)[] = [];
    recheck.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    renderRow({ [CONVERSATION]: chatState(UNCONFIRMED) });
    const check = screen.getByRole<HTMLButtonElement>('button', {
      name: CHECK,
    });
    check.focus();
    // Three presses before React renders again, as fast key repeats land.
    act(() => {
      check.click();
      check.click();
      check.click();
    });
    await waitFor(() => expect(recheck).toHaveBeenCalled());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(check.getAttribute('aria-disabled')).toBe('true');
    // Never disabled: a disabled button would drop focus to the page.
    expect(check.hasAttribute('disabled')).toBe(false);
    for (const resolve of pending) resolve('indeterminate');
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Station still can’t confirm it.',
      ),
    );
    expect(document.activeElement).toBe(check);
  });

  it('when a Check settles the message, focus returns to the row it leaves', async () => {
    recheck.mockResolvedValueOnce('started');
    const { rerender, view, facts, container } = renderRow({
      [CONVERSATION]: chatState(UNCONFIRMED),
    });
    const check = screen.getByRole('button', { name: CHECK });
    check.focus();
    fireEvent.click(check);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'The agent started this message.',
      ),
    );
    const { unconfirmedDelivery: _gone, ...settled } = facts ?? {};
    rerender(view(settled));
    expect(screen.queryByTestId('inbox-row-unconfirmed-flag')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('.inbox-row__open'),
    );
  });

  it('answers that say nothing new are left out of the count', async () => {
    recheck.mockImplementation(async (clientTurnId: string) =>
      clientTurnId === 'turn-newer' ? 'started' : undefined,
    );
    renderRow(TWO_CHATS);
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'The agent started this message.',
      ),
    );
  });

  it('when no answer says anything new, the line says so', async () => {
    recheck.mockResolvedValue(undefined);
    renderRow(TWO_CHATS);
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Nothing new to check right now.',
      ),
    );
  });

  it('a title change while the flag is on screen raises no notice', async () => {
    recheck.mockResolvedValueOnce('started');
    const { rerender, item, facts } = renderRow({
      [CONVERSATION]: chatState(UNCONFIRMED),
    });
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'The agent started this message.',
      ),
    );
    rerender(
      <InboxRow
        item={{ ...item, title: 'Renamed chat' }}
        facts={facts}
        isCurrent={false}
        isSnoozed={false}
        isOpenChat={false}
        now={NOW}
        onActivate={vi.fn()}
      />,
    );
    expect(toastStore.getSnapshot()).toEqual([]);
  });

  it('leaving the screen after an answer that settles nothing raises no notice', async () => {
    recheck.mockResolvedValueOnce('indeterminate');
    const { unmount } = renderRow({ [CONVERSATION]: chatState(UNCONFIRMED) });
    fireEvent.click(screen.getByRole('button', { name: CHECK }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Station still can’t confirm it.',
      ),
    );
    unmount();
    expect(toastStore.getSnapshot()).toEqual([]);
  });

  it('the same flag on Home and in the dock raises one notice when its Check settles the message', async () => {
    recheck.mockResolvedValueOnce('started');
    const { item, facts } = rowFor({ [CONVERSATION]: chatState(UNCONFIRMED) });
    const both = (rowFacts: WorkFacts | undefined) => (
      <>
        {['home', 'dock'].map((surface) => (
          <InboxRow
            key={surface}
            item={item}
            facts={rowFacts}
            isCurrent={false}
            isSnoozed={false}
            isOpenChat={false}
            now={NOW}
            onActivate={vi.fn()}
          />
        ))}
      </>
    );
    const { rerender } = render(both(facts));
    fireEvent.click(screen.getAllByRole('button', { name: CHECK })[0]!);
    await waitFor(() =>
      expect(screen.getAllByRole('status')[0]!.textContent).toBe(
        'The agent started this message.',
      ),
    );
    const { unconfirmedDelivery: _gone, ...settled } = facts ?? {};
    rerender(both(settled));
    expect(toastStore.getSnapshot().map((toast) => toast.message)).toEqual([
      'Say hello in one short line: The agent started this message.',
    ]);
  });

  it('a row on another Station shows the flag with where to act, and no Check', () => {
    // A chat bound to a paired Station: its row is that Station's, and the
    // Check it offers lives in the opened chat, which reaches that Station.
    const { item, facts } = rowFor(
      {
        [CONVERSATION]: chatState({
          ...UNCONFIRMED,
          conversationId: CONVERSATION,
          stationBinding: {
            version: 1,
            environmentId: 'env-paired',
            stationName: 'Paired',
            affinity: {
              kind: 'device',
              connectionId: 'connection-paired',
              principalNamespace: 'principal-paired',
            },
          },
        }),
      },
      [],
    );
    expect(facts?.station?.label).toBe('Paired');
    render(
      <InboxRow
        item={item}
        facts={facts}
        isCurrent={false}
        isSnoozed={false}
        isOpenChat={false}
        now={NOW}
        onActivate={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: CHECK })).toBeNull();
    expect(screen.getByTestId('inbox-row-unconfirmed-flag').textContent).toBe(
      'Last message may not have arrived. Open the chat to check it.',
    );
  });

  it('a row with nothing unconfirmed has no flag', () => {
    renderRow({ [CONVERSATION]: chatState({ status: 'idle' }) });
    expect(screen.queryByTestId('inbox-row-unconfirmed-flag')).toBeNull();
  });
});
