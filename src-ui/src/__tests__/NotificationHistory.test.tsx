/**
 * @vitest-environment jsdom
 */

import type { AttentionProjection } from '@kontourai/station-contracts/attention';
import type { Notification } from '@kontourai/station-contracts/notification';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const dismiss = vi.fn();
const action = vi.fn();
const acknowledge = vi.fn();
const refetchNotifications = vi.fn();
const refetchAttention = vi.fn();
let notifications: Notification[] = [];
let attention: AttentionProjection = { items: [], pendingCount: 0 };
let sessions: OrchestrationSessionSummary[] = [];
let sessionsSettled = true;
let listsLoading = false;
// both reads settle with no data when they fail, so an errored
// query used to be indistinguishable from a genuinely empty inbox — the
// panel asserted "All caught up" over a read that never answered. These are
// independent, matching `NotificationHistory`'s own `notificationsError ??
// attentionError` OR: either source alone must surface the failure.
let notificationsError: unknown;
let attentionError: unknown;

vi.mock('@kontourai/station-sdk', () => ({
  LIVE_NOTIFICATION_STATUSES: ['pending', 'delivered'],
  useNotificationsQuery: () => ({
    data: notifications,
    error: notificationsError,
    isLoading: listsLoading,
    refetch: refetchNotifications,
  }),
  useAttentionQuery: () => ({
    data: attention,
    error: attentionError,
    isLoading: listsLoading,
    refetch: refetchAttention,
  }),
  useOrchestrationSessionsQuery: () => ({
    data: sessions,
    isSuccess: sessionsSettled,
  }),
  useDismissNotificationMutation: () => ({
    isPending: false,
    mutate: dismiss,
  }),
  useNotificationActionMutation: () => ({
    isPending: false,
    mutate: action,
  }),
  // `session-failed` is the only kind that carries `acknowledgedAt`, so it is
  // the only kind that can exercise the acknowledged/pending split below —
  // and its row constructs this mutation for Open session and Dismiss.
  useAcknowledgeAttentionItemMutation: () => ({
    isPending: false,
    mutate: acknowledge,
    mutateAsync: async (id: string) => {
      acknowledge(id);
    },
  }),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

import { NotificationHistory } from '../components/notifications/NotificationHistory';

/**
 * File-scoped, not per-describe: `attention`/`notifications`/`sessions` are
 * module-level, and a `beforeEach` inside one `describe` does not run for its
 * siblings. The suites below used to be isolated only by the accident of what
 * the previous suite happened to leave behind — a leaked attention item with a
 * Dismiss action is enough to make `getAllByRole(/dismiss/i)[0]` pick a
 * different row than the test means.
 */
beforeEach(() => {
  notifications = [];
  attention = { items: [], pendingCount: 0 };
  sessions = [];
  sessionsSettled = true;
  listsLoading = false;
  notificationsError = undefined;
  attentionError = undefined;
  dismiss.mockReset();
  action.mockReset();
  acknowledge.mockReset();
  refetchNotifications.mockReset();
  refetchAttention.mockReset();
});

describe('NotificationHistory', () => {
  test('renders active notifications and routes action clicks through the server-backed mutations', () => {
    notifications = [
      {
        id: 'notif-1',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Approval needed',
        body: 'Workspace Agent wants to use fs.read.',
        priority: 'high',
        status: 'delivered',
        actions: [{ id: 'decline', label: 'Deny', variant: 'danger' }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const onClose = vi.fn();
    render(
      <NotificationHistory
        isOpen={true}
        onClose={onClose}
        onViewAll={vi.fn()}
      />,
    );

    expect(screen.getByText('Notifications')).toBeTruthy();
    expect(screen.getByText('Recent activity')).toBeTruthy();
    expect(screen.getByText('View all notifications')).toBeTruthy();
    fireEvent.click(screen.getByText('Deny'));

    expect(action).toHaveBeenCalledWith({
      actionId: 'decline',
      id: 'notif-1',
    });
    // Acting on one notification must NOT tear down the list being triaged —
    // the popover stays open and the row animates instead.
    expect(onClose).not.toHaveBeenCalled();
  });

  test('dismiss collapses the row into an undo affordance instead of closing', () => {
    notifications = [
      {
        id: 'notif-2',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Approval needed',
        body: 'Workspace Agent wants to use fs.read.',
        priority: 'high',
        status: 'delivered',
        actions: [{ id: 'decline', label: 'Deny', variant: 'danger' }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const onClose = vi.fn();
    render(
      <NotificationHistory
        isOpen={true}
        onClose={onClose}
        onViewAll={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /dismiss/i })[0]);

    // The dismissal is held, not committed, and the panel stays open.
    expect(screen.getByText('Dismissed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(dismiss).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.queryByText('Dismissed')).toBeNull();
    expect(dismiss).not.toHaveBeenCalled();
  });

  test('uses the shared concise empty-state copy', () => {
    render(
      <NotificationHistory
        isOpen={true}
        onClose={vi.fn()}
        onViewAll={vi.fn()}
      />,
    );

    expect(screen.getByText('All caught up')).toBeTruthy();
  });

  test('treats an incomplete attention response as empty instead of crashing the shell', () => {
    attention = {} as AttentionProjection;

    render(
      <NotificationHistory
        isOpen={true}
        onClose={vi.fn()}
        onViewAll={vi.fn()}
      />,
    );

    expect(screen.getByText('All caught up')).toBeTruthy();
  });

  test('groups actionable items before recent activity without duplicating projected approvals', () => {
    const timestamp = new Date().toISOString();
    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'approval:notif-1',
          kind: 'approval',
          title: 'Approval needed',
          createdAt: timestamp,
          updatedAt: timestamp,
          openHref: '/activity?session=thread-1',
          source: {
            notificationId: 'notif-1',
            notificationSource: 'approval-inbox',
          },
          actions: [],
        },
      ],
    };
    notifications = [
      {
        id: 'notif-1',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Approval needed',
        priority: 'high',
        status: 'delivered',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 'ordinary',
        source: 'scheduler',
        category: 'job',
        title: 'Job failed',
        priority: 'normal',
        status: 'delivered',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];

    render(
      <NotificationHistory
        isOpen={true}
        onClose={vi.fn()}
        onViewAll={vi.fn()}
      />,
    );

    const headings = screen.getAllByRole('heading', { level: 2 });
    // archive#3222: the section names the badge's own number, so a reader
    // arriving from "Notifications (1 need attention)" is shown one row and
    // told that is all of them.
    expect(headings.map((heading) => heading.textContent?.trim())).toEqual([
      'Needs attention (1)',
      'Recent activity',
    ]);
    expect(screen.getAllByText('Approval needed')).toHaveLength(1);
    expect(screen.getByText('Job failed')).toBeTruthy();
  });

  test('keeps the recent activity section visible when attention is the only content', () => {
    const timestamp = new Date().toISOString();
    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'needs_input:thread-1',
          kind: 'needs_input',
          title: 'Input needed',
          createdAt: timestamp,
          updatedAt: timestamp,
          openHref: '/activity?session=thread-1',
          source: { threadId: 'thread-1' },
        },
      ],
    };

    render(
      <NotificationHistory
        isOpen={true}
        onClose={vi.fn()}
        onViewAll={vi.fn()}
      />,
    );

    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent?.trim()),
    ).toEqual(['Needs attention (1)', 'Recent activity']);
    expect(screen.getByText('No recent activity')).toBeTruthy();
  });
});

/**
 * archive#3222 / archive#3227 A5 — the popover under the bell badge.
 *
 * `AttentionProjection.items` deliberately KEEPS acknowledged items
 * (`attention-projection.ts:225-228`) while `pendingCount` — the badge — counts
 * only the unacknowledged ones (`:229`). The popover used to render
 * `items.slice(0, 5)` under an `<h2>Needs attention</h2>`, so it claimed
 * attention for rows the badge had already stopped counting and truncated at
 * five with nothing said.
 *
 * The fix is the page's fix, not a second one: the section renders the badge's
 * own population and labels it through `attentionCountLabel`, the same helper
 * `AttentionSection` uses, which forces a `"5 of 9"` pair the moment the
 * rendered rows stop being the whole pending set.
 */
describe('NotificationHistory attention section agrees with the badge', () => {
  const stamp = '2026-08-18T09:00:00.000Z';

  function failed(index: number, acknowledged?: string) {
    return {
      id: `session-failed:thread-${index}`,
      kind: 'session-failed' as const,
      title: `Session ${index} failed`,
      createdAt: stamp,
      updatedAt: stamp,
      openHref: `/activity?session=thread-${index}`,
      source: { threadId: `thread-${index}` },
      ...(acknowledged ? { acknowledgedAt: acknowledged } : {}),
    };
  }

  function open() {
    render(
      <NotificationHistory isOpen onClose={vi.fn()} onViewAll={vi.fn()} />,
    );
  }

  function attentionHeading(): string | null {
    return (
      screen
        .queryAllByRole('heading', { level: 2 })
        .find((heading) => heading.textContent?.startsWith('Needs attention'))
        ?.textContent?.trim() ?? null
    );
  }

  test("nothing narrowed: the heading shows the badge's own number", () => {
    // The badge reads 2 and every pending row fits, so there is one
    // population and one number — the pair would be noise here.
    attention = { pendingCount: 2, items: [failed(1), failed(2)] };
    open();

    expect(attentionHeading()).toBe('Needs attention (2)');
    expect(screen.getByText('Session 1 failed')).toBeTruthy();
    expect(screen.getByText('Session 2 failed')).toBeTruthy();
  });

  test('truncation announces itself instead of dropping four rows in silence', () => {
    // Badge 9, popover room for 5. The reader must be able to see that the
    // list under the badge they just clicked is not the whole of it.
    attention = {
      pendingCount: 9,
      items: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => failed(index)),
    };
    open();

    expect(attentionHeading()).toBe('Needs attention (5 of 9)');
    expect(screen.getByText('Session 5 failed')).toBeTruthy();
    expect(screen.queryByText('Session 6 failed')).toBeNull();
  });

  test('all acknowledged: the badge is gone, so nothing may claim attention', () => {
    // `items` still carries the history; `pendingCount` is 0 and the header
    // bell renders no badge at all. A populated "Needs attention" section
    // underneath it is the section asserting a state the data does not carry.
    attention = {
      pendingCount: 0,
      items: [failed(1, stamp), failed(2, stamp), failed(3, stamp)],
    };
    open();

    expect(attentionHeading()).toBeNull();
    expect(screen.queryByText('Session 1 failed')).toBeNull();
    expect(screen.getByText('All caught up')).toBeTruthy();
  });

  test('an acknowledged row is dropped, not shown beside the live ones', () => {
    attention = {
      pendingCount: 1,
      items: [failed(1, stamp), failed(2)],
    };
    open();

    expect(attentionHeading()).toBe('Needs attention (1)');
    expect(screen.queryByText('Session 1 failed')).toBeNull();
    expect(screen.getByText('Session 2 failed')).toBeTruthy();
  });

  test('acknowledged rows do not consume the five visible slots', () => {
    // The slice runs over the PENDING list, so four acked rows cannot push a
    // live one off the bottom — the old `items.slice(0, 5)` let them.
    attention = {
      pendingCount: 2,
      items: [
        failed(1, stamp),
        failed(2, stamp),
        failed(3, stamp),
        failed(4, stamp),
        failed(5, stamp),
        failed(6),
        failed(7),
      ],
    };
    open();

    expect(attentionHeading()).toBe('Needs attention (2)');
    expect(screen.getByText('Session 6 failed')).toBeTruthy();
    expect(screen.getByText('Session 7 failed')).toBeTruthy();
  });

  test('a server pendingCount that disagrees is shown, never clamped away', () => {
    // Same contract as `attentionCountLabel`'s docblock: two pending rows
    // rendered under a badge reading 3 is drift, and a pair that says so is
    // the only honest render of it.
    attention = { pendingCount: 3, items: [failed(1), failed(2)] };
    open();

    expect(attentionHeading()).toBe('Needs attention (2 of 3)');
  });
});

describe('NotificationHistory undo window', () => {
  /**
   * The destructive half of the dismiss feature had no direct coverage: whether
   * the dismissal ACTUALLY commits once the undo window elapses, whether Undo
   * genuinely cancels it, and whether an unmount with a pending timer commits
   * exactly once rather than double-firing with the timer.
   */
  function renderOne() {
    notifications = [
      {
        id: 'notif-undo',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Approval needed',
        body: 'Workspace Agent wants to use fs.read.',
        priority: 'high',
        status: 'delivered',
        actions: [{ id: 'decline', label: 'Deny', variant: 'danger' }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const utils = render(
      <NotificationHistory isOpen onClose={vi.fn()} onViewAll={vi.fn()} />,
    );
    dismiss.mockClear();
    return utils;
  }

  test('the dismissal commits once the undo window elapses', () => {
    vi.useFakeTimers();
    try {
      renderOne();
      fireEvent.click(screen.getAllByRole('button', { name: /dismiss/i })[0]);
      expect(dismiss).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(dismiss).toHaveBeenCalledWith('notif-undo');
    } finally {
      vi.useRealTimers();
    }
  });

  test('Undo cancels the commit permanently, not just until the timer fires', () => {
    vi.useFakeTimers();
    try {
      renderOne();
      fireEvent.click(screen.getAllByRole('button', { name: /dismiss/i })[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(dismiss).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('unmounting with a pending dismissal commits it exactly once', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderOne();
      fireEvent.click(screen.getAllByRole('button', { name: /dismiss/i })[0]);

      // Closing the panel must not silently cancel what the user asked for...
      unmount();
      expect(dismiss).toHaveBeenCalledTimes(1);

      //.and the pending timer must not then fire a second commit.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(dismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * archive#1780 — the finding this slice closes.
 *
 * The popover renders `notifications minus attention-projected`. When the
 * attention projection correctly drops an unanswerable session's card, its
 * still-`delivered` notification lands here — and used to arrive with live
 * Allow/Deny buttons that dispatch into a guaranteed server rejection. The
 * fix is annotation, not a second suppression: suppressing on one surface
 * while another offers the action is the exact mechanism that produced the
 * finding (ADR 0012).
 */
describe('NotificationHistory answerability annotation', () => {
  const observation = {
    answerable: false,
    qualification: 'provider_absent',
    observedBy: 'station-7f3a',
    observedAt: '2026-08-03T12:04:03.000Z',
  } as const;

  function strandedSession(
    answerability: OrchestrationSessionSummary['answerability'],
  ): OrchestrationSessionSummary {
    return {
      provider: 'acme',
      threadId: 'thread-dead',
      status: 'ready',
      controlMode: 'station-owned',
      lifecycleState: 'needs_input',
      answerability,
      isLoaded: true,
      isPersisted: true,
      eventCount: 3,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:01.000Z',
    };
  }

  function strandedApproval(threadId = 'thread-dead'): Notification {
    return {
      id: 'notif-stranded',
      source: 'approval-inbox',
      category: 'approval-request',
      title: 'Approval needed',
      body: 'Workspace Agent wants to use fs.read.',
      priority: 'high',
      status: 'delivered',
      actions: [
        { id: 'accept', label: 'Allow', variant: 'primary' },
        { id: 'decline', label: 'Deny', variant: 'danger' },
      ],
      metadata: { requestKind: 'orchestration', threadId },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function open() {
    render(
      <NotificationHistory isOpen onClose={vi.fn()} onViewAll={vi.fn()} />,
    );
  }

  beforeEach(() => {
    notifications = [strandedApproval()];
    sessions = [strandedSession(observation)];
    sessionsSettled = true;
  });

  test('AC1: the stranded approval renders with disabled actions and the observation', () => {
    open();
    const allow = screen.getByRole('button', { name: 'Allow' });
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect((allow as HTMLButtonElement).disabled).toBe(true);
    expect((deny as HTMLButtonElement).disabled).toBe(true);

    const notice = screen.getByTestId('notification-answerability').textContent;
    // Which arm, whose process, and WHEN. Dropping any one of the three
    // turns the record of an observation back into a timeless label.
    expect(notice).toContain("no adapter for provider 'acme'");
    expect(notice).toContain('station-7f3a');
    expect(notice).toContain('2026-08-03T12:04:03.000Z');
  });

  test('the disabled action points a screen reader at the reason (review L3)', () => {
    // A disabled button announces only "dimmed". The basis was on screen for
    // a sighted reader and inaudible to everyone else — the same
    // "render the basis" contract, one modality over.
    open();
    const allow = screen.getByRole('button', { name: 'Allow' });
    const describedBy = allow.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(
      document.getElementById(describedBy as string)?.textContent,
    ).toContain('station-7f3a');
  });

  test('an enabled action describes nothing — no dangling reference', () => {
    sessions = [strandedSession({ answerable: true })];
    open();
    expect(
      screen
        .getByRole('button', { name: 'Allow' })
        .getAttribute('aria-describedby'),
    ).toBeNull();
  });

  test('AC2 (anti-filter): the row is PRESENT — disappearance is the rejection case', () => {
    open();
    expect(screen.getByText('Approval needed')).toBeTruthy();
    expect(screen.queryByText('No recent activity')).toBeNull();
  });

  test('AC1 rejection path: a click on a disabled action dispatches nothing', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(action).not.toHaveBeenCalled();
  });

  test('AC3: Dismiss stays live — a dismissal IS a user decision', () => {
    open();
    const dismissButton = screen.getByRole('button', { name: /dismiss/i });
    expect((dismissButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(dismissButton);
    expect(screen.getByText('Dismissed')).toBeTruthy();
  });

  test('AC4 (self-heal): a later poll saying answerable re-enables with no repair step', () => {
    // Nothing was written when the row was annotated, so recovery is a
    // re-read — this is the whole reason ADR 0012 projects rather than
    // persists an observation.
    sessions = [strandedSession({ answerable: true })];
    open();
    expect(
      (screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByTestId('notification-answerability')).toBeNull();
  });

  test('AC5 (control): a live approval renders unchanged with enabled actions', () => {
    sessions = [strandedSession({ answerable: true })];
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(action).toHaveBeenCalledWith({
      actionId: 'decline',
      id: 'notif-stranded',
    });
  });

  test('a session the settled read does not list renders the explicit unknown gap, actions untouched', () => {
    // "Could not look" is not "nothing can answer this": the row is
    // annotated with the gap and NOT gated, because a surface with no
    // observation has no standing to disable an action.
    notifications = [strandedApproval('thread-not-listed')];
    open();
    expect(
      screen.getByTestId('notification-answerability').textContent,
    ).toContain('Answerability unknown');
    expect(
      (screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test('an unsettled sessions read annotates nothing at all', () => {
    sessionsSettled = false;
    sessions = [];
    open();
    expect(screen.queryByTestId('notification-answerability')).toBeNull();
  });

  test('a registry-kind approval is left entirely alone', () => {
    notifications = [
      { ...strandedApproval(), metadata: { requestKind: 'registry' } },
    ];
    open();
    expect(screen.queryByTestId('notification-answerability')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  /**
   * "All caught up" is a claim about the data, not a default. The panel now
   * mounts on first open (archive#2751) rather than living for the app's
   * lifetime, so its first paint genuinely has nothing yet — and a cache
   * eviction returns it to that state later. Asserting an empty inbox while
   * the fetch is still in flight would state something the component has not
   * derived, which is exactly the defect class this repo treats as serious.
   */
  test('shows loading rather than claiming "All caught up" before data arrives', () => {
    listsLoading = true;
    notifications = [];
    attention = { items: [], pendingCount: 0 };

    render(
      <NotificationHistory isOpen onClose={vi.fn()} onViewAll={vi.fn()} />,
    );

    expect(
      screen.getByRole('status', { name: 'Loading notifications' }),
    ).toBeTruthy();
    expect(screen.queryByText('All caught up')).toBeNull();
  });

  test('claims "All caught up" only once both queries have settled empty', () => {
    listsLoading = false;
    notifications = [];
    attention = { items: [], pendingCount: 0 };

    render(
      <NotificationHistory isOpen onClose={vi.fn()} onViewAll={vi.fn()} />,
    );

    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(
      screen.queryByRole('status', { name: 'Loading notifications' }),
    ).toBeNull();
  });
});

/**
 * `notificationsError ?? attentionError` renders `ErrorState`
 * before the empty branch, before this fix "All caught up" — the most
 * definitive empty state in the app — rendered over a query that failed.
 * The panel ORs the two sources, so each is pinned independently: either
 * query erroring alone must surface the failure, not just both together.
 */
describe('NotificationHistory error state (Review H1)', () => {
  test('a notifications-read failure renders the error state, not "All caught up"', () => {
    notificationsError = new Error('notifications read failed');
    notifications = [];
    attention = { items: [], pendingCount: 0 };

    render(
      <NotificationHistory isOpen onClose={vi.fn()} onViewAll={vi.fn()} />,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Unable to load notifications')).toBeTruthy();
    expect(screen.getByText('notifications read failed')).toBeTruthy();
    expect(screen.queryByText('All caught up')).toBeNull();
  });

  test('an attention-read failure alone also renders the error state', () => {
    attentionError = new Error('attention read failed');
    notifications = [];
    attention = { items: [], pendingCount: 0 };

    render(
      <NotificationHistory isOpen onClose={vi.fn()} onViewAll={vi.fn()} />,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Unable to load notifications')).toBeTruthy();
    expect(screen.getByText('attention read failed')).toBeTruthy();
    expect(screen.queryByText('All caught up')).toBeNull();
  });

  test('a settled-empty read (no error) still renders "All caught up", with no error state', () => {
    notifications = [];
    attention = { items: [], pendingCount: 0 };

    render(
      <NotificationHistory isOpen onClose={vi.fn()} onViewAll={vi.fn()} />,
    );

    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('clicking Retry refetches both notifications and attention', () => {
    notificationsError = new Error('notifications read failed');

    render(
      <NotificationHistory isOpen onClose={vi.fn()} onViewAll={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchNotifications).toHaveBeenCalledTimes(1);
    expect(refetchAttention).toHaveBeenCalledTimes(1);
  });
});
