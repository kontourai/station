/**
 * @vitest-environment jsdom
 */

import type {
  AttentionProjection,
  NeedsInputAttentionItem,
  ReviewPendingAttentionItem,
} from '@kontourai/station-contracts/attention';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * A `needs_input` item for a task running on a PAIRED Station names this
 * Station's lifecycle record, not a session that can take a turn: the server
 * refuses a local turn on it ("Peer delegation Activity records are
 * read-only."). The inbox must therefore not offer the local inline reply for
 * it, and must say where it is answered — the rule the Activity detail
 * already applies to the same record.
 *
 * Drives the real callers (`NotificationsPage` → `AttentionSection` →
 * `AttentionCard`, and the bell's `NotificationHistory` →
 * `AttentionHistoryItem`) with the item shape the projection emits for a peer
 * record: no `inputReference` (the peer's request events never reach this
 * Station), `environmentKind: 'peer'`, and an Activity `openHref`.
 */
let attention: AttentionProjection = { items: [], pendingCount: 0 };
const sendTurn = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  LIVE_NOTIFICATION_STATUSES: ['pending', 'delivered'],
  useNotificationsQuery: () => ({ data: [], error: null, isLoading: false }),
  useAttentionQuery: () => ({ data: attention, isLoading: false }),
  useOrchestrationSessionsQuery: () => ({ data: [], isSuccess: true }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  sendOrchestrationTurn: (...args: unknown[]) => sendTurn(...args),
  useClearNotificationActivityMutation: () => ({ mutate: vi.fn() }),
  useDismissNotificationMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useNotificationActionMutation: () => ({ isPending: false, mutate: vi.fn() }),
  DevicePairingRequestActionError: class extends Error {},
  useConfirmDevicePairingRequestMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
  useDenyDevicePairingRequestMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
  useAcknowledgeAttentionItemMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }),
  acknowledgeAttentionItem: vi.fn(),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => null,
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { NotificationHistory } from '../components/notifications/NotificationHistory';
import { NotificationsPage } from '../pages/NotificationsPage';

const now = '2026-10-04T12:00:00.000Z';
const PEER_THREAD = 'peer-delegation-record-1';
// The projection's own link for a peer item (attention-projection.ts).
const PEER_HREF = activityDeepLink({ sessionId: PEER_THREAD });

function localItem(): NeedsInputAttentionItem {
  return {
    id: 'needs_input:thread-local',
    kind: 'needs_input',
    title: 'Local task needs input',
    createdAt: now,
    updatedAt: now,
    sessionId: 'thread-local',
    projectSlug: 'campfit',
    openHref: '/projects/campfit?chat=thread-local&dock=open',
    source: { threadId: 'thread-local' },
  };
}

function peerItem(): NeedsInputAttentionItem {
  return {
    id: `needs_input:${PEER_THREAD}`,
    kind: 'needs_input',
    title: 'Peer task needs input',
    createdAt: now,
    updatedAt: now,
    sessionId: PEER_THREAD,
    projectSlug: 'campfit',
    openHref: PEER_HREF,
    source: { threadId: PEER_THREAD },
    environmentKind: 'peer',
    environmentName: 'Station B',
  };
}

/**
 * A peer `review_pending` carrying a `requestReference`. The projection never
 * builds one (the peer's request events never reach this Station), but if a
 * reference ever rides along, inspecting it here would still address the
 * local record, so the card must not offer it.
 */
function reviewItem(
  title: string,
  threadId: string,
  peer: boolean,
): ReviewPendingAttentionItem {
  return {
    id: `review_pending:${threadId}`,
    kind: 'review_pending',
    title,
    createdAt: now,
    updatedAt: now,
    sessionId: threadId,
    openHref: peer
      ? activityDeepLink({ sessionId: threadId })
      : `/projects/campfit?chat=${threadId}&dock=open`,
    source: { threadId },
    requestType: 'approval',
    requestReference: {
      threadId,
      requestId: 'req-1',
      requestEventId: 'evt-1',
    },
    // No `environmentName`: the record did not carry one.
    ...(peer ? { environmentKind: 'peer' as const } : {}),
  };
}

function row(testId: string, title: string): HTMLElement {
  const match = screen
    .getAllByTestId(testId)
    .find((candidate) => within(candidate).queryByText(title) !== null);
  if (!match) throw new Error(`No ${testId} row titled ${title}`);
  return match;
}

beforeEach(() => {
  attention = { items: [localItem(), peerItem()], pendingCount: 2 };
  sendTurn.mockReset();
});

describe('Notifications inbox: a paired-Station item offers no local reply', () => {
  function renderPage() {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <NotificationsPage />
      </QueryClientProvider>,
    );
  }

  test('the local item keeps its inline reply (control)', () => {
    renderPage();
    const local = row('attention-item', 'Local task needs input');
    expect(within(local).getByLabelText('Answer this session')).toBeTruthy();
    expect(
      within(local).getByRole('button', { name: 'Send answer' }),
    ).toBeTruthy();
    expect(within(local).queryByTestId('attention-peer-elsewhere')).toBeNull();
  });

  test('the peer item has no reply, says where to answer, and opens Activity', () => {
    renderPage();
    const peer = row('attention-item', 'Peer task needs input');
    expect(within(peer).queryByLabelText('Answer this session')).toBeNull();
    expect(within(peer).queryByRole('textbox')).toBeNull();
    expect(
      within(peer).queryByRole('button', { name: 'Send answer' }),
    ).toBeNull();
    expect(
      within(peer).getByTestId('attention-peer-elsewhere').textContent,
    ).toBe('Answer this on Station B, the paired Station that runs the task.');
    expect(
      within(peer)
        .getByRole('link', { name: 'Open in Activity' })
        .getAttribute('href'),
    ).toBe(PEER_HREF);
    expect(sendTurn).not.toHaveBeenCalled();
  });
});

describe('Notifications inbox: a paired-Station review offers no request inspection', () => {
  beforeEach(() => {
    attention = {
      items: [
        reviewItem('Local review', 'thread-local-review', false),
        reviewItem('Peer review', 'peer-delegation-review', true),
      ],
      pendingCount: 2,
    };
  });

  function renderPage() {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <NotificationsPage />
      </QueryClientProvider>,
    );
  }

  test('the local review keeps Inspect request (control)', () => {
    renderPage();
    const local = row('attention-item', 'Local review');
    expect(
      within(local).getByRole('button', { name: 'Inspect request' }),
    ).toBeTruthy();
  });

  test('the peer review has no Inspect request and uses the generic sentence without a name', () => {
    renderPage();
    const peer = row('attention-item', 'Peer review');
    expect(
      within(peer).queryByRole('button', { name: 'Inspect request' }),
    ).toBeNull();
    expect(
      within(peer).getByTestId('attention-peer-elsewhere').textContent,
    ).toBe('Answer this on the paired Station that runs the task.');
    expect(
      within(peer)
        .getByRole('link', { name: 'Open in Activity' })
        .getAttribute('href'),
    ).toBe(activityDeepLink({ sessionId: 'peer-delegation-review' }));
  });
});

describe('Bell popover: a paired-Station item says where it is answered', () => {
  function renderBell() {
    return render(
      <NotificationHistory
        isOpen={true}
        onClose={vi.fn()}
        onViewAll={vi.fn()}
      />,
    );
  }

  test('the peer row carries the note and no reply; the local row carries neither', () => {
    const { container } = renderBell();
    // The popover renders no reply for any kind; pinned so a future reply
    // cannot appear on a peer row unnoticed.
    expect(container.querySelector('textarea')).toBeNull();
    const notes = screen.getAllByTestId('attention-peer-elsewhere');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toBe(
      'Answer this on Station B, the paired Station that runs the task.',
    );
    const peerRow = notes[0].closest('.notification-history__item');
    expect(peerRow?.textContent).toContain('Peer task needs input');
    expect(
      within(peerRow as HTMLElement)
        .getByRole('link', { name: 'Open in Activity' })
        .getAttribute('href'),
    ).toBe(PEER_HREF);
  });
});
