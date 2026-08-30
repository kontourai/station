/**
 * @vitest-environment jsdom
 */

import type { AttentionProjection } from '@kontourai/station-contracts/attention';
import type { Notification } from '@kontourai/station-contracts/notification';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const clearActivity = vi.fn();
const dismiss = vi.fn();
const action = vi.fn();
const confirmPairing = vi.fn();
const denyPairing = vi.fn();
const sdkMocks = vi.hoisted(() => ({ acknowledgeAttentionItem: vi.fn() }));
const invalidateQueries = vi.fn();
let notifications: Notification[] = [];
let notificationsError: Error | null = null;
let attention: AttentionProjection = { items: [], pendingCount: 0 };
let sessions: OrchestrationSessionSummary[] = [];

vi.mock('@kontourai/station-sdk', () => ({
  useNotificationsQuery: () => ({
    data: notifications,
    error: notificationsError,
    isLoading: false,
  }),
  useAttentionQuery: () => ({ data: attention, isLoading: false }),
  useOrchestrationSessionsQuery: () => ({ data: sessions, isSuccess: true }),
  useQueryClient: () => ({ invalidateQueries }),
  sendOrchestrationTurn: vi.fn(),
  useClearNotificationActivityMutation: () => ({
    mutate: clearActivity,
  }),
  useDismissNotificationMutation: () => ({
    isPending: false,
    mutate: dismiss,
  }),
  useNotificationActionMutation: () => ({
    isPending: false,
    mutate: action,
  }),
  DevicePairingRequestActionError: class extends Error {},
  useConfirmDevicePairingRequestMutation: () => ({
    isPending: false,
    error: null,
    mutate: confirmPairing,
  }),
  useDenyDevicePairingRequestMutation: () => ({
    isPending: false,
    error: null,
    mutate: denyPairing,
  }),
  useAcknowledgeAttentionItemMutation: () => ({
    isPending: false,
    mutate: acknowledgeAttentionItem,
  }),
  acknowledgeAttentionItem: sdkMocks.acknowledgeAttentionItem,
}));

const acknowledgeAttentionItem = sdkMocks.acknowledgeAttentionItem;

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

const navigate = vi.fn();
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));

import { APP_SURFACE_REGISTRY } from '../app-shell/surface-registry';
import { NotificationsPage } from '../pages/NotificationsPage';

function renderPage() {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <NotificationsPage />
    </QueryClientProvider>,
  );
  return {
    ...view,
    /**
     * Re-render against the current module-level fixtures, standing in for the
     * refetch a mutation's `invalidateQueries` triggers. A fresh element is
     * required: React bails out of a re-render handed the identical element.
     */
    refresh: () =>
      view.rerender(
        <QueryClientProvider client={client}>
          <NotificationsPage />
        </QueryClientProvider>,
      ),
  };
}

/**
 * The number the header bell renders, derived exactly as `HeaderActions` does
 * `attention.pendingCount` through the notifications surface's own `badge`
 * so these tests compare the page against the real badge derivation rather
 * than against a number restated in the test.
 */
function bellBadgeCount(): number | null {
  const surface = APP_SURFACE_REGISTRY.get('notifications');
  if (!surface) throw new Error('Notifications surface is not registered');
  return (
    surface.badge?.({ attentionCount: attention.pendingCount })?.count ?? null
  );
}

function attentionHeading(): string {
  const heading = screen.getByRole('heading', { name: /Needs attention/ });
  return (heading.textContent ?? '').replaceAll(/\s+/g, ' ').trim();
}

describe('NotificationsPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/notifications');
    notifications = [];
    notificationsError = null;
    attention = { items: [], pendingCount: 0 };
    sessions = [];
    clearActivity.mockReset();
    dismiss.mockReset();
    action.mockReset();
    confirmPairing.mockReset();
    denyPairing.mockReset();
    acknowledgeAttentionItem.mockReset();
    invalidateQueries.mockReset();
    navigate.mockReset();
  });

  test('renders approval notifications with actions', () => {
    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'approval:notif-1',
          kind: 'approval',
          title: 'Approval needed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          openHref: '/activity?session=thread-1',
          source: {
            notificationId: 'notif-1',
            notificationSource: 'approval-inbox',
          },
          actions: [{ id: 'accept', label: 'Allow Once', variant: 'primary' }],
        },
      ],
    };

    renderPage();

    expect(screen.getAllByText('Approval request').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Allow Once'));
    expect(action).toHaveBeenCalledWith({
      actionId: 'accept',
      id: 'notif-1',
    });
  });

  /*
   * #765 D5: an inbound pairing request used to file under passive Activity
   * with only Dismiss, while "Needs attention" claimed nothing needed you —
   * and approving was CLI-only. It is an attention item with the decision
   * on it now, and its mirror activity row is suppressed while pending.
   */
  test('a pending pairing request needs attention, with Approve/Deny, and no duplicate activity row', () => {
    const timestamp = new Date().toISOString();
    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'device-pairing:pair-req-1',
          kind: 'device-pairing',
          title: 'A device is asking to pair',
          body: 'Test Phone is waiting for approval on this Station.',
          createdAt: timestamp,
          updatedAt: timestamp,
          deviceName: 'Test Phone',
          viewerCanDecide: true,
          openHref: '/connections',
          source: {
            requestId: 'pair-req-1',
            notificationId: 'pairing-notif-1',
          },
        },
      ],
    };
    notifications = [
      {
        id: 'pairing-notif-1',
        source: 'device-pairing',
        category: 'pairing-request',
        title: 'A device is asking to pair',
        priority: 'high',
        status: 'delivered',
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: { requestId: 'pair-req-1' },
      },
    ];

    renderPage();

    // Counted by the same badge derivation the header bell uses.
    expect(bellBadgeCount()).toBe(1);
    // Filed under Needs attention, not only Activity.
    const attentionSection = screen
      .getByRole('heading', { name: /Needs attention/ })
      .closest('section');
    if (!attentionSection) throw new Error('attention section not rendered');
    expect(
      within(attentionSection).getByText('A device is asking to pair'),
    ).toBeTruthy();
    // The decision is on the item — approve calls the pairing confirm.
    fireEvent.click(
      within(attentionSection).getByRole('button', { name: 'Approve' }),
    );
    expect(confirmPairing).toHaveBeenCalledWith('pair-req-1');
    fireEvent.click(
      within(attentionSection).getByRole('button', { name: 'Deny' }),
    );
    expect(denyPairing).toHaveBeenCalledWith('pair-req-1');
    // The mirror notification does not double up in the activity list.
    expect(screen.getByText(/Showing 0 of 0 activity items/)).toBeTruthy();
  });

  test('a resolved pairing request leaves Needs attention empty and its record in activity', () => {
    const timestamp = new Date().toISOString();
    attention = { pendingCount: 0, items: [] };
    notifications = [
      {
        id: 'pairing-notif-1',
        source: 'device-pairing',
        category: 'pairing-request',
        title: 'A device is asking to pair',
        priority: 'high',
        status: 'actioned',
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: { requestId: 'pair-req-1' },
      },
    ];

    renderPage();

    expect(bellBadgeCount()).toBeNull();
    expect(screen.getByText('Nothing needs you right now')).toBeTruthy();
    expect(screen.getByText(/Showing 1 of 1 activity items/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  test('focuses the exact approval deep link even when history filters hide it', () => {
    window.history.replaceState(
      {},
      '',
      '/notifications?q=does-not-match&approval=notif-exact',
    );
    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'approval:notif-exact',
          kind: 'approval',
          title: 'Exact approval',
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
          source: {
            notificationId: 'notif-exact',
            notificationSource: 'approval-inbox',
          },
          actions: [{ id: 'accept', label: 'Allow', variant: 'primary' }],
        },
      ],
    };
    renderPage();
    expect(screen.getByText('Exact approval')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId('attention-item'));
    expect(action).not.toHaveBeenCalled();
  });

  test('does not substitute another approval for a missing exact deep link', () => {
    window.history.replaceState(
      {},
      '',
      '/notifications?approval=missing-notification',
    );
    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'approval:other',
          kind: 'approval',
          title: 'Different approval',
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
          source: {
            notificationId: 'other',
            notificationSource: 'approval-inbox',
          },
          actions: [],
        },
      ],
    };
    renderPage();
    expect(
      screen.getByText(/That approval request isn’t available/i),
    ).toBeTruthy();
    // The load-bearing promise, and the reason this message exists at all:
    // Station declines to substitute a different approval (archive#3965).
    expect(
      screen.getByText(/won’t open a different one in its place/i),
    ).toBeTruthy();
    expect(document.activeElement).not.toBe(
      screen.getByTestId('attention-item'),
    );
  });

  test('focuses an exact terminal approval from durable activity history', () => {
    window.history.replaceState(
      {},
      '',
      '/notifications?q=does-not-match&approval=terminal-approval',
    );
    notifications = [
      {
        id: 'terminal-approval',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Resolved exact approval',
        priority: 'high',
        status: 'actioned',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:01:00.000Z',
      },
    ];
    renderPage();
    expect(screen.getByText('Resolved exact approval')).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByTestId('notification-card'),
    );
  });

  test('names an unavailable deep-linked approval instead of all-caught-up for an empty inbox', () => {
    window.history.replaceState(
      {},
      '',
      '/notifications?approval=missing-notification',
    );
    renderPage();
    expect(
      screen.getByText(/That approval request isn’t available/i),
    ).toBeTruthy();
    // The load-bearing promise, and the reason this message exists at all:
    // Station declines to substitute a different approval (archive#3965).
    expect(
      screen.getByText(/won’t open a different one in its place/i),
    ).toBeTruthy();
    expect(screen.queryByText('All caught up')).toBeNull();
  });

  test('renders structured empty-state copy when there are no notifications', () => {
    renderPage();

    // The title and subtitle are the page frame's (page-frame-registry.ts);
    // what this page still owns is its sections and their empty copy.
    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(
      screen.getByText(
        'Nothing needs you right now, and there is no activity yet.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Dismiss all attention items' }),
    ).toHaveProperty('disabled', true);
  });

  test('filters both inbox sections and stores shareable filters in the URL', () => {
    const timestamp = '2026-08-11T12:00:00.000Z';
    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'session-failed:thread-boom',
          kind: 'session-failed',
          title: 'Build failed',
          body: 'Compiler exited',
          createdAt: timestamp,
          updatedAt: timestamp,
          openHref: '/activity?session=thread-boom',
          source: { threadId: 'thread-boom' },
        },
      ],
    };
    notifications = [
      {
        id: 'pairing-one',
        source: 'device-pairing',
        category: 'pairing-request',
        title: 'Pixel pairing expired',
        priority: 'normal',
        status: 'expired',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];

    renderPage();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'pixel' },
    });

    expect(screen.queryByText('Build failed')).toBeNull();
    expect(screen.getByText('Pixel pairing expired')).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get('q')).toBe('pixel');

    fireEvent.click(screen.getByRole('button', { name: 'Session failed' }));
    expect(screen.queryByText('Pixel pairing expired')).toBeNull();
    expect(
      new URLSearchParams(window.location.search).getAll('category'),
    ).toEqual(['session-failed']);

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Build failed')).toBeTruthy();
    expect(screen.getByText('Pixel pairing expired')).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  test('restores filters from the URL and reacts to history navigation', () => {
    notifications = [
      {
        id: 'job-one',
        source: 'scheduler',
        category: 'job',
        title: 'Nightly job failed',
        priority: 'normal',
        status: 'delivered',
        createdAt: '2026-08-11T12:00:00.000Z',
        updatedAt: '2026-08-11T12:00:00.000Z',
      },
    ];
    window.history.replaceState({}, '', '/notifications?q=missing');
    renderPage();

    expect(screen.queryByText('Nightly job failed')).toBeNull();
    window.history.pushState({}, '', '/notifications?q=nightly');
    fireEvent(window, new PopStateEvent('popstate'));
    expect(screen.getByText('Nightly job failed')).toBeTruthy();
  });

  // archive#settings-revamp: canonical cross-link to Settings → Notifications.
  // No guard here (confirmed, 1) — this page holds no editable/dirty
  // state a navigation could silently discard.
  test('the Notification settings link navigates to Settings with the notifications section param', () => {
    renderPage();

    fireEvent.click(
      screen.getByRole('button', { name: 'Notification settings' }),
    );

    expect(navigate).toHaveBeenCalledWith('/settings', {
      view: 'notifications',
      highlight: 'push-notifications',
    });
  });

  test('reports notification loading failures and retries both sources', () => {
    notificationsError = new Error('Notification service unavailable');

    renderPage();

    expect(screen.getByText('Unable to load notifications')).toBeTruthy();
    expect(screen.getByText('Notification service unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['attention', 'http://station.test'],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications'],
    });
  });

  // the failure branch dropped the header the loading branch
  // deliberately preserves, so a failed read took the route's own title and
  // its Clear / Notification settings controls down with it — the 6-OPS-23
  // defect the loading branch had already been fixed for.
  test('a load failure keeps the page header the loading branch preserves', () => {
    notificationsError = new Error('Notification service unavailable');

    renderPage();

    expect(screen.getByText('Unable to load notifications')).toBeTruthy();
    // The title is the page frame's (page-frame-registry.ts) and never
    // depended on the read; what this page must keep publishing on a
    // failure is its own header action.
    expect(
      screen.getByRole('button', { name: /Notification settings/i }),
    ).toBeTruthy();
  });

  test('retains resolved approval history without duplicating active approvals', () => {
    const timestamp = new Date().toISOString();
    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'approval:active',
          kind: 'approval',
          title: 'Active approval',
          createdAt: timestamp,
          updatedAt: timestamp,
          openHref: '/activity?session=active',
          source: {
            notificationId: 'active',
            notificationSource: 'approval-inbox',
          },
          actions: [{ id: 'accept', label: 'Allow Once' }],
        },
      ],
    };
    notifications = [
      {
        id: 'active',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Active approval',
        priority: 'high',
        status: 'delivered',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 'resolved',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Resolved approval',
        priority: 'high',
        status: 'actioned',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];

    renderPage();

    expect(screen.getAllByText('Active approval')).toHaveLength(1);
    expect(screen.getByText('Resolved approval')).toBeTruthy();
  });

  test('bulk dismissal confirms and dismisses only attention items', async () => {
    const timestamp = new Date().toISOString();
    attention = {
      pendingCount: 2,
      items: [
        {
          id: 'review_pending:thread-review',
          kind: 'review_pending',
          title: 'Review pending',
          createdAt: timestamp,
          updatedAt: timestamp,
          openHref: '/activity?session=thread-review',
          source: { threadId: 'thread-review' },
        },
        {
          id: 'approval:notif-approval',
          kind: 'approval',
          title: 'Approval needed',
          createdAt: timestamp,
          updatedAt: timestamp,
          openHref: '/activity?session=thread-approval',
          source: {
            notificationId: 'notif-approval',
            notificationSource: 'approval-inbox',
          },
          actions: [{ id: 'accept', label: 'Allow Once' }],
        },
      ],
    };
    notifications = [
      {
        id: 'notif-approval',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Approval needed',
        priority: 'high',
        status: 'delivered',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: 'notif-2',
        source: 'scheduler',
        category: 'job',
        title: 'Job failed',
        priority: 'normal',
        status: 'delivered',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];

    renderPage();

    expect(screen.getByText('Needs attention (2)')).toBeTruthy();
    fireEvent.click(screen.getByText('Dismiss all attention items'));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(
        'Dismiss 2 items needing attention? Activity stays.',
      ),
    ).toBeTruthy();
    expect(sdkMocks.acknowledgeAttentionItem).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Dismiss all attention items',
      }),
    );
    await waitFor(() =>
      expect(sdkMocks.acknowledgeAttentionItem).toHaveBeenCalledTimes(2),
    );
    expect(sdkMocks.acknowledgeAttentionItem).toHaveBeenCalledWith(
      'review_pending:thread-review',
      'http://station.test',
    );
    expect(clearActivity, 'activity count unchanged').not.toHaveBeenCalled();
    // The answered confirm closes. It used to stay open and re-render against
    // the emptied queue as "Dismiss 0 items needing attention?".
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('bulk dismissal includes a still-pending device pairing item', async () => {
    const timestamp = new Date().toISOString();
    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'device-pairing:pair-req-1',
          kind: 'device-pairing',
          title: 'Phone is waiting for approval',
          deviceName: 'Phone',
          viewerCanDecide: true,
          createdAt: timestamp,
          updatedAt: timestamp,
          openHref: '/connections',
          source: { requestId: 'pair-req-1' },
        },
      ],
    };
    renderPage();

    fireEvent.click(screen.getByText('Dismiss all attention items'));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Dismiss all attention items',
      }),
    );

    await waitFor(() =>
      expect(acknowledgeAttentionItem).toHaveBeenCalledWith(
        'device-pairing:pair-req-1',
        'http://station.test',
      ),
    );
  });

  test('cancelling the attention dismissal leaves activity untouched', () => {
    notifications = [
      {
        id: 'notif-3',
        source: 'scheduler',
        category: 'job',
        title: 'Job failed',
        priority: 'normal',
        status: 'delivered',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'session-failed:thread-one',
          kind: 'session-failed',
          title: 'Failed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          openHref: '/activity?session=thread-one',
          source: { threadId: 'thread-one' },
        },
      ],
    };
    renderPage();
    fireEvent.click(screen.getByText('Dismiss all attention items'));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sdkMocks.acknowledgeAttentionItem).not.toHaveBeenCalled();
  });

  // archive#1912: `NotificationCard` used to render its Dismiss button only
  // for `status === 'delivered'` — an `expired` (or still-`pending`)
  // notification, exactly the stale-pairing-request shape the issue
  // reported, had no dismiss affordance at all.
  test('an expired notification still offers a Dismiss button', () => {
    notifications = [
      {
        id: 'notif-expired',
        source: 'device-pairing',
        category: 'pairing-request',
        title: 'Pairing request expired',
        priority: 'normal',
        status: 'expired',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    renderPage();

    expect(screen.getByText('Pairing request expired')).toBeTruthy();
    fireEvent.click(screen.getByText('Dismiss'));
    expect(dismiss).toHaveBeenCalledWith('notif-expired');
  });

  // A terminal status (already dismissed/actioned) still gets no button —
  // the fix widens the gate, it does not remove it.
  test('an already-dismissed notification renders no Dismiss button', () => {
    notifications = [
      {
        id: 'notif-gone',
        source: 'scheduler',
        category: 'job',
        title: 'Old job notice',
        priority: 'normal',
        status: 'dismissed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    renderPage();

    expect(screen.getByText('Old job notice')).toBeTruthy();
    expect(screen.queryByText('Dismiss')).toBeNull();
  });

  // archive#1914: a `session-failed` attention item's "Dismiss" acknowledges
  // it (a stored ack, not a notification delete) rather than doing nothing.
  test('dismissing a session-failed attention item acknowledges it', () => {
    const timestamp = new Date().toISOString();
    attention = {
      pendingCount: 1,
      items: [
        {
          id: 'session-failed:thread-boom',
          kind: 'session-failed',
          title: 'Session failed',
          body: 'Engine exited with code 1',
          createdAt: timestamp,
          updatedAt: timestamp,
          openHref: '/activity?session=thread-boom',
          source: { threadId: 'thread-boom' },
        },
      ],
    };

    renderPage();

    expect(screen.getByText('Needs attention (1)')).toBeTruthy();
    fireEvent.click(screen.getByText('Dismiss'));
    expect(acknowledgeAttentionItem).toHaveBeenCalledWith(
      'session-failed:thread-boom',
    );
  });
});

/**
 * archive#1780: the full notifications page carries the SAME annotation
 * the popover carries, on the same join. The two surfaces disagreeing about
 * one approval is the divergence this slice exists to end — and this page is
 * the one a reader reaches by clicking "View all notifications" from the
 * popover, so an unannotated row here directly contradicts what they just
 * read.
 */
describe('NotificationsPage answerability annotation', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/notifications');
  });

  const stranded: Notification = {
    id: 'notif-stranded',
    source: 'approval-inbox',
    category: 'approval-request',
    title: 'Approval needed',
    priority: 'high',
    status: 'delivered',
    metadata: { requestKind: 'orchestration', threadId: 'thread-dead' },
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  };

  function session(
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

  test('annotates the stranded row with qualification, observer and observedAt', () => {
    notifications = [stranded];
    sessions = [
      session({
        answerable: false,
        qualification: 'provider_absent',
        observedBy: 'station-7f3a',
        observedAt: '2026-08-03T12:04:03.000Z',
      }),
    ];
    renderPage();

    // Anti-filter first: the row must still be here.
    expect(screen.getByText('Approval needed')).toBeTruthy();
    const notice = screen.getByTestId('notification-answerability').textContent;
    expect(notice).toContain("no adapter for provider 'acme'");
    expect(notice).toContain('station-7f3a');
    expect(notice).toContain('2026-08-03T12:04:03.000Z');
  });

  test('control: an answerable session leaves the row unannotated', () => {
    notifications = [stranded];
    sessions = [session({ answerable: true })];
    renderPage();
    expect(screen.getByText('Approval needed')).toBeTruthy();
    expect(screen.queryByTestId('notification-answerability')).toBeNull();
  });
});

/**
 * archive#3214: the "Needs attention (N)" heading used to count the FILTERED
 * list while the bell badge counted the full pending set, so the two wore one
 * label for two populations. These pin the repaired contract: unfiltered the
 * heading IS the badge's number, and under a filter it names both.
 */
describe('NotificationsPage attention count scope', () => {
  const AT = '2026-08-11T12:00:00.000Z';

  function failedItem(
    id: string,
    title: string,
    acknowledgedAt?: string,
  ): AttentionProjection['items'][number] {
    return {
      id: `session-failed:${id}`,
      kind: 'session-failed',
      title,
      createdAt: AT,
      updatedAt: AT,
      openHref: `/activity?session=${id}`,
      source: { threadId: id },
      ...(acknowledgedAt ? { acknowledgedAt } : {}),
    };
  }

  beforeEach(() => {
    window.history.replaceState({}, '', '/notifications');
    notifications = [];
    notificationsError = null;
    attention = { items: [], pendingCount: 0 };
    sessions = [];
    acknowledgeAttentionItem.mockReset();
  });

  test('unfiltered, the heading renders exactly the bell badge count', () => {
    attention = {
      pendingCount: 2,
      items: [
        failedItem('boom', 'Build failed'),
        failedItem('crash', 'Deploy crashed'),
        failedItem('old', 'Old failure', AT),
      ],
    };

    renderPage();

    expect(bellBadgeCount()).toBe(2);
    expect(attentionHeading()).toBe('Needs attention (2)');
  });

  /**
   * The reported symptom. Searching for one of three rows used to leave the
   * heading reading "(1)" beside a bell still reading 2, with nothing on the
   * page saying which of them meant what.
   */
  test('under a filter the heading names both populations instead of restating the badge label', () => {
    attention = {
      pendingCount: 2,
      items: [
        failedItem('boom', 'Build failed'),
        failedItem('crash', 'Deploy crashed'),
        failedItem('old', 'Old failure', AT),
      ],
    };

    renderPage();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'build' },
    });

    expect(screen.getByText('Build failed')).toBeTruthy();
    expect(screen.queryByText('Deploy crashed')).toBeNull();
    expect(bellBadgeCount()).toBe(2);
    // Both numbers present and each labelled by its position in the pair.
    expect(attentionHeading()).toBe('Needs attention (1 of 2)');
  });

  /**
   * The worst case: the filter hides every pending item. The old label printed
   * nothing at all here, so the badge's 2 vanished from the page it links to.
   */
  test('a filter that hides every pending item still reports the badge total', () => {
    attention = {
      pendingCount: 2,
      items: [
        failedItem('boom', 'Build failed'),
        failedItem('crash', 'Deploy crashed'),
      ],
    };

    renderPage();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'nothing-matches-this' },
    });

    expect(screen.getByText('No matching attention')).toBeTruthy();
    expect(bellBadgeCount()).toBe(2);
    expect(attentionHeading()).toBe('Needs attention (0 of 2)');
  });

  test('clearing the filter returns the heading to the badge number alone', () => {
    attention = {
      pendingCount: 2,
      items: [
        failedItem('boom', 'Build failed'),
        failedItem('crash', 'Deploy crashed'),
      ],
    };

    renderPage();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'build' },
    });
    expect(attentionHeading()).toBe('Needs attention (1 of 2)');

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(attentionHeading()).toBe('Needs attention (2)');
    expect(bellBadgeCount()).toBe(2);
  });

  /**
   * Acknowledging is the operation archive#3203 taught to move the badge; both
   * numbers must move together, filtered or not. The projection is re-served
   * with the acknowledgement recorded, exactly as the invalidation-driven
   * refetch does.
   */
  test('acknowledging an item moves the heading and the badge together', () => {
    attention = {
      pendingCount: 2,
      items: [
        failedItem('boom', 'Build failed'),
        failedItem('crash', 'Deploy crashed'),
      ],
    };

    const page = renderPage();
    expect(attentionHeading()).toBe('Needs attention (2)');

    fireEvent.click(screen.getAllByText('Dismiss')[0]);
    expect(acknowledgeAttentionItem).toHaveBeenCalledWith(
      'session-failed:boom',
    );

    attention = {
      pendingCount: 1,
      items: [
        failedItem('boom', 'Build failed', AT),
        failedItem('crash', 'Deploy crashed'),
      ],
    };
    page.refresh();

    expect(bellBadgeCount()).toBe(1);
    expect(attentionHeading()).toBe('Needs attention (1)');
  });

  test('acknowledging under an active filter moves both halves of the pair', () => {
    attention = {
      pendingCount: 2,
      items: [
        failedItem('boom', 'Build failed'),
        failedItem('crash', 'Deploy crashed'),
      ],
    };

    const page = renderPage();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'build' },
    });
    expect(attentionHeading()).toBe('Needs attention (1 of 2)');

    attention = {
      pendingCount: 1,
      items: [
        failedItem('boom', 'Build failed', AT),
        failedItem('crash', 'Deploy crashed'),
      ],
    };
    page.refresh();

    expect(bellBadgeCount()).toBe(1);
    expect(attentionHeading()).toBe('Needs attention (0 of 1)');
  });

  /**
   * WHICH source the total comes from, not merely that it happens to agree.
   * The fixture is deliberately inconsistent — `pendingCount` says 4 while the
   * two unacknowledged rows would recompute to 2 — so the page can only read
   * 4 by consuming `AttentionProjection.pendingCount`, the exact field the
   * bell badge renders. A page that re-derived the total from `items` with its
   * own `!acknowledgedAt` filter would print 2 here and reintroduce the
   * two-derivations-for-one-label defect the moment the server's definition of
   * pending changed.
   */
  test('the unfiltered total is read off pendingCount, not recomputed from items', () => {
    attention = {
      pendingCount: 4,
      items: [
        failedItem('boom', 'Build failed'),
        failedItem('crash', 'Deploy crashed'),
      ],
    };

    renderPage();

    expect(bellBadgeCount()).toBe(4);
    expect(attentionHeading()).toBe('Needs attention (4)');
  });

  test('the pair total is read off pendingCount too, so the badge half never drifts', () => {
    attention = {
      pendingCount: 4,
      items: [
        failedItem('boom', 'Build failed'),
        failedItem('crash', 'Deploy crashed'),
      ],
    };

    renderPage();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'build' },
    });

    expect(bellBadgeCount()).toBe(4);
    expect(attentionHeading()).toBe('Needs attention (1 of 4)');
  });

  test('with no attention or activity the single prominent empty replaces both regions', () => {
    attention = { pendingCount: 0, items: [failedItem('old', 'Old', AT)] };

    renderPage();

    expect(bellBadgeCount()).toBeNull();
    expect(screen.getByText('All caught up')).toBeTruthy();
  });
});
