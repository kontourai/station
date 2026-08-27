import type { DevicePairingRequest } from '@kontourai/station-contracts/environment-security';
import { describe, expect, it } from 'vitest';
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

  it('carries enough to find the request without carrying the decision', async () => {
    const [notification] = await providerFor([request()]).poll();
    expect(notification.metadata?.requestId).toBe('request-1');
    expect(notification.metadata?.surface).toBe('connections:pairing');
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
  it('emits actioned for confirmed requests', async () => {
    const provider = providerFor([request({ status: 'confirmed' })]);
    const updates = await provider.syncStatus();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      dedupeTag: 'device-pairing:request-1',
      status: 'actioned',
      actionId: 'allow',
    });
  });

  it('emits actioned for denied requests', async () => {
    const provider = providerFor([request({ status: 'denied' })]);
    const updates = await provider.syncStatus();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      dedupeTag: 'device-pairing:request-1',
      status: 'actioned',
      actionId: 'deny',
    });
  });

  it('emits expired for expired pending requests', async () => {
    const provider = providerFor([request({ expiresAt: Date.now() - 1 })]);
    const updates = await provider.syncStatus();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      dedupeTag: 'device-pairing:request-1',
      status: 'expired',
    });
  });

  it('returns empty for pending unexpired requests', async () => {
    const provider = providerFor([request()]);
    const updates = await provider.syncStatus();
    expect(updates).toEqual([]);
  });

  it('handles mixed statuses', async () => {
    const provider = providerFor([
      request({ requestId: 'a', status: 'confirmed' }),
      request({ requestId: 'b', status: 'denied' }),
      request({ requestId: 'c', expiresAt: Date.now() - 1 }),
      request({ requestId: 'd' }), // pending, not expired
    ]);
    const updates = await provider.syncStatus();
    expect(updates).toHaveLength(3);
    const byId = Object.fromEntries(updates.map((u) => [u.dedupeTag, u]));
    expect(byId['device-pairing:a'].status).toBe('actioned');
    expect(byId['device-pairing:b'].status).toBe('actioned');
    expect(byId['device-pairing:c'].status).toBe('expired');
    expect(byId['device-pairing:d']).toBeUndefined();
  });
});
