/**
 * @vitest-environment jsdom
 */

/**
 * The header's four dropdowns — notification history, help menu, overflow menu,
 * and (#1552 D1) the avatar's profile menu — are mounted behind `showX && <Suspense>` + `React.lazy` so their markup
 * stays out of the first-paint chunk (archive#2751). Each one already opened
 * with `if (!isOpen) return null`, so deferring the *mount* is meant to be
 * invisible: closed still renders nothing, open still renders the panel.
 *
 * `HeaderActions.test.tsx` cannot police that. It stubs all three modules to
 * ` => null` and only ever renders them with `showX={false}`, so forcing any
 * of the three gates to `false` leaves its 27 assertions green — verified by
 * injection. This file supplies the missing direction: it renders each surface
 * *open* and asserts the lazily-imported component actually reaches the DOM, so
 * a broken gate, a broken dynamic import, or a Suspense boundary that never
 * resolves fails here instead of shipping as a dropdown that stopped opening.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionStatusDot: () => <span data-testid="connection-status" />,
  useConnectionStatus: () => ({ status: 'connected', reason: null }),
  useConnections: () => ({ activeConnection: { name: 'Default' } }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAttentionQuery: () => ({ data: { items: [], pendingCount: 0 } }),
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

/**
 * Each stub renders a marker instead of the real panel: the claim under test is
 * that the deferred module is imported and mounted when its surface opens, not
 * that the panel re-renders its own contents (those have their own suites).
 *
 * The stubs are spies rather than plain functions because the closed case needs
 * to distinguish "never mounted" from "mounted and rendering null" — the real
 * panels return null while closed, so absence of markup is true either way. An
 * invocation count is the only signal that separates them, and it is what the
 * deferral actually claims: while the surface is shut, the component is never
 * reached at all. Without it, deleting a `showX &&` gate is invisible (verified
 * by injection: the marker-only assertion stayed green).
 */
const stubs = vi.hoisted(() => ({
  notificationHistory: vi.fn(),
  helpMenu: vi.fn(),
  overflowMenu: vi.fn(),
  profileMenu: vi.fn(),
}));

vi.mock('../components/notifications/NotificationHistory', () => ({
  NotificationHistory: (props: { isOpen: boolean }) => {
    stubs.notificationHistory(props);
    return props.isOpen ? (
      <div data-testid="deferred-notification-history" />
    ) : null;
  },
}));

vi.mock('../components/header/HelpMenu', () => ({
  HelpMenu: (props: { isOpen: boolean }) => {
    stubs.helpMenu(props);
    return props.isOpen ? <div data-testid="deferred-help-menu" /> : null;
  },
}));

vi.mock('../components/header/OverflowMenu', () => ({
  OverflowMenu: (props: { isOpen: boolean }) => {
    stubs.overflowMenu(props);
    return props.isOpen ? <div data-testid="deferred-overflow-menu" /> : null;
  },
}));

vi.mock('../components/header/ProfileMenu', () => ({
  ProfileMenu: (props: { isOpen: boolean }) => {
    stubs.profileMenu(props);
    return props.isOpen ? <div data-testid="deferred-profile-menu" /> : null;
  },
}));

import { HeaderActions } from '../components/header/HeaderActions';

type OpenState = {
  showHelp?: boolean;
  showNotifications?: boolean;
  showOverflow?: boolean;
  showProfileMenu?: boolean;
};

function renderHeader(open: OpenState = {}) {
  render(
    <HeaderActions
      helpPrompts={[]}
      settingsShortcut="⌘,"
      showHelp={open.showHelp ?? false}
      showNotifications={open.showNotifications ?? false}
      showOverflow={open.showOverflow ?? false}
      showProfileMenu={open.showProfileMenu ?? false}
      userInitials="ST"
      onCloseHelp={vi.fn()}
      onCloseNotifications={vi.fn()}
      onCloseOverflow={vi.fn()}
      onHelpPrompt={vi.fn()}
      onOpenConnections={vi.fn()}
      onOpenProfile={vi.fn()}
      onOpenHelp={vi.fn()}
      onToggleNotifications={vi.fn()}
      onToggleSettings={vi.fn()}
      onToggleOverflow={vi.fn()}
      onCloseProfileMenu={vi.fn()}
      onToggleProfileMenu={vi.fn()}
      onViewAllNotifications={vi.fn()}
    />,
  );
}

const surfaces = [
  {
    name: 'notification history',
    prop: 'showNotifications' as const,
    testId: 'deferred-notification-history',
    stub: stubs.notificationHistory,
  },
  {
    name: 'help menu',
    prop: 'showHelp' as const,
    testId: 'deferred-help-menu',
    stub: stubs.helpMenu,
  },
  {
    name: 'overflow menu',
    prop: 'showOverflow' as const,
    testId: 'deferred-overflow-menu',
    stub: stubs.overflowMenu,
  },
  {
    name: 'profile menu',
    prop: 'showProfileMenu' as const,
    testId: 'deferred-profile-menu',
    stub: stubs.profileMenu,
  },
];

describe('HeaderActions deferred dropdowns', () => {
  beforeEach(() => {
    for (const surface of surfaces) surface.stub.mockClear();
  });

  for (const surface of surfaces) {
    test(`mounts the ${surface.name} once its surface opens`, async () => {
      renderHeader({ [surface.prop]: true });

      // `findBy*` rather than `getBy*`: the component arrives across a
      // dynamic-import boundary, so it is legitimately absent on first paint.
      expect(await screen.findByTestId(surface.testId)).toBeTruthy();
      expect(surface.stub).toHaveBeenCalled();
    });

    test(`never reaches the ${surface.name} while its surface is closed`, async () => {
      renderHeader();

      // Give the lazy boundary the same chance to resolve it gets when open, so
      // this asserts "never mounted", not merely "has not mounted yet". The
      // invocation check is the load-bearing one: the panel renders null while
      // closed, so markup alone cannot tell a removed gate from a live one.
      await waitFor(() => {
        expect(screen.queryByTestId(surface.testId)).toBeNull();
      });
      expect(screen.queryByTestId(surface.testId)).toBeNull();
      expect(surface.stub).not.toHaveBeenCalled();
    });
  }
});
