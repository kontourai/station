// @vitest-environment jsdom

/**
 * #3043: the shared inbox row. Fixed line budget, one status line read from
 * the status ladder, chips only where a fact backs them, and two sizes.
 *
 * Rows are built through the real work item builder from the fold-pinned
 * running summary (see `session` below), with named fields overridden by
 * hand per test. Hover geometry is measured in a real engine by
 * `InboxRow.geometry.test.tsx`; jsdom computes no layout.
 */

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLD_FIXTURES,
  FOLD_SESSION_CREATED_AT,
} from '../../../../../tests/helpers/session-summary-fold-fixtures';
import { chatDraftsStore } from '../../../contexts/chat-drafts-store';
import {
  buildOrchestrationItems,
  type HomeWorkItem,
} from '../../../views/home/home-view-model';
import { buildWorkFacts, type WorkFacts } from '../../../views/home/work-facts';
import { workStatus } from '../../../views/home/work-status';
import {
  CONVERSATION_REFERENCE_DRAG_TYPE,
  draggedConversationReference,
  publishReferenceableConversations,
} from '../../chat/conversationReferenceDrag';
import { InboxGroupList, InboxRow } from '../../chat-dock/ChatDockInboxRows';
import { inboxRowChips } from '../inbox-row-chips';

// The details sheet's on-demand reads (git, pull requests, basis) need a
// connection scope; with none they stay disabled, which is all these tests
// need of them.
vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../contexts/ApiBaseContext')
  >()),
  useHostRequestAuthorityScope: () => null,
}));

const discardCommand = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  dispatchOrchestrationCommandWithReceipt: discardCommand,
}));

const NOW = Date.parse('2026-09-30T10:01:15.000Z');

/**
 * The summary every row here starts from: the fold-pinned running turn
 * (`FOLD_FIXTURES.runningTool`, which the server test proves is what the
 * server produces), plus a title and project for the row to show. Tests then
 * override NAMED FIELDS by hand to reach other states; those overrides are
 * written here, not folded, and the ladder's own fold-driven coverage lives
 * in `work-status.test.ts`.
 */
function session(
  over: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    threadId: 'T',
    status: 'running',
    createdAt: FOLD_SESSION_CREATED_AT,
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 2,
    displayTitle: 'Migrate sessions table',
    projectSlug: 'station',
    ...FOLD_FIXTURES.runningTool.summary,
    // One minute before NOW, so the row's time slot reads "1m".
    updatedAt: '2026-09-30T10:00:15.000Z',
    ...over,
  };
}

interface Row {
  item: HomeWorkItem;
  facts: WorkFacts | undefined;
}

/** A row the way a host builds one: the item, and its facts beside it. */
function rowFor(over: Partial<OrchestrationSessionSummary> = {}): Row {
  const sessions = [session(over)];
  const items = buildOrchestrationItems(sessions, []);
  return {
    item: items[0],
    facts: buildWorkFacts({ items, sessions }).get(items[0].id),
  };
}

function renderRow(
  row: Row,
  props: Partial<React.ComponentProps<typeof InboxRow>> = {},
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <InboxRow
        item={row.item}
        facts={row.facts}
        isCurrent={false}
        isSnoozed={false}
        isOpenChat={false}
        now={NOW}
        onActivate={vi.fn()}
        hoverCard={false}
        {...props}
      />
    </QueryClientProvider>,
  );
}

/** The status line as drawn: screen-reader-only text is not part of it. */
function statusText(): string {
  const clone = screen
    .getByTestId('inbox-row-status')
    .cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('.sr-only')) hidden.remove();
  return clone.textContent ?? '';
}

/** What a screen reader is told about the row: its description, with
 *  `aria-hidden` content left out as the accessibility tree leaves it out. */
function describedText(): string {
  const open = screen.getByTestId('inbox-row').querySelector('button')!;
  return (open.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => {
      const clone = document.getElementById(id)?.cloneNode(true) as Element;
      for (const hidden of clone.querySelectorAll('[aria-hidden="true"]'))
        hidden.remove();
      return clone.textContent ?? '';
    })
    .join(' ');
}

const SILENCE = {
  lastProgressEventAt: '2026-09-30T09:55:15.000Z',
  progressSilence: {
    detectedAt: '2026-09-30T10:00:15.000Z',
    windowMs: 300_000,
    silentSinceEventAt: '2026-09-30T09:55:15.000Z',
    provider: 'claude',
  },
} satisfies OrchestrationSessionSummary['turnProgress'];

const FAILED = {
  lifecycleState: 'failed',
  hasActiveTurn: false,
  terminalAttribution: {
    kind: 'runtime_error',
    detail:
      'The engine reported an error: Claude model "claude-opus-5" failed: stream ended early.',
  },
} satisfies Partial<OrchestrationSessionSummary>;

// The ticking duration reads the wall clock, so the wall clock is the
// fixtures' NOW. Only `Date` is faked here: timers stay real for the lazy
// details sheet; the ticking tests fake them explicitly.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Named overrides on the running summary, each reaching another rung. */
const STATES: ReadonlyArray<
  [name: string, over: Partial<OrchestrationSessionSummary>]
> = [
  ['running a tool', {}],
  [
    'approval while the turn is open',
    {
      lifecycleState: 'review_pending',
      transitionReason: 'review_requested',
      pendingReview: true,
    },
  ],
  ['failed with a reason', FAILED],
  ['idle', { hasActiveTurn: false, conversationActivity: undefined }],
];

describe('the row says exactly what the ladder says', () => {
  it.each(STATES)('%s', (_name, over) => {
    const row = rowFor(over);
    renderRow(row);
    const status = workStatus(row.item, NOW, row.facts);
    expect(statusText()).toBe(status.line);
    const element = screen.getByTestId('inbox-row');
    expect(element.dataset.statusRung).toBe(status.rung);
    expect(element.dataset.lane).toBe(status.lane);
  });

  it('without its facts a row says only what its label says', () => {
    renderRow({ item: rowFor().item, facts: undefined });
    expect(statusText()).toBe('Running');
  });

  it('a needs-approval row shows the status and opens the chat; it offers no inline decision', () => {
    const onActivate = vi.fn();
    const row = rowFor({
      lifecycleState: 'review_pending',
      transitionReason: 'review_requested',
      pendingReview: true,
    });
    renderRow(row, { onActivate, onSnoozeWake: vi.fn() });
    expect(statusText()).toBe('Needs approval');
    expect(screen.queryByRole('button', { name: /approve|deny/i })).toBeNull();
    screen
      .getByRole('button', { name: 'Migrate sessions table, station' })
      .click();
    expect(onActivate).toHaveBeenCalledWith(row.item);
  });

  it('status is never colour-only: every rung renders an icon beside its word', () => {
    const rungs: Partial<OrchestrationSessionSummary>[] = [
      {},
      { lifecycleState: 'needs_input', transitionReason: 'input_requested' },
      { lifecycleState: 'failed', hasActiveTurn: false },
      { lifecycleState: 'idle', hasActiveTurn: false },
    ];
    for (const over of rungs) {
      renderRow(rowFor(over));
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

  it('a silent run is not rendered with the healthy-running tone or icon', () => {
    const glyphPath = () =>
      screen
        .getByTestId('inbox-row-status')
        .querySelector('svg.inbox-row__status-glyph path')
        ?.getAttribute('d');
    const healthy = renderRow(rowFor());
    const healthyTone = screen.getByTestId('inbox-row-status').dataset.tone;
    const healthyGlyph = glyphPath();
    expect(healthyTone).toBe('active');
    healthy.unmount();

    renderRow(rowFor({ turnProgress: SILENCE }));
    expect(statusText()).toBe('No progress · Bash · 6m');
    expect(screen.getByTestId('inbox-row-status').dataset.tone).toBe('caution');
    expect(glyphPath()).toBeTruthy();
    expect(glyphPath()).not.toBe(healthyGlyph);
    // The turn is open and nothing is owed: it stays in the Running lane.
    expect(screen.getByTestId('inbox-row').dataset.lane).toBe('running');
  });
});

describe('what a screen reader and a ticking clock each get', () => {
  it('describes the row by its status, with a coarse duration instead of the ticking one', () => {
    renderRow(rowFor());
    expect(statusText()).toBe('Running · Bash · 1m');
    // The per-second number is hidden from the description; a duration that
    // only moves with the host's clock stands in for it.
    expect(describedText()).toBe('Running · Bash, for about 1 minute');
  });

  it('ticks once a second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderRow(rowFor());
    expect(statusText()).toBe('Running · Bash · 1m');
    act(() => {
      vi.advanceTimersByTime(48_000);
    });
    // 72s + 48s: the shared clock moved the duration to the next minute.
    expect(statusText()).toBe('Running · Bash · 2m');
  });

  it('shows the real elapsed time even when the list clock is 30s stale', () => {
    // The list's `now` advances on a coarse tick; a turn that started 25s
    // ago must not read "0s" because the list last ticked before it began.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderRow(rowFor(), { now: NOW - 30_000 });
    expect(statusText()).toBe('Running · Bash · 1m');
    act(() => {
      vi.advanceTimersByTime(48_000);
    });
    expect(statusText()).toBe('Running · Bash · 2m');
  });

  it('a host re-rendering with a fresh now does not restart the ticker', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const row = rowFor();
    const view = renderRow(row);
    const started = setIntervalSpy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(48_000);
    });
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <InboxRow
          item={row.item}
          facts={row.facts}
          isCurrent={false}
          isSnoozed={false}
          isOpenChat={false}
          now={NOW + 48_000}
          onActivate={vi.fn()}
          hoverCard={false}
        />
      </QueryClientProvider>,
    );
    expect(setIntervalSpy.mock.calls.length).toBe(started);
    expect(statusText()).toBe('Running · Bash · 2m');
    setIntervalSpy.mockRestore();
  });

  it('a row with no open turn runs no timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderRow(
      rowFor({ hasActiveTurn: false, conversationActivity: undefined }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a reason is readable in full on every surface', () => {
  it('a failure reason is on the row unshortened, may wrap, and is the row’s description', () => {
    renderRow(rowFor(FAILED));
    const status = screen.getByTestId('inbox-row-status');
    expect(status.className).toContain('inbox-row__status--reason');
    expect(screen.getByTestId('inbox-row-failure-reason').textContent).toBe(
      FAILED.terminalAttribution.detail,
    );
    expect(describedText()).toBe(
      `Failed · ${FAILED.terminalAttribution.detail}`,
    );
  });

  it('the unanswerable basis is on the row and in its description', () => {
    const row = rowFor({
      lifecycleState: 'review_pending',
      pendingReview: true,
      hasActiveTurn: false,
      answerability: {
        answerable: false,
        qualification: 'past_resume',
        observedBy: 'station-a',
        observedAt: '2026-09-30T10:00:10.000Z',
      },
    });
    renderRow(row);
    expect(row.item.unanswerableNotice).toMatch(/observed by station-a/);
    expect(screen.getByTestId('inbox-row-answerability').textContent).toBe(
      row.item.unanswerableNotice,
    );
    // Off the visible line (the word is "Elsewhere"; the basis is the
    // hover card's), still the row's description.
    expect(screen.getByTestId('inbox-row-status').className).not.toContain(
      'inbox-row__status--reason',
    );
    expect(describedText()).toContain(row.item.unanswerableNotice);
  });

  it('a line that is not a reason keeps the one-line budget', () => {
    renderRow(rowFor());
    expect(screen.getByTestId('inbox-row-status').className).not.toContain(
      'inbox-row__status--reason',
    );
  });

  it('a slim failed row shows the word and still describes the reason', () => {
    renderRow(rowFor(FAILED), { size: 'slim' });
    expect(statusText()).toBe('Failed');
    expect(describedText()).toBe(
      `Failed · ${FAILED.terminalAttribution.detail}`,
    );
  });

  it('touch chrome opens the card as a sheet holding every fact the row leaves off', async () => {
    const row = rowFor({
      ...FAILED,
      model: 'claude-opus-5',
      cwd: '/Users/me/dev/kontourai/station',
    });
    renderRow(row, { chrome: 'touch', hoverCard: true });
    const details = screen.getByRole('button', {
      name: 'Details for Migrate sessions table',
    });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);
    const sheet = await screen.findByTestId(
      'inbox-row-details',
      {},
      { timeout: 8000 },
    );
    expect(details.getAttribute('aria-expanded')).toBe('true');
    // The whole reason, the model and the folder.
    expect(sheet.textContent).toContain(FAILED.terminalAttribution.detail);
    expect(sheet.textContent).toContain(row.item.modelLabel);
    expect(sheet.textContent).toContain('…/kontourai/station');
    expect(sheet.textContent).toContain('Failed');
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByTestId('inbox-row-details')).toBeNull();
  });

  it('hover chrome offers no Details action: its card opens on hover and focus', () => {
    renderRow(rowFor(), { hoverCard: true, onSnoozeWake: vi.fn() });
    expect(screen.queryByRole('button', { name: /^Details for/ })).toBeNull();
  });
});

describe('the chip line exists only when a chip does', () => {
  it('renders no chip line for a row with no chip facts', () => {
    renderRow(rowFor());
    expect(screen.queryByTestId('inbox-row-chips')).toBeNull();
    expect(document.querySelector('.inbox-row__chip')).toBeNull();
  });

  it('shows the remote machine, the unsent draft and the woke marker each from its own fact', () => {
    const base = rowFor();
    const remote: Row = {
      ...base,
      item: {
        ...base.item,
        environmentLabel: 'brian-media',
        chatSessionId: 'chat-with-draft',
      },
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
    renderRow(rowFor(FAILED), {
      size: 'slim',
    });
    const row = screen.getByTestId('inbox-row');
    expect(row.className).toContain('inbox-row--slim');
    expect(row.querySelector('.inbox-row__meta')).toBeNull();
    expect(row.querySelector('.inbox-row__chips')).toBeNull();
    expect(statusText()).toBe('Failed');
    expect(row.querySelector('.inbox-row__time')?.textContent).toBe('1m');
  });

  it('a slim remote row still names its machine', () => {
    const base = rowFor();
    renderRow(
      { ...base, item: { ...base.item, environmentLabel: 'brian-media' } },
      { size: 'slim' },
    );
    expect(document.querySelector('.inbox-row__slim-remote')?.textContent).toBe(
      'brian-media',
    );
  });

  it('hover chrome offers snooze, named and with a tooltip, and no separate open control', () => {
    renderRow(rowFor(), { onSnoozeWake: vi.fn() });
    const snooze = screen.getByRole('button', {
      name: 'Snooze Migrate sessions table',
    });
    expect(snooze.getAttribute('title')).toBe('Snooze');
    // One control that opens the duration choice; never a one-tap default.
    expect(snooze.getAttribute('aria-haspopup')).toBe('menu');
    // The row itself opens; a second control would be a redundant tab stop.
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
  });

  const directActions = () =>
    [...document.querySelectorAll('.inbox-row__actions > button')].map(
      (button) => button.getAttribute('aria-label'),
    );

  it('touch chrome shows Details and one direct action; the rest are buttons in the sheet', async () => {
    const onSnoozeWake = vi.fn();
    const onCloseChat = vi.fn();
    const base = rowFor();
    renderRow(
      { ...base, item: { ...base.item, chatSessionId: 'tab-1' } },
      {
        chrome: 'touch',
        hoverCard: true,
        isOpenChat: true,
        onSnoozeWake,
        onCloseChat,
      },
    );
    // Snooze is the live row's one direct action; close moved to the sheet.
    expect(directActions()).toEqual([
      'Details for Migrate sessions table',
      'Snooze Migrate sessions table',
    ]);
    const details = screen.getByRole('button', {
      name: 'Details for Migrate sessions table',
    });
    fireEvent.click(details);
    const actions = await screen.findByTestId(
      'inbox-row-details-actions',
      {},
      { timeout: 8000 },
    );
    fireEvent.click(
      within(actions).getByRole('button', { name: 'Close chat' }),
    );
    // The host is handed the Details trigger, which is inside the row.
    expect(onCloseChat).toHaveBeenCalledWith('tab-1', details);
    expect(screen.queryByTestId('inbox-row-details')).toBeNull();
  });

  it('a row whose one action is close keeps it beside Details', () => {
    const base = rowFor();
    renderRow(
      { ...base, item: { ...base.item, chatSessionId: 'tab-1' } },
      {
        chrome: 'touch',
        hoverCard: true,
        isOpenChat: true,
        onCloseChat: vi.fn(),
      },
    );
    expect(directActions()).toEqual([
      'Details for Migrate sessions table',
      'Close Migrate sessions table',
    ]);
  });

  it('a slim touch row shows Details alone, with its actions in the sheet', async () => {
    const onSnoozeWake = vi.fn();
    const row = rowFor();
    renderRow(row, {
      chrome: 'touch',
      size: 'slim',
      hoverCard: true,
      isSnoozed: true,
      onSnoozeWake,
    });
    expect(directActions()).toEqual(['Details for Migrate sessions table']);
    const details = screen.getByRole('button', { name: /^Details for/ });
    fireEvent.click(details);
    const actions = await screen.findByTestId(
      'inbox-row-details-actions',
      {},
      { timeout: 8000 },
    );
    fireEvent.click(within(actions).getByRole('button', { name: 'Unsnooze' }));
    expect(onSnoozeWake).toHaveBeenCalledWith(row.item, null, details);
  });

  it('a host that offers no actions gets no slot and no extra tab stop', () => {
    renderRow(rowFor());
    expect(document.querySelector('.inbox-row__actions')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

describe('the Details sheet belongs to the item, not to the row instance', () => {
  const group = (id: 'idle' | 'running', item: HomeWorkItem) => ({
    id,
    label: id,
    items: [item],
  });

  it('stays open when its row changes lane, and returns focus to the row’s new position', async () => {
    const idle = rowFor({
      hasActiveTurn: false,
      conversationActivity: undefined,
    }).item;
    const running = rowFor().item;
    expect(idle.id).toBe(running.id);
    const list = (groups: ReturnType<typeof group>[]) => (
      <QueryClientProvider client={new QueryClient()}>
        <InboxGroupList
          groups={groups}
          idPrefix="test"
          activeChatSessionId={null}
          openChatIds={new Set()}
          now={NOW}
          chrome="touch"
          onActivate={vi.fn()}
          onSnoozeWake={vi.fn()}
        />
      </QueryClientProvider>
    );
    const view = render(list([group('idle', idle)]));
    fireEvent.click(screen.getByRole('button', { name: /^Details for/ }));
    await screen.findByTestId('inbox-row-details', {}, { timeout: 8000 });

    // The agent starts a turn: the row leaves Idle and mounts under Running.
    view.rerender(list([group('running', running)]));
    expect(screen.getByTestId('inbox-row').dataset.lane).toBe('running');
    await screen.findByTestId('inbox-row-details', {}, { timeout: 8000 });

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByTestId('inbox-row-details')).toBeNull();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /^Details for/ }),
      ),
    );
  });
});

describe('an unsent composer draft on touch chrome (U11)', () => {
  it('its Details sheet offers Discard unsent draft, which clears the composer and the store', async () => {
    const base = rowFor({
      hasActiveTurn: false,
      conversationActivity: undefined,
    });
    const row: Row = {
      facts: undefined,
      item: { ...base.item, chatSessionId: 'tab-draft' },
    };
    chatDraftsStore.set('tab-draft', 'Draft on the phone: check the README');
    try {
      renderRow(row, { chrome: 'touch', hoverCard: true, isOpenChat: true });
      expect(screen.getByText('Unsent draft')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /^Details for/ }));
      await screen.findByTestId('inbox-row-details', {}, { timeout: 8000 });
      const discard = screen.getByRole('button', {
        name: 'Discard unsent draft for Migrate sessions table',
      });
      expect(discard.classList.contains('action-overflow__row--danger')).toBe(
        true,
      );
      fireEvent.click(discard);
      expect(chatDraftsStore.hasDraft('tab-draft')).toBe(false);
      // The chip reads the same store, so it goes with the text.
      expect(screen.queryByText('Unsent draft')).toBeNull();
      expect(screen.queryByTestId('inbox-row-details')).toBeNull();
    } finally {
      chatDraftsStore.clear('tab-draft');
    }
  });

  it('a row with no unsent draft offers no such row', async () => {
    const base = rowFor({
      hasActiveTurn: false,
      conversationActivity: undefined,
    });
    renderRow(
      { facts: undefined, item: { ...base.item, chatSessionId: 'tab-clean' } },
      {
        chrome: 'touch',
        hoverCard: true,
        isOpenChat: true,
        onCloseChat: vi.fn(),
      },
    );
    fireEvent.click(screen.getByRole('button', { name: /^Details for/ }));
    await screen.findByTestId('inbox-row-details', {}, { timeout: 8000 });
    expect(
      screen.queryByRole('button', { name: /^Discard unsent draft/ }),
    ).toBeNull();
  });
});

describe('a Draft row on touch chrome', () => {
  const draftRow = (): Row => {
    const base = rowFor({
      hasActiveTurn: false,
      conversationActivity: undefined,
    });
    return {
      facts: undefined,
      item: { ...base.item, lifecycleLabel: 'Draft', turnProgress: undefined },
    };
  };
  const rowElement = () => screen.getByTestId('inbox-row');

  it('its one direct action is Discard, and the host is handed a button inside the row', async () => {
    discardCommand.mockClear();
    const onDraftDiscarded = vi.fn();
    const row = draftRow();
    renderRow(row, {
      chrome: 'touch',
      hoverCard: true,
      onSnoozeWake: vi.fn(),
      onDraftDiscarded,
    });
    expect(
      [...document.querySelectorAll('.inbox-row__actions > button')].map(
        (button) => button.getAttribute('aria-label'),
      ),
    ).toEqual([
      'Details for Migrate sessions table',
      'Discard draft Migrate sessions table',
    ]);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Discard draft Migrate sessions table',
      }),
    );
    await vi.waitFor(() => expect(onDraftDiscarded).toHaveBeenCalledTimes(1));
    expect(discardCommand).toHaveBeenCalledWith({
      type: 'discardDraft',
      threadId: 'T',
    });
    const [item, action] = onDraftDiscarded.mock.calls[0];
    expect(item).toBe(row.item);
    expect(rowElement().contains(action)).toBe(true);
  });

  it('from the Details sheet, Discard is a labelled button that closes the sheet and hands the host the row’s trigger', async () => {
    discardCommand.mockClear();
    const onDraftDiscarded = vi.fn();
    const row = draftRow();
    // A slim row shows Details alone, so its discard lives in the sheet.
    renderRow(row, {
      chrome: 'touch',
      size: 'slim',
      hoverCard: true,
      onDraftDiscarded,
    });
    const details = screen.getByRole('button', { name: /^Details for/ });
    fireEvent.click(details);
    const actions = await screen.findByTestId(
      'inbox-row-details-actions',
      {},
      { timeout: 8000 },
    );
    const discard = within(actions).getByRole('button', {
      name: 'Discard draft Migrate sessions table',
    });
    expect(discard.textContent).toBe('Discard draft');
    fireEvent.click(discard);
    await vi.waitFor(() => expect(onDraftDiscarded).toHaveBeenCalledTimes(1));
    // Not the portaled sheet button: the row's own Details trigger, which
    // the host can find its row from to move focus before the row goes.
    expect(onDraftDiscarded).toHaveBeenCalledWith(row.item, details);
    expect(rowElement().contains(details)).toBe(true);
    expect(screen.queryByTestId('inbox-row-details')).toBeNull();
  });
});

describe('a Details sheet whose row leaves the list', () => {
  it('is closed, and does not reopen when the row comes back', async () => {
    const earlier = rowFor({
      lifecycleState: 'idle',
      hasActiveTurn: false,
      conversationActivity: undefined,
    }).item;
    const list = (expanded: boolean) => (
      <QueryClientProvider client={new QueryClient()}>
        <InboxGroupList
          groups={[{ id: 'earlier', label: 'Earlier', items: [earlier] }]}
          idPrefix="test"
          activeChatSessionId={null}
          openChatIds={new Set()}
          now={NOW}
          chrome="touch"
          collapsible={{
            sections: { snoozed: false, earlier: expanded },
            onToggle: vi.fn(),
          }}
          onActivate={vi.fn()}
          onSnoozeWake={vi.fn()}
        />
      </QueryClientProvider>
    );
    const view = render(list(true));
    fireEvent.click(screen.getByRole('button', { name: /^Details for/ }));
    await screen.findByTestId('inbox-row-details', {}, { timeout: 8000 });

    // The section is collapsed: its rows, and the sheet, are gone.
    view.rerender(list(false));
    await vi.waitFor(() =>
      expect(screen.queryByTestId('inbox-row-details')).toBeNull(),
    );
    expect(screen.queryByTestId('inbox-row')).toBeNull();

    // Expanded again: the row is back and nothing reopens by itself.
    view.rerender(list(true));
    expect(screen.getByTestId('inbox-row')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId('inbox-row-details')).toBeNull();
    expect(
      screen
        .getByRole('button', { name: /^Details for/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });
});

describe('the Details sheet’s actions are a menu list, never a row of buttons', () => {
  const openSheet = async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Details for/ }));
    await screen.findByTestId('inbox-row-details', {}, { timeout: 8000 });
  };

  it('a slim draft row lists snooze presets under a Snooze group, then close, with Discard last and marked', async () => {
    const onSnoozeWake = vi.fn();
    const base = rowFor({
      hasActiveTurn: false,
      conversationActivity: undefined,
    });
    const row: Row = {
      facts: undefined,
      item: {
        ...base.item,
        lifecycleLabel: 'Draft',
        turnProgress: undefined,
        chatSessionId: 'tab-1',
      },
    };
    renderRow(row, {
      chrome: 'touch',
      size: 'slim',
      hoverCard: true,
      isOpenChat: true,
      onSnoozeWake,
      onCloseChat: vi.fn(),
      onDraftDiscarded: vi.fn(),
    });
    await openSheet();
    const menu = screen.getByTestId('inbox-row-details-actions');
    // The shared menu primitive, group by group; every row full-width with
    // an icon in the glyph slot and a label.
    expect(menu.className).toContain('menu-surface');
    const groups = [...menu.children];
    expect(
      groups.every((group) => group.classList.contains('menu-group')),
    ).toBe(true);
    expect(
      groups.map((group) =>
        [...group.querySelectorAll('button')].map(
          (button) => button.textContent,
        ),
      ),
    ).toEqual([
      ['1 hour', '3 hours', 'Tomorrow 9am', 'Next Monday 9am'],
      ['Close chat'],
      ['Discard draft'],
    ]);
    expect(within(groups[0] as HTMLElement).getByText('Snooze')).toBeTruthy();
    expect(
      screen.getByRole('group', { name: 'Snooze' }).contains(groups[0]),
    ).toBe(true);
    for (const button of menu.querySelectorAll('button')) {
      expect(button.classList.contains('menu-row')).toBe(true);
      expect(button.querySelector('svg')).not.toBeNull();
    }
    const discard = within(menu).getByRole('button', {
      name: 'Discard draft Migrate sessions table',
    });
    expect(discard.className).toContain('action-overflow__row--danger');
    // A preset goes through the sheet: closes it, hands over the trigger.
    const details = screen.getByRole('button', { name: /^Details for/ });
    fireEvent.click(within(menu).getByRole('button', { name: '3 hours' }));
    expect(onSnoozeWake).toHaveBeenCalledWith(
      row.item,
      NOW + 3 * 3_600_000,
      details,
    );
    expect(screen.queryByTestId('inbox-row-details')).toBeNull();
  });

  it('a row that keeps nothing in the sheet renders no list at all', async () => {
    // Home's Draft row: Discard is beside the row and there is no snooze.
    const base = rowFor({
      hasActiveTurn: false,
      conversationActivity: undefined,
    });
    renderRow(
      {
        facts: undefined,
        item: {
          ...base.item,
          lifecycleLabel: 'Draft',
          turnProgress: undefined,
        },
      },
      { chrome: 'touch', hoverCard: true, onDraftDiscarded: vi.fn() },
    );
    await openSheet();
    expect(screen.queryByTestId('inbox-row-details-actions')).toBeNull();
    expect(
      screen.getByTestId('inbox-row-details').querySelector('.menu-surface'),
    ).toBeNull();
  });

  it('opens on the dialog layer when its row sits inside a dialog-layer host, and as a popover otherwise', async () => {
    // A popover-layer sheet opened from the mobile task switcher (a dialog)
    // would paint UNDER the switcher. The layer follows the host's computed
    // layer, not which host it is.
    document.documentElement.style.setProperty(
      '--layer-surface-popover',
      '9250',
    );
    const layerOf = () =>
      screen
        .getByTestId('inbox-row-details')
        .closest('.responsive-surface-overlay')
        ?.getAttribute('data-responsive-layer');
    try {
      const inDialog = render(
        <div style={{ position: 'fixed', zIndex: 10000 }}>
          <QueryClientProvider client={new QueryClient()}>
            <InboxRow
              item={rowFor().item}
              isCurrent={false}
              isSnoozed={false}
              isOpenChat={false}
              now={NOW}
              chrome="touch"
              onActivate={vi.fn()}
            />
          </QueryClientProvider>
        </div>,
      );
      await openSheet();
      expect(layerOf()).toBe('dialog');
      inDialog.unmount();

      renderRow(rowFor(), { chrome: 'touch', hoverCard: true });
      await openSheet();
      expect(layerOf()).toBe('popover');
    } finally {
      document.documentElement.style.removeProperty('--layer-surface-popover');
    }
  });
});

describe('#3159: a row whose conversation may be referenced is a drag source', () => {
  const scope = { apiBase: 'http://station.test' };
  afterEach(() => publishReferenceableConversations(null));

  it('drags its conversation, from its Station, onto a composer', () => {
    const row = rowFor();
    publishReferenceableConversations({
      apiBase: scope.apiBase,
      ids: new Set([row.item.id]),
    });
    renderRow(row);
    const button = screen.getByRole('button', {
      name: new RegExp(row.item.title),
    });
    expect(button.getAttribute('draggable')).toBe('true');
    const values = new Map<string, string>();
    fireEvent.dragStart(button, {
      dataTransfer: {
        setData: (type: string, value: string) => values.set(type, value),
        effectAllowed: 'all',
      },
    });
    expect(values.get(CONVERSATION_REFERENCE_DRAG_TYPE)).toBe(row.item.id);
    expect(draggedConversationReference(row.item.id, scope)).toMatchObject({
      id: row.item.id,
      title: row.item.title,
    });
    fireEvent.dragEnd(button);
    expect(draggedConversationReference(row.item.id, scope)).toBeNull();
  });

  it('is not draggable when the inventory does not mark it referenceable', () => {
    const row = rowFor();
    publishReferenceableConversations({
      apiBase: scope.apiBase,
      ids: new Set(['another-conversation']),
    });
    renderRow(row);
    expect(
      screen
        .getByRole('button', { name: new RegExp(row.item.title) })
        .hasAttribute('draggable'),
    ).toBe(false);
  });
});

describe("the project's colour is a swatch, never the name's colour", () => {
  it('draws a decorative dot before the project name, which stays text in the row’s own colour', () => {
    renderRow(rowFor(), { projectAccent: 'var(--event-tool-call)' });
    const row = screen.getByTestId('inbox-row');
    const swatch = row.querySelector<HTMLElement>('.inbox-row__project-accent');
    expect(swatch).not.toBeNull();
    expect(swatch!.getAttribute('aria-hidden')).toBe('true');
    expect(swatch!.style.backgroundColor).toBe('var(--event-tool-call)');
    // Before the name, beside it on the meta line.
    const project = row.querySelector<HTMLElement>('.inbox-row__project')!;
    expect(swatch!.nextElementSibling).toBe(project);
    expect(project.textContent).toBe('station');
    // The accent is never a text colour (accent-foreground ratchet).
    expect(project.style.color).toBe('');
    expect(
      row.querySelector('.inbox-row__meta-text')!.getAttribute('style'),
    ).toBeNull();
    // The open button's name still says the project in words.
    expect(row.querySelector('button')!.getAttribute('aria-label')).toContain(
      'station',
    );
  });

  it('a row with no accent draws no swatch', () => {
    renderRow(rowFor());
    expect(document.querySelector('.inbox-row__project-accent')).toBeNull();
  });

  it('a list resolves each row’s accent by its project slug', () => {
    const station = rowFor().item;
    const other = rowFor({ threadId: 'U', projectSlug: 'other' }).item;
    const unbound = rowFor({ threadId: 'V', projectSlug: undefined }).item;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <InboxGroupList
          groups={[
            { id: 'idle', label: 'Idle', items: [station, other, unbound] },
          ]}
          idPrefix="test"
          activeChatSessionId={null}
          openChatIds={new Set()}
          now={NOW}
          onActivate={vi.fn()}
          onSnoozeWake={vi.fn()}
          projectAccentBySlug={
            new Map([
              ['station', 'var(--event-agent-start)'],
              ['other', 'var(--event-reasoning)'],
            ])
          }
        />
      </QueryClientProvider>,
    );
    const colours = screen
      .getAllByTestId('inbox-row')
      .map(
        (row) =>
          row.querySelector<HTMLElement>('.inbox-row__project-accent')?.style
            .backgroundColor ?? null,
      );
    expect(colours).toEqual([
      'var(--event-agent-start)',
      'var(--event-reasoning)',
      null,
    ]);
  });
});

describe("the project's icon takes the swatch's place when it has one", () => {
  const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

  it('draws the icon, decorative, before the name — not the dot', () => {
    renderRow(rowFor(), {
      projectAccent: 'var(--event-tool-call)',
      projectIcon: IMAGE,
    });
    const row = screen.getByTestId('inbox-row');
    const mark = row.querySelector<HTMLElement>('.inbox-row__project-accent');
    expect(mark?.querySelector('img')?.getAttribute('src')).toBe(IMAGE);
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.classList.contains('project-icon--dot')).toBe(false);
    expect(mark?.nextElementSibling?.textContent).toBe('station');
    // The open button's name still says the project in words, once.
    expect(row.querySelector('button')!.getAttribute('aria-label')).toContain(
      'station',
    );
  });

  it('the phone sheet’s project line draws it too', () => {
    renderRow(rowFor(), {
      projectAccent: 'var(--event-tool-call)',
      projectIcon: '🧭',
      actionsInDetails: true,
    });
    const context = screen
      .getByTestId('inbox-row')
      .querySelector('.inbox-row__project-context');
    expect(
      context?.querySelector('.inbox-row__project-accent .brand-icon__glyph')
        ?.textContent,
    ).toBe('🧭');
  });

  it('a list resolves each row’s icon by its project slug', () => {
    const station = rowFor().item;
    const other = rowFor({ threadId: 'U', projectSlug: 'other' }).item;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <InboxGroupList
          groups={[{ id: 'idle', label: 'Idle', items: [station, other] }]}
          idPrefix="test"
          activeChatSessionId={null}
          openChatIds={new Set()}
          now={NOW}
          onActivate={vi.fn()}
          onSnoozeWake={vi.fn()}
          projectAccentBySlug={
            new Map([
              ['station', 'var(--event-agent-start)'],
              ['other', 'var(--event-reasoning)'],
            ])
          }
          projectIconBySlug={new Map([['station', IMAGE]])}
        />
      </QueryClientProvider>,
    );
    const marks = screen
      .getAllByTestId('inbox-row')
      .map((row) =>
        row.querySelector<HTMLElement>('.inbox-row__project-accent'),
      );
    expect(marks[0]?.querySelector('img')?.getAttribute('src')).toBe(IMAGE);
    expect(marks[1]?.querySelector('img')).toBeNull();
    expect(marks[1]?.style.backgroundColor).toBe('var(--event-reasoning)');
  });
});
