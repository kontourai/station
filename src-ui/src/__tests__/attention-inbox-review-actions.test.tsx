/**
 * @vitest-environment jsdom
 */

import type {
  AttentionProjection,
  GateReviewAttentionItem,
  ProposedChangeAttentionItem,
} from '@kontourai/station-contracts/attention';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * #2064 (D4): the two kinds that moved in from `/review-queue` are DECIDABLE
 * from Notifications, through the same server calls the Review page makes.
 *
 * The assertions are on which SDK mutation the row invokes and with what
 * payload. That is the seam this change owns: the URL each of those mutations
 * posts to is pinned separately and already
 * (`packages/sdk/src/__tests__/proposedChanges.test.ts` asserts
 * `POST /api/proposed-changes/change-1/approve`), so a row that calls the
 * approve mutation with this payload reaches that endpoint. Pointing the row
 * at any other mutation — reject instead of approve, a diff-comment delete,
 * a hand-rolled `useMutation` — fails here.
 *
 * It drives the real `NotificationsPage`, not `AttentionCard` in isolation:
 * the item has to survive the page's pending filter and its section
 * rendering to reach a button at all.
 */
const approveChange = vi.fn();
const rejectChange = vi.fn();
const resolveComment = vi.fn();
let attention: AttentionProjection = { items: [], pendingCount: 0 };

vi.mock('@kontourai/station-sdk', () => ({
  useNotificationsQuery: () => ({ data: [], error: null, isLoading: false }),
  useAttentionQuery: () => ({ data: attention, isLoading: false }),
  useOrchestrationSessionsQuery: () => ({ data: [], isSuccess: true }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  sendOrchestrationTurn: vi.fn(),
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
  }),
  acknowledgeAttentionItem: vi.fn(),
  useApproveProposedChangeMutation: () => ({
    isPending: false,
    error: null,
    mutate: approveChange,
  }),
  useRejectProposedChangeMutation: () => ({
    isPending: false,
    error: null,
    mutate: rejectChange,
  }),
  useResolveDiffCommentMutation: () => ({
    isPending: false,
    error: null,
    mutate: resolveComment,
  }),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => null,
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { NotificationsPage } from '../pages/NotificationsPage';

const now = '2026-09-13T12:00:00.000Z';

function proposedChangeItem(): ProposedChangeAttentionItem {
  return {
    id: 'proposed-change:change-1',
    kind: 'proposed-change',
    title: 'src/index.ts',
    body: 'modify from claude',
    createdAt: now,
    updatedAt: now,
    projectSlug: 'campfit',
    path: 'src/index.ts',
    contentKind: 'code',
    sourceRuntime: 'claude',
    openHref: '/review-queue?change=change-1',
    source: { proposedChangeId: 'change-1', projectSlug: 'campfit' },
  };
}

function gateReviewItem(): GateReviewAttentionItem {
  return {
    id: 'gate-review:review-session-1',
    kind: 'gate-review',
    title: 'Survey gate review',
    body: '2 unresolved · flow:build#7',
    createdAt: now,
    updatedAt: now,
    projectSlug: 'campfit',
    unresolved: 2,
    openHref: '/review-queue?review=review-session-1',
    source: {
      reviewSessionRef: 'review-session-1',
      projectSlug: 'campfit',
      workflowSubjectRef: 'flow:build#7',
    },
  };
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationsPage />
    </QueryClientProvider>,
  );
}

function attentionRow(title: string): HTMLElement {
  const row = screen
    .getAllByTestId('attention-item')
    .find((candidate) => within(candidate).queryByText(title) !== null);
  if (!row) throw new Error(`No attention row titled ${title}`);
  return row;
}

describe('deciding review work from the attention inbox', () => {
  beforeEach(() => {
    approveChange.mockClear();
    rejectChange.mockClear();
    resolveComment.mockClear();
    attention = { items: [], pendingCount: 0 };
  });

  test('Approve posts the proposed-change approval, naming the surface that decided', () => {
    attention = { items: [proposedChangeItem()], pendingCount: 1 };
    renderPage();

    fireEvent.click(
      within(attentionRow('src/index.ts')).getByRole('button', {
        name: 'Approve',
      }),
    );

    expect(approveChange).toHaveBeenCalledWith({
      id: 'change-1',
      decision: { reason: 'Approved from notifications' },
    });
    expect(rejectChange).not.toHaveBeenCalled();
    expect(resolveComment).not.toHaveBeenCalled();
  });

  test('Reject posts the proposed-change rejection, not the approval', () => {
    attention = { items: [proposedChangeItem()], pendingCount: 1 };
    renderPage();

    fireEvent.click(
      within(attentionRow('src/index.ts')).getByRole('button', {
        name: 'Reject',
      }),
    );

    expect(rejectChange).toHaveBeenCalledWith({
      id: 'change-1',
      decision: { reason: 'Rejected from notifications' },
    });
    expect(approveChange).not.toHaveBeenCalled();
  });

  test('a paused gate review opens the exact review session, and offers no decision it cannot make', () => {
    attention = { items: [gateReviewItem()], pendingCount: 1 };
    renderPage();

    const row = attentionRow('Survey gate review');
    expect(
      within(row)
        .getByRole('link', { name: 'Open review' })
        .getAttribute('href'),
    ).toBe('/review-queue?review=review-session-1');
    // The Review page makes no mutation for these sessions either; an
    // Approve-shaped button here would claim an authority this surface and
    // that one both lack.
    expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  test('the change row links into Review at the exact change, never the bare list', () => {
    attention = { items: [proposedChangeItem()], pendingCount: 1 };
    renderPage();

    expect(
      within(attentionRow('src/index.ts'))
        .getByRole('link', { name: 'Open in Review' })
        .getAttribute('href'),
    ).toBe('/review-queue?change=change-1');
  });
});
