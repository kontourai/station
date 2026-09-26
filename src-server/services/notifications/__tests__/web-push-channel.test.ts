/**
 * WebPushChannel (#2586): the assertions the retired `wireWebPushDelivery`
 * suite made about the send itself — which categories, the composed
 * payload, TTL, deep links, self-heal, never-throws — now against the
 * channel the delivery router calls. Who and when is the router's
 * (router.test.ts, notification-delivery-wiring.test.ts).
 */
import type { Notification } from '@kontourai/station-contracts/notification';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { describe, expect, test, vi } from 'vitest';
import { deliveryEnvelopeFor } from '../delivery/channel.js';
import {
  WebPushChannel,
  type WebPushDeliveryDevicePairing,
} from '../web-push-channel.js';
import type { WebPushSendResult, WebPushService } from '../web-push-service.js';

const APPROVAL = {
  id: 'notification-1',
  source: 'approval-inbox',
  category: 'approval-request',
  title: 'Approval needed',
  body: 'An agent wants to use a tool.',
  priority: 'high',
  status: 'delivered',
  scheduledAt: null,
  deliveredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} satisfies Notification;

const JOB_FAILURE = {
  ...APPROVAL,
  id: 'notification-2',
  source: 'scheduler',
  category: 'job-failure',
  title: 'Job "nightly-sync" failed',
  body: 'Something went wrong.',
  // Real shape from builtin-scheduler-execution.ts's job-failure schedule().
  metadata: { jobName: 'nightly-sync', link: '/schedule?job=nightly-sync' },
} satisfies Notification;

function subscription(id: string) {
  return {
    endpoint: `https://push.example.test/subscription/${id}`,
    keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
  };
}

function pairing(
  deviceIds: string[],
  overrides: Partial<WebPushDeliveryDevicePairing> = {},
): WebPushDeliveryDevicePairing & { cleared: string[] } {
  const cleared: string[] = [];
  return {
    cleared,
    listPushSubscriptions: () =>
      deviceIds.map((deviceId) => ({
        deviceId,
        subscription: subscription(deviceId),
      })),
    clearPushSubscription: (deviceId: string) => {
      cleared.push(deviceId);
    },
    ...overrides,
  };
}

async function send(
  channel: WebPushChannel,
  notification: Notification,
  hideContent = false,
) {
  const targets = channel
    .registrations()
    .map(({ surface, ref }) => ({ surface, ref, hideContent }));
  return channel.deliver(
    notification,
    deliveryEnvelopeFor(notification).envelope,
    targets,
  );
}

describe('WebPushChannel', () => {
  test('carries only categories the outcome model classifies', () => {
    const channel = new WebPushChannel(
      pairing([]),
      { send: vi.fn() },
      {
        warn: vi.fn(),
      },
    );
    expect(channel.accepts(APPROVAL)).toBe(true);
    expect(channel.accepts(JOB_FAILURE)).toBe(true);
    expect(channel.accepts({ ...APPROVAL, category: 'general' })).toBe(false);
  });

  test('registrations are the subscribed devices, as device surfaces', () => {
    const channel = new WebPushChannel(
      pairing(['a', 'b']),
      { send: vi.fn() },
      {
        warn: vi.fn(),
      },
    );
    expect(channel.registrations()).toEqual([
      { surface: 'device:a', ref: 'a' },
      { surface: 'device:b', ref: 'b' },
    ]);
  });

  test('sends the composed payload and per-outcome TTL to each target', async () => {
    const webPush = vi
      .fn<WebPushService['send']>()
      .mockResolvedValue('sent' as WebPushSendResult);
    const channel = new WebPushChannel(
      pairing(['a', 'b']),
      { send: webPush },
      {
        warn: vi.fn(),
      },
    );
    expect(await send(channel, APPROVAL)).toEqual([
      { ref: 'a', result: 'sent' },
      { ref: 'b', result: 'sent' },
    ]);
    expect(webPush).toHaveBeenCalledTimes(2);
    const [sub, payload, ttl] = webPush.mock.calls[0]!;
    expect(sub).toEqual(subscription('a'));
    expect(payload).toMatchObject({
      title: 'Approval needed',
      body: 'An agent wants to use a tool.',
      category: 'approval-request',
      notificationId: 'notification-1',
      url: '/notifications',
    });
    expect(ttl).toBe(24 * 60 * 60); // WAITING_TTL_MS, in seconds
  });

  test("deep links: a job failure's own link, and an exact session", async () => {
    const webPush = vi
      .fn<WebPushService['send']>()
      .mockResolvedValue('sent' as WebPushSendResult);
    const channel = new WebPushChannel(
      pairing(['a']),
      { send: webPush },
      {
        warn: vi.fn(),
      },
    );
    await send(channel, JOB_FAILURE);
    await send(channel, {
      ...APPROVAL,
      metadata: { sessionId: 'thread-1', sessionKind: 'runtime' },
    });
    expect(webPush.mock.calls.map(([, payload]) => payload.url)).toEqual([
      '/schedule?job=nightly-sync',
      activityDeepLink({ sessionId: 'thread-1' }),
    ]);
  });

  test('hideContent sends a generic title and body', async () => {
    const webPush = vi
      .fn<WebPushService['send']>()
      .mockResolvedValue('sent' as WebPushSendResult);
    const channel = new WebPushChannel(
      pairing(['a']),
      { send: webPush },
      {
        warn: vi.fn(),
      },
    );
    await send(channel, APPROVAL, true);
    const [, payload] = webPush.mock.calls[0]!;
    expect(payload).toMatchObject({ title: 'Station' });
    expect(JSON.stringify(payload)).not.toContain('Approval needed');
    expect(JSON.stringify(payload)).not.toContain('use a tool');
  });

  test('a gone subscription is cleared (self-heal)', async () => {
    const devices = pairing(['gone-device']);
    const channel = new WebPushChannel(
      devices,
      { send: vi.fn().mockResolvedValue('gone') },
      { warn: vi.fn() },
    );
    expect(await send(channel, APPROVAL)).toEqual([
      { ref: 'gone-device', result: 'gone' },
    ]);
    expect(devices.cleared).toEqual(['gone-device']);
  });

  test('never throws: a send rejection, a listing throw and a self-heal throw are logged', async () => {
    const logger = { warn: vi.fn() };
    const rejecting = new WebPushChannel(
      pairing(['a']),
      { send: vi.fn().mockRejectedValue(new Error('network exploded')) },
      logger,
    );
    expect(await send(rejecting, APPROVAL)).toEqual([
      { ref: 'a', result: 'retry' },
    ]);

    const unlisted = new WebPushChannel(
      pairing([], {
        listPushSubscriptions: () => {
          throw new Error('registry unavailable');
        },
      }),
      { send: vi.fn() },
      logger,
    );
    expect(unlisted.registrations()).toEqual([]);

    const unhealable = new WebPushChannel(
      pairing(['a'], {
        clearPushSubscription: () => {
          throw new Error('write failed');
        },
      }),
      { send: vi.fn().mockResolvedValue('gone') },
      logger,
    );
    expect(await send(unhealable, APPROVAL)).toEqual([
      { ref: 'a', result: 'gone' },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  test('a target whose subscription was not listed is suppressed, not sent', async () => {
    const webPush = vi.fn<WebPushService['send']>();
    const channel = new WebPushChannel(
      pairing(['a']),
      { send: webPush },
      {
        warn: vi.fn(),
      },
    );
    channel.registrations();
    expect(
      await channel.deliver(APPROVAL, deliveryEnvelopeFor(APPROVAL).envelope, [
        { surface: 'device:stranger', ref: 'stranger', hideContent: false },
      ]),
    ).toEqual([{ ref: 'stranger', result: 'suppressed' }]);
    expect(webPush).not.toHaveBeenCalled();
  });
});
