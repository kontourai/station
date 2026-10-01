// @vitest-environment jsdom

/**
 * #3043: the shared inbox row. Fixed line budget, one status line read from
 * the status ladder, chips only where a fact backs them, and two sizes.
 *
 * Rows are built from a real session summary shape through the real work
 * item builder, so a field the builder stops carrying fails here at the
 * render boundary. Hover geometry is measured in a real engine by
 * `InboxRow.geometry.test.tsx`; jsdom computes no layout.
 */

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatDraftsStore } from '../../../contexts/chat-drafts-store';
import {
  buildOrchestrationItems,
  type HomeWorkItem,
} from '../../../views/home/home-view-model';
import { workStatus } from '../../../views/home/work-status';
import { InboxRow } from '../../chat-dock/ChatDockInboxRows';
import { inboxRowChips } from '../inbox-row-chips';

const NOW = Date.parse('2026-09-30T10:01:15.000Z');
const TURN_STARTED = '2026-09-30T10:00:03.000Z';

function session(
  over: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    threadId: 'T',
    status: 'running',
    createdAt: '2026-09-30T10:00:01.000Z',
    updatedAt: '2026-09-30T10:00:05.000Z',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 3,
    displayTitle: 'Migrate sessions table',
    projectSlug: 'station',
    lifecycleState: 'running',
    transitionReason: 'turn_started',
    transitionSource: 'runtime',
    pendingReview: false,
    hasActiveTurn: true,
    conversationActivity: {
      conversationId: 'T',
      currentThreadId: 'T',
      asOfSequence: 2,
      openTurn: { turnId: 't1', threadId: 'T', startedAt: TURN_STARTED },
      runningTools: [
        { name: 'Bash', callId: 'c1', startedAt: '2026-09-30T10:00:04.000Z' },
      ],
      lastActivityAt: '2026-09-30T10:00:04.000Z',
    },
    ...over,
  };
}

function itemFor(
  over: Partial<OrchestrationSessionSummary> = {},
): HomeWorkItem {
  return buildOrchestrationItems([session(over)], [])[0];
}

function renderRow(
  item: HomeWorkItem,
  props: Partial<React.ComponentProps<typeof InboxRow>> = {},
) {
  return render(
    <InboxRow
      item={item}
      isCurrent={false}
      isSnoozed={false}
      isOpenChat={false}
      now={NOW}
      onActivate={vi.fn()}
      hoverCard={false}
      {...props}
    />,
  );
}

const statusText = () => screen.getByTestId('inbox-row-status').textContent;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the row says exactly what the ladder says', () => {
  it.each([
    ['running a tool', {}],
    [
      'approval while the turn is open',
      {
        lifecycleState: 'review_pending',
        transitionReason: 'review_requested',
        pendingReview: true,
      },
    ],
    [
      'failed with a reason',
      {
        lifecycleState: 'failed',
        hasActiveTurn: false,
        terminalAttribution: { kind: 'runtime_error', detail: 'rate limit' },
      },
    ],
    ['idle', { hasActiveTurn: false, conversationActivity: undefined }],
  ] as const)('%s', (_name, over) => {
    const item = itemFor(over as Partial<OrchestrationSessionSummary>);
    renderRow(item);
    const status = workStatus(item, NOW);
    expect(statusText()).toBe(status.line);
    const row = screen.getByTestId('inbox-row');
    expect(row.dataset.statusRung).toBe(status.rung);
    expect(row.dataset.lane).toBe(status.lane);
  });

  it('a needs-approval row shows the status and opens the chat; it offers no inline decision', () => {
    const onActivate = vi.fn();
    const item = itemFor({
      lifecycleState: 'review_pending',
      transitionReason: 'review_requested',
      pendingReview: true,
    });
    renderRow(item, { onActivate, onSnoozeWake: vi.fn() });
    expect(statusText()).toBe('Needs approval');
    expect(screen.queryByRole('button', { name: /approve|deny/i })).toBeNull();
    screen
      .getByRole('button', { name: 'Migrate sessions table, station' })
      .click();
    expect(onActivate).toHaveBeenCalledWith(item);
  });

  it('status is never colour-only: every rung renders an icon beside its word', () => {
    for (const over of [
      {},
      { lifecycleState: 'needs_input', transitionReason: 'input_requested' },
      { lifecycleState: 'failed', hasActiveTurn: false },
      { lifecycleState: 'idle', hasActiveTurn: false },
    ] as Partial<OrchestrationSessionSummary>[]) {
      renderRow(itemFor(over));
      const status = screen.getByTestId('inbox-row-status');
      expect(
        status.querySelector('svg.inbox-row__status-glyph'),
      ).not.toBeNull();
      expect(status.querySelector('.inbox-row__word')?.textContent).not.toBe(
        '',
      );
      cleanup();
    }
  });

  it('offers the status line as the description of the open control', () => {
    renderRow(itemFor());
    const open = screen.getByRole('button', {
      name: 'Migrate sessions table, station',
    });
    const describedBy = open.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Running · Bash · 1m 12s',
    );
  });

  it('ticks the duration once a second, from the injected clock', () => {
    vi.useFakeTimers();
    renderRow(itemFor());
    expect(statusText()).toBe('Running · Bash · 1m 12s');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(statusText()).toBe('Running · Bash · 1m 15s');
  });

  it('a row with no open turn runs no timer', () => {
    vi.useFakeTimers();
    renderRow(
      itemFor({ hasActiveTurn: false, conversationActivity: undefined }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not mark the chat on screen as unread', () => {
    const item: HomeWorkItem = {
      ...itemFor({ hasActiveTurn: false, conversationActivity: undefined }),
      conversationUpdatedAt: '2026-09-30T10:00:05.000Z',
    };
    const other = renderRow(item);
    expect(screen.getByTestId('inbox-row').className).toContain('is-unread');
    expect(statusText()).toContain('Unread.');
    other.unmount();
    renderRow(item, { isCurrent: true });
    expect(screen.getByTestId('inbox-row').className).not.toContain(
      'is-unread',
    );
  });
});

describe('the chip line exists only when a chip does', () => {
  const WORKTREE = {
    mode: 'worktree',
    repoPath: '/repo',
    path: '/repo-worktrees/a',
    branch: 'station/inbox-row',
    baseRef: 'main',
    cleanupPolicy: 'cleanup',
    preserveOnFailure: true,
    createdAt: '2026-09-30T10:00:00.000Z',
  } as const;

  it('renders no chip line for a row with no chip facts', () => {
    renderRow(itemFor());
    expect(screen.queryByTestId('inbox-row-chips')).toBeNull();
    expect(document.querySelector('.inbox-row__chip')).toBeNull();
  });

  it('a shared-workspace session has no branch chip', () => {
    renderRow(itemFor({ workspaceIsolation: { mode: 'shared' } }));
    expect(screen.queryByTestId('inbox-row-chips')).toBeNull();
  });

  it('a worktree session shows its branch, and only that', () => {
    renderRow(itemFor({ workspaceIsolation: WORKTREE }));
    const chips = [...document.querySelectorAll('.inbox-row__chip')];
    expect(chips.map((chip) => chip.getAttribute('data-chip'))).toEqual([
      'branch',
    ]);
    expect(chips[0].textContent).toBe('station/inbox-row');
  });

  it('shows the remote machine, the unsent draft and the woke marker each from its own fact', () => {
    const remote: HomeWorkItem = {
      ...itemFor(),
      environmentLabel: 'brian-media',
      chatSessionId: 'chat-with-draft',
    };
    chatDraftsStore.set('chat-with-draft', 'unsent');
    renderRow(remote, { isWoken: true });
    expect(
      [...document.querySelectorAll('.inbox-row__chip')].map((chip) => [
        chip.getAttribute('data-chip'),
        chip.textContent,
      ]),
    ).toEqual([
      ['remote', 'brian-media'],
      ['draft', 'Unsent draft'],
      ['woke', 'Woke from snooze'],
    ]);
    act(() => chatDraftsStore.clear('chat-with-draft'));
    expect(
      [...document.querySelectorAll('.inbox-row__chip')].map((chip) =>
        chip.getAttribute('data-chip'),
      ),
    ).toEqual(['remote', 'woke']);
  });

  it('the chip derivation, fact by fact', () => {
    expect(inboxRowChips({})).toEqual([]);
    expect(
      inboxRowChips({}, { hasUnsentDraft: false, isWoken: false }),
    ).toEqual([]);
    expect(inboxRowChips({ worktreeBranch: 'a' })).toEqual([
      { kind: 'branch', label: 'a' },
    ]);
    expect(inboxRowChips({ environmentLabel: 'box' })).toEqual([
      { kind: 'remote', label: 'box' },
    ]);
    expect(inboxRowChips({}, { hasUnsentDraft: true })).toEqual([
      { kind: 'draft', label: 'Unsent draft' },
    ]);
  });
});

describe('two sizes and two chromes', () => {
  it('the slim size is one line: no meta line, no chips, the status word and the time', () => {
    renderRow(
      itemFor({
        lifecycleState: 'failed',
        hasActiveTurn: false,
        terminalAttribution: { kind: 'runtime_error', detail: 'rate limit' },
        workspaceIsolation: { mode: 'shared' },
      }),
      { size: 'slim' },
    );
    const row = screen.getByTestId('inbox-row');
    expect(row.className).toContain('inbox-row--slim');
    expect(row.querySelector('.inbox-row__meta')).toBeNull();
    expect(row.querySelector('.inbox-row__chips')).toBeNull();
    expect(statusText()).toBe('Failed');
    // The reason is not lost, only folded: it is the word's tooltip.
    expect(screen.getByTestId('inbox-row-status').getAttribute('title')).toBe(
      'Failed · rate limit',
    );
    expect(row.querySelector('.inbox-row__time')?.textContent).toBe('1m');
  });

  it('a slim remote row still names its machine', () => {
    renderRow(
      { ...itemFor(), environmentLabel: 'brian-media' },
      { size: 'slim' },
    );
    expect(document.querySelector('.inbox-row__slim-remote')?.textContent).toBe(
      'brian-media',
    );
  });

  it('hover chrome offers open and snooze, each named and with a tooltip', () => {
    renderRow(itemFor(), { onSnoozeWake: vi.fn() });
    const open = screen.getByRole('button', {
      name: 'Open Migrate sessions table',
    });
    const snooze = screen.getByRole('button', {
      name: 'Snooze Migrate sessions table',
    });
    expect(open.getAttribute('title')).toBe('Open');
    expect(snooze.getAttribute('title')).toBe('Snooze for 30 minutes');
  });

  it('touch chrome omits the separate open control; the row is the target', () => {
    renderRow(itemFor(), { onSnoozeWake: vi.fn(), chrome: 'touch' });
    expect(
      screen.queryByRole('button', { name: 'Open Migrate sessions table' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Snooze Migrate sessions table' }),
    ).not.toBeNull();
  });

  it('a host that offers no actions gets no slot and no extra tab stop', () => {
    renderRow(itemFor());
    expect(document.querySelector('.inbox-row__actions')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
