/**
 * #2583 (S1 of #2582): the unified notification envelope rides in
 * `metadata.envelope` so the store document keeps the exact top-level shape
 * the previous build's validator accepts. These tests drive the real store
 * read/write path (JsonFileStore + `validateNotificationDocument`), which this
 * slice does not modify.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Notification,
  NotificationEnvelopeV1,
} from '@kontourai/station-contracts/notification';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  agentNotificationDedupeTag,
  readNotificationEnvelope,
} from '@kontourai/station-shared/notification-envelope';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  notificationOps: { add: vi.fn() },
}));

const { NotificationEnvelopeValidationError, NotificationService } =
  await import('../notification-service.js');
const { EventBus } = await import('../../orchestration/event-bus.js');

function agentEnvelope(sessionId = 'session-1'): NotificationEnvelopeV1 {
  return {
    v: 1,
    source: { kind: 'agent', sessionId, agent: 'claude', assurance: 'bound' },
    audience: { kind: 'session-readers', sessionId },
    urgency: 'attention',
    target: { kind: 'session', sessionId },
    interrupt: 'default',
  };
}

/**
 * The bytes the current writer produces for a store with no envelopes: a
 * delivered record with a dedupe tag and actions, a pending one, and a
 * dismissed one. Hand-authored so the fixture does not depend on the code
 * under test.
 */
const LEGACY_STORE = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    source: 'approval-inbox',
    category: 'approval-request',
    title: 'Approve tool call',
    body: 'Bash: ls',
    priority: 'high',
    status: 'delivered',
    scheduledAt: null,
    deliveredAt: '2026-09-24T10:00:00.000Z',
    ttl: 86_400_000,
    actions: [{ id: 'approve', label: 'Approve', variant: 'primary' }],
    metadata: { dedupeTag: 'approval:abc', sessionId: 'session-9' },
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    revision: 1,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    source: 'scheduler',
    category: 'job-failure',
    title: 'Nightly failed',
    priority: 'normal',
    status: 'pending',
    scheduledAt: '2099-01-01T00:00:00.000Z',
    deliveredAt: null,
    metadata: {},
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    revision: 3,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    source: 'turn-completion',
    category: 'turn-completed',
    title: 'Your agent finished',
    priority: 'normal',
    status: 'dismissed',
    scheduledAt: null,
    deliveredAt: '2026-09-24T09:00:00.000Z',
    metadata: { dedupeTag: 'turn:t1' },
    createdAt: '2026-09-24T09:00:00.000Z',
    updatedAt: '2026-09-24T09:05:00.000Z',
    revision: 2,
  },
];

describe('NotificationService envelope (#2583)', () => {
  let dir: string;
  let storePath: string;
  let bus: InstanceType<typeof EventBus>;
  let svc: InstanceType<typeof NotificationService>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notif-envelope-test-'));
    storePath = join(dir, 'notifications.json');
    bus = new EventBus();
    svc = new NotificationService(bus, dir, 999_999);
  });

  afterEach(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  function freshReader() {
    return new NotificationService(new EventBus(), dir, 999_999);
  }

  function updatedEvents() {
    const events: Notification[] = [];
    bus.subscribe((message) => {
      if (message.event === SERVER_EVENTS.NOTIFICATION_UPDATED) {
        events.push(message.data as unknown as Notification);
      }
    });
    return events;
  }

  test('an existing envelope-less store loads unchanged and stays byte-identical', async () => {
    const bytes = JSON.stringify(LEGACY_STORE, null, 2);
    writeFileSync(storePath, bytes, 'utf8');
    const reader = freshReader();
    await reader.start();

    const listed = await reader.list();
    expect(listed.map((n) => n.id)).toEqual(LEGACY_STORE.map((n) => n.id));
    expect(listed[0]).toMatchObject({
      title: 'Approve tool call',
      metadata: { dedupeTag: 'approval:abc', sessionId: 'session-9' },
    });
    for (const n of listed) expect(readNotificationEnvelope(n)).toBeUndefined();

    // A read on a legacy record never synthesises an envelope.
    expect(await reader.markRead(LEGACY_STORE[0].id, 'device:a')).toBe(
      'no-envelope',
    );
    expect(readFileSync(storePath, 'utf8')).toBe(bytes);
    await reader.shutdown();
  });

  test('an enveloped record keeps the top-level shape the unchanged store validator accepts', async () => {
    const scheduled = await svc.schedule('agent', {
      category: 'agent-attention',
      title: 'Need approval to run migration',
      priority: 'high',
      metadata: { envelope: agentEnvelope() },
      dedupeTag: agentNotificationDedupeTag('session-1', 'migration'),
    });
    await svc.markRead(scheduled.id, 'device:phone');

    const [record] = JSON.parse(readFileSync(storePath, 'utf8')) as Array<
      Record<string, unknown>
    >;
    // The previous build's validator rejects any unknown top-level key; the
    // envelope adds none.
    expect(Object.keys(record).sort()).toEqual(
      [
        'category',
        'createdAt',
        'deliveredAt',
        'id',
        'metadata',
        'priority',
        'revision',
        'scheduledAt',
        'source',
        'status',
        'title',
        'ttl',
        'updatedAt',
      ].sort(),
    );

    // A fresh service reads the file through `validateNotificationDocument`
    // (unchanged by #2583), so a load here is a load in the previous build.
    const [loaded] = await freshReader().list();
    expect(readNotificationEnvelope(loaded)).toEqual({
      ...agentEnvelope(),
      readAt: expect.any(String),
      readBy: 'device:phone',
    });
  });

  test('the load above is a real validation: an unknown top-level key still fails closed', async () => {
    await svc.schedule('agent', {
      category: 'agent-info',
      title: 'FYI',
      metadata: { envelope: agentEnvelope() },
    });
    const document = JSON.parse(readFileSync(storePath, 'utf8'));
    document[0].envelope = document[0].metadata.envelope;
    writeFileSync(storePath, JSON.stringify(document), 'utf8');
    await expect(freshReader().list()).rejects.toThrow(
      /Notification store is invalid/,
    );
  });

  test('an envelope with nested undefined is stored normalized, and the store reloads', async () => {
    const envelope = {
      ...agentEnvelope(),
      target: undefined,
      source: { ...agentEnvelope().source, projectId: undefined },
    };
    const scheduled = await svc.schedule('agent', {
      category: 'agent-done',
      title: 'Tests pass',
      metadata: { envelope },
    });
    const stored = readNotificationEnvelope(scheduled);
    expect(stored).toBeDefined();
    expect(Object.hasOwn(stored!, 'target')).toBe(false);
    expect(await freshReader().list()).toHaveLength(1);
  });

  test('a malformed envelope is refused and nothing is written', async () => {
    await svc.schedule('test', { category: 'test', title: 'Before' });
    const bytes = readFileSync(storePath, 'utf8');
    await expect(
      svc.schedule('agent', {
        category: 'agent-info',
        title: 'Bad',
        metadata: { envelope: { ...agentEnvelope(), urgency: 'urgent' } },
      }),
    ).rejects.toBeInstanceOf(NotificationEnvelopeValidationError);
    expect(readFileSync(storePath, 'utf8')).toBe(bytes);
  });

  test('agent dedupe tags stay globally unique: same root updates, another root is separate, dismissal is final', async () => {
    const opts = (root: string, title: string) => ({
      category: 'agent-info',
      title,
      metadata: { envelope: agentEnvelope(root) },
      dedupeTag: agentNotificationDedupeTag(root, 'build'),
    });
    const first = await svc.schedule('agent', opts('root-a', 'Build 1/3'));
    const updated = await svc.schedule('agent', opts('root-a', 'Build 2/3'));
    const other = await svc.schedule('agent', opts('root-b', 'Other build'));

    expect(updated.id).toBe(first.id);
    expect(updated.title).toBe('Build 2/3');
    expect(other.id).not.toBe(first.id);

    await svc.dismiss(first.id);
    const afterDismiss = await svc.schedule(
      'agent',
      opts('root-a', 'Build 3/3'),
    );
    expect(afterDismiss).toMatchObject({ id: first.id, status: 'dismissed' });
    expect(afterDismiss.title).toBe('Build 2/3');

    const reloaded = await freshReader().list();
    expect(reloaded.map((n) => n.metadata?.dedupeTag).sort()).toEqual([
      'agent:root-a:build',
      'agent:root-b:build',
    ]);
  });

  test('markRead records the first reader, emits NOTIFICATION_UPDATED, and a later reader never overwrites it', async () => {
    const events = updatedEvents();
    const scheduled = await svc.schedule('agent', {
      category: 'agent-attention',
      title: 'Need input',
      metadata: { envelope: agentEnvelope() },
    });

    expect(await svc.markRead(scheduled.id, 'device:phone')).toBe('read');
    expect(events).toHaveLength(1);
    const first = readNotificationEnvelope(events[0]);
    expect(first).toMatchObject({ readBy: 'device:phone' });
    expect(events[0].status).toBe('delivered');

    expect(await svc.markRead(scheduled.id, 'local:tab-2')).toBe(
      'already-read',
    );
    expect(events).toHaveLength(1);

    const [persisted] = await freshReader().list();
    expect(readNotificationEnvelope(persisted)).toMatchObject({
      readBy: 'device:phone',
      readAt: first?.readAt,
    });
  });

  test('markRead on an unknown id reports not-found and emits nothing', async () => {
    const events = updatedEvents();
    expect(
      await svc.markRead('44444444-4444-4444-8444-444444444444', 'device:a'),
    ).toBe('not-found');
    expect(events).toHaveLength(0);
  });

  test('markRead does not cancel the expiry timer of the record it marks', async () => {
    vi.useFakeTimers();
    try {
      const target = new NotificationService(bus, dir, 999_999);
      const scheduled = await target.schedule('agent', {
        category: 'agent-info',
        title: 'Short-lived',
        ttl: 1_000,
        metadata: { envelope: agentEnvelope() },
      });
      expect(await target.markRead(scheduled.id, 'device:a')).toBe('read');
      await vi.advanceTimersByTimeAsync(1_001);
      await target.drainAsyncDispatch();
      expect((await target.list())[0].status).toBe('expired');
      await target.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
