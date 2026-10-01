import type { DevicePairingRequest } from '@kontourai/station-contracts/environment-security';
import { describe, expect, it } from 'vitest';
import { composeWebPushPayload } from '../../notifications/push-payload-composer.js';
import {
  DEVICE_PAIRING_NOTIFICATION_CATEGORY,
  DevicePairingNotificationProvider,
} from '../device-pairing-notifications.js';

/**
 * Approving a device used to require already being in the Connections modal:
 * the request appeared there and nowhere else, so a phone could sit on
 * "credential required" while the approving surface gave no signal at all.
 */

function request(overrides: Partial<DevicePairingRequest> = {}) {
  return {
    requestId: 'request-1',
    offerId: 'offer-1',
    deviceName: 'Pixel 10 Pro XL',
    scope: 'station:interactive',
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    status: 'pending',
    ...overrides,
  } as DevicePairingRequest;
}

function providerFor(requests: DevicePairingRequest[]) {
  return new DevicePairingNotificationProvider(() => ({
    listRequests: () => requests,
  }));
}

describe('device pairing notifications', () => {
  it('announces a pending request', async () => {
    const [notification] = await providerFor([request()]).poll();
    expect(notification.category).toBe(DEVICE_PAIRING_NOTIFICATION_CATEGORY);
    expect(notification.body).toContain('Pixel 10 Pro XL');
  });

  it('is a pointer, never an authorisation', async () => {
    // Approving a device has to happen from a session the Station already
    // trusts. An approve action here would make the notification itself the
    // authority, which is the one thing this must not become.
    const [notification] = await providerFor([request()]).poll();
    expect(notification.actions ?? []).toEqual([]);
    expect(JSON.stringify(notification)).not.toMatch(/approve|grant|confirm/i);
  });

  it('opens the exact pending request from a composed push without carrying a decision', async () => {
    const [pending] = await providerFor([request()]).poll();
    const now = new Date().toISOString();
    const composed = composeWebPushPayload({
      ...pending,
      id: 'notification-1',
      source: 'device-pairing',
      priority: 'high',
      status: 'delivered',
      scheduledAt: null,
      deliveredAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(composed?.payload.url).toBe('/notifications?pairing=request-1');
    expect(pending.metadata?.navigateTo).toEqual({
      path: '/notifications?pairing=request-1',
    });
    expect(pending.actions ?? []).toEqual([]);
  });

  it('ignores a request that is no longer pending', async () => {
    const settled = await providerFor([
      request({ status: 'confirmed' }),
      request({ requestId: 'r2', status: 'denied' }),
    ]).poll();
    expect(settled).toEqual([]);
  });

  it('ignores an expired request rather than pointing at a dead end', async () => {
    const expired = await providerFor([
      request({ expiresAt: Date.now() - 1 }),
    ]).poll();
    expect(expired).toEqual([]);
  });

  it('expires with the request it announces', async () => {
    // A "needs you" outliving the window it refers to is worse than silence.
    const expiresAt = Date.now() + 120_000;
    const [notification] = await providerFor([request({ expiresAt })]).poll();
    expect(notification.ttl).toBeGreaterThan(0);
    expect(notification.ttl).toBeLessThanOrEqual(120_000);
  });

  it('raises one notification per request however often it polls', async () => {
    const provider = providerFor([request()]);
    const first = await provider.poll();
    const second = await provider.poll();
    expect(first[0].dedupeTag).toBe(second[0].dedupeTag);
    expect(first[0].dedupeTag).toContain('request-1');
  });

  it('stays quiet before the environment is initialised', async () => {
    // The pairing accessor throws until then, and polling starts at bootstrap.
    const provider = new DevicePairingNotificationProvider(() => null);
    await expect(provider.poll()).resolves.toEqual([]);
  });
});

describe('syncStatus', () => {
  it('settles decided and expired requests, and leaves a live pending one alone', async () => {
    const provider = providerFor([
      request({ requestId: 'a', status: 'confirmed' }),
      request({ requestId: 'b', status: 'denied' }),
      request({ requestId: 'c', expiresAt: Date.now() - 1 }),
      request({ requestId: 'd' }), // pending, not expired
    ]);
    expect(await provider.syncStatus()).toEqual([
      { dedupeTag: 'device-pairing:a', status: 'actioned', actionId: 'allow' },
      { dedupeTag: 'device-pairing:b', status: 'actioned', actionId: 'deny' },
      { dedupeTag: 'device-pairing:c', status: 'expired' },
    ]);
  });
});
