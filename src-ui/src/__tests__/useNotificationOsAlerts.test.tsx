/**
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const reconcileBlocking = vi.fn(async () => 0);
const reconcileEnveloped = vi.fn(async () => 0);
const notifications = { current: undefined as unknown };
const platform = {
  current: { isTauri: true, isDesktop: true, isMobile: false },
};

vi.mock('../platform/native/blockingAlert', () => ({
  reconcileBlockingAlerts: (...args: unknown[]) =>
    reconcileBlocking(...(args as [])),
}));
vi.mock('../platform/native/notificationAlert', () => ({
  reconcileNotificationAlerts: (...args: unknown[]) =>
    reconcileEnveloped(...(args as [])),
}));
vi.mock('@kontourai/station-sdk', () => ({
  LIVE_NOTIFICATION_STATUSES: ['pending', 'delivered'],
  useNotificationsQuery: () => ({ data: notifications.current }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:4100' }),
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platform.current,
}));

import { useNotificationOsAlerts } from '../hooks/useNotificationOsAlerts';

describe('useNotificationOsAlerts (#2587)', () => {
  beforeEach(() => {
    reconcileBlocking.mockClear();
    reconcileEnveloped.mockClear();
    platform.current = { isTauri: true, isDesktop: true, isMobile: false };
  });

  test('hands every observed list to the envelope channel, envelope or not', async () => {
    // A list with no envelope must still reach the channel: it seeds on its
    // first observation, so skipping this one would seed — and swallow — the
    // session's first agent notification when it arrives.
    const pairing = { id: 'pair-1', category: 'pairing-request' };
    notifications.current = [pairing];
    renderHook(() => useNotificationOsAlerts());

    await waitFor(() =>
      expect(reconcileEnveloped).toHaveBeenCalledWith(
        [pairing],
        'http://localhost:4100',
      ),
    );
    // The blocking channel keeps its local-pairing filter; the envelope
    // channel sees the unfiltered list and ignores blocking categories itself.
    expect(reconcileBlocking).toHaveBeenCalledWith([], 'http://localhost:4100');
  });

  test('never reaches the envelope channel off a desktop native host', async () => {
    platform.current = { isTauri: true, isDesktop: false, isMobile: true };
    notifications.current = [{ id: 'n-1' }];
    renderHook(() => useNotificationOsAlerts());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reconcileEnveloped).not.toHaveBeenCalled();
  });
});
