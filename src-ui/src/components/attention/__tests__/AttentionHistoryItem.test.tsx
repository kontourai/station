/**
 * @vitest-environment jsdom
 */

import type {
  ApprovalAttentionItem,
  SessionFailedAttentionItem,
} from '@kontourai/station-sdk';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const acknowledge = vi.fn();
const acknowledgeAsync = vi.fn(() => Promise.resolve());
const navigate = vi.fn();

vi.mock('../../../utils/attentionOpen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/attentionOpen')>()),
  navigateToAttentionTarget: (href: string) => navigate(href),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAcknowledgeAttentionItemMutation: () => ({
    isPending: false,
    error: null,
    mutate: acknowledge,
    mutateAsync: acknowledgeAsync,
  }),
}));

beforeEach(() => {
  acknowledge.mockReset();
  acknowledgeAsync.mockReset();
  acknowledgeAsync.mockResolvedValue(undefined);
  navigate.mockReset();
});

import { AttentionHistoryItem } from '../AttentionHistoryItem';

function baseApproval(
  overrides: Partial<ApprovalAttentionItem> = {},
): ApprovalAttentionItem {
  const now = new Date().toISOString();
  return {
    id: 'approval:notif-1',
    kind: 'approval',
    title: 'Approval needed',
    createdAt: now,
    updatedAt: now,
    source: { notificationId: 'notif-1', notificationSource: 'approval-inbox' },
    actions: [{ id: 'accept', label: 'Allow Once', variant: 'primary' }],
    ...overrides,
  };
}

describe('AttentionHistoryItem — approval kind', () => {
  test('renders an "Open session" link when the item resolves a session target', () => {
    render(
      <AttentionHistoryItem
        item={baseApproval({ openHref: '/?surface=activity&session=thread-1' })}
        isPending={false}
        isDismissPending={false}
        onAction={vi.fn()}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const link = screen.getByRole('link', { name: 'Open session' });
    expect(link.getAttribute('href')).toBe(
      '/?surface=activity&session=thread-1',
    );
  });

  test('renders no "Open session" link when the item has no resolvable target', () => {
    render(
      <AttentionHistoryItem
        item={baseApproval()}
        isPending={false}
        isDismissPending={false}
        onAction={vi.fn()}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Open session' })).toBeNull();
    expect(screen.getByText('Approval needed')).toBeTruthy();
  });
});

function baseFailure(
  overrides: Partial<SessionFailedAttentionItem> = {},
): SessionFailedAttentionItem {
  const now = new Date().toISOString();
  return {
    id: 'session-failed:thread-boom',
    kind: 'session-failed',
    title: 'Fix the login redirect',
    createdAt: now,
    updatedAt: now,
    openHref: '/?surface=activity&session=thread-boom',
    source: { threadId: 'thread-boom' },
    ...overrides,
  };
}

function renderRow(
  item: Parameters<typeof AttentionHistoryItem>[0]['item'],
  props: Partial<Parameters<typeof AttentionHistoryItem>[0]> = {},
) {
  return render(
    <AttentionHistoryItem
      item={item}
      isPending={false}
      isDismissPending={false}
      onAction={vi.fn()}
      onClose={vi.fn()}
      onDismiss={vi.fn()}
      {...props}
    />,
  );
}

describe('AttentionHistoryItem — session-failed kind', () => {
  // archive#1914: the popover's own Dismiss for a derived kind, wired
  // independently of the notification-delete `onDismiss` prop — there is no
  // notification id for a session-failed item to route through it.
  test('Dismiss acknowledges the item by its own id, not via onDismiss', () => {
    const onDismiss = vi.fn();
    render(
      <AttentionHistoryItem
        item={baseFailure()}
        isPending={false}
        isDismissPending={false}
        onAction={vi.fn()}
        onClose={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
    dismissButton.click();

    expect(acknowledge).toHaveBeenCalledWith('session-failed:thread-boom');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  /*
   * archive#3203. THIS is the surface the owner was reading: the tray row
   * rendered only the kind eyebrow and the title, so the projection's `body`
   * — the failure's own cause — and its `updatedAt` were both carried here
   * and thrown away, and three failures were one indistinguishable row
   * repeated three times.
   */
  test('the row carries the cause, the identity, and the time', () => {
    renderRow(
      baseFailure({
        body: 'ECONNREFUSED api.example.com:443',
        engine: 'claude',
        agent: 'reviewer',
      }),
    );

    expect(screen.getByText('Fix the login redirect')).toBeTruthy();
    expect(screen.getByTestId('attention-cause').textContent).toBe(
      'ECONNREFUSED api.example.com:443',
    );
    expect(screen.getByTestId('attention-identity').textContent).toBe(
      'Claude Code · reviewer',
    );
    // `formatNotificationTime` renders a fresh stamp as "Just now" — the
    // point is that a <time> exists at all, which it did not before.
    expect(screen.getByText('Just now')).toBeTruthy();
  });

  test('an unrecorded cause says so rather than rendering nothing', () => {
    renderRow(baseFailure());

    expect(screen.getByTestId('attention-cause').textContent).toBe(
      'No failure detail was recorded for this session.',
    );
  });

  test('three failures from three sessions render three distinct rows', () => {
    const rows = [
      baseFailure({
        title: 'Fix the login redirect',
        body: 'ECONNREFUSED api.example.com:443',
        engine: 'claude',
      }),
      baseFailure({
        title: 'Migrate the invoice table',
        body: 'Engine exited with code 1',
        engine: 'codex',
      }),
      baseFailure({ title: 'Draft the release notes', engine: 'claude' }),
    ].map((item) => {
      const { container, unmount } = renderRow(item);
      const text = container.querySelector(
        '.notification-history__item',
      )?.textContent;
      unmount();
      return text;
    });

    expect(new Set(rows).size).toBe(3);
  });

  // archive#3203 defect 2: the count stayed at 4 after acting on a row.
  test('opening the row acknowledges it before navigating', async () => {
    const onClose = vi.fn();
    renderRow(baseFailure(), { onClose });

    screen.getByRole('link', { name: 'Open session' }).click();

    expect(onClose).toHaveBeenCalled();
    expect(acknowledgeAsync).toHaveBeenCalledWith('session-failed:thread-boom');
    expect(navigate).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        '/?surface=activity&session=thread-boom',
      ),
    );
  });

  test('opening an approval row acknowledges nothing', () => {
    // Only `session-failed` is acknowledgeable server-side; an ack recorded
    // against any other kind is discarded, so firing one would be a write
    // that claims the row was seen and changes nothing.
    renderRow(
      baseApproval({ openHref: '/?surface=activity&session=thread-1' }),
    );

    screen.getByRole('link', { name: 'Open session' }).click();

    expect(acknowledgeAsync).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('AttentionHistoryItem — dismiss affordance', () => {
  test('a genuinely-pending approval shows a visually quiet dismiss and routes clicks to onDismiss with the notification id', () => {
    const onDismiss = vi.fn();
    render(
      <AttentionHistoryItem
        item={baseApproval({ openHref: '/?surface=activity&session=thread-1' })}
        isPending={false}
        isDismissPending={false}
        onAction={vi.fn()}
        onClose={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismissButton.className).toContain(
      'notification-history__action--quiet',
    );

    dismissButton.click();
    expect(onDismiss).toHaveBeenCalledWith('notif-1');
  });

  test('a non-actionable approval (no live actions) shows a plain dismiss, not the quiet variant', () => {
    render(
      <AttentionHistoryItem
        item={baseApproval({ actions: [] })}
        isPending={false}
        isDismissPending={false}
        onAction={vi.fn()}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismissButton.className).not.toContain(
      'notification-history__action--quiet',
    );
  });

  test('disables the dismiss button while a dismiss mutation is pending', () => {
    render(
      <AttentionHistoryItem
        item={baseApproval()}
        isPending={false}
        isDismissPending={true}
        onAction={vi.fn()}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
