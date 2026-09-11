/**
 * @vitest-environment jsdom
 *
 * `NotificationsSection` (`views/settings/VoiceFeaturesSection.tsx`) — the
 * "View the notifications inbox" cross-link this section gained in
 * archive#settings-revamp. Only `NotificationsSection`'s own
 * dependencies are mocked; `pushNotificationsEnabled: false` keeps
 * `NotificationSubscribeButton` (a sibling export's concern) unmounted so
 * this file never needs to also stand up `usePushNotifications`.
 */

import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES } from '@kontourai/station-contracts/device-settings';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { navigationStore } from '../contexts/navigation-store';

const toggleFeature = vi.fn();
vi.mock('../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({
    settings: {
      pushNotificationsEnabled: false,
      notificationSounds: DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
    },
    toggle: toggleFeature,
  }),
}));

const navigateMock = vi.fn(
  (...args: Parameters<typeof navigationStore.navigate>) =>
    navigationStore.navigate(...args),
);
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: navigateMock }),
}));

import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { NotificationsSection } from '../views/settings/VoiceFeaturesSection';

/** The parent registers its dirty state with the real navigation store. */
function GuardedHarness({ dirty }: { dirty: boolean }) {
  const { DiscardModal } = useUnsavedGuard(dirty);
  return (
    <>
      <NotificationsSection apiBase="http://localhost:3141" />
      <DiscardModal />
    </>
  );
}

describe('NotificationsSection', () => {
  test('renders the push-notifications toggle and the notifications-inbox cross-link', () => {
    render(<NotificationsSection apiBase="http://localhost:3141" />);

    expect(screen.getByText('Push notifications')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'View the notifications inbox' }),
    ).toBeTruthy();
  });

  describe('unsaved-guard wiring for the "View the notifications inbox" cross-link', () => {
    test('navigates to /notifications when the page is not dirty', () => {
      navigationStore.navigate('/guard-origin');
      navigateMock.mockClear();
      render(<GuardedHarness dirty={false} />);

      fireEvent.click(
        screen.getByRole('button', { name: 'View the notifications inbox' }),
      );

      expect(navigateMock).toHaveBeenCalledWith('/notifications');
      expect(window.location.pathname).toBe('/notifications');
      expect(screen.queryByText('Unsaved Changes')).toBeNull();
    });

    // The interception is what this section wires; the resume is not. That the
    // Discard button settles the deferred navigation to its target is
    // `useUnsavedGuard`'s own contract, driven end to end in
    // `src-ui/src/__tests__/useUnsavedGuard.test.tsx` -- 'a real Discard dialog
    // closes without falsely superseding its own prepared navigation', which
    // clicks a real Discard and asserts the browser reached the target path.
    // The route this link carries is pinned by the clean-page case above.
    test('a dirty page intercepts navigation with the discard-confirmation modal instead of silently navigating away', () => {
      navigationStore.navigate('/guard-origin');
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      fireEvent.click(
        screen.getByRole('button', { name: 'View the notifications inbox' }),
      );

      expect(window.location.pathname).toBe('/guard-origin');
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    });

    test('confirming discard from a dirty page completes the deferred navigation', () => {
      navigationStore.navigate('/guard-origin');
      navigateMock.mockClear();
      render(<GuardedHarness dirty />);

      fireEvent.click(
        screen.getByRole('button', { name: 'View the notifications inbox' }),
      );
      expect(window.location.pathname).toBe('/guard-origin');

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(navigateMock).toHaveBeenCalledWith('/notifications');
      expect(window.location.pathname).toBe('/notifications');
    });
  });
});
