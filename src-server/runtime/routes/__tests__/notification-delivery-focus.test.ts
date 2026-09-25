/**
 * #2620: focus presence and per-tab event-stream liveness, composed the way
 * `configureRuntimeRoutes` composes them — the REAL focus route and event
 * route share one `FocusPresence` and one client-stream presence with the
 * REAL delivery wiring. The operator's tab is the focused surface; the
 * paired phone and tablet are the surfaces it may quiet.
 */
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import type {
  Notification,
  NotificationEnvelopeV1,
} from '@kontourai/station-contracts/notification';
import { DEFAULT_NOTIFICATION_ESCALATE_AFTER_MS } from '@kontourai/station-contracts/notification-preferences';
import { FOCUS_PRESENCE_REPORT_PATH } from '@kontourai/station-contracts/presence';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createEventRoutes } from '../../../routes/orchestration/events.js';
import { createFocusPresenceRoutes } from '../../../routes/presence/focus-presence-routes.js';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import type { WebPushService } from '../../../services/notifications/web-push-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { FocusPresence } from '../../../services/presence/focus-presence.js';
import { ClientConnectionPresence } from '../../../services/ssh/client-connection-presence.js';
import { createClientStreamPresence } from '../client-stream-presence.js';
import { wireNotificationDelivery } from '../notification-delivery-wiring.js';

const makeTempDir = trackTempDirs();

// Uppercase on the wire: the focus route and the stream lease must still
// land on the same `local:` surface.
const TAB = '0F0E0D0C-0B0A-4908-8706-050403020100';
const NOW = new Date('2026-09-24T12:00:00Z');

const operator: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'operator-credential-value',
  authority: 'operator-credential',
  source: 'bearer',
};

const DEVICES = ['phone', 'tablet'].map(
  (id) =>
    ({
      id,
      name: id,
      scope: 'orchestration:read orchestration:operate',
      kind: 'device',
      createdAt: 1,
      revokedAt: null,
    }) as PairedDevice,
);

function agentNotification(
  id: string,
  urgency: NotificationEnvelopeV1['urgency'],
  category: string,
): Notification {
  const envelope: NotificationEnvelopeV1 = {
    v: 1,
    source: { kind: 'agent', sessionId: 'session-1', assurance: 'bound' },
    audience: { kind: 'session-readers', sessionId: 'session-1' },
    urgency,
    interrupt: 'default',
  };
  return {
    id,
    source: 'agent',
    category,
    title: `${urgency} notice`,
    priority: 'high',
    status: 'delivered',
    scheduledAt: null,
    deliveredAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    metadata: { envelope },
  } as Notification;
}

const done = () => agentNotification('n-done', 'done', 'agent-done');
const attention = () =>
  agentNotification('n-attention', 'attention', 'agent-attention');
const failed = () => agentNotification('n-failed', 'failed', 'agent-failed');

const openStreams: AbortController[] = [];

function harness() {
  const eventBus = new EventBus();
  const focusPresence = new FocusPresence();
  const clientStreams = createClientStreamPresence({
    devices: new ClientConnectionPresence(),
    identifyDevice: () => null,
  });
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, operator);
    await next();
  });
  app.route(
    '/api/events',
    createEventRoutes({
      eventBus,
      getACPStatus: () => ({ connected: false, connections: [] }),
      logger,
      connectClientSession: (request) => clientStreams.connect(request),
    }),
  );
  app.route(
    '/api/presence',
    createFocusPresenceRoutes({
      presence: focusPresence,
      identifyDevice: () => null,
      resolvePrincipalId: () => LOCAL_OPERATOR_PRINCIPAL_ID,
    }),
  );

  const send = vi.fn<WebPushService['send']>().mockResolvedValue('sent');
  const store = new Map<string, Notification>();
  wireNotificationDelivery({
    enabled: true,
    homeDir: makeTempDir('delivery-focus-'),
    eventBus,
    logger,
    devicePairing: {
      listDevices: () => DEVICES,
      listPushSubscriptions: () =>
        DEVICES.map(({ id }) => ({
          deviceId: id,
          subscription: {
            endpoint: `https://push.example.test/${id}`,
            keys: { p256dh: `p-${id}`, auth: `a-${id}` },
          },
        })),
      clearPushSubscription: vi.fn(),
    },
    webPushService: { send },
    // The operator and both devices can read the session.
    canUserReadSession: () => true,
    listNotifications: async () => [...store.values()],
    focus: focusPresence,
    inAppLiveness: clientStreams.inAppLiveness,
  });

  const tabIsLive = () =>
    clientStreams.inAppLiveness.isLive(`local:${TAB.toLowerCase()}`);

  return {
    async openTabStream() {
      const controller = new AbortController();
      openStreams.push(controller);
      void app.request(
        new Request('http://station.test/api/events', {
          headers: { 'X-Station-Client-Session': TAB },
          signal: controller.signal,
        }),
      );
      await vi.waitFor(() => expect(tabIsLive()).toBe(true));
      return async () => {
        controller.abort();
        await vi.waitFor(() => expect(tabIsLive()).toBe(false));
      };
    },
    async focusTab(seq: number) {
      const response = await app.request(FOCUS_PRESENCE_REPORT_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Station-Client-Session': TAB,
        },
        body: JSON.stringify({ clientSessionId: TAB, state: 'focused', seq }),
      });
      expect(response.status).toBe(204);
    },
    deliver(notification: Notification) {
      store.set(notification.id, notification);
      eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        notification as never,
      );
    },
    markRead(id: string) {
      const record = store.get(id)!;
      store.set(id, { ...record, status: 'dismissed' });
    },
    pushedTo: () =>
      send.mock.calls.map(([subscription]) =>
        subscription.endpoint.split('/').pop(),
      ),
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  for (const controller of openStreams.splice(0)) controller.abort();
  vi.useRealTimers();
});

describe('focus presence gated by per-tab stream liveness (#2620)', () => {
  test('a focused tab with a live stream quiets a `done` notification on every other surface', async () => {
    const h = harness();
    await h.openTabStream();
    await h.focusTab(1);
    h.deliver(done());
    await flush();
    expect(h.pushedTo()).toEqual([]);
    // Not deferred either: `done` is never escalated.
    await vi.advanceTimersByTimeAsync(DEFAULT_NOTIFICATION_ESCALATE_AFTER_MS);
    expect(h.pushedTo()).toEqual([]);
  });

  test('a focused tab whose stream has closed quiets nothing', async () => {
    const h = harness();
    const closeStream = await h.openTabStream();
    await h.focusTab(1);
    await closeStream();
    // Its focus report is still inside the lease — only liveness differs.
    h.deliver(done());
    await flush();
    expect(h.pushedTo()).toEqual(['phone', 'tablet']);
  });

  test('a focused tab that never opened a stream quiets nothing', async () => {
    const h = harness();
    await h.focusTab(1);
    h.deliver(done());
    await flush();
    expect(h.pushedTo()).toEqual(['phone', 'tablet']);
  });

  test.each([
    ['attention', attention],
    ['failed', failed],
  ])(
    'a focused live tab only delays %s: it reaches the phone if still unread',
    async (_label, notification) => {
      const h = harness();
      await h.openTabStream();
      await h.focusTab(1);
      h.deliver(notification());
      await flush();
      expect(h.pushedTo()).toEqual([]);
      await vi.advanceTimersByTimeAsync(DEFAULT_NOTIFICATION_ESCALATE_AFTER_MS);
      expect(h.pushedTo()).toEqual(['phone', 'tablet']);
    },
  );

  test('a focused live tab: attention read on the tab before the deferral ends is never pushed', async () => {
    const h = harness();
    await h.openTabStream();
    await h.focusTab(1);
    h.deliver(attention());
    await flush();
    h.markRead('n-attention');
    await vi.advanceTimersByTimeAsync(DEFAULT_NOTIFICATION_ESCALATE_AFTER_MS);
    expect(h.pushedTo()).toEqual([]);
  });
});
