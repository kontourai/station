/**
 * #2620: focus presence and per-tab event-stream liveness, composed the way
 * `configureRuntimeRoutes` composes them — the REAL focus route and event
 * route share one `FocusPresence` and one client-stream presence with the
 * REAL delivery wiring. The focused surface is an operator tab
 * (`local:`) or the local browser UI's device (`device:laptop`, two
 * documents); the paired phone and tablet are the surfaces it may quiet.
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
import { pairedDevicePrincipal } from '../../bootstrap/orchestration-request-principal.js';
import { createClientStreamPresence } from '../client-stream-presence.js';
import { wireNotificationDelivery } from '../notification-delivery-wiring.js';

const makeTempDir = trackTempDirs();

// Uppercase on the wire: the focus route and the stream lease must still
// land on the same `local:` surface.
const TAB = '0F0E0D0C-0B0A-4908-8706-050403020100';
const NOW = new Date('2026-09-24T12:00:00Z');

// A second document of the same browser (the local UI signs in as a device).
const OTHER_TAB = '11111111-1111-4111-8111-111111111111';

const operator: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'operator-credential-value',
  authority: 'operator-credential',
  source: 'bearer',
};
/** The local browser UI's ui-bootstrap device credential. */
const laptopCredential: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'laptop-credential',
  authority: 'device-credential',
  deviceId: 'laptop',
  source: 'session',
};

const device = (id: string) =>
  ({
    id,
    name: id,
    scope: 'orchestration:read orchestration:operate',
    kind: 'device',
    createdAt: 1,
    revokedAt: null,
  }) as PairedDevice;
/** Push-subscribed phones. */
const DEVICES = ['phone', 'tablet'].map(device);
/** The browser: a family device with no push subscription. */
const LAPTOP = device('laptop');

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

type Caller = 'operator' | 'laptop';

function harness() {
  const eventBus = new EventBus();
  const focusPresence = new FocusPresence();
  const clientStreams = createClientStreamPresence({
    devices: new ClientConnectionPresence(),
    identifyDevice: (credential) =>
      credential === laptopCredential.credential ? { id: 'laptop' } : null,
    focus: focusPresence,
  });
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  /** Documents holding a leased stream, to wait on open and close. */
  const leased = new Set<string>();

  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(
      c.req.raw,
      c.req.header('x-test-caller') === 'laptop' ? laptopCredential : operator,
    );
    await next();
  });
  app.route(
    '/api/events',
    createEventRoutes({
      eventBus,
      getACPStatus: () => ({ connected: false, connections: [] }),
      logger,
      connectClientSession: (request) => {
        const lease = clientStreams.connect(request);
        if (!lease) return undefined;
        const document = request.headers.get('x-station-client-session')!;
        leased.add(document);
        return {
          touch: () => lease.touch(),
          release: () => {
            leased.delete(document);
            lease.release();
          },
        };
      },
    }),
  );
  app.route(
    '/api/presence',
    createFocusPresenceRoutes({
      presence: focusPresence,
      identifyDevice: (credential) =>
        credential === laptopCredential.credential
          ? { id: 'laptop', kind: 'device' }
          : null,
      resolvePrincipalId: (c) =>
        c.req.header('x-test-caller') === 'laptop'
          ? pairedDevicePrincipal(LAPTOP).id
          : LOCAL_OPERATOR_PRINCIPAL_ID,
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
      listDevices: () => [...DEVICES, LAPTOP],
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
    // The operator and every device can read the session.
    canUserReadSession: () => true,
    listNotifications: async () => [...store.values()],
    focus: focusPresence,
    inAppLiveness: clientStreams.inAppLiveness,
  });

  let seq = 0;
  async function openStream(caller: Caller, document: string) {
    const controller = new AbortController();
    openStreams.push(controller);
    void Promise.resolve(
      app.request(
        new Request('http://station.test/api/events', {
          headers: {
            'X-Station-Client-Session': document,
            'x-test-caller': caller,
          },
          signal: controller.signal,
        }),
      ),
    )
      // Read the stream as a browser would, so keepalive writes complete.
      .then((response: Response) => response.body?.pipeTo(new WritableStream()))
      .catch(() => {});
    await vi.waitFor(() => expect(leased.has(document)).toBe(true));
    return async () => {
      controller.abort();
      await vi.waitFor(() => expect(leased.has(document)).toBe(false));
    };
  }
  async function report(
    caller: Caller,
    document: string,
    state: 'focused' | 'visible' | 'hidden',
  ) {
    seq += 1;
    const response = await app.request(FOCUS_PRESENCE_REPORT_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Station-Client-Session': document,
        'x-test-caller': caller,
      },
      body: JSON.stringify({ clientSessionId: document, state, seq }),
    });
    expect(response.status).toBe(204);
  }

  return {
    openStream,
    report,
    openTabStream: () => openStream('operator', TAB),
    focusTab: () => report('operator', TAB, 'focused'),
    tabIsLive: () =>
      clientStreams.inAppLiveness.isLive(`local:${TAB.toLowerCase()}`),
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
    await h.focusTab();
    h.deliver(done());
    await flush();
    expect(h.pushedTo()).toEqual([]);
    // Not deferred either: `done` is never escalated.
    await vi.advanceTimersByTimeAsync(DEFAULT_NOTIFICATION_ESCALATE_AFTER_MS);
    expect(h.pushedTo()).toEqual([]);
  });

  test('the keepalive keeps a long-open stream live past the 90 s stream lease', async () => {
    const h = harness();
    await h.openTabStream();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.tabIsLive()).toBe(true);
    // Focus is reported after the wait so it is fresh; only the stream aged.
    await h.focusTab();
    h.deliver(done());
    await flush();
    expect(h.pushedTo()).toEqual([]);
  });

  test('a focused tab whose stream has closed quiets nothing', async () => {
    const h = harness();
    const closeStream = await h.openTabStream();
    await h.focusTab();
    await closeStream();
    // Its focus report is still inside the lease — only liveness differs.
    h.deliver(done());
    await flush();
    expect(h.pushedTo()).toEqual(['phone', 'tablet']);
  });

  test('a focused tab that never opened a stream quiets nothing', async () => {
    const h = harness();
    await h.focusTab();
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
      await h.focusTab();
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
    await h.focusTab();
    h.deliver(attention());
    await flush();
    h.markRead('n-attention');
    await vi.advanceTimersByTimeAsync(DEFAULT_NOTIFICATION_ESCALATE_AFTER_MS);
    expect(h.pushedTo()).toEqual([]);
  });

  describe('the local browser UI, which signs in as a device (ui-bootstrap)', () => {
    test("the focused document's stream is dead while another document of the same browser is live: nothing is quieted", async () => {
      const h = harness();
      await h.report('laptop', OTHER_TAB, 'hidden');
      await h.openStream('laptop', OTHER_TAB);
      await h.report('laptop', TAB, 'focused');
      const closeFocused = await h.openStream('laptop', TAB);
      await closeFocused();
      h.deliver(done());
      await flush();
      expect(h.pushedTo()).toEqual(['phone', 'tablet']);
    });

    test('the focused document never opened a stream while another is live: nothing is quieted', async () => {
      const h = harness();
      await h.openStream('laptop', OTHER_TAB);
      await h.report('laptop', TAB, 'focused');
      h.deliver(done());
      await flush();
      expect(h.pushedTo()).toEqual(['phone', 'tablet']);
    });

    test("the focused document's own stream is live: `done` is quieted on the phone", async () => {
      const h = harness();
      await h.openStream('laptop', TAB);
      await h.report('laptop', TAB, 'focused');
      h.deliver(done());
      await flush();
      expect(h.pushedTo()).toEqual([]);
    });
  });
});
