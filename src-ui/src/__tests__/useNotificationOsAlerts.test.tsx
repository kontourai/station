/**
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const reconcileBlocking = vi.fn(async () => 0);
const pollFeed = vi.fn(async () => 0);
const notifications = { current: undefined as unknown };
const platform = {
  current: { isTauri: true, isDesktop: true, isMobile: false },
};

vi.mock('../platform/native/blockingAlert', () => ({
  reconcileBlockingAlerts: (...args: unknown[]) =>
    reconcileBlocking(...(args as [])),
}));
vi.mock('../platform/native/deliveryFeed', () => ({
  pollDeliveryFeed: (...args: unknown[]) => pollFeed(...(args as [])),
}));
vi.mock('@kontourai/station-sdk', () => ({
  LIVE_NOTIFICATION_STATUSES: ['pending', 'delivered'],
  useNotificationsQuery: () => ({ data: notifications.current }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({
    apiBase: 'http://localhost:4100',
    connectionId: 'conn-a',
  }),
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platform.current,
}));

import {
  DELIVERY_FEED_POLL_MS,
  useNotificationOsAlerts,
} from '../hooks/useNotificationOsAlerts';

describe('useNotificationOsAlerts (#2587)', () => {
  beforeEach(() => {
    reconcileBlocking.mockClear();
    pollFeed.mockClear();
    platform.current = { isTauri: true, isDesktop: true, isMobile: false };
    notifications.current = undefined;
  });
  afterEach(() => vi.useRealTimers());

  test('keys the blocking channel by endpoint and connection id', async () => {
    notifications.current = [{ id: 'appr-1', category: 'approval-request' }];
    renderHook(() => useNotificationOsAlerts());
    await waitFor(() =>
      expect(reconcileBlocking).toHaveBeenCalledWith(
        [{ id: 'appr-1', category: 'approval-request' }],
        'http://localhost:4100\nconn-a',
      ),
    );
  });

  test('polls the delivery feed on mount and then inside the host lease', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useNotificationOsAlerts());
    await vi.advanceTimersByTimeAsync(0);
    expect(pollFeed).toHaveBeenCalledWith(
      'http://localhost:4100',
      'http://localhost:4100\nconn-a',
    );
    await vi.advanceTimersByTimeAsync(DELIVERY_FEED_POLL_MS);
    expect(pollFeed).toHaveBeenCalledTimes(2);
    expect(DELIVERY_FEED_POLL_MS).toBeLessThan(90_000);
    unmount();
    await vi.advanceTimersByTimeAsync(DELIVERY_FEED_POLL_MS);
    expect(pollFeed).toHaveBeenCalledTimes(2);
  });

  test('never polls the feed off a desktop native host (browser tabs keep toasts only)', async () => {
    for (const host of [
      { isTauri: true, isDesktop: false, isMobile: true },
      { isTauri: false, isDesktop: true, isMobile: false },
    ]) {
      platform.current = host;
      renderHook(() => useNotificationOsAlerts());
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pollFeed).not.toHaveBeenCalled();
  });
});
