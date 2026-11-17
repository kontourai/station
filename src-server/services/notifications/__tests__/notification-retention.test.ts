/**
 * #5052: settled records leave `notifications.json` once their settle time is
 * older than the retention window, through the service's own mutation path.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  notificationOps: { add: vi.fn() },
  notificationRetentionPruned: { add: vi.fn() },
  jsonFileStoreWriteBytes: { record: vi.fn() },
}));

const { NotificationService, NotificationDedupeSourceConflictError } =
  await import('../notification-service.js');
const { EventBus } = await import('../../orchestration/event-bus.js');
const {
  jsonFileStoreWriteBytes,
  notificationOps,
  notificationRetentionPruned,
} = await import('../../../telemetry/metrics.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const tempDir = trackTempDirs();

type Status = 'pending' | 'delivered' | 'dismissed' | 'expired' | 'actioned';

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

/** A stored record as the service writes it, settled `ageMs` ago. */
function stored(
  status: Status,
  ageMs: number,
  extra: { dedupeTag?: string; source?: string; title?: string } = {},
): Record<string, unknown> {
  const at = iso(ageMs);
  return {
    id: randomUUID(),
    source: extra.source ?? 'test',
    category: 'test',
    title: extra.title ?? `${status} ${ageMs}`,
    priority: 'normal',
    status,
    scheduledAt: status === 'pending' ? iso(-DAY_MS) : null,
    deliveredAt: status === 'pending' || status === 'dismissed' ? null : at,
    metadata: extra.dedupeTag ? { dedupeTag: extra.dedupeTag } : {},
    createdAt: at,
    updatedAt: at,
    revision: 2,
  };
}

describe('notification retention', () => {
  let dir: string;
  let bus: InstanceType<typeof EventBus>;
  const services: Array<InstanceType<typeof NotificationService>> = [];

  const storePath = () => join(dir, 'notifications.json');
  const tombstonePath = () => join(dir, 'notification-tombstones.json');
  const seed = (records: Array<Record<string, unknown>>) =>
    writeFileSync(storePath(), JSON.stringify(records, null, 2));
  const onDisk = () =>
    JSON.parse(readFileSync(storePath(), 'utf8')) as Array<
      Record<string, unknown>
    >;
  /** Payloads `bus` carries for `event`, as they arrive. */
  const observe = (event: string) => {
    const seen: unknown[] = [];
    bus.subscribe((message) => {
      if (message.event === event) seen.push(message.data);
    });
    return seen;
  };
  const service = (
    options: ConstructorParameters<typeof NotificationService>[3] = {},
  ) => {
    const svc = new NotificationService(bus, dir, 999_999, options);
    services.push(svc);
    return svc;
  };

  beforeEach(() => {
    dir = tempDir('notif-retention-');
    bus = new EventBus();
    vi.mocked(notificationRetentionPruned.add).mockClear();
    vi.mocked(notificationOps.add).mockClear();
    vi.mocked(jsonFileStoreWriteBytes.record).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(services.splice(0).map((svc) => svc.shutdown()));
  });

  test('a write removes settled records just outside the window and keeps those just inside', async () => {
    const inside = [
      stored('expired', 30 * DAY_MS - MINUTE_MS),
      stored('actioned', 30 * DAY_MS - MINUTE_MS),
      stored('dismissed', 30 * DAY_MS - MINUTE_MS),
    ];
    const outside = [
      stored('expired', 30 * DAY_MS + MINUTE_MS),
      stored('actioned', 30 * DAY_MS + MINUTE_MS),
      stored('dismissed', 30 * DAY_MS + MINUTE_MS),
    ];
    seed([...outside, ...inside]);
    const svc = service();

    const fresh = await svc.schedule('test', {
      title: 'new',
      category: 'test',
    });

    expect(onDisk().map((record) => record.id)).toEqual([
      ...inside.map((record) => record.id),
      fresh.id,
    ]);
    expect((await svc.list()).map((record) => record.id)).not.toContain(
      outside[0].id,
    );
  });

  test('delivered, pending and leased records are never removed, however old', async () => {
    const delivered = stored('delivered', 400 * DAY_MS);
    const pending = stored('pending', 400 * DAY_MS);
    const leased: Record<string, unknown> = {
      ...stored('delivered', 400 * DAY_MS),
      actionLease: {
        id: randomUUID(),
        actionId: 'go',
        phase: 'dispatching',
        revision: 2,
        expiresAt: iso(399 * DAY_MS),
      },
    };
    seed([delivered, pending, leased, stored('expired', 400 * DAY_MS)]);
    const svc = service({ retentionDays: 1 });

    await svc.schedule('test', { title: 'new', category: 'test' });

    const ids = onDisk().map((record) => record.id);
    expect(ids).toEqual(
      expect.arrayContaining([delivered.id, pending.id, leased.id]),
    );
    expect(ids).toHaveLength(4);
  });

  test('start prunes a quiet home, and any transition (here a dismiss) prunes too', async () => {
    const old = stored('expired', 31 * DAY_MS);
    seed([old, stored('delivered', 0)]);
    const cleared = observe(SERVER_EVENTS.NOTIFICATION_CLEARED);

    await service().start();
    expect(onDisk().map((record) => record.id)).not.toContain(old.id);
    expect(cleared).toEqual([{ clearedCount: 1, retainedCount: 1 }]);

    const older = stored('actioned', 31 * DAY_MS);
    const live = onDisk()[0];
    seed([older, live]);
    await service().dismiss(live.id as string);
    expect(onDisk().map((record) => record.id)).toEqual([live.id]);
  });

  test('a pruned dismissed tag is not delivered again when its producer schedules it again', async () => {
    const dismissed = stored('dismissed', 31 * DAY_MS, {
      source: 'scheduler',
      dedupeTag: 'scheduler:heartbeat-stale',
    });
    seed([dismissed, stored('delivered', 0)]);
    const svc = service();
    const delivered = observe(SERVER_EVENTS.NOTIFICATION_DELIVERED);

    await svc.start();
    expect(onDisk().map((record) => record.id)).not.toContain(dismissed.id);
    expect(JSON.parse(readFileSync(tombstonePath(), 'utf8'))).toEqual([
      {
        dedupeTag: 'scheduler:heartbeat-stale',
        id: dismissed.id,
        source: 'scheduler',
        status: 'dismissed',
        settledAt: dismissed.updatedAt,
        retainedAt: expect.any(String),
      },
    ]);

    const again = await svc.schedule('scheduler', {
      title: 'Scheduler heartbeat stale',
      category: 'scheduler-unhealthy',
      dedupeTag: 'scheduler:heartbeat-stale',
    });

    expect(again).toMatchObject({ id: dismissed.id, status: 'dismissed' });
    expect(delivered).toEqual([]);
    expect(onDisk()).toHaveLength(1);
    expect(notificationOps.add).toHaveBeenCalledWith(1, {
      op: 'tombstone-hit',
    });
    // The tag still belongs to its source.
    await expect(
      svc.schedule('approval-inbox', {
        title: 'squat',
        category: 'test',
        dedupeTag: 'scheduler:heartbeat-stale',
      }),
    ).rejects.toBeInstanceOf(NotificationDedupeSourceConflictError);
  });

  test('a provider poll of a pruned expired item does not deliver it again', async () => {
    const expired = stored('expired', 31 * DAY_MS, {
      source: 'poller',
      dedupeTag: 'poller:item-1',
    });
    seed([expired]);
    const svc = service();
    svc.addProvider({
      id: 'poller',
      displayName: 'Poller',
      categories: ['test'],
      poll: async () => [
        { title: 'Item 1', category: 'test', dedupeTag: 'poller:item-1' },
      ],
    });
    const delivered = observe(SERVER_EVENTS.NOTIFICATION_DELIVERED);

    await svc.start();
    await svc.poll();

    expect(delivered).toEqual([]);
    expect(onDisk()).toEqual([]);
  });

  test('a hit keeps the tombstone a window from now; an unasked tag is forgotten after one window', async () => {
    const tombstone = (tag: string, retainedAgoMs: number) => ({
      dedupeTag: tag,
      id: randomUUID(),
      source: 'scheduler',
      status: 'dismissed',
      settledAt: iso(70 * DAY_MS),
      retainedAt: iso(retainedAgoMs),
    });
    writeFileSync(
      tombstonePath(),
      JSON.stringify([
        tombstone('scheduler:asked', 2 * DAY_MS),
        tombstone('scheduler:forgotten', 30 * DAY_MS + MINUTE_MS),
      ]),
    );
    const svc = service();
    const delivered = observe(SERVER_EVENTS.NOTIFICATION_DELIVERED);

    await svc.schedule('scheduler', {
      title: 'asked',
      category: 'test',
      dedupeTag: 'scheduler:asked',
    });
    const [refreshed] = JSON.parse(readFileSync(tombstonePath(), 'utf8'));
    expect(refreshed.dedupeTag).toBe('scheduler:asked');
    expect(Date.now() - Date.parse(refreshed.retainedAt)).toBeLessThan(
      MINUTE_MS,
    );
    expect(delivered).toEqual([]);

    const fresh = await svc.schedule('scheduler', {
      title: 'forgotten',
      category: 'test',
      dedupeTag: 'scheduler:forgotten',
    });
    expect(fresh.status).toBe('delivered');
    expect(delivered).toHaveLength(1);
  });

  test('the window defaults to 30 days and STATION_NOTIFICATION_RETENTION_DAYS or the option overrides it', async () => {
    const at = (days: number) => stored('expired', days * DAY_MS + MINUTE_MS);
    const survivors = async (
      options: ConstructorParameters<typeof NotificationService>[3] = {},
    ) => {
      seed([at(29), at(6), at(0)]);
      const records = onDisk();
      await service(options).start();
      return onDisk().map((record) =>
        records.findIndex((seeded) => seeded.id === record.id),
      );
    };

    expect(await survivors()).toEqual([0, 1, 2]);
    vi.stubEnv('STATION_NOTIFICATION_RETENTION_DAYS', 'zero');
    expect(await survivors()).toEqual([0, 1, 2]);
    vi.stubEnv('STATION_NOTIFICATION_RETENTION_DAYS', '7');
    expect(await survivors()).toEqual([1, 2]);
    expect(await survivors({ retentionDays: 1 })).toEqual([2]);
    expect(() => service({ retentionDays: 0 })).toThrow(TypeError);
  });

  test('records pruned counts by status and the smaller write bytes', async () => {
    const body = 'x'.repeat(2_000);
    seed([
      ...[1, 2, 3].map(() => ({
        ...stored('expired', 31 * DAY_MS),
        body,
      })),
      { ...stored('dismissed', 31 * DAY_MS), body },
      stored('delivered', 0),
    ]);
    const before = statSync(storePath()).size;

    await service().start();

    expect(vi.mocked(notificationRetentionPruned.add).mock.calls).toEqual(
      expect.arrayContaining([
        [3, { status: 'expired' }],
        [1, { status: 'dismissed' }],
      ]),
    );
    expect(vi.mocked(notificationRetentionPruned.add)).toHaveBeenCalledTimes(2);
    const primary = vi
      .mocked(jsonFileStoreWriteBytes.record)
      .mock.calls.find(
        ([, attributes]) =>
          attributes?.store === 'notifications' &&
          attributes.artifact === 'primary',
      );
    expect(primary?.[0]).toBe(statSync(storePath()).size);
    expect(primary?.[0]).toBeLessThan(before / 4);
  });
});
