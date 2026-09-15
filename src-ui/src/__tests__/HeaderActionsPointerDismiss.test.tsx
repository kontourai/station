/**
 * @vitest-environment jsdom
 */

/**
 * #2081: the notification bell could not close its own popover.
 *
 * The sequence, which no existing suite could see, because every one of them
 * fires `click` on its own and jsdom moves focus for neither the defect nor
 * the fix: pressing the bell while the popover is open is a `mousedown`
 * ANYWHERE OUTSIDE the popover, and `NotificationHistory`'s own
 * `useClickOutside` listens for exactly that on `document`
 * (`NotificationHistory.tsx:294-311`). It closes the popover, React flushes
 * that, and the bell's `click` then reads the already-false state and toggles
 * it straight back open. The control looked inert.
 *
 * The state under test therefore has to be REAL state with the view model's
 * own functional toggle (`useHeaderViewModel.ts:122`), not a spy: a `vi.fn()`
 * toggle records the call and never flushes anything, so the re-open — which
 * is the defect — cannot happen in front of it. The panel has to be the real
 * one for the same reason; the `useClickOutside` dismissal is the path this
 * trigger actually falls down, and a stub has none.
 *
 * `pointerClick` supplies the one step jsdom omits (focus moves on press) and
 * flushes React between the press and the click, so the click handler reads
 * post-dismissal state exactly as a browser's would. See `helpers/pointer.ts`.
 */

import type { AttentionProjection } from '@kontourai/station-contracts/attention';
import type { Notification } from '@kontourai/station-contracts/notification';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

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
  useDismissNotificationMutation: () => ({ isPending: false, mutate: vi.fn() }),
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
import { pointerClick } from './helpers/pointer';

/**
 * The header with its notification state held for real.
 *
 * `toggle` is `useHeaderViewModel`'s own shape — `setState((current) =>
 * !current)` — because that functional updater is half of the defect: by the
 * time it runs it reads the state a dismissal has already flushed, so it
 * cannot tell "the user asked to close this" from "something closed it a
 * moment ago and the user is opening it again".
 */
function Header() {
  const [showNotifications, setShowNotifications] = useState(false);
  return (
    <HeaderActions
      helpPrompts={[]}
      settingsShortcut="⌘,"
      showHelp={false}
      showNotifications={showNotifications}
      showOverflow={false}
      showProfileMenu={false}
      userInitials="ST"
      onCloseHelp={vi.fn()}
      onCloseNotifications={() => setShowNotifications(false)}
      onCloseOverflow={vi.fn()}
      onCloseProfileMenu={vi.fn()}
      onHelpPrompt={vi.fn()}
      onOpenConnections={vi.fn()}
      onOpenProfile={vi.fn()}
      onOpenHelp={vi.fn()}
      onToggleNotifications={() => setShowNotifications((current) => !current)}
      onToggleSettings={vi.fn()}
      onToggleOverflow={vi.fn()}
      onToggleProfileMenu={vi.fn()}
      onViewAllNotifications={vi.fn()}
    />
  );
}

const panel = () =>
  document.querySelector<HTMLElement>('.notification-history');

/** The popover arrives across a dynamic import, so its first paint is async. */
async function openWithPointer(bell: HTMLElement) {
  pointerClick(bell);
  await screen.findByText('Notifications', {
    selector: '.notification-history__title',
  });
}

describe('#2081 — the notification bell closes its own popover', () => {
  beforeEach(() => {
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

  test('a pointer click on the bell closes the popover, it does not reopen it', async () => {
    render(<Header />);
    const bell = screen.getByRole('button', { name: /^Notifications/ });

    await openWithPointer(bell);
    // The press must have left focus INSIDE the popover, or the dismissal the
    // second press relies on was never armed and the assertion below would
    // pass against the defect as well as against the fix.
    expect(panel()?.contains(document.activeElement)).toBe(true);

    pointerClick(bell);

    expect(panel()).toBeNull();
    // And the popover's return-focus contract still holds: focus is on the
    // control the user pressed, not stranded on `document.body`, which is what
    // `applyReturnFocus` refuses to focus and what a fix that suppressed the
    // press-focus without replacing it would leave behind.
    expect(document.activeElement).toBe(bell);
  });

  /**
   * The keyboard half of the same decision.
   *
   * The fix reads the state the trigger was in WHEN IT WAS PRESSED, which only
   * a pointer press can record — a click the UA synthesises from Enter or
   * Space has no `mousedown` before it. So it must fall back to the live state,
   * and this drives the case that separates the two: a press that never became
   * a click (pressed, dragged off, released elsewhere) leaves the recorded
   * state saying "it was open", and the next Enter must not spend itself
   * closing something that is already closed.
   */
  test('Enter on the bell opens the popover after an abandoned press', async () => {
    render(<Header />);
    const bell = screen.getByRole('button', { name: /^Notifications/ });

    await openWithPointer(bell);

    // Pressed, then dragged off and released elsewhere: the press dismisses
    // the popover through `useClickOutside`, and no click ever arrives.
    fireEvent.mouseDown(bell);
    act(() => {
      bell.focus();
    });
    expect(panel()).toBeNull();

    // Enter on a focused button: a click with no press behind it, which jsdom
    // and the browser both report as `detail: 0`.
    fireEvent.click(bell, { detail: 0 });
    await screen.findByText('Notifications', {
      selector: '.notification-history__title',
    });
  });
});
