import type { Notification } from '@kontourai/station-contracts/notification';
import {
  defaultNotificationPreferences,
  desktopHostSurfaceId,
} from '@kontourai/station-contracts/notification-preferences';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { EventBus } from '../../../orchestration/event-bus.js';
import {
  DESKTOP_HOST_LEASE_MS,
  DesktopHostChannel,
  isDesktopHostSurface,
} from '../desktop-host-channel.js';
import { wireNotificationDeliveryRouter } from '../router.js';

const DESKTOP = desktopHostSurfaceId('7c9e6679-7425-40de-944b-e07fc1f90ae7');

function approval(
  overrides: Partial<Notification> = {},
): Record<string, unknown> {
  return {
    id: 'n-1',
    source: 'approval-inbox',
    category: 'approval-request',
    title: 'Approve running the migration',
    body: 'builder wants to run db:migrate',
    priority: 'high',
    status: 'delivered',
    scheduledAt: null,
    deliveredAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    metadata: { link: '/approvals' },
    ...overrides,
  };
}

function wired(hideContent = false) {
  let now = 1_000_000;
  const channel = new DesktopHostChannel({ now: () => now });
  const bus = new EventBus();
  const prefs = defaultNotificationPreferences();
  if (hideContent)
    prefs.perSurface[DESKTOP] = { minUrgency: 'info', hideContent: true };
  wireNotificationDeliveryRouter({
    eventBus: bus,
    channels: [channel],
    resolver: {
      resolve: () => ({
        deviceSurfaces: new Set(),
        includesOperator: true,
        operatorPrincipalId: 'human:local:operator',
        onePerson: true,
      }),
    },
    preferences: { current: () => prefs },
    logger: { warn: vi.fn() },
  });
  return {
    channel,
    bus,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('DesktopHostChannel', () => {
  test('surface ids: only local:desktop-<installation id>', () => {
    expect(isDesktopHostSurface(DESKTOP)).toBe(true);
    expect(isDesktopHostSurface('local:0b1d2c3e-session')).toBe(false);
    expect(isDesktopHostSurface('device:phone')).toBe(false);
    expect(isDesktopHostSurface('local:desktop-x')).toBe(false);
  });

  test('a host that never read its feed is not a delivery target', async () => {
    const { channel, bus } = wired();
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, approval());
    await flush();
    expect(channel.registrations()).toEqual([]);
    // Registering now does not replay what it missed as a target.
    expect(channel.read(DESKTOP, 0).entries).toEqual([]);
  });

  test('a polling host receives the decided alert with its click target', async () => {
    const { channel, bus } = wired();
    const first = channel.read(DESKTOP, 0);
    expect(first).toEqual({
      entries: [],
      cursor: 0,
      leaseMs: DESKTOP_HOST_LEASE_MS,
    });
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, approval());
    await flush();
    const feed = channel.read(DESKTOP, first.cursor);
    expect(feed.entries).toEqual([
      {
        seq: 1,
        kind: 'alert',
        notificationId: 'n-1',
        title: 'Approve running the migration',
        body: 'builder wants to run db:migrate',
        urgency: 'attention',
        link: '/approvals',
        at: expect.any(String),
      },
    ]);
    // The cursor moves past what was read.
    expect(channel.read(DESKTOP, feed.cursor).entries).toEqual([]);
  });

  test('hideContent is applied before the entry is queued: no title, no body', async () => {
    const { channel, bus } = wired(true);
    channel.read(DESKTOP, 0);
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, approval());
    await flush();
    const [entry] = channel.read(DESKTOP, 0).entries;
    expect(entry).toMatchObject({ kind: 'alert', title: 'Station' });
    expect(entry).not.toHaveProperty('body');
    expect(JSON.stringify(entry)).not.toContain('migrat');
  });

  test('a dismiss elsewhere queues a retract for the host', async () => {
    const { channel, bus } = wired();
    channel.read(DESKTOP, 0);
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, approval());
    await flush();
    bus.emit(
      SERVER_EVENTS.NOTIFICATION_DISMISSED,
      approval({ status: 'dismissed' }),
    );
    await flush();
    expect(
      channel.read(DESKTOP, 0).entries.map((e) => [e.kind, e.notificationId]),
    ).toEqual([
      ['alert', 'n-1'],
      ['retract', 'n-1'],
    ]);
  });

  test('the registration lapses when the host stops reading', async () => {
    const { channel, bus, advance } = wired();
    channel.read(DESKTOP, 0);
    advance(DESKTOP_HOST_LEASE_MS + 1);
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, approval());
    await flush();
    expect(channel.read(DESKTOP, 0).entries).toEqual([]);
  });

  test('a feed keeps at most 100 entries', async () => {
    const { channel, bus } = wired();
    channel.read(DESKTOP, 0);
    for (let i = 0; i < 120; i += 1)
      bus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        approval({ id: `n-${i}` }),
      );
    await flush();
    const entries = channel.read(DESKTOP, 0).entries;
    expect(entries).toHaveLength(100);
    expect(entries[0]?.notificationId).toBe('n-20');
  });
});
