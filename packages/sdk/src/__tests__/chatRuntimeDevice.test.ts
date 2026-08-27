import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  DevicePairingRequiredError,
  fetchVapidPublicKey,
  subscribePushNotifications,
  unsubscribePushNotifications,
} from '../query-domains/chatRuntimeDevice';

function mockJsonResponse(payload: unknown, status = 200) {
  vi.mocked(fetch).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response);
}

describe('chatRuntimeDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('fetches the VAPID public key from the configured API base', async () => {
    mockJsonResponse({ publicKey: 'test-public-key' });

    await expect(fetchVapidPublicKey()).resolves.toBe('test-public-key');
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/system/vapid-public-key',
    );
  });

  it('rejects when the server does not return a public key', async () => {
    mockJsonResponse({});

    await expect(fetchVapidPublicKey()).rejects.toThrow(
      'Missing VAPID public key',
    );
  });

  it('subscribePushNotifications posts the subscription and resolves on success', async () => {
    mockJsonResponse({ ok: true });

    await expect(
      subscribePushNotifications({
        endpoint: 'https://push.example.test/sub',
        keys: { p256dh: 'p', auth: 'a' },
      } as PushSubscriptionJSON),
    ).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/system/push-subscribe',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('subscribePushNotifications throws DevicePairingRequiredError on a 403 device_pairing_required response', async () => {
    mockJsonResponse({ error: 'device_pairing_required' }, 403);

    await expect(
      subscribePushNotifications({
        endpoint: 'https://push.example.test/sub',
        keys: { p256dh: 'p', auth: 'a' },
      } as PushSubscriptionJSON),
    ).rejects.toBeInstanceOf(DevicePairingRequiredError);
  });

  // Since #1189 the runtime auth gate verifies any presented, well-formed
  // credential regardless of peer class, so a device revoked elsewhere is
  // refused with 401 before it ever reaches push-routes' own 403. Recovery is
  // still re-pairing, not re-authentication, so this must reach the same
  // "Pair this device first" state rather than a generic failure.
  it('subscribePushNotifications throws DevicePairingRequiredError on a 401 authentication_required response', async () => {
    mockJsonResponse({ error: { code: 'authentication_required' } }, 401);

    await expect(
      subscribePushNotifications({
        endpoint: 'https://push.example.test/sub',
        keys: { p256dh: 'p', auth: 'a' },
      } as PushSubscriptionJSON),
    ).rejects.toBeInstanceOf(DevicePairingRequiredError);
  });

  it('unsubscribePushNotifications throws DevicePairingRequiredError on a 401 authentication_required response', async () => {
    mockJsonResponse({ error: { code: 'authentication_required' } }, 401);

    await expect(
      unsubscribePushNotifications('https://push.example.test/sub'),
    ).rejects.toBeInstanceOf(DevicePairingRequiredError);
  });

  // The match is on the error shape, not the bare status, so a 401 raised by
  // some other layer still surfaces as an ordinary failure.
  it('subscribePushNotifications throws a generic error on a 401 that is not authentication_required', async () => {
    mockJsonResponse({ error: 'rate_limited' }, 401);

    await expect(
      subscribePushNotifications({
        endpoint: 'https://push.example.test/sub',
        keys: { p256dh: 'p', auth: 'a' },
      } as PushSubscriptionJSON),
    ).rejects.toThrow('Failed to subscribe to push notifications: 401');
  });

  it('subscribePushNotifications throws a generic error on other non-ok responses', async () => {
    mockJsonResponse({ error: 'invalid_request' }, 400);

    await expect(
      subscribePushNotifications({
        endpoint: 'https://push.example.test/sub',
        keys: { p256dh: 'p', auth: 'a' },
      } as PushSubscriptionJSON),
    ).rejects.toThrow('Failed to subscribe to push notifications: 400');
  });

  it('unsubscribePushNotifications throws DevicePairingRequiredError on a 403 device_pairing_required response', async () => {
    mockJsonResponse({ error: 'device_pairing_required' }, 403);

    await expect(
      unsubscribePushNotifications('https://push.example.test/sub'),
    ).rejects.toBeInstanceOf(DevicePairingRequiredError);
  });

  it('unsubscribePushNotifications resolves on success', async () => {
    mockJsonResponse({ ok: true });

    await expect(
      unsubscribePushNotifications('https://push.example.test/sub'),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/system/push-unsubscribe',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
