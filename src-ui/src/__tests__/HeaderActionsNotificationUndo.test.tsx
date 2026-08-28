/**
 * @vitest-environment jsdom
 */

/**
 * The 4-second undo window survives closing the notification panel.
 *
 * This is a *composition* claim, and it is the one archive#2751 nearly broke.
 * `NotificationHistory` holds each dismissal in a `setTimeout` it owns and
 * flushes any pending ones on unmount — correct as an app-teardown safety net,
 * so a dismissal the user asked for is not silently lost. Deferring the panel
 * behind `showNotifications && <Suspense>` would have promoted that flush onto
 * the ordinary close path: dismiss the wrong row, click anywhere outside, and
 * the commit fires immediately with no Undo left on reopen — defeating the
 * affordance precisely in the mis-tap case its own code comments say it exists
 * for ("a destructive action with no way back is worse on a phone").
 *
 * Neither existing suite can see it. `NotificationHistory.test.tsx` pins the
 * unmount flush and the undo affordance separately, and both remain correct in
 * isolation; `HeaderActions.test.tsx` stubs the panel out entirely. The
 * regression lives only where the two meet, so this file renders the real panel
 * through `HeaderActions` and closes it the way a user does.
 */

import type { AttentionProjection } from '@kontourai/station-contracts/attention';
import type { Notification } from '@kontourai/station-contracts/notification';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const dismiss = vi.fn();
let notifications: Notification[] = [];
let attention: AttentionProjection = { items: [], pendingCount: 0 };

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionStatusDot: () => <span data-testid="connection-status" />,
  useConnectionStatus: () => ({ status: 'connected', reason: null }),
  useConnections: () => ({ activeConnection: { name: 'Default' } }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  LIVE_NOTIFICATION_STATUSES: ['pending', 'delivered'],
  useNotificationsQuery: () => ({ data: notifications, isLoading: false }),
  useAttentionQuery: () => ({ data: attention, isLoading: false }),
  useOrchestrationSessionsQuery: () => ({ data: [], isSuccess: true }),
  useDismissNotificationMutation: () => ({ isPending: false, mutate: dismiss }),
  useNotificationActionMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ supervisesBundledServer: false }),
}));

vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));

import { HeaderActions } from '../components/header/HeaderActions';

function renderHeader(showNotifications: boolean, onClose = vi.fn()) {
  const view = render(
    <HeaderActions
      helpPrompts={[]}
      settingsShortcut="⌘,"
      showHelp={false}
      showNotifications={showNotifications}
      showOverflow={false}
      userInitials="ST"
      onCloseHelp={vi.fn()}
      onCloseNotifications={onClose}
      onCloseOverflow={vi.fn()}
      onHelpPrompt={vi.fn()}
      onOpenConnections={vi.fn()}
      onOpenProfile={vi.fn()}
      onToggleHelp={vi.fn()}
      onToggleNotifications={vi.fn()}
      onToggleSettings={vi.fn()}
      onToggleOverflow={vi.fn()}
      onViewAllNotifications={vi.fn()}
    />,
  );
  const rerenderWith = (next: boolean) =>
    view.rerender(
      <HeaderActions
        helpPrompts={[]}
        settingsShortcut="⌘,"
        showHelp={false}
        showNotifications={next}
        showOverflow={false}
        userInitials="ST"
        onCloseHelp={vi.fn()}
        onCloseNotifications={onClose}
        onCloseOverflow={vi.fn()}
        onHelpPrompt={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenProfile={vi.fn()}
        onToggleHelp={vi.fn()}
        onToggleNotifications={vi.fn()}
        onToggleSettings={vi.fn()}
        onToggleOverflow={vi.fn()}
        onViewAllNotifications={vi.fn()}
      />,
    );
  return { onClose, rerenderWith };
}

/** The panel arrives across a dynamic import, so its first paint is async. */
async function openPanel() {
  const handle = renderHeader(true);
  await screen.findByText('Notifications', {
    selector: '.notification-history__title',
  });
  return handle;
}

describe('HeaderActions + NotificationHistory — undo survives closing', () => {
  beforeEach(() => {
    dismiss.mockReset();
    attention = { items: [], pendingCount: 0 };
    notifications = [
      {
        id: 'notif-1',
        source: 'approval-inbox',
        category: 'approval-request',
        title: 'Approval needed',
        body: 'Workspace Agent wants to use fs.read.',
        priority: 'high',
        status: 'delivered',
        actions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
  });

  test('a pending dismissal is still undoable after closing and reopening', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { onClose, rerenderWith } = await openPanel();

      fireEvent.click(screen.getAllByRole('button', { name: /dismiss/i })[0]);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();

      // Close the way a user does: a click anywhere outside the popover.
      fireEvent.mouseDown(document.body);
      expect(onClose).toHaveBeenCalled();
      rerenderWith(false);

      // The undo window is still open, so nothing may have committed yet.
      expect(dismiss).not.toHaveBeenCalled();

      rerenderWith(true);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();

      // And undoing it must cancel the commit outright, not merely delay it.
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(dismiss).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a dismissal left pending still commits once its window elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerenderWith } = await openPanel();

      fireEvent.click(screen.getAllByRole('button', { name: /dismiss/i })[0]);
      rerenderWith(false);

      // Closing must not cancel what the user asked for either — the timer
      // keeps running while the panel is shut and commits exactly once.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(dismiss).toHaveBeenCalledWith('notif-1');
    } finally {
      vi.useRealTimers();
    }
  });
});
