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
import {
  resetPendingUndoForTest,
  undoLatestAction,
} from '../../undo/UndoableActionShortcut';
import { inboxRowChips } from '../inbox-row-chips';
import { snoozeChoices } from '../snooze-presets';

// The details sheet's on-demand reads (git, pull requests, basis) need a
// connection scope; with none they stay disabled, which is all these tests
// need of them.
const discardAuthority = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../contexts/ApiBaseContext')
  >()),
  useHostRequestAuthorityScope: () =>
    discardAuthority.enabled
      ? {
          apiBase: 'http://station.test',
          authorityKey: 'inbox-row-test',
          isCurrent: () => true,
        }
      : null,
}));

const discardCommand = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<object>>(async () => ({})),
);
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  dispatchOrchestrationCommandWithReceipt: discardCommand,
}));

const resolutionState = vi.hoisted(() => ({
  supported: false,
  settled: {} as Record<string, string>,
  mutate: vi.fn(),
}));
vi.mock('../../chat-dock/useConversationWorkState', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../chat-dock/useConversationWorkState')
    >();
  return {
    ...actual,
    useConversationWorkState: () => ({
      ...actual.useConversationWorkState(),
      supported: resolutionState.supported,
      settled: resolutionState.settled,
      change: { isPending: false, mutate: resolutionState.mutate },
    }),
  };
});

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

// The off-screen reason and duration are directly referenced even when
// hidden from the button's name.
function describedText(): string {
  const open = screen.getByTestId('inbox-row').querySelector('button')!;
  return (open.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
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
      .getByRole('button', { name: /^Migrate sessions table.*station/ })
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
    expect(statusText()).toBe('No progress · Bash · 6m 0s');
    expect(screen.getByTestId('inbox-row-status').dataset.tone).toBe('caution');
    expect(glyphPath()).toBeTruthy();
    expect(glyphPath()).not.toBe(healthyGlyph);
    // The turn is open and nothing is owed: it stays in the Running lane.
    expect(screen.getByTestId('inbox-row').dataset.lane).toBe('running');
  });
});

describe('what a screen reader and a ticking clock each get', () => {
  it('names the visible status once and describes the coarse duration', () => {
    renderRow(rowFor());
    expect(statusText()).toBe('Running · Bash · 1m 12s');
    // The per-second number is hidden from the description; a duration that
    // only moves with the host's clock stands in for it.
    expect(
      screen.getByRole('button', {
        name: /^Migrate sessions table.*Running · Bash.*station/,
        description: /^for about 1 minute$/,
      }),
    ).toBeTruthy();
    expect(describedText()).toBe('for about 1 minute');
  });

  it('ticks once a second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderRow(rowFor());
    expect(statusText()).toBe('Running · Bash · 1m 12s');
    act(() => {
      vi.advanceTimersByTime(48_000);
    });
    // 72s + 48s: the shared clock moved the duration to the next minute.
    expect(statusText()).toBe('Running · Bash · 2m 0s');
  });

  it('shows the real elapsed time even when the list clock is 30s stale', () => {
    // The list's `now` advances on a coarse tick; a turn that started 25s
    // ago must not read "0s" because the list last ticked before it began.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderRow(rowFor(), { now: NOW - 30_000 });
    expect(statusText()).toBe('Running · Bash · 1m 12s');
    act(() => {
      vi.advanceTimersByTime(48_000);
    });
    expect(statusText()).toBe('Running · Bash · 2m 0s');
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
          now={NOW + 48_000}
          onActivate={vi.fn()}
          hoverCard={false}
        />
      </QueryClientProvider>,
    );
    expect(setIntervalSpy.mock.calls.length).toBe(started);
    expect(statusText()).toBe('Running · Bash · 2m 0s');
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
    expect(
      screen.getByRole('button', {
        name: /^Migrate sessions table.*Failed.*The engine reported an error/,
      }),
    ).toBeTruthy();
    expect(describedText()).toBe('');
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
    // Off the visible line (the word is "Read only"; the basis is the
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
    expect(describedText()).toBe(FAILED.terminalAttribution.detail);
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

  it('a hold on a touch-chrome row opens its Details sheet, and does not also open the chat', async () => {
    const onActivate = vi.fn();
    const row = rowFor(FAILED);
    vi.useFakeTimers();
    try {
      renderRow(row, { chrome: 'touch', hoverCard: true, onActivate });
      const open = screen.getByRole('button', {
        name: /^Migrate sessions table/,
      });
      fireEvent.pointerDown(open, {
        pointerType: 'touch',
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.pointerUp(open, { pointerType: 'touch' });
      fireEvent.click(open);
    } finally {
      vi.useRealTimers();
    }
    expect(onActivate).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole('button', { name: 'Details for Migrate sessions table' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      await screen.findByTestId('inbox-row-details', {}, { timeout: 8000 }),
    ).toBeTruthy();
  });

  it('a hover-chrome row leaves the right-click alone: its actions are beside the pointer', () => {
    renderRow(rowFor(), { hoverCard: true, onSnoozeWake: vi.fn() });
    const open = screen.getByRole('button', {
      name: /^Migrate sessions table/,
    });
    expect(fireEvent.contextMenu(open)).toBe(true);
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

  it('shows the remote machine and the woke marker as chips, and the unsent draft as a pencil on the project line', () => {
    const base = rowFor();
    const remote: Row = {
      ...base,
      item: {
        ...base.item,
        environmentLabel: 'home-media',
        chatSessionId: 'chat-with-draft',
      },
    };
    chatDraftsStore.set('chat-with-draft', 'unsent');
    renderRow(remote, { isWoken: true });
    expect(
      [...document.querySelectorAll('.inbox-row__chip')].map((chip) => [
        chip.getAttribute('data-chip'),
        chip.textContent?.trim(),
      ]),
    ).toEqual([
      ['remote', 'Station: home-media'],
      ['woke', 'Woke from snooze'],
    ]);
    // #4266: no full-line "Unsent draft" chip. A pencil after the project,
    // hidden from assistive tech: the row's name already says it.
    const marker = screen.getByTestId('inbox-row-draft-marker');
    expect(marker.getAttribute('title')).toBe('Unsent draft');
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(marker.closest('.inbox-row__context')).not.toBeNull();
    expect(screen.queryByText('Unsent draft')).toBeNull();
    expect(
      screen.getByRole('button', { name: /\bunsent draft$/ }),
    ).toBeTruthy();
    act(() => chatDraftsStore.clear('chat-with-draft'));
    expect(screen.queryByTestId('inbox-row-draft-marker')).toBeNull();
  });

  it('shows peer Station provenance from work facts with a project mark', () => {
    const row = rowFor();
    renderRow({
      ...row,
      facts: {
        ...row.facts!,
        station: { id: 'peer-1', label: 'Build Station' },
      },
    });
    expect(screen.getByText('Station: Build Station')).toBeTruthy();
    expect(document.querySelector('.project-icon')).not.toBeNull();
  });

  it('does not borrow host artwork or colour for a peer-bound chat with the same project slug', () => {
    const row = rowFor();
    renderRow(
      {
        ...row,
        facts: {
          ...row.facts!,
          station: { id: 'peer', label: 'Peer Station' },
        },
      },
      { projectIcon: '🚀', projectAccent: '#ff8800' },
    );
    expect(document.querySelector('.project-icon--icon')).toBeNull();
    expect(document.querySelector('.project-icon--initials')).not.toBeNull();
    expect(document.querySelector('[data-project-icon="dot"]')).toBeNull();
  });

  it('the chip derivation, fact by fact', () => {
    expect(inboxRowChips({})).toEqual([]);
    expect(inboxRowChips({ receivedAgentMessage: true })).toEqual([
      { kind: 'agent-message', label: 'Agent message' },
    ]);
    expect(inboxRowChips({}, { isWoken: false })).toEqual([]);
    expect(inboxRowChips({ environmentLabel: 'box' })).toEqual([
      { kind: 'remote', label: 'Station: box' },
    ]);
  });
});

describe('the picker project line draws one project mark (#4266)', () => {
  it('a project without an icon shows one initials mark beside its name', () => {
    const { container } = renderRow(rowFor(), {
      actionsInDetails: true,
      chrome: 'touch',
      projectAccent: '#ff8800',
    });
    const line = container.querySelector('.inbox-row__project-line')!;
    expect(line.querySelectorAll('.project-icon--initials')).toHaveLength(1);
    expect(line.querySelector('[data-project-icon]')).toBeNull();
    expect(line.querySelector('.inbox-row__project')?.textContent).toBeTruthy();
  });

  it('a project with its own icon shows that icon instead of initials', () => {
    const { container } = renderRow(rowFor(), {
      actionsInDetails: true,
      chrome: 'touch',
      projectAccent: '#ff8800',
      projectIcon: '🚀',
    });
    const line = container.querySelector('.inbox-row__project-line')!;
    expect(line.querySelector('.project-icon--initials')).toBeNull();
    expect(line.querySelector('.project-icon--icon')?.textContent).toBe('🚀');
  });

  it('an unsent draft is a pencil on the picker project line, not a chip', () => {
    const base = rowFor();
    chatDraftsStore.set('picker-draft', 'half a thought');
    try {
      const { container } = renderRow(
        { ...base, item: { ...base.item, chatSessionId: 'picker-draft' } },
        { actionsInDetails: true, chrome: 'touch' },
      );
      const line = container.querySelector('.inbox-row__project-line')!;
      expect(
        line.querySelector('[data-testid="inbox-row-draft-marker"]'),
      ).not.toBeNull();
      expect(container.querySelector('.inbox-row__chips')).toBeNull();
    } finally {
      chatDraftsStore.clear('picker-draft');
    }
  });

  it('the agent is named in visible text beside its marks', () => {
    const { container } = renderRow(rowFor(), {
      actionsInDetails: true,
      chrome: 'touch',
    });
    const text = container.querySelector('.inbox-row__agent');
    expect(text?.className).not.toContain('sr-only');
    expect(container.querySelector('.inbox-row__agent')?.textContent).toBe(
      rowFor().item.agentLabel,
    );
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
      { ...base, item: { ...base.item, environmentLabel: 'home-media' } },
      { size: 'slim' },
    );
    expect(document.querySelector('.inbox-row__slim-remote')?.textContent).toBe(
      'home-media',
    );
  });

  it.each(['hover', 'touch'] as const)(
    '%s chrome leaves snooze times unformatted until its actions open',
    (chrome) => {
      const formattedTime = vi.spyOn(Date.prototype, 'toLocaleTimeString');
      try {
        renderRow(rowFor(), { chrome, hoverCard: true, onSnoozeWake: vi.fn() });
        expect(formattedTime).not.toHaveBeenCalled();
        fireEvent.click(
          screen.getByRole('button', {
            name:
              chrome === 'hover'
                ? 'Actions for Migrate sessions table'
                : 'Snooze Migrate sessions table',
          }),
        );
        expect(
          screen.getByRole('menuitem', { name: /^In 1 hour,/ }),
        ).toBeTruthy();
        expect(formattedTime).toHaveBeenCalled();
      } finally {
        formattedTime.mockRestore();
      }
    },
  );

  it('hover chrome puts the row actions behind one ⋯ menu, in the one order', () => {
    const row = rowFor({ hasActiveTurn: false });
    const onActivate = vi.fn();
    const onSnoozeWake = vi.fn();
    renderRow(row, {
      onActivate,
      onSnoozeWake,
      done: { done: false, onSelect: vi.fn() },
    });
    const more = screen.getByRole('button', {
      name: 'Actions for Migrate sessions table',
    });
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    // The row itself opens; no other control sits beside the menu.
    expect(
      document.querySelectorAll('.inbox-row__actions button'),
    ).toHaveLength(1);
    fireEvent.click(more);
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.firstChild?.textContent),
    ).toEqual([
      'Open chat',
      'Mark done',
      ...snoozeChoices(NOW).map((choice) => choice.label),
    ]);
    // Each snooze choice says the time it ends.
    const [first] = snoozeChoices(NOW);
    expect(
      within(menu).getByRole('menuitem', {
        name: new RegExp(`^${first.label},`),
      }).textContent,
    ).toBe(`${first.label}, ${first.hint}`);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open chat' }));
    expect(onActivate).toHaveBeenCalledWith(row.item);
    fireEvent.click(more);
    fireEvent.click(
      screen.getByRole('menuitem', { name: new RegExp(`^${first.label},`) }),
    );
    expect(onSnoozeWake).toHaveBeenCalledWith(row.item, first.wakeAt, more);
  });

  const directActions = () =>
    [...document.querySelectorAll('.inbox-row__actions > button')].map(
      (button) => button.getAttribute('aria-label'),
    );

  it('touch chrome shows Details and one direct action; the rest are buttons in the sheet', async () => {
    const onSnoozeWake = vi.fn();
    const onSelect = vi.fn();
    const base = rowFor();
    renderRow(
      { ...base, item: { ...base.item, chatSessionId: 'tab-1' } },
      {
        chrome: 'touch',
        hoverCard: true,
        onSnoozeWake,
        done: { done: false, onSelect },
      },
    );
    // Snooze is the live row's one direct action; Mark done is in the sheet.
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
    // Open chat leads; Close is not an inbox action.
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent)
        .slice(0, 2),
    ).toEqual(['Open chat', 'Mark done']);
    expect(
      within(actions).queryByRole('button', { name: /^Close/ }),
    ).toBeNull();
    fireEvent.click(within(actions).getByRole('button', { name: 'Mark done' }));
    // The host is handed the Details trigger, which is inside the row.
    expect(onSelect).toHaveBeenCalledWith(details);
    expect(screen.queryByTestId('inbox-row-details')).toBeNull();
  });

  it('a touch row whose one action is Mark done keeps it in the sheet', () => {
    renderRow(rowFor(), {
      chrome: 'touch',
      hoverCard: true,
      done: { done: false, onSelect: vi.fn() },
    });
    expect(directActions()).toEqual(['Details for Migrate sessions table']);
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
    fireEvent.click(within(actions).getByRole('button', { name: 'Wake now' }));
    expect(onSnoozeWake).toHaveBeenCalledWith(row.item, null, details);
  });

  it('a host that offers no actions gets no slot and no extra tab stop', () => {
    renderRow(rowFor());
    expect(document.querySelector('.inbox-row__actions')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

describe('shared inbox actions', () => {
  it('keeps snooze choices in Details when Snooze is also a row shortcut', async () => {
    const row = rowFor();
    const onSnoozeWake = vi.fn();
    renderRow(row, {
      chrome: 'touch',
      hoverCard: true,
      onSnoozeWake,
    });
    expect(
      screen.getByRole('button', { name: 'Snooze Migrate sessions table' }),
    ).toBeTruthy();
    const details = screen.getByRole('button', { name: /^Details for/ });
    fireEvent.click(details);
    const actions = await screen.findByTestId(
      'inbox-row-details-actions',
      {},
      { timeout: 8000 },
    );
    const [first] = snoozeChoices(NOW);
    fireEvent.click(
      within(actions).getByRole('button', {
        name: new RegExp(`^${first.label},`),
      }),
    );
    expect(onSnoozeWake).toHaveBeenCalledWith(
      row.item,
      NOW + 3_600_000,
      details,
    );
    expect(screen.queryByTestId('inbox-row-details')).toBeNull();
  });

  it.each([false, true])(
    'runs the same Mark done command from the desktop menu and Details (done: %s)',
    async (isDone) => {
      const onSelect = vi.fn();
      const row = rowFor({
        hasActiveTurn: false,
        conversationActivity: undefined,
      });
      const done = { done: isDone, pending: false, onSelect };
      const verb = isDone ? 'Reopen' : 'Mark done';
      renderRow(row, { done });
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Actions for Migrate sessions table',
        }),
      );
      fireEvent.click(screen.getByRole('menuitem', { name: verb }));
      expect(onSelect).toHaveBeenCalledTimes(1);
      cleanup();

      renderRow(row, { chrome: 'touch', hoverCard: true, done });
      fireEvent.click(screen.getByRole('button', { name: /^Details for/ }));
      const actions = await screen.findByTestId(
        'inbox-row-details-actions',
        {},
        { timeout: 8000 },
      );
      fireEvent.click(within(actions).getByRole('button', { name: verb }));
      expect(onSelect).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('inbox-row-details')).toBeNull();
    },
  );

  it.each(['hover', 'touch'] as const)(
    'does not resubmit a pending Mark done through %s actions',
    async (chrome) => {
      const onSelect = vi.fn();
      renderRow(rowFor(), {
        chrome,
        hoverCard: true,
        done: { done: false, pending: true, onSelect },
      });
      if (chrome === 'touch') {
        fireEvent.click(screen.getByRole('button', { name: /^Details for/ }));
        await screen.findByTestId(
          'inbox-row-details-actions',
          {},
          { timeout: 8000 },
        );
      } else
        fireEvent.click(screen.getByRole('button', { name: /^Actions for/ }));
      const markDone =
        chrome === 'touch'
          ? screen.getByRole('button', { name: 'Mark done' })
          : screen.getByRole('menuitem', { name: 'Mark done' });
      expect(markDone.hasAttribute('disabled')).toBe(true);
      fireEvent.click(markDone);
      expect(onSelect).not.toHaveBeenCalled();
    },
  );
});

describe('Mark done is one verb over settle and dismiss', () => {
  const running = { ...rowFor().item, conversationId: 'running-chat' };
  const idle = {
    ...rowFor({ hasActiveTurn: false }).item,
    id: 'idle',
    title: 'Review next steps',
    lifecycleLabel: 'Ready' as const,
    conversationId: 'idle-chat',
  };
  const markDone = (title: string) => {
    fireEvent.click(
      screen.getByRole('button', { name: `Actions for ${title}` }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark done' }));
  };
  afterEach(() => {
    resolutionState.supported = false;
    resolutionState.mutate.mockClear();
  });

  it('settles where settlement reaches the row, and dismisses on this device otherwise', () => {
    const dismiss = vi.fn();
    const settle = vi.fn();
    resolutionState.supported = true;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <InboxGroupList
          groups={[
            { id: 'running', label: 'Running', items: [running] },
            { id: 'idle', label: 'Idle', items: [idle] },
          ]}
          idPrefix="test"
          activeChatSessionId={null}
          now={NOW}
          chrome="hover"
          onActivate={vi.fn()}
          onDismiss={dismiss}
          onSettle={settle}
          onSnoozeWake={vi.fn()}
        />
      </QueryClientProvider>,
    );
    // A running chat cannot be settled yet: Mark done dismisses it here.
    markDone(running.title);
    expect(dismiss).toHaveBeenCalledWith(
      running,
      expect.any(HTMLButtonElement),
    );
    expect(settle).not.toHaveBeenCalled();
    // An idle chat is settled, synced to the person's other devices.
    markDone(idle.title);
    expect(settle).toHaveBeenCalledWith(
      'idle-chat',
      true,
      expect.any(HTMLButtonElement),
    );
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses every row when settlement is not available', () => {
    const dismiss = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <InboxGroupList
          groups={[{ id: 'idle', label: 'Idle', items: [idle] }]}
          idPrefix="test"
          activeChatSessionId={null}
          now={NOW}
          chrome="hover"
          onActivate={vi.fn()}
          onDismiss={dismiss}
          onSettle={vi.fn()}
          onSnoozeWake={vi.fn()}
        />
      </QueryClientProvider>,
    );
    markDone(idle.title);
    expect(dismiss).toHaveBeenCalledWith(idle, expect.any(HTMLButtonElement));
  });

  it('a settled row offers Reopen, and a row marked done on this device offers Reopen too', () => {
    const settle = vi.fn();
    const restore = vi.fn();
    resolutionState.supported = true;
    resolutionState.settled = { 'idle-chat': '2026-09-30T09:00:00.000Z' };
    try {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <InboxGroupList
            groups={[
              { id: 'settled', label: 'Settled', items: [idle] },
              { id: 'dismissed', label: 'Marked done', items: [running] },
            ]}
            idPrefix="test"
            activeChatSessionId={null}
            now={NOW}
            chrome="hover"
            onActivate={vi.fn()}
            onDismiss={vi.fn()}
            onRestore={restore}
            onSettle={settle}
            onSnoozeWake={vi.fn()}
          />
        </QueryClientProvider>,
      );
      for (const title of [idle.title, running.title]) {
        fireEvent.click(
          screen.getByRole('button', { name: `Actions for ${title}` }),
        );
        fireEvent.click(screen.getByRole('menuitem', { name: 'Reopen' }));
      }
      expect(settle).toHaveBeenCalledWith(
        'idle-chat',
        false,
        expect.any(HTMLButtonElement),
      );
      expect(restore).toHaveBeenCalledWith(
        running,
        expect.any(HTMLButtonElement),
      );
    } finally {
      resolutionState.settled = {};
    }
  });
});

it('swipe actions place Mark done to the right of Snooze', () => {
  const row = rowFor({ hasActiveTurn: false });
  renderRow(row, {
    chrome: 'touch',
    hoverCard: true,
    swipeActions: true,
    swipeOpen: true,
    onSnoozeWake: vi.fn(),
    done: { done: false, pending: false, onSelect: vi.fn() },
  });
  const tray = document.querySelector<HTMLElement>('.inbox-row__swipe-actions');
  if (!tray) throw new Error('Missing swipe actions');
  expect(
    within(tray)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim()),
  ).toEqual(['Snooze', 'Mark done']);
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
  it('its Details sheet offers Discard draft, which clears the composer and the store, with Undo', async () => {
    resetPendingUndoForTest();
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
      renderRow(row, { chrome: 'touch', hoverCard: true });
      expect(screen.getByTestId('inbox-row-draft-marker')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /^Details for/ }));
      await screen.findByTestId('inbox-row-details', {}, { timeout: 8000 });
      const discard = screen.getByRole('button', {
        name: 'Discard draft for Migrate sessions table',
      });
      expect(discard.classList.contains('action-overflow__row--danger')).toBe(
        true,
      );
      fireEvent.click(discard);
      expect(chatDraftsStore.hasDraft('tab-draft')).toBe(false);
      // The chip reads the same store, so it goes with the text.
      expect(screen.queryByTestId('inbox-row-draft-marker')).toBeNull();
      expect(screen.queryByTestId('inbox-row-details')).toBeNull();
      // Like the server Draft's discard, it can be undone (⌘Z reaches it).
      act(() => {
        expect(undoLatestAction()).toBe(true);
      });
      expect(chatDraftsStore.get('tab-draft')).toBe(
        'Draft on the phone: check the README',
      );
      expect(screen.getByTestId('inbox-row-draft-marker')).toBeTruthy();
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
        done: { done: false, onSelect: vi.fn() },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: /^Details for/ }));
    await screen.findByTestId('inbox-row-details', {}, { timeout: 8000 });
    expect(screen.queryByRole('button', { name: /^Discard draft/ })).toBeNull();
  });
});

describe('a Draft row on touch chrome', () => {
  beforeEach(() => {
    discardAuthority.enabled = true;
  });
  afterEach(() => {
    discardAuthority.enabled = false;
    vi.useRealTimers();
  });
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Discard draft Migrate sessions table',
      }),
    );
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    vi.useRealTimers();
    await vi.waitFor(() => expect(onDraftDiscarded).toHaveBeenCalledTimes(1));
    expect(discardCommand.mock.calls[0]?.[0]).toEqual({
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(discard);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    vi.useRealTimers();
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

  it('a slim draft row lists Open chat, the snooze list under Snooze until, with Discard last and marked', async () => {
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
      onSnoozeWake,
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
      ['Open chat'],
      snoozeChoices(NOW).map((choice) => `${choice.label}, ${choice.hint}`),
      ['Discard draft'],
    ]);
    expect(
      within(groups[1] as HTMLElement).getByText('Snooze until'),
    ).toBeTruthy();
    expect(
      screen.getByRole('group', { name: 'Snooze until' }).contains(groups[1]),
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
    const last = snoozeChoices(NOW).at(-1)!;
    fireEvent.click(
      within(menu).getByRole('button', { name: new RegExp(`^${last.label},`) }),
    );
    expect(onSnoozeWake).toHaveBeenCalledWith(row.item, last.wakeAt, details);
    expect(screen.queryByTestId('inbox-row-details')).toBeNull();
  });

  it('a host that supplies no actions renders no list in the sheet', async () => {
    renderRow(rowFor(), { chrome: 'touch', hoverCard: true });
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
    // Before the name, beside it on the state line.
    const project = row.querySelector<HTMLElement>('.inbox-row__project')!;
    expect(swatch!.nextElementSibling).toBe(project);
    expect(project.textContent).toBe('station');
    // The accent is never a text colour (accent-foreground ratchet).
    expect(project.style.color).toBe('');
    expect(
      row.querySelector('.inbox-row__context')!.getAttribute('style'),
    ).toBeNull();
    // The open button's name still says the project in words.
    expect(
      within(row).getByRole('button', {
        name: /^Migrate sessions table.*station/,
      }),
    ).toBeTruthy();
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
          row
            .querySelector<HTMLElement>('.inbox-row__project-line')
            ?.style.getPropertyValue('--inbox-project-accent') || null,
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
    expect(
      within(row).getByRole('button', {
        name: /^Migrate sessions table.*station/,
      }),
    ).toBeTruthy();
  });

  it('the phone sheet’s project line draws it too', () => {
    renderRow(rowFor(), {
      projectAccent: 'var(--event-tool-call)',
      projectIcon: '🧭',
      actionsInDetails: true,
    });
    const context = screen
      .getByTestId('inbox-row')
      .querySelector('.inbox-row__project-line');
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
    expect(
      marks[1]?.parentElement?.style.getPropertyValue('--inbox-project-accent'),
    ).toBe('var(--event-reasoning)');
  });
});

it('renders the answer rung for an input request after server projection', () => {
  renderRow(
    rowFor({
      lifecycleState: 'needs_input',
      transitionReason: 'input_requested',
      pendingReview: false,
    }),
  );
  expect(statusText()).toBe('Needs input');
});

describe('a collapsed inbox section that holds the open chat', () => {
  const idle = (threadId: string, title: string) =>
    rowFor({
      threadId,
      displayTitle: title,
      lifecycleState: 'idle',
      hasActiveTurn: false,
      conversationActivity: undefined,
    }).item;

  it('still shows that one row under its header, and only that row', () => {
    const open = idle('T-open', 'The chat on screen');
    const other = idle('T-other', 'Another chat');
    const activeId = open.orchestrationThreadId ?? open.chatSessionId ?? '';
    expect(activeId).not.toBe('');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <InboxGroupList
          groups={[{ id: 'open', label: 'Open', items: [other, open] }]}
          idPrefix="test"
          activeChatSessionId={activeId}
          now={NOW}
          chrome="touch"
          collapsible={{ sections: { open: false }, onToggle: vi.fn() }}
          onActivate={vi.fn()}
          onSnoozeWake={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const section = screen.getByRole('region', { name: /^Open/ });
    expect(
      within(section)
        .getByRole('button', { name: /^Open/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    const rows = within(section).getAllByTestId('inbox-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('The chat on screen');
  });

  it('stacks collapsed sections from the top when none is expanded', () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <InboxGroupList
          groups={[
            { id: 'open', label: 'Open', items: [idle('T-a', 'A')] },
            { id: 'external', label: 'Third-party', items: [idle('T-b', 'B')] },
          ]}
          idPrefix="test"
          activeChatSessionId={null}
          now={NOW}
          chrome="touch"
          collapsible={{
            sections: { open: false, external: false },
            onToggle: vi.fn(),
          }}
          onActivate={vi.fn()}
          onSnoozeWake={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(container.querySelectorAll('.chat-dock-inbox__group')).toHaveLength(
      2,
    );
    expect(
      container.querySelector('.chat-dock-inbox__group--shelf-start'),
    ).toBeNull();
  });
});
