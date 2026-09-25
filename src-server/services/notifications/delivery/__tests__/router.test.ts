import type { Notification } from '@kontourai/station-contracts/notification';
import { type NotificationEnvelopeV1 } from '@kontourai/station-contracts/notification';
import {
  defaultNotificationPreferences,
  type NotificationPreferencesV1,
} from '@kontourai/station-contracts/notification-preferences';
import {
  SERVER_EVENTS,
  type ServerEventName,
} from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import type { EventBus } from '../../../orchestration/event-bus.js';
import type { AudienceResolver } from '../audience-resolver.js';
import type {
  ChannelTarget,
  DeliveryChannel,
  DeliveryOutcome,
  SurfaceId,
} from '../channel.js';
import type { FocusEntry } from '../policy.js';
import {
  type FocusSource,
  type NotificationDeliveryRouterOptions,
  wireNotificationDeliveryRouter,
} from '../router.js';

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const PHONE: SurfaceId = 'device:phone';
const LAPTOP: SurfaceId = 'device:laptop';
const ALICE = 'principal:alice';

type Listener = (message: {
  event: ServerEventName;
  data?: Record<string, unknown>;
}) => void;

/**
 * A bus that calls its one listener WITHOUT a try/catch, so a throw that
 * escapes the router fails the test instead of being swallowed the way the
 * real EventBus swallows it.
 */
function rawBus() {
  let listener: Listener | undefined;
  const bus = {
    subscribe(fn: Listener) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as EventBus;
  return {
    bus,
    emit(event: ServerEventName, data?: unknown) {
      listener?.({ event, data: data as Record<string, unknown> });
    },
    subscribed: () => listener !== undefined,
  };
}

class RecordingChannel implements DeliveryChannel {
  readonly deliveries: Array<{
    id: string;
    title: string;
    to: ChannelTarget[];
  }> = [];
  readonly retractions: Array<{ id: string; to: ChannelTarget[] }> = [];
  readonly capabilities;
  constructor(
    readonly kind: DeliveryChannel['kind'],
    private readonly surfaces: SurfaceId[],
    retract: boolean,
  ) {
    this.capabilities = { retract, sealed: true, wakesClosedApp: true };
    if (!retract) this.retract = undefined;
  }
  registrations() {
    return this.surfaces.map((surface) => ({ surface, ref: `${surface}#ref` }));
  }
  async deliver(
    notification: Notification,
    _envelope: NotificationEnvelopeV1,
    to: ChannelTarget[],
  ): Promise<DeliveryOutcome[]> {
    this.deliveries.push({
      id: notification.id,
      title: notification.title,
      to,
    });
    return to.map(({ ref }) => ({ ref, result: 'sent' }));
  }
  retract?: (id: string, to: ChannelTarget[]) => Promise<void> = async (
    id,
    to,
  ) => {
    this.retractions.push({ id, to });
  };
}

function notification(
  overrides: Partial<Notification> & { envelope?: NotificationEnvelopeV1 } = {},
): Notification {
  const { envelope = agentEnvelope(), ...rest } = overrides;
  return {
    id: 'n-1',
    source: 'agent',
    category: 'agent-attention',
    title: 'Need approval to run migration',
    priority: 'high',
    status: 'delivered',
    scheduledAt: null,
    deliveredAt: new Date(NOW).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    metadata: { envelope },
    ...rest,
  };
}

function agentEnvelope(
  overrides: Partial<NotificationEnvelopeV1> = {},
): NotificationEnvelopeV1 {
  return {
    v: 1,
    source: { kind: 'agent', sessionId: 'session-1', assurance: 'bound' },
    audience: { kind: 'session-readers', sessionId: 'session-1' },
    urgency: 'attention',
    interrupt: 'default',
    ...overrides,
  };
}

const everyone: AudienceResolver = {
  resolve: () => ({
    deviceSurfaces: new Set([PHONE, LAPTOP]),
    includesOperator: true,
    principalOf: new Map([
      [PHONE, ALICE],
      [LAPTOP, ALICE],
    ]),
    operatorPrincipalId: 'human:local:operator',
  }),
};

function focusOn(
  surfaces: SurfaceId[] | SurfaceId,
  principalId = ALICE,
): FocusSource & { asked: string[][] } {
  const asked: string[][] = [];
  const list = Array.isArray(surfaces) ? surfaces : [surfaces];
  return {
    asked,
    snapshotForPrincipals: (principalIds) => {
      asked.push([...principalIds]);
      return new Map<SurfaceId, FocusEntry>(
        list.map((surface) => [
          surface,
          { state: 'focused', reportedAt: NOW, principalId },
        ]),
      );
    },
  };
}

function setup(
  overrides: Partial<NotificationDeliveryRouterOptions> & {
    prefs?: NotificationPreferencesV1;
  } = {},
) {
  const bus = rawBus();
  const logger = { warn: vi.fn() };
  const timers: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  const retracting = new RecordingChannel('fcm-alert', [PHONE, LAPTOP], true);
  const plain = new RecordingChannel('web-push', [PHONE, LAPTOP], false);
  const current = new Map<string, Notification>();
  const prefs = overrides.prefs ?? defaultNotificationPreferences();
  const router = wireNotificationDeliveryRouter({
    eventBus: bus.bus,
    channels: [retracting, plain],
    resolver: everyone,
    preferences: { current: () => prefs },
    logger,
    inAppLiveness: { isLive: () => true },
    now: () => NOW,
    timeZone: 'UTC',
    readNotification: async (id) => current.get(id),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...overrides,
  });
  return { bus, logger, timers, retracting, plain, current, router };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function fire(timer: { callback: () => void; cancelled: boolean }) {
  expect(timer.cancelled).toBe(false);
  timer.callback();
  await flush();
}

describe('NotificationDeliveryRouter', () => {
  test('nothing focused: every audience surface on every channel, in the emit turn', () => {
    const { bus, retracting, plain } = setup();
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
    // Synchronous: no await before the channels were called.
    expect(plain.deliveries.map((d) => d.to.map((t) => t.surface))).toEqual([
      [PHONE, LAPTOP],
    ]);
    expect(retracting.deliveries).toHaveLength(1);
  });

  test('only surfaces the resolver returned are targeted', () => {
    const { bus, plain } = setup({
      resolver: {
        resolve: () => ({
          deviceSurfaces: new Set([PHONE]),
          includesOperator: false,
        }),
      },
    });
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
    expect(plain.deliveries[0]?.to.map((t) => t.surface)).toEqual([PHONE]);
  });

  test('hideContent from the surface preference reaches the channel target', () => {
    const prefs = defaultNotificationPreferences();
    prefs.perSurface[PHONE] = { minUrgency: 'info', hideContent: true };
    const { bus, plain } = setup({ prefs });
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
    expect(
      plain.deliveries[0]?.to.map((t) => [t.surface, t.hideContent]),
    ).toEqual([
      [PHONE, true],
      [LAPTOP, false],
    ]);
  });

  describe('escalation', () => {
    test('another surface focused: deferred, then sent only because it is still unread', async () => {
      const { bus, timers, plain, current, router } = setup({
        focus: focusOn(LAPTOP),
      });
      const n = notification();
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, n);
      expect(plain.deliveries).toHaveLength(0);
      expect(timers).toHaveLength(1);
      expect(timers[0]?.delayMs).toBe(180_000);
      expect(router.pendingEscalations()).toEqual(['n-1']);

      current.set(n.id, n);
      await fire(timers[0]!);
      expect(plain.deliveries.map((d) => d.to.map((t) => t.surface))).toEqual([
        [PHONE],
      ]);
      expect(router.pendingEscalations()).toEqual([]);
    });

    test.each([
      [
        'read on another surface',
        notification({
          envelope: agentEnvelope({
            readAt: new Date(NOW).toISOString(),
            readBy: LAPTOP,
          }),
        }),
      ],
      [
        'dismissed',
        notification({
          envelope: agentEnvelope({
            dismissedAt: new Date(NOW).toISOString(),
            dismissedBy: LAPTOP,
          }),
        }),
      ],
      ['no longer delivered', notification({ status: 'dismissed' })],
      ['gone from the store', undefined],
    ])(
      'not sent when the record is %s at re-check time',
      async (_label, record) => {
        const { bus, timers, plain, retracting, current } = setup({
          focus: focusOn(LAPTOP),
        });
        bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
        if (record) current.set('n-1', record);
        await fire(timers[0]!);
        expect(plain.deliveries).toHaveLength(0);
        expect(retracting.deliveries).toHaveLength(0);
      },
    );

    test('info/done while another surface is focused are not deferred at all', () => {
      const { bus, timers, plain } = setup({ focus: focusOn(LAPTOP) });
      bus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        notification({
          category: 'agent-done',
          envelope: agentEnvelope({ urgency: 'done' }),
        }),
      );
      expect(timers).toHaveLength(0);
      expect(plain.deliveries).toHaveLength(0);
    });
  });

  test.each([
    ['a newer envelope version', { v: 2 }],
    ['a malformed envelope', 'not-an-object'],
  ])(
    "%s is the owner's in-app view only: nothing is pushed",
    (_label, envelope) => {
      const { bus, plain, retracting } = setup();
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
        ...notification({ category: 'approval-request' }),
        metadata: { envelope },
      });
      expect(plain.deliveries).toHaveLength(0);
      expect(retracting.deliveries).toHaveLength(0);
    },
  );

  test('control: the same record with no envelope at all is legacy and is pushed', () => {
    const { bus, plain } = setup();
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
      ...notification({ category: 'approval-request' }),
      metadata: {},
    });
    expect(plain.deliveries).toHaveLength(1);
  });

  describe('focus', () => {
    test("is asked only for the audience's principals", () => {
      const focus = focusOn(LAPTOP);
      const { bus } = setup({ focus });
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      expect(focus.asked).toEqual([[ALICE, 'human:local:operator']]);
    });

    test('a report whose principal is not the one the surface resolves to quiets no one', () => {
      const { bus, plain, timers } = setup({
        focus: focusOn(LAPTOP, 'principal:mallory'),
      });
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      expect(timers).toHaveLength(0);
      expect(plain.deliveries[0]?.to.map((t) => t.surface)).toEqual([
        PHONE,
        LAPTOP,
      ]);
    });

    test('a focused surface with no live in-app channel quiets no one', () => {
      const { bus, plain, timers } = setup({
        focus: focusOn(LAPTOP),
        inAppLiveness: { isLive: (surface) => surface !== LAPTOP },
      });
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      expect(timers).toHaveLength(0);
      expect(plain.deliveries[0]?.to.map((t) => t.surface)).toEqual([
        PHONE,
        LAPTOP,
      ]);
    });

    test("an owner audience is one person: focus on the operator's desktop quiets their unbound phone", () => {
      const { bus, plain, timers } = setup({
        resolver: {
          resolve: () => ({
            deviceSurfaces: new Set([PHONE, LAPTOP]),
            includesOperator: true,
            // Different principal ids (a device identity and the operator)...
            principalOf: new Map([
              [PHONE, 'device-identity:phone'],
              [LAPTOP, 'human:local:operator'],
            ]),
            operatorPrincipalId: 'human:local:operator',
            // ...but the resolver vouches they are one person.
            onePerson: true,
          }),
        },
        focus: focusOn(LAPTOP, 'human:local:operator'),
      });
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      expect(plain.deliveries).toHaveLength(0);
      expect(timers).toHaveLength(1);
    });

    test('with no liveness wired, focus is inert (the safe side)', () => {
      const { bus, plain } = setup({
        focus: focusOn(LAPTOP),
        inAppLiveness: undefined,
      });
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      expect(plain.deliveries).toHaveLength(1);
    });
  });

  describe('read and dismiss propagation', () => {
    test('a read cancels the escalation and retracts from retract-capable channels only', async () => {
      const { bus, timers, retracting, plain, router } = setup();
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      expect(retracting.deliveries).toHaveLength(1);

      bus.emit(
        SERVER_EVENTS.NOTIFICATION_UPDATED,
        notification({
          envelope: agentEnvelope({
            readAt: new Date(NOW).toISOString(),
            readBy: PHONE,
          }),
        }),
      );
      await flush();
      expect(retracting.retractions).toEqual([
        {
          id: 'n-1',
          to: [
            { surface: PHONE, ref: `${PHONE}#ref`, hideContent: false },
            { surface: LAPTOP, ref: `${LAPTOP}#ref`, hideContent: false },
          ],
        },
      ]);
      expect(plain.retract).toBeUndefined();
      expect(timers).toHaveLength(0);
      expect(router.pendingEscalations()).toEqual([]);
    });

    test('a dismiss during the deferral cancels the escalation timer', () => {
      const { bus, timers, router } = setup({ focus: focusOn(LAPTOP) });
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      bus.emit(
        SERVER_EVENTS.NOTIFICATION_DISMISSED,
        notification({ status: 'dismissed' }),
      );
      expect(timers[0]?.cancelled).toBe(true);
      expect(router.pendingEscalations()).toEqual([]);
    });

    test('a dismiss retracts what was sent', async () => {
      const { bus, retracting } = setup();
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      bus.emit(
        SERVER_EVENTS.NOTIFICATION_DISMISSED,
        notification({ status: 'dismissed' }),
      );
      await flush();
      expect(retracting.retractions.map((r) => r.id)).toEqual(['n-1']);
    });
  });

  describe('updates are idempotent', () => {
    test('an UPDATED with unchanged content never re-sends', () => {
      const { bus, plain } = setup();
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      bus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, notification());
      bus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, notification());
      expect(plain.deliveries).toHaveLength(1);
    });

    test('a dedupe update that changed the content is delivered again', () => {
      const { bus, plain } = setup();
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      bus.emit(
        SERVER_EVENTS.NOTIFICATION_UPDATED,
        notification({ title: 'Migration approved, running' }),
      );
      expect(plain.deliveries.map((d) => d.title)).toEqual([
        'Need approval to run migration',
        'Migration approved, running',
      ]);
    });

    test('an UPDATED for a record this router never routed does not deliver', () => {
      const { bus, plain } = setup();
      bus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, notification());
      expect(plain.deliveries).toHaveLength(0);
    });

    test('legacy records keep their old behaviour: an UPDATED never delivers', () => {
      const { bus, plain } = setup();
      const legacy = notification({ category: 'approval-request' });
      delete legacy.metadata;
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, legacy);
      bus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, { ...legacy, title: 'x' });
      expect(plain.deliveries).toHaveLength(1);
    });
  });

  describe('never throws into the bus', () => {
    test.each<[string, Partial<NotificationDeliveryRouterOptions>]>([
      [
        'a resolver that throws',
        {
          resolver: {
            resolve: () => {
              throw new Error('registry unavailable');
            },
          },
        },
      ],
      [
        'a focus source that throws',
        {
          focus: {
            snapshotForPrincipals: () => {
              throw new Error('presence unavailable');
            },
          },
        },
      ],
      [
        'preferences that throw',
        {
          preferences: {
            current: () => {
              throw new Error('preferences unavailable');
            },
          },
        },
      ],
      [
        'channels whose registrations, deliver (sync and async) and retract throw',
        {
          channels: [
            {
              kind: 'web-push',
              capabilities: {
                retract: false,
                sealed: true,
                wakesClosedApp: true,
              },
              registrations: () => {
                throw new Error('store unreadable');
              },
              deliver: async () => [],
            },
            {
              kind: 'fcm-alert',
              capabilities: {
                retract: true,
                sealed: true,
                wakesClosedApp: true,
              },
              registrations: () => [{ surface: PHONE, ref: 'r' }],
              deliver: () => {
                throw new Error('sync explosion');
              },
              retract: () => {
                throw new Error('sync retract explosion');
              },
            },
            {
              kind: 'apns-alert',
              capabilities: {
                retract: true,
                sealed: true,
                wakesClosedApp: true,
              },
              registrations: () => [{ surface: PHONE, ref: 'r' }],
              deliver: () => Promise.reject(new Error('async explosion')),
              retract: () => Promise.reject(new Error('async retract')),
            },
          ],
        },
      ],
    ])(
      '%s: logged, and the listener stays subscribed',
      async (_label, options) => {
        const { bus, logger } = setup(options);
        expect(() => {
          bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
          bus.emit(
            SERVER_EVENTS.NOTIFICATION_DISMISSED,
            notification({ status: 'dismissed' }),
          );
        }).not.toThrow();
        await flush();
        expect(logger.warn).toHaveBeenCalled();
        expect(bus.subscribed()).toBe(true);
      },
    );

    test('malformed event payloads are ignored', () => {
      const { bus, plain } = setup();
      expect(() => {
        bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, undefined);
        bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {});
        bus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, { id: 7 });
        bus.emit(SERVER_EVENTS.NOTIFICATION_DISMISSED, null);
      }).not.toThrow();
      expect(plain.deliveries).toHaveLength(0);
    });

    test('an escalation whose read-back throws is logged, not thrown', async () => {
      const { bus, timers, logger, plain } = setup({
        focus: focusOn(LAPTOP),
        readNotification: () => Promise.reject(new Error('store locked')),
      });
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
      await fire(timers[0]!);
      expect(plain.deliveries).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        'notification-delivery: escalation failed',
        expect.any(Object),
      );
    });
  });

  test('stop() unsubscribes and cancels armed escalations', () => {
    const { bus, timers, router } = setup({ focus: focusOn(LAPTOP) });
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, notification());
    router.stop();
    expect(timers[0]?.cancelled).toBe(true);
    expect(bus.subscribed()).toBe(false);
  });
});
