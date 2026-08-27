/**
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const reconcile = vi.fn(async () => 0);

/**
 * The alert path is behind a dynamic import, so "did not happen" can only be
 * asserted after the microtasks that WOULD have run have run. Without this
 * flush a negative assertion passes vacuously — an injected removal of the
 * platform gate went undetected until it was added.
 */
async function flushAlertPath() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const notifications = { current: undefined as unknown };
const connection = { current: 'http://station.one' };
const platform = {
  current: { isTauri: true, isDesktop: true, isMobile: false },
};
const queryArgs = { current: [] as unknown[] };

vi.mock('../platform/native/blockingAlert', () => ({
  reconcileBlockingAlerts: (...args: unknown[]) => reconcile(...(args as [])),
}));
vi.mock('@kontourai/station-sdk', () => ({
  LIVE_NOTIFICATION_STATUSES: ['pending', 'delivered'],
  useNotificationsQuery: (...args: unknown[]) => {
    queryArgs.current = args;
    return { data: notifications.current };
  },
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: connection.current }),
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platform.current,
}));

import { useApprovalOsAlerts } from '../hooks/useApprovalOsAlerts';

describe('useApprovalOsAlerts', () => {
  beforeEach(() => {
    reconcile.mockClear();
    platform.current = { isTauri: true, isDesktop: true, isMobile: false };
    connection.current = 'http://station.one';
    notifications.current = undefined;
  });

  test('hands the live notifications to the alert reconciler on a desktop host', async () => {
    notifications.current = [{ id: 'n-1' }];
    renderHook(() => useApprovalOsAlerts());

    await waitFor(() =>
      expect(reconcile).toHaveBeenCalledWith(
        [{ id: 'n-1' }],
        'http://station.one',
      ),
    );
  });

  test('stays silent on a mobile native host, where a foreground post is silence', async () => {
    platform.current = { isTauri: true, isDesktop: false, isMobile: true };
    notifications.current = [{ id: 'n-1' }];
    const { rerender } = renderHook(() => useApprovalOsAlerts());
    rerender();

    await flushAlertPath();
    expect(reconcile).not.toHaveBeenCalled();
    // Positive control: the same fixture DOES reach the reconciler once the
    // host qualifies, so this fails on a dead hook rather than passing for
    // the wrong reason.
    platform.current = { isTauri: true, isDesktop: true, isMobile: false };
    rerender();
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
  });

  test('stays silent in a browser, which has no native notifier', async () => {
    platform.current = { isTauri: false, isDesktop: true, isMobile: false };
    notifications.current = [{ id: 'n-1' }];
    const { rerender } = renderHook(() => useApprovalOsAlerts());
    rerender();

    await flushAlertPath();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test('does not poll where alerts are disabled, and polls where they are not', () => {
    // The query is the only recurring cost this hook adds; losing `enabled`
    // would make every browser tab fetch notifications every 10s for nothing.
    platform.current = { isTauri: false, isDesktop: true, isMobile: false };
    notifications.current = [];
    const { rerender } = renderHook(() => useApprovalOsAlerts());
    expect(queryArgs.current[1]).toMatchObject({ enabled: false });

    platform.current = { isTauri: true, isDesktop: true, isMobile: false };
    rerender();
    expect(queryArgs.current[0]).toEqual({ status: ['pending', 'delivered'] });
    expect(queryArgs.current[1]).toMatchObject({
      enabled: true,
      refetchInterval: 10_000,
    });
  });
});
