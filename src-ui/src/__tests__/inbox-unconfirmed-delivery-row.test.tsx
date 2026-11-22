// @vitest-environment jsdom
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
import {
  buildActiveChatTaskItems,
  buildHomeWorkItems,
} from '../views/home/home-view-model';
import { buildWorkFacts } from '../views/home/work-facts';

/**
 * #5398: the shared inbox row (Home, the dock and the phone sheet) shows an
 * unconfirmed delivery as the flag "Last reply may not have arrived" beside
 * the row's own status, and its Check asks Station once.
 */

const NOW = Date.parse('2026-09-30T10:01:15.000Z');
const CONVERSATION = 'station:1795332853880';

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

function row(chat: Partial<ChatUIState>) {
  const chats: Record<string, ChatUIState> = {
    [CONVERSATION]: {
      ...createDefaultChatState(),
      agentSlug: 'station',
      title: 'Say hello in one short line.',
      createdAt: NOW - 120_000,
      ...chat,
    },
  };
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
  const item = items[0]!;
  return render(
    <InboxRow
      item={item}
      facts={facts.get(item.id)}
      isCurrent={false}
      isSnoozed={false}
      isOpenChat={false}
      now={NOW}
      onActivate={vi.fn()}
    />,
  );
}

const UNCONFIRMED: Partial<ChatUIState> = {
  status: 'queued',
  outboundQueuedTurns: [
    {
      clientTurnId: 'turn-unconfirmed',
      content: 'Say hello in one short line.',
      createdAt: NOW - 110_000,
      status: 'may-have-started',
    },
  ],
};

describe('the inbox row flag for an unconfirmed delivery (#5398)', () => {
  it('shows Done with the flag, and Check asks Station about that message', async () => {
    recheck.mockResolvedValueOnce('started');
    const { container } = row(UNCONFIRMED);
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
    ).toContain('Last reply may not have arrived');
    expect(screen.queryByText('Delivery unconfirmed')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Check delivery in Say hello in one short line.',
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'The agent started this message.',
      ),
    );
    expect(recheck).toHaveBeenCalledWith('turn-unconfirmed');
  });

  it('a Check that cannot reach Station says so in words, not the raw error', async () => {
    recheck.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    row(UNCONFIRMED);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Check delivery in Say hello in one short line.',
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).not.toBe(''),
    );
    expect(screen.getByRole('status').textContent).not.toContain(
      'Failed to fetch',
    );
  });

  it('a row with nothing unconfirmed has no flag', () => {
    row({ status: 'idle' });
    expect(screen.queryByTestId('inbox-row-unconfirmed-flag')).toBeNull();
  });
});
