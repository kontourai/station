/**
 * #2586: the production composition of notification delivery. Drives the
 * real `wireNotificationDelivery` (the function `configureRuntimeSupportServices`
 * calls) so dropping or miswiring a dependency — the read authority a device
 * resolves to, the store the escalation re-check reads — fails here.
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import type {
  Notification,
  NotificationEnvelopeV1,
} from '@kontourai/station-contracts/notification';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import type { WebPushService } from '../../../services/notifications/web-push-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { pairedDevicePrincipal } from '../../bootstrap/orchestration-request-principal.js';
import { wireNotificationDelivery } from '../notification-delivery-wiring.js';

const device = (overrides: Partial<PairedDevice>): PairedDevice =>
  ({
    name: 'Device',
    scope: 'orchestration:read orchestration:operate',
    kind: 'device',
    createdAt: 1,
    revokedAt: null,
    ...overrides,
  }) as PairedDevice;

const DEVICES = [
  device({ id: 'phone' }),
  device({ id: 'tablet' }),
  // A delegated Station that push-subscribed.
  device({ id: 'delegate', kind: 'delegation' }),
];

const NOW = new Date('2026-09-24T12:00:00Z');

function approval(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n-approval',
    source: 'approval-inbox',
    category: 'approval-request',
    title: 'Approval needed',
    priority: 'high',
    status: 'delivered',
    scheduledAt: null,
    deliveredAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function agentNotice(): Notification {
  const envelope: NotificationEnvelopeV1 = {
    v: 1,
    source: { kind: 'agent', sessionId: 'session-1', assurance: 'bound' },
    audience: { kind: 'session-readers', sessionId: 'session-1' },
    urgency: 'attention',
    interrupt: 'default',
  };
  return approval({
    id: 'n-agent',
    source: 'agent',
    category: 'agent-attention',
    title: 'Need approval to run migration',
    metadata: { envelope },
  });
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delivery-wiring-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

function wire(
  overrides: Partial<Parameters<typeof wireNotificationDelivery>[0]> = {},
) {
  const eventBus = new EventBus();
  const send = vi.fn<WebPushService['send']>().mockResolvedValue('sent');
  const canUserReadSession =
    overrides.canUserReadSession ??
    vi.fn((_sessionId: string, _authority: SessionReadAuthority) => true);
  const listNotifications =
    overrides.listNotifications ??
    vi.fn(async (): Promise<Notification[]> => []);
  const logger_ = { warn: vi.fn() };
  const wiring = wireNotificationDelivery({
    enabled: true,
    homeDir: home,
    eventBus,
    logger: logger_,
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
    ...overrides,
    canUserReadSession,
    listNotifications,
  });
  const pushedTo = () =>
    send.mock.calls.map(([subscription]) =>
      subscription.endpoint.split('/').pop(),
    );
  return {
    eventBus,
    send,
    canUserReadSession,
    listNotifications,
    wiring,
    pushedTo,
    logger_,
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('wireNotificationDelivery (production composition)', () => {
  test("an approval reaches the owner's family devices, never a delegated Station", async () => {
    const { eventBus, pushedTo } = wire();
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, approval() as never);
    await flush();
    expect(pushedTo()).toEqual(['phone', 'tablet']);
  });

  test("an agent notification asks the session read model with each device's own authority", async () => {
    const tablet = DEVICES[1]!;
    const tabletAuthority = sessionReadAuthorityFromRequest(
      pairedDevicePrincipal(tablet).id,
      undefined,
      undefined,
    );
    const { eventBus, pushedTo, canUserReadSession } = wire({
      canUserReadSession: vi.fn(
        (sessionId: string, authority: SessionReadAuthority) =>
          sessionId === 'session-1' &&
          JSON.stringify(authority) === JSON.stringify(tabletAuthority),
      ),
    });
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, agentNotice() as never);
    await flush();
    expect(pushedTo()).toEqual(['tablet']);
    // The operator's own authority is asked too (for its local surfaces).
    const operatorAuthority = sessionReadAuthorityFromRequest(
      LOCAL_OPERATOR_PRINCIPAL_ID,
      undefined,
      undefined,
    );
    expect(
      vi
        .mocked(canUserReadSession)
        .mock.calls.some(
          ([, authority]) =>
            JSON.stringify(authority) === JSON.stringify(operatorAuthority),
        ),
    ).toBe(true);
  });

  test('an escalation re-reads the store: sent if still unread, not if read', async () => {
    vi.useFakeTimers({ now: NOW });
    const focusOnDesk = {
      snapshotForPrincipals: () =>
        new Map([
          [
            'local:desk-tab' as const,
            {
              state: 'focused' as const,
              // A fresh report whenever it is asked for.
              reportedAt: Date.now(),
              principalId: LOCAL_OPERATOR_PRINCIPAL_ID,
            },
          ],
        ]),
    };
    for (const read of [false, true]) {
      const record = approval({
        id: read ? 'n-read' : 'n-unread',
        ...(read ? { status: 'dismissed' as const } : {}),
      });
      const { eventBus, pushedTo, listNotifications } = wire({
        focus: focusOnDesk,
        inAppLiveness: { isLive: () => true },
        listNotifications: vi.fn(async () => [record]),
      });
      eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        approval({ id: record.id }) as never,
      );
      await flush();
      // The person is at their desk: the phone waits.
      expect(pushedTo()).toEqual([]);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(listNotifications).toHaveBeenCalled();
      expect(pushedTo()).toEqual(read ? [] : ['phone', 'tablet']);
    }
  });

  test('disabled (hosted): nothing subscribes and no desktop feed exists', async () => {
    const { eventBus, send, wiring } = wire({ enabled: false });
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, approval() as never);
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(wiring.desktopHostChannel).toBeUndefined();
  });
});
