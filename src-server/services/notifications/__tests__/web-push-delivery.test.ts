import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { EventBus } from '../../orchestration/event-bus.js';
import type { WebPushDeliveryDevicePairing } from '../web-push-delivery.js';
import { wireWebPushDelivery } from '../web-push-delivery.js';
import type { WebPushSendResult, WebPushService } from '../web-push-service.js';

const APPROVAL_NOTIFICATION = {
  id: 'notification-1',
  source: 'approval-inbox',
  category: 'approval-request',
  title: 'Approval needed',
  body: 'An agent wants to use a tool.',
  priority: 'high' as const,
  status: 'delivered' as const,
  scheduledAt: null,
  deliveredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function subscription(id: string) {
  return {
    endpoint: `https://push.example.test/subscription/${id}`,
    keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
  };
}

function fakeDevicePairing(
  entries: Array<{
    deviceId: string;
    subscription: ReturnType<typeof subscription>;
  }>,
): WebPushDeliveryDevicePairing & { cleared: string[] } {
  const cleared: string[] = [];
  return {
    cleared,
    listPushSubscriptions: () => entries,
    clearPushSubscription: (deviceId: string) => {
      cleared.push(deviceId);
    },
  };
}

function quietLogger() {
  return { warn: vi.fn() };
}

const JOB_FAILURE_NOTIFICATION = {
  id: 'notification-2',
  source: 'scheduler',
  category: 'job-failure',
  title: 'Job "nightly-sync" failed',
  body: 'Something went wrong.',
  priority: 'high' as const,
  status: 'delivered' as const,
  scheduledAt: null,
  deliveredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  // Real shape from builtin-scheduler-execution.ts's job-failure schedule().
  metadata: { jobName: 'nightly-sync', link: '/schedule?job=nightly-sync' },
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('wireWebPushDelivery', () => {
  test('hosted disable never reads subscriptions or sends scheduler/session notification content', async () => {
    const eventBus = new EventBus();
    const send = vi.fn<WebPushService['send']>();
    const devicePairing: WebPushDeliveryDevicePairing = {
      listPushSubscriptions: vi.fn(() => [
        { deviceId: 'device-1', subscription: subscription('a') },
      ]),
      clearPushSubscription: vi.fn(),
    };
    wireWebPushDelivery(eventBus, devicePairing, { send }, quietLogger(), {
      enabled: false,
    });

    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, APPROVAL_NOTIFICATION);
    eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      JOB_FAILURE_NOTIFICATION,
    );
    await flushMicrotasks();

    expect(devicePairing.listPushSubscriptions).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test('filters: ignores every event except an approval-request NOTIFICATION_DELIVERED', async () => {
    const eventBus = new EventBus();
    const send = vi.fn<WebPushService['send']>();
    const devicePairing = fakeDevicePairing([
      { deviceId: 'device-1', subscription: subscription('a') },
    ]);
    wireWebPushDelivery(eventBus, devicePairing, { send }, quietLogger());

    eventBus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, { id: 'x' });
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
      ...APPROVAL_NOTIFICATION,
      category: 'general',
    });
    await flushMicrotasks();

    expect(send).not.toHaveBeenCalled();
  });

  test('fan-out: sends to every subscribed device for one approval-request delivery', async () => {
    const eventBus = new EventBus();
    const send = vi
      .fn<WebPushService['send']>()
      .mockResolvedValue('sent' as WebPushSendResult);
    const devicePairing = fakeDevicePairing([
      { deviceId: 'device-1', subscription: subscription('a') },
      { deviceId: 'device-2', subscription: subscription('b') },
    ]);
    wireWebPushDelivery(eventBus, devicePairing, { send }, quietLogger());

    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, APPROVAL_NOTIFICATION);
    await flushMicrotasks();

    expect(send).toHaveBeenCalledTimes(2);
    const [firstSub, firstPayload] = send.mock.calls[0];
    expect(firstSub).toEqual(subscription('a'));
    expect(firstPayload).toMatchObject({
      title: 'Approval needed',
      category: 'approval-request',
      notificationId: 'notification-1',
      url: '/notifications',
    });
    expect(devicePairing.cleared).toEqual([]);
  });

  test('self-heals: clears the subscription for a device whose send result is "gone"', async () => {
    const eventBus = new EventBus();
    const send = vi
      .fn<WebPushService['send']>()
      .mockImplementation(async (_sub, payload) =>
        payload.notificationId === 'notification-1' ? 'gone' : 'sent',
      );
    const devicePairing = fakeDevicePairing([
      { deviceId: 'gone-device', subscription: subscription('gone') },
    ]);
    wireWebPushDelivery(eventBus, devicePairing, { send }, quietLogger());

    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, APPROVAL_NOTIFICATION);
    await flushMicrotasks();

    expect(devicePairing.cleared).toEqual(['gone-device']);
  });

  test('never-throws: a send rejection, a listPushSubscriptions throw, and a clearPushSubscription throw are all swallowed', async () => {
    const eventBus = new EventBus();
    const logger = quietLogger();

    // 1) send() rejects outright (WebPushService.send is documented as
    // never-throwing, but the delivery wiring must not assume that).
    const rejectingSend = vi
      .fn<WebPushService['send']>()
      .mockRejectedValue(new Error('network exploded'));
    const unsubscribe1 = wireWebPushDelivery(
      eventBus,
      fakeDevicePairing([
        { deviceId: 'device-1', subscription: subscription('a') },
      ]),
      { send: rejectingSend },
      logger,
    );
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, APPROVAL_NOTIFICATION);
    await flushMicrotasks();
    unsubscribe1();

    // 2) listPushSubscriptions() throws synchronously.
    const throwingList: WebPushDeliveryDevicePairing = {
      listPushSubscriptions: () => {
        throw new Error('registry unavailable');
      },
      clearPushSubscription: vi.fn(),
    };
    const unsubscribe2 = wireWebPushDelivery(
      eventBus,
      throwingList,
      { send: vi.fn() },
      logger,
    );
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, APPROVAL_NOTIFICATION);
    await flushMicrotasks();
    unsubscribe2();

    // 3) clearPushSubscription() throws when self-healing a "gone" result.
    const throwingClear: WebPushDeliveryDevicePairing = {
      listPushSubscriptions: () => [
        { deviceId: 'device-1', subscription: subscription('a') },
      ],
      clearPushSubscription: () => {
        throw new Error('write failed');
      },
    };
    const goneSend = vi
      .fn<WebPushService['send']>()
      .mockResolvedValue('gone' as WebPushSendResult);
    const unsubscribe3 = wireWebPushDelivery(
      eventBus,
      throwingClear,
      { send: goneSend },
      logger,
    );
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, APPROVAL_NOTIFICATION);
    await flushMicrotasks();
    unsubscribe3();

    // The structural guarantee under test: none of the three failure modes
    // above ever propagated out of the EventBus listener. EventBus removes a
    // listener that throws synchronously, so a still-subscribed listener at
    // the end proves nothing here threw synchronously either.
    expect(logger.warn).toHaveBeenCalled();
  });

  test('never-throws: a malformed event payload does not crash the listener or unsubscribe it', async () => {
    const eventBus = new EventBus();
    const send = vi
      .fn<WebPushService['send']>()
      .mockResolvedValue('sent' as WebPushSendResult);
    const devicePairing = fakeDevicePairing([
      { deviceId: 'device-1', subscription: subscription('a') },
    ]);
    wireWebPushDelivery(eventBus, devicePairing, { send }, quietLogger());

    // No data at all, and data missing the fields this listener reads.
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, undefined);
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {});
    await flushMicrotasks();
    expect(send).not.toHaveBeenCalled();

    // The listener must still be subscribed (not removed by a prior throw).
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, APPROVAL_NOTIFICATION);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('station#1100: also pushes a job-failure delivery (broadened beyond approval-request)', async () => {
    const eventBus = new EventBus();
    const send = vi
      .fn<WebPushService['send']>()
      .mockResolvedValue('sent' as WebPushSendResult);
    const devicePairing = fakeDevicePairing([
      { deviceId: 'device-1', subscription: subscription('a') },
    ]);
    wireWebPushDelivery(eventBus, devicePairing, { send }, quietLogger());

    eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      JOB_FAILURE_NOTIFICATION,
    );
    await flushMicrotasks();

    expect(send).toHaveBeenCalledTimes(1);
    const [, payload] = send.mock.calls[0];
    expect(payload).toMatchObject({
      title: 'Job "nightly-sync" failed',
      category: 'job-failure',
      notificationId: 'notification-2',
      // archive#1100 review fix MEDIUM: the job's own metadata.link deep
      // link is used (there's no session to resolve for a scheduled job),
      // not the generic /notifications fallback.
      url: '/schedule?job=nightly-sync',
    });
  });

  test('station#1100 AC2: passes the per-outcome TTL (seconds) through to WebPushService.send', async () => {
    const eventBus = new EventBus();
    const send = vi
      .fn<WebPushService['send']>()
      .mockResolvedValue('sent' as WebPushSendResult);
    const devicePairing = fakeDevicePairing([
      { deviceId: 'device-1', subscription: subscription('a') },
    ]);
    wireWebPushDelivery(eventBus, devicePairing, { send }, quietLogger());

    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, APPROVAL_NOTIFICATION);
    await flushMicrotasks();

    expect(send).toHaveBeenCalledTimes(1);
    const [, , ttlSeconds] = send.mock.calls[0];
    expect(ttlSeconds).toBe(24 * 60 * 60); // WAITING_TTL_MS, in seconds
  });

  test('station#1100 AC3: deep-links to the exact session when the notification metadata resolves one', async () => {
    const eventBus = new EventBus();
    const send = vi
      .fn<WebPushService['send']>()
      .mockResolvedValue('sent' as WebPushSendResult);
    const devicePairing = fakeDevicePairing([
      { deviceId: 'device-1', subscription: subscription('a') },
    ]);
    wireWebPushDelivery(eventBus, devicePairing, { send }, quietLogger());

    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
      ...APPROVAL_NOTIFICATION,
      metadata: { sessionId: 'thread-1', sessionKind: 'runtime' },
    });
    await flushMicrotasks();

    const [, payload] = send.mock.calls[0];
    expect(payload).toMatchObject({ url: '/activity?session=thread-1' });
  });
});
