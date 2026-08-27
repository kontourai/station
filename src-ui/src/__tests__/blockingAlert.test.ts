/**
 * @vitest-environment jsdom
 */

import {
  BLOCKING_NOTIFICATION_CATEGORIES,
  type Notification,
} from '@kontourai/station-contracts/notification';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const notifyNatively = vi.fn(
  async (_input: { title: string; body?: string }) => true,
);
vi.mock('../platform/native/notify', () => ({
  notifyNatively: (input: { title: string; body?: string }) =>
    notifyNatively(input),
}));

import {
  reconcileBlockingAlerts,
  resetBlockingAlertState,
} from '../platform/native/blockingAlert';

/**
 * The real producer's shape: `DevicePairingNotificationProvider` schedules
 * exactly this category with this title. Fabricating a friendlier shape is
 * what let the first version of this feature ship keyed to a projection the
 * pairing case never enters.
 */
function pairing(id: string, overrides: Partial<Notification> = {}) {
  return {
    id,
    source: 'device-pairing',
    category: BLOCKING_NOTIFICATION_CATEGORIES.devicePairing,
    status: 'delivered',
    priority: 'high',
    title: 'A device is asking to pair',
    body: 'Pixel 10 Pro XL · Station',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  } as Notification;
}

const A = 'http://station.one';

describe('reconcileBlockingAlerts', () => {
  beforeEach(() => {
    notifyNatively.mockClear();
    resetBlockingAlertState();
  });

  test('announces a device pairing request — the case this exists for', async () => {
    expect(await reconcileBlockingAlerts([], A)).toBe(0);
    expect(await reconcileBlockingAlerts([pairing('pair-1')], A)).toBe(1);
    expect(notifyNatively).toHaveBeenCalledTimes(1);
  });

  test('never forwards the notification’s own text to the OS', async () => {
    // Approval titles are adapter-supplied and can carry the command being
    // approved, tokens included; the projection truncates but does not
    // redact. A lock screen has no authentication in front of it.
    await reconcileBlockingAlerts([], A);
    await reconcileBlockingAlerts(
      [
        pairing('pair-1', {
          title: 'curl -H "Authorization: Bearer sk-live-SECRET" …',
          body: 'secret payload',
        }),
      ],
      A,
    );

    const [posted] = notifyNatively.mock.calls[0] ?? [];
    expect(posted).toEqual({
      title: 'A device is asking to pair',
      body: 'Open Station to approve or deny it.',
    });
    expect(JSON.stringify(posted)).not.toContain('SECRET');
    expect(JSON.stringify(posted)).not.toContain('secret payload');
  });

  test('announces an approval request with its own copy', async () => {
    await reconcileBlockingAlerts([], A);
    await reconcileBlockingAlerts(
      [
        pairing('appr-1', {
          category: BLOCKING_NOTIFICATION_CATEGORIES.approvalRequest,
        }),
      ],
      A,
    );

    expect(notifyNatively).toHaveBeenCalledWith({
      title: 'A run is waiting for your approval',
      body: 'Open Station to review it.',
    });
  });

  test('ignores categories that are not blocking a person', async () => {
    await reconcileBlockingAlerts([], A);
    expect(
      await reconcileBlockingAlerts(
        [pairing('turn-1', { category: 'turn-completed' })],
        A,
      ),
    ).toBe(0);
    expect(notifyNatively).not.toHaveBeenCalled();
  });

  test('seeds the backlog already waiting at first observation', async () => {
    expect(
      await reconcileBlockingAlerts([pairing('old-1'), pairing('old-2')], A),
    ).toBe(0);
    expect(notifyNatively).not.toHaveBeenCalled();
  });

  test('announces each request once across repeated polls', async () => {
    await reconcileBlockingAlerts([], A);
    await reconcileBlockingAlerts([pairing('pair-1')], A);
    await reconcileBlockingAlerts([pairing('pair-1')], A);
    expect(notifyNatively).toHaveBeenCalledTimes(1);
  });

  test('announces again when a resolved request returns under the same id', async () => {
    await reconcileBlockingAlerts([], A);
    await reconcileBlockingAlerts([pairing('pair-1')], A);
    await reconcileBlockingAlerts([], A);
    await reconcileBlockingAlerts([pairing('pair-1')], A);
    expect(notifyNatively).toHaveBeenCalledTimes(2);
  });

  test('reseeds on a Station switch instead of carrying ids across', async () => {
    // Ids are only meaningful within one Station: carrying them would both
    // suppress a real alert on B and re-announce a stale one back on A.
    await reconcileBlockingAlerts([], A);
    await reconcileBlockingAlerts([pairing('pair-1')], A);
    expect(notifyNatively).toHaveBeenCalledTimes(1);

    const B = 'http://station.two';
    await reconcileBlockingAlerts([pairing('pair-1')], B);
    expect(notifyNatively).toHaveBeenCalledTimes(1);

    await reconcileBlockingAlerts([pairing('pair-1'), pairing('pair-2')], B);
    expect(notifyNatively).toHaveBeenCalledTimes(2);
  });
});
