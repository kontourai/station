// @vitest-environment jsdom
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
function rowFor(chats: Record<string, ChatUIState>) {
  const items = buildHomeWorkItems({
    chats: {},
    sessions: [completed],
    retainTaskChildren: true,
    agents: [],
    chatItems: buildActiveChatTaskItems({
      chats,
      agents: [],
      sessions: [completed],
    }),
  });
  const facts = buildWorkFacts({ items, chats, sessions: [completed] });
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

beforeEach(() => {
  recheck.mockReset();
  toastStore.clear();
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

  it('checks every message of a conversation two chats hold, and reports the newest one', async () => {
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
        'Station still can’t confirm it. Open the chat to discard it.',
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
      `${TITLE}: Station did not receive it. Retry sends it with the same message key.`,
    ]);
  });

  it('a row on another Station shows the flag with where to act, and no Check', () => {
    renderRow(
      { [CONVERSATION]: chatState(UNCONFIRMED) },
      { hostDetails: false },
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
