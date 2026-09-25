/**
 * #2583 (S1 of #2582): the unified notification envelope rides in
 * `metadata.envelope` so the store document keeps the exact top-level shape
 * the previous build's validator accepts. These tests drive the real store
 * read/write path (JsonFileStore + `validateNotificationDocument`), which this
 * slice does not modify. Only `scheduleEnveloped` writes an envelope; the
 * untrusted `schedule` (REST body, providers) cannot.
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

const {
  NotificationEnvelopeValidationError,
  NotificationReservedFieldError,
  NotificationService,
} = await import('../notification-service.js');
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

  function scheduleAgent(
    title = 'Need input',
    envelope: NotificationEnvelopeV1 = agentEnvelope(),
    extra: { dedupeTag?: string; ttl?: number; category?: string } = {},
  ) {
    return svc.scheduleEnveloped(
      'agent',
      { category: extra.category ?? 'agent-attention', title, ...extra },
      envelope,
    );
  }

  describe('storage compatibility', () => {
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
      for (const n of listed)
        expect(readNotificationEnvelope(n)).toBeUndefined();

      // A read on a legacy record never synthesises an envelope.
      expect(await reader.markRead(LEGACY_STORE[0].id, 'device:a')).toBe(
        'no-envelope',
      );
      expect(readFileSync(storePath, 'utf8')).toBe(bytes);
      await reader.shutdown();
    });

    test('an enveloped record keeps the top-level shape the unchanged store validator accepts', async () => {
      const { notification } = await scheduleAgent('Need approval', undefined, {
        dedupeTag: agentNotificationDedupeTag('session-1', 'migration'),
      });
      await svc.markRead(notification.id, 'device:phone');

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
      await scheduleAgent('FYI');
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
      const { notification } = await scheduleAgent('Tests pass', envelope);
      const stored = readNotificationEnvelope(notification);
      expect(stored).toBeDefined();
      expect(Object.hasOwn(stored!, 'target')).toBe(false);
      expect(await freshReader().list()).toHaveLength(1);
    });
  });

  describe('trusted write path', () => {
    test('the untrusted schedule() refuses a forged envelope and writes nothing', async () => {
      await svc.schedule('test', { category: 'test', title: 'Before' });
      const bytes = readFileSync(storePath, 'utf8');
      // The reviewer's probe: agent provenance, bound assurance, a principal
      // audience and a pre-set read marker, all through a request body.
      const forged = {
        ...agentEnvelope('victim'),
        audience: { kind: 'principal', principalId: 'someone' },
        readAt: '2026-09-24T00:00:00.000Z',
        readBy: 'device:attacker',
      };
      await expect(
        svc.schedule('api', {
          category: 'test',
          title: 'Forged',
          metadata: { envelope: forged },
        }),
      ).rejects.toBeInstanceOf(NotificationReservedFieldError);
      expect(readFileSync(storePath, 'utf8')).toBe(bytes);
    });

    test.each([
      ['an agent: dedupeTag', { dedupeTag: 'agent:victim-root:build' }],
      [
        'an agent: dedupe tag smuggled in metadata',
        { metadata: { dedupeTag: 'agent:victim-root:build' } },
      ],
      ['an agent-* category', { category: 'agent-attention' }],
    ])('the untrusted schedule() refuses %s', async (_label, extra) => {
      await expect(
        svc.schedule('api', { category: 'test', title: 'Squat', ...extra }),
      ).rejects.toBeInstanceOf(NotificationReservedFieldError);
      expect(await svc.list()).toEqual([]);
    });

    test('a squatted-and-dismissed key cannot suppress the real agent: the squat never lands', async () => {
      const tag = agentNotificationDedupeTag('victim-root', 'build');
      await expect(
        svc.schedule('api', {
          category: 'test',
          title: 'Squat',
          dedupeTag: tag,
        }),
      ).rejects.toBeInstanceOf(NotificationReservedFieldError);
      const real = await scheduleAgent(
        'Build failed',
        agentEnvelope('victim-root'),
        { dedupeTag: tag },
      );
      expect(real.outcome).toBe('created');
      expect(real.notification.status).toBe('delivered');
    });

    test('the untrusted schedule() cannot rewrite an enveloped record through a shared tag', async () => {
      const { notification } = await scheduleAgent(
        'System notice',
        {
          v: 1,
          source: { kind: 'system', subsystem: 'scheduler' },
          audience: { kind: 'owner' },
          urgency: 'info',
          interrupt: 'default',
        },
        { dedupeTag: 'scheduler:nightly', category: 'job-failure' },
      );
      await expect(
        svc.schedule('api', {
          category: 'job-failure',
          title: 'Overwrite',
          dedupeTag: 'scheduler:nightly',
        }),
      ).rejects.toBeInstanceOf(NotificationReservedFieldError);
      const [stored] = await svc.list();
      expect(stored.title).toBe('System notice');
      expect(readNotificationEnvelope(stored)?.source).toEqual({
        kind: 'system',
        subsystem: 'scheduler',
      });
      expect(stored.id).toBe(notification.id);
    });

    test.each<[string, Record<string, unknown>]>([
      [
        'a pre-set read marker',
        { readAt: '2026-09-24T00:00:00.000Z', readBy: 'device:a' },
      ],
      [
        'a pre-set dismiss marker',
        { dismissedAt: '2026-09-24T00:00:00.000Z', dismissedBy: 'device:a' },
      ],
      [
        'a principal audience',
        { audience: { kind: 'principal', principalId: 'p' } },
      ],
      ['an unknown urgency', { urgency: 'urgent' }],
      ['an unknown key', { extra: true }],
    ])(
      'scheduleEnveloped refuses %s and writes nothing',
      async (_label, patch) => {
        await expect(
          scheduleAgent('Bad', {
            ...agentEnvelope(),
            ...patch,
          } as unknown as NotificationEnvelopeV1),
        ).rejects.toBeInstanceOf(NotificationEnvelopeValidationError);
        expect(await svc.list()).toEqual([]);
      },
    );

    test('scheduleEnveloped refuses an envelope smuggled in metadata too', async () => {
      await expect(
        svc.scheduleEnveloped(
          'agent',
          { category: 'agent-info', title: 'x', metadata: { envelope: {} } },
          agentEnvelope(),
        ),
      ).rejects.toBeInstanceOf(NotificationReservedFieldError);
    });

    test('metadata.sessionId/conversationId are derived from the envelope, and a conflicting value is refused', async () => {
      const envelope: NotificationEnvelopeV1 = {
        ...agentEnvelope('session-7'),
        source: {
          kind: 'agent',
          sessionId: 'session-7',
          conversationId: 'conv-7',
          assurance: 'bound',
        },
      };
      const { notification } = await scheduleAgent('Derived', envelope);
      expect(notification.metadata).toMatchObject({
        sessionId: 'session-7',
        conversationId: 'conv-7',
      });

      await expect(
        svc.scheduleEnveloped(
          'agent',
          {
            category: 'agent-info',
            title: 'Conflict',
            metadata: { sessionId: 'other-session' },
          },
          envelope,
        ),
      ).rejects.toBeInstanceOf(NotificationEnvelopeValidationError);
    });

    test('agent dedupe: same root updates (and emits NOTIFICATION_UPDATED), another root is separate, dismissal is final', async () => {
      const events = updatedEvents();
      const schedule = (root: string, title: string) =>
        scheduleAgent(title, agentEnvelope(root), {
          category: 'agent-info',
          dedupeTag: agentNotificationDedupeTag(root, 'build'),
        });
      const first = await schedule('root-a', 'Build 1/3');
      const updated = await schedule('root-a', 'Build 2/3');
      const other = await schedule('root-b', 'Other build');

      expect(first.outcome).toBe('created');
      expect(updated).toMatchObject({
        outcome: 'updated',
        notification: { id: first.notification.id, title: 'Build 2/3' },
      });
      expect(other.notification.id).not.toBe(first.notification.id);
      expect(events.map((e) => e.title)).toEqual(['Build 2/3']);

      await svc.dismiss(first.notification.id);
      const afterDismiss = await schedule('root-a', 'Build 3/3');
      expect(afterDismiss.outcome).toBe('unchanged');
      expect(afterDismiss.notification).toMatchObject({
        id: first.notification.id,
        status: 'dismissed',
        title: 'Build 2/3',
      });

      const reloaded = await freshReader().list();
      expect(reloaded.map((n) => n.metadata?.dedupeTag).sort()).toEqual([
        'agent:root-a:build',
        'agent:root-b:build',
      ]);
    });

    test('a legacy dedupe update still emits nothing', async () => {
      const events = updatedEvents();
      await svc.schedule('p', { category: 'c', title: 'A', dedupeTag: 'p:1' });
      await svc.schedule('p', { category: 'c', title: 'B', dedupeTag: 'p:1' });
      expect(events).toHaveLength(0);
    });
  });

  describe('markRead', () => {
    test('records the first reader, emits NOTIFICATION_UPDATED, and a later reader never overwrites it', async () => {
      const events = updatedEvents();
      const { notification } = await scheduleAgent();

      expect(await svc.markRead(notification.id, 'device:phone')).toBe('read');
      expect(events).toHaveLength(1);
      const first = readNotificationEnvelope(events[0]);
      expect(first).toMatchObject({ readBy: 'device:phone' });
      expect(events[0].status).toBe('delivered');

      expect(await svc.markRead(notification.id, 'local:tab-2')).toBe(
        'already-read',
      );
      expect(events).toHaveLength(1);

      const [persisted] = await freshReader().list();
      expect(readNotificationEnvelope(persisted)).toMatchObject({
        readBy: 'device:phone',
        readAt: first?.readAt,
      });
    });

    test('merges into the raw stored envelope, keeping fields a newer build wrote', async () => {
      const { notification } = await scheduleAgent();
      const document = JSON.parse(readFileSync(storePath, 'utf8'));
      document[0].metadata.envelope.futureField = { keep: true };
      document[0].metadata.envelope.source.model = 'opus';
      writeFileSync(storePath, JSON.stringify(document), 'utf8');

      expect(await svc.markRead(notification.id, 'device:a')).toBe('read');
      const [record] = JSON.parse(readFileSync(storePath, 'utf8'));
      expect(record.metadata.envelope).toMatchObject({
        futureField: { keep: true },
        source: { model: 'opus' },
        readBy: 'device:a',
      });
    });

    test('only a delivered record can be read', async () => {
      const { notification } = await scheduleAgent();
      await svc.dismiss(notification.id);
      expect(await svc.markRead(notification.id, 'device:a')).toBe(
        'not-delivered',
      );
    });

    test('unknown id reports not-found and emits nothing; a non-surface id throws', async () => {
      const events = updatedEvents();
      expect(
        await svc.markRead('44444444-4444-4444-8444-444444444444', 'device:a'),
      ).toBe('not-found');
      expect(events).toHaveLength(0);
      await expect(
        svc.markRead('44444444-4444-4444-8444-444444444444', 'phone' as never),
      ).rejects.toThrow(TypeError);
    });

    test('does not cancel the expiry timer of the record it marks', async () => {
      vi.useFakeTimers();
      try {
        const target = new NotificationService(bus, dir, 999_999);
        const { notification } = await target.scheduleEnveloped(
          'agent',
          { category: 'agent-info', title: 'Short-lived', ttl: 1_000 },
          agentEnvelope(),
        );
        expect(await target.markRead(notification.id, 'device:a')).toBe('read');
        await vi.advanceTimersByTimeAsync(1_001);
        await target.drainAsyncDispatch();
        expect((await target.list())[0].status).toBe('expired');
        await target.shutdown();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('dismiss', () => {
    test('records the first dismissing surface for an enveloped record', async () => {
      const { notification } = await scheduleAgent();
      await svc.dismiss(notification.id, undefined, 'local:tab-1');
      await svc.dismiss(notification.id, undefined, 'device:late');
      const [stored] = await freshReader().list();
      expect(stored.status).toBe('dismissed');
      expect(readNotificationEnvelope(stored)).toMatchObject({
        dismissedBy: 'local:tab-1',
        dismissedAt: expect.any(String),
      });
    });

    test('a device caller is its own surface; an operator caller records status only', async () => {
      const a = await scheduleAgent('A', agentEnvelope('s-a'));
      const b = await scheduleAgent('B', agentEnvelope('s-b'));
      const reported = { version: 1, surface: 'web', build: null } as const;
      await svc.dismiss(a.notification.id, {
        version: 1,
        actor: { kind: 'device', deviceId: 'dev-1' },
        reported,
      });
      await svc.dismiss(b.notification.id, {
        version: 1,
        actor: { kind: 'operator' },
        reported,
      });
      const byTitle = Object.fromEntries(
        (await svc.list()).map((n) => [n.title, readNotificationEnvelope(n)]),
      );
      expect(byTitle.A).toMatchObject({ dismissedBy: 'device:dev-1' });
      expect(byTitle.B?.dismissedAt).toBeUndefined();
    });
  });

  describe('provider status sync (#2583 delta review)', () => {
    function syncingProvider(
      id: string,
      updates: Array<{
        dedupeTag: string;
        status: 'actioned' | 'expired' | 'dismissed';
      }>,
    ) {
      return {
        id,
        displayName: id,
        categories: ['test'],
        syncStatus: async () => updates,
      };
    }

    test.each(['dismissed', 'actioned', 'expired'] as const)(
      'a provider syncing an agent tag as %s leaves the agent record untouched',
      async (status) => {
        const tag = agentNotificationDedupeTag('s1', 'k1');
        const { notification } = await scheduleAgent(
          'Agent notice',
          agentEnvelope('s1'),
          { dedupeTag: tag, category: 'agent-info' },
        );
        svc.addProvider(
          syncingProvider('rogue', [{ dedupeTag: tag, status }]) as never,
        );
        await svc.poll();

        const [stored] = await svc.list();
        expect(stored).toMatchObject({
          id: notification.id,
          status: 'delivered',
        });
        const next = await scheduleAgent(
          'Agent notice 2',
          agentEnvelope('s1'),
          {
            dedupeTag: tag,
            category: 'agent-info',
          },
        );
        expect(next.outcome).toBe('updated');
      },
    );

    test('a provider cannot sync another provider-sourced record, and still syncs its own', async () => {
      await svc.schedule('provider-a', {
        category: 'test',
        title: 'A',
        dedupeTag: 'shared:1',
      });
      svc.addProvider(
        syncingProvider('provider-b', [
          { dedupeTag: 'shared:1', status: 'dismissed' },
        ]) as never,
      );
      await svc.poll();
      expect((await svc.list())[0].status).toBe('delivered');

      svc.addProvider(
        syncingProvider('provider-a', [
          { dedupeTag: 'shared:1', status: 'dismissed' },
        ]) as never,
      );
      await svc.poll();
      expect((await svc.list())[0].status).toBe('dismissed');
    });

    test('a provider cannot sync an enveloped record that shares its source and tag', async () => {
      const { notification } = await svc.scheduleEnveloped(
        'provider-a',
        { category: 'job-failure', title: 'Enveloped', dedupeTag: 'shared:2' },
        {
          v: 1,
          source: { kind: 'provider', providerId: 'provider-a' },
          audience: { kind: 'owner' },
          urgency: 'failed',
          interrupt: 'default',
        },
      );
      svc.addProvider(
        syncingProvider('provider-a', [
          { dedupeTag: 'shared:2', status: 'dismissed' },
        ]) as never,
      );
      await svc.poll();
      expect((await svc.list())[0]).toMatchObject({
        id: notification.id,
        status: 'delivered',
      });
    });
  });

  test('schedule() without a category fails the store validation, not a TypeError', async () => {
    await expect(
      svc.schedule('api', { title: 'No category' } as never),
    ).rejects.toThrow(/Notification store is invalid/);
    expect(await svc.list()).toEqual([]);
  });
});
