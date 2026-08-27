import { beforeEach, describe, expect, test, vi } from 'vitest';

// The send-outcome classifier is the safety-critical seam: 'gone' triggers
// subscription self-healing in web-push-delivery.ts, so a transient failure
// (5xx, network error) must NEVER classify as 'gone' or healthy devices
// would be silently unsubscribed.
const sendNotification = vi.fn();

class FakeWebPushError extends Error {
  statusCode: number;
  constructor(statusCode: number) {
    super(`push failed with ${statusCode}`);
    this.statusCode = statusCode;
  }
}

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    WebPushError: FakeWebPushError,
  },
}));

const subscription = {
  endpoint: 'https://push.example/sub/1',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
};

const payload = {
  title: 'Approval needed',
  category: 'approval-request',
  notificationId: 'n-1',
  url: '/notifications',
};

async function makeService() {
  const { WebPushService } = await import('../web-push-service.js');
  return new WebPushService(
    { publicKey: 'pub', privateKey: 'priv' },
    'mailto:push@station.local',
  );
}

describe('WebPushService send-outcome classification', () => {
  beforeEach(() => {
    sendNotification.mockReset();
  });

  test('a successful delivery classifies as sent', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const service = await makeService();
    await expect(service.send(subscription, payload)).resolves.toBe('sent');
  });

  test.each([404, 410])(
    'a %i from the push service classifies as gone (self-heal eligible)',
    async (statusCode) => {
      sendNotification.mockRejectedValue(new FakeWebPushError(statusCode));
      const service = await makeService();
      await expect(service.send(subscription, payload)).resolves.toBe('gone');
    },
  );

  test.each([400, 429, 500, 502, 503])(
    'a transient/other %i classifies as error, never gone',
    async (statusCode) => {
      sendNotification.mockRejectedValue(new FakeWebPushError(statusCode));
      const service = await makeService();
      await expect(service.send(subscription, payload)).resolves.toBe('error');
    },
  );

  test('a non-WebPushError failure (network, DNS) classifies as error', async () => {
    sendNotification.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const service = await makeService();
    await expect(service.send(subscription, payload)).resolves.toBe('error');
  });

  test('send never throws', async () => {
    sendNotification.mockImplementation(() => {
      throw new Error('sync explosion');
    });
    const service = await makeService();
    await expect(service.send(subscription, payload)).resolves.toBe('error');
  });

  test('station#1100 AC2: passes ttlSeconds through as the Web Push protocol TTL option', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const service = await makeService();
    await service.send(subscription, payload, 7200);
    expect(sendNotification).toHaveBeenCalledWith(
      subscription,
      JSON.stringify(payload),
      { TTL: 7200 },
    );
  });

  test('station#1100 AC2: omits the TTL option entirely when ttlSeconds is not provided', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const service = await makeService();
    await service.send(subscription, payload);
    expect(sendNotification).toHaveBeenCalledWith(
      subscription,
      JSON.stringify(payload),
      undefined,
    );
  });
});
