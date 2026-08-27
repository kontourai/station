import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  notificationOps: { add: vi.fn() },
}));

const {
  NotificationDispatchClosedError,
  NotificationService,
  NotificationShutdownTimeoutError,
} = await import('../notification-service.js');
const { EventBus } = await import('../../orchestration/event-bus.js');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('NotificationService', () => {
  let dir: string;
  let bus: InstanceType<typeof EventBus>;
  let svc: InstanceType<typeof NotificationService>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'notif-test-'));
    bus = new EventBus();
    svc = new NotificationService(bus, dir, 999_999);
  });

  afterEach(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('schedule creates an immediately delivered notification', async () => {
    const n = await svc.schedule('test', {
      title: 'Hello',
      body: 'World',
      category: 'test',
    });
    expect(n.status).toBe('delivered');
    expect(n.title).toBe('Hello');
  });

  test('list returns scheduled notifications', async () => {
    await svc.schedule('test', { title: 'A', body: '', category: 'a' });
    await svc.schedule('test', { title: 'B', body: '', category: 'b' });
    expect(await svc.list()).toHaveLength(2);
  });

  test('a validated current snapshot never acquires the migration lock', async () => {
    await svc.schedule('test', { title: 'Current', category: 'test' });
    const acquireMutationLock = vi.fn(async () => {
      throw new Error('current reads must not lock');
    });
    const reader = new NotificationService(bus, dir, 999_999, {
      acquireMutationLock,
    });

    await expect(reader.list()).resolves.toEqual([
      expect.objectContaining({ title: 'Current' }),
    ]);
    expect(acquireMutationLock).not.toHaveBeenCalled();
  });

  test('a contended legacy fallback yields the event loop before migration', async () => {
    await svc.schedule('test', { title: 'Legacy', category: 'test' });
    const storePath = join(dir, 'notifications.json');
    const legacy = JSON.parse(readFileSync(storePath, 'utf8')) as Array<
      Record<string, unknown>
    >;
    delete legacy[0].revision;
    writeFileSync(storePath, JSON.stringify(legacy), 'utf8');
    const entered = deferred();
    const release = deferred();
    const reader = new NotificationService(bus, dir, 999_999, {
      acquireMutationLock: async () => {
        entered.resolve();
        await release.promise;
        return () => {};
      },
    });

    const read = reader.list();
    await entered.promise;
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    await nextEventLoopTurn();
    expect(ticked).toBe(true);
    release.resolve();
    await expect(read).resolves.toEqual([
      expect.objectContaining({ title: 'Legacy' }),
    ]);
  });

  test.each([
    [
      'schedule',
      async (target: typeof svc) =>
        target.schedule('test', { title: 'New', category: 'test' }),
    ],
    ['dismiss', async (target: typeof svc, id: string) => target.dismiss(id)],
    [
      'markStatus',
      async (target: typeof svc, id: string) =>
        target.markStatus(id, 'expired'),
    ],
    [
      'action',
      async (target: typeof svc, id: string) => target.action(id, 'default'),
    ],
    [
      'snooze',
      async (target: typeof svc, id: string) =>
        target.snooze(id, new Date(Date.now() + 60_000).toISOString()),
    ],
    ['clearAll', async (target: typeof svc) => target.clearAll()],
    ['clearActivity', async (target: typeof svc) => target.clearActivity()],
  ] as const)(
    'public mutation %s yields the event loop while its lock is contended',
    async (_name, mutate) => {
      const notification = await svc.schedule('test', {
        title: 'Existing',
        category: 'test',
      });
      const entered = deferred();
      const release = deferred();
      const target = new NotificationService(bus, dir, 999_999, {
        acquireMutationLock: async () => {
          entered.resolve();
          await release.promise;
          return () => {};
        },
      });

      const mutation = mutate(target, notification.id);
      await entered.promise;
      let ticked = false;
      setTimeout(() => {
        ticked = true;
      }, 0);
      await nextEventLoopTurn();
      expect(ticked).toBe(true);
      release.resolve();
      await mutation;
    },
  );

  test('the synchronous adapter observes rejection and never emits an unhandled rejection', async () => {
    const failures: Array<{ operation: string; error: unknown }> = [];
    const target = new NotificationService(bus, dir, 999_999, {
      onAsyncDispatchError: (operation, error) =>
        failures.push({ operation, error }),
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      target.dispatch('synthetic-adapter', async () => {
        throw new Error('synthetic adapter failure');
      });
      await target.drainAsyncDispatch();
      await nextEventLoopTurn();
      expect(failures).toEqual([
        {
          operation: 'synthetic-adapter',
          error: expect.objectContaining({
            message: 'synthetic adapter failure',
          }),
        },
      ]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test.each(['event-bus', 'timer', 'scheduler'] as const)(
    'the shared %s adapter seam preserves queued ordering',
    async (adapter) => {
      const target = new NotificationService(bus, dir, 999_999);
      const order: string[] = [];
      const first = deferred();
      target.dispatch(`${adapter}:first`, async () => {
        await first.promise;
        order.push('first');
      });
      target.dispatch(`${adapter}:second`, async () => {
        order.push('second');
      });

      await nextEventLoopTurn();
      expect(order).toEqual([]);
      first.resolve();
      await target.drainAsyncDispatch();
      expect(order).toEqual(['first', 'second']);
    },
  );

  test('shutdown awaits an admitted durable event before it resolves', async () => {
    const release = deferred();
    const target = new NotificationService(bus, dir, 999_999);
    target.dispatch('event-bus:schedule', async () => {
      await release.promise;
      await target.schedule('event', { title: 'Durable', category: 'test' });
    });

    let stopped = false;
    const shutdown = target.shutdown().then(() => {
      stopped = true;
    });
    await nextEventLoopTurn();
    expect(stopped).toBe(false);

    release.resolve();
    await shutdown;
    expect(await target.list()).toEqual([
      expect.objectContaining({ title: 'Durable' }),
    ]);
  });

  test('shutdown rejects late dispatch admission through the shared observer', async () => {
    const failures: Array<{ operation: string; error: unknown }> = [];
    const target = new NotificationService(bus, dir, 999_999, {
      onAsyncDispatchError: (operation, error) =>
        failures.push({ operation, error }),
    });
    await target.shutdown();
    const task = vi.fn(async () => {});

    expect(target.dispatch('late-event', task)).toBe(false);
    expect(task).not.toHaveBeenCalled();
    expect(failures).toEqual([
      {
        operation: 'late-event',
        error: expect.any(NotificationDispatchClosedError),
      },
    ]);
  });

  test('queued provider start cannot poll or rearm after shutdown closes admissions', async () => {
    const blocker = deferred();
    const provider = {
      id: 'queued-provider',
      displayName: 'Queued provider',
      categories: ['test'],
      poll: vi.fn(async () => []),
    };
    const target = new NotificationService(bus, dir, 5);
    target.addProvider(provider);
    target.dispatch('blocker', () => blocker.promise);
    target.dispatch('service-start', () => target.start());

    const shutdown = target.shutdown();
    blocker.resolve();
    await shutdown;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));

    expect(provider.poll).not.toHaveBeenCalled();
  });

  test('observer failure cannot reject shutdown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = new NotificationService(bus, dir, 999_999, {
      onAsyncDispatchError: () => {
        throw new Error('observer failed');
      },
    });
    target.dispatch('failed-event', async () => {
      throw new Error('event failed');
    });

    await expect(target.shutdown()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Notification async adapter error observer failed',
      'failed-event',
      expect.objectContaining({ message: 'observer failed' }),
    );
    warn.mockRestore();
  });

  test('shutdown bounds a hung admitted task without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const target = new NotificationService(bus, dir, 999_999, {
        shutdownTimeoutMs: 25,
      });
      target.dispatch('hung-event', () => new Promise(() => {}));
      const shutdown = target.shutdown();
      const caught = shutdown.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);

      await expect(caught).resolves.toBeInstanceOf(
        NotificationShutdownTimeoutError,
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
    }
  });

  test('list filters by status', async () => {
    await svc.schedule('test', { title: 'A', body: '', category: 'a' });
    const n = await svc.schedule('test', {
      title: 'B',
      body: '',
      category: 'b',
    });
    await svc.dismiss(n.id);
    expect(await svc.list({ status: ['delivered'] })).toHaveLength(1);
    expect(await svc.list({ status: ['dismissed'] })).toHaveLength(1);
  });

  test('list filters by category', async () => {
    await svc.schedule('test', { title: 'A', body: '', category: 'alert' });
    await svc.schedule('test', { title: 'B', body: '', category: 'info' });
    expect(await svc.list({ category: ['alert'] })).toHaveLength(1);
  });

  test('dismiss changes status', async () => {
    const n = await svc.schedule('test', {
      title: 'X',
      body: '',
      category: 'c',
    });
    await svc.dismiss(n.id);
    const found = await svc.list({ status: ['dismissed'] });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(n.id);
  });

  test('snooze sets pending status and new scheduledAt', async () => {
    const n = await svc.schedule('test', {
      title: 'X',
      body: '',
      category: 'c',
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    await svc.snooze(n.id, future);
    const found = await svc.list({ status: ['pending'] });
    expect(found).toHaveLength(1);
    expect(found[0].scheduledAt).toBe(future);
  });

  test('clearAll removes everything', async () => {
    await svc.schedule('test', { title: 'A', body: '', category: 'a' });
    await svc.schedule('test', { title: 'B', body: '', category: 'b' });
    await svc.clearAll();
    expect(await svc.list()).toHaveLength(0);
  });

  test('clearAll notifies providers before removing notifications', async () => {
    const handleDismiss = vi.fn();
    svc.addProvider({
      id: 'mock',
      displayName: 'Mock',
      categories: ['test'],
      handleDismiss,
    } as any);

    await svc.schedule('mock', { title: 'A', body: '', category: 'a' });
    await svc.schedule('mock', { title: 'B', body: '', category: 'b' });
    await svc.clearAll();
    await svc.drainAsyncDispatch();

    expect(handleDismiss).toHaveBeenCalledTimes(2);
  });

  test('predicate clearAll retains unreadable rows without dismissing their provider item', async () => {
    const handleDismiss = vi.fn();
    svc.addProvider({
      id: 'mock',
      displayName: 'Mock',
      categories: ['test'],
      handleDismiss,
    } as any);
    const alpha = await svc.schedule('mock', {
      title: 'Alpha',
      body: '',
      category: 'a',
    });
    const bravo = await svc.schedule('mock', {
      title: 'Bravo',
      body: '',
      category: 'b',
    });

    await svc.clearAll((notification) => notification.id === alpha.id);
    await svc.drainAsyncDispatch();

    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: bravo.id }),
    ]);
    expect(handleDismiss).toHaveBeenCalledTimes(1);
    expect(handleDismiss).toHaveBeenCalledWith(alpha.id);
  });

  test('clearActivity atomically preserves active approvals and removes other activity', async () => {
    const activeApproval = await svc.schedule('approval-inbox', {
      title: 'Approval needed',
      body: '',
      category: 'approval-request',
    });
    const resolvedApproval = await svc.schedule('approval-inbox', {
      title: 'Resolved approval',
      body: '',
      category: 'approval-request',
    });
    await svc.markStatus(resolvedApproval.id, 'actioned');
    await svc.schedule('scheduler', {
      title: 'Job failed',
      body: '',
      category: 'job',
    });

    expect(await svc.clearActivity()).toBe(2);
    expect(await svc.list()).toEqual([
      expect.objectContaining({
        id: activeApproval.id,
        status: 'delivered',
      }),
    ]);
  });

  test('predicate clearActivity removes only authorized activity atomically', async () => {
    const alpha = await svc.schedule('orchestration', {
      title: 'Alpha',
      body: '',
      category: 'job',
      metadata: { sessionId: 'alpha-session' },
    });
    const bravo = await svc.schedule('orchestration', {
      title: 'Bravo',
      body: '',
      category: 'job',
      metadata: { sessionId: 'bravo-session' },
    });
    const generic = await svc.schedule('scheduler', {
      title: 'Generic',
      body: '',
      category: 'job',
    });

    expect(
      await svc.clearActivity(
        (notification) => notification.metadata?.sessionId !== 'bravo-session',
      ),
    ).toBe(2);
    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: bravo.id }),
    ]);
    expect(
      (await svc.list()).map((notification) => notification.id),
    ).not.toContain(alpha.id);
    expect(
      (await svc.list()).map((notification) => notification.id),
    ).not.toContain(generic.id);
  });

  test('dedupeTag updates existing instead of creating new', async () => {
    await svc.schedule('test', {
      title: 'V1',
      body: '',
      category: 'c',
      dedupeTag: 'dup',
    });
    await svc.schedule('test', {
      title: 'V2',
      body: '',
      category: 'c',
      dedupeTag: 'dup',
    });
    const all = await svc.list();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('V2');
  });

  test('re-reads under the mutation lock so a stale schedule cannot restore a dismissed dedupe record', async () => {
    const first = await svc.schedule('test', {
      title: 'Pairing request',
      body: '',
      category: 'pairing-request',
      dedupeTag: 'pairing:req-stale-dismiss',
    });
    let lockCalls = 0;
    const stale = new NotificationService(bus, dir, 999_999, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        if (lockCalls === 1) await svc.dismiss(first.id);
        return async () => {};
      },
    });

    const result = await stale.schedule('test', {
      title: 'Stale provider poll',
      body: '',
      category: 'pairing-request',
      dedupeTag: 'pairing:req-stale-dismiss',
    });

    expect(lockCalls).toBe(1);
    expect(result).toMatchObject({ id: first.id, status: 'dismissed' });
    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: first.id, status: 'dismissed' }),
    ]);
  });

  test('preserves concurrent distinct schedules and reopens them durably', async () => {
    let lockCalls = 0;
    const stale = new NotificationService(bus, dir, 999_999, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        if (lockCalls === 1) {
          await svc.schedule('test', {
            title: 'First',
            body: '',
            category: 'test',
          });
        }
        return async () => {};
      },
    });

    await stale.schedule('test', {
      title: 'Second',
      body: '',
      category: 'test',
    });

    expect(lockCalls).toBe(1);
    expect(
      (await new NotificationService(new EventBus(), dir, 999_999).list()).map(
        (notification) => notification.title,
      ),
    ).toEqual(['First', 'Second']);
  });

  test('re-reads under the mutation lock so a stale clear retains a concurrent notification', async () => {
    const old = await svc.schedule('test', {
      title: 'Old activity',
      body: '',
      category: 'job',
    });
    let lockCalls = 0;
    const stale = new NotificationService(bus, dir, 999_999, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        if (lockCalls === 1) {
          await svc.schedule('test', {
            title: 'Concurrent activity',
            body: '',
            category: 'job',
          });
        }
        return async () => {};
      },
    });

    expect(
      await stale.clearActivity((notification) => notification.id === old.id),
    ).toBe(1);

    expect(lockCalls).toBe(1);
    expect(await svc.list()).toEqual([
      expect.objectContaining({ title: 'Concurrent activity' }),
    ]);
  });

  test('refuses a mutation lock without changing the durable notification document', async () => {
    const notification = await svc.schedule('test', {
      title: 'Locked',
      body: '',
      category: 'test',
    });
    const storePath = join(dir, 'notifications.json');
    const before = readFileSync(storePath, 'utf8');
    const locked = new NotificationService(bus, dir, 999_999, {
      acquireMutationLock: async () => {
        throw new Error('notification mutation lock unavailable');
      },
    });

    await expect(locked.dismiss(notification.id)).rejects.toThrow(
      'notification mutation lock unavailable',
    );
    expect(readFileSync(storePath, 'utf8')).toBe(before);
    expect(existsSync(`${storePath}.mutation`)).toBe(false);
  });

  test('does not publish a notification when its durable write fails', async () => {
    const storePath = join(dir, 'notifications.json');
    await svc.schedule('test', {
      title: 'Already durable',
      body: '',
      category: 'test',
    });
    const before = readFileSync(storePath, 'utf8');
    const failing = new NotificationService(bus, dir, 999_999, {
      storeFactory: (path) => ({
        read: () => JSON.parse(readFileSync(path, 'utf8')),
        write: () => {
          throw new Error('notification durable write failed');
        },
      }),
    });

    await expect(
      failing.schedule('test', {
        title: 'Must not persist',
        body: '',
        category: 'test',
      }),
    ).rejects.toThrow('notification durable write failed');
    expect(readFileSync(storePath, 'utf8')).toBe(before);
  });

  test('fails loudly on a corrupt primary without replacing its exact bytes', async () => {
    const storePath = join(dir, 'notifications.json');
    const bytes = '{ unreadable notification state';
    writeFileSync(storePath, bytes, 'utf8');

    await expect(svc.list()).rejects.toThrow(/JSON store is corrupt/);
    await expect(
      svc.schedule('test', {
        title: 'Must not overwrite corruption',
        body: '',
        category: 'test',
      }),
    ).rejects.toThrow(/JSON store is corrupt/);
    expect(readFileSync(storePath, 'utf8')).toBe(bytes);
    expect(existsSync(`${storePath}.mutation`)).toBe(false);
  });

  test.each(['{}', '[false]'])(
    'fails loudly on a readable but invalid notification document without replacing %s',
    async (bytes) => {
      const storePath = join(dir, 'notifications.json');
      writeFileSync(storePath, bytes, 'utf8');

      await expect(svc.list()).rejects.toThrow('Notification store is invalid');
      await expect(
        svc.schedule('test', {
          title: 'Must not overwrite invalid state',
          body: '',
          category: 'test',
        }),
      ).rejects.toThrow('Notification store is invalid');
      expect(readFileSync(storePath, 'utf8')).toBe(bytes);
      expect(existsSync(`${storePath}.mutation`)).toBe(false);
    },
  );

  test('treats ENOENT as an empty notification document and persists its first schedule', async () => {
    const storePath = join(dir, 'notifications.json');
    expect(await svc.list()).toEqual([]);

    await svc.schedule('test', { title: 'First', body: '', category: 'test' });

    expect(existsSync(storePath)).toBe(true);
    expect(
      await new NotificationService(new EventBus(), dir, 999_999).list(),
    ).toEqual([expect.objectContaining({ title: 'First' })]);
  });

  test('starts from a real all-legacy persisted document and migrates each record once', async () => {
    const delivered = await svc.schedule('test', {
      title: 'Already delivered',
      body: 'Preserve this',
      category: 'test',
      dedupeTag: 'legacy-delivered',
    });
    const pending = await svc.schedule('test', {
      title: 'Still pending',
      body: 'Preserve this too',
      category: 'test',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      dedupeTag: 'legacy-pending',
    });
    const storePath = join(dir, 'notifications.json');
    const legacy = JSON.parse(readFileSync(storePath, 'utf8')) as Array<
      Record<string, unknown>
    >;
    for (const notification of legacy) delete notification.revision;
    writeFileSync(storePath, JSON.stringify(legacy), 'utf8');

    const migrated = new NotificationService(new EventBus(), dir, 999_999);
    await migrated.start();

    expect(await migrated.list()).toEqual([
      expect.objectContaining({
        id: delivered.id,
        title: 'Already delivered',
        status: 'delivered',
      }),
      expect.objectContaining({
        id: pending.id,
        title: 'Still pending',
        status: 'pending',
      }),
    ]);
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toEqual(
      legacy.map((notification) => ({ ...notification, revision: 1 })),
    );
    const migratedBytes = readFileSync(storePath, 'utf8');
    await migrated.start();
    expect(readFileSync(storePath, 'utf8')).toBe(migratedBytes);
    await migrated.shutdown();
  });

  test('re-reads under the migration lock and never downgrades a current document', async () => {
    const notification = await svc.schedule('test', {
      title: 'Current revision wins',
      body: '',
      category: 'test',
    });
    const storePath = join(dir, 'notifications.json');
    const current = JSON.parse(readFileSync(storePath, 'utf8')) as Array<
      Record<string, unknown>
    >;
    current[0].revision = 7;
    const currentBytes = JSON.stringify(current);
    const legacy = current.map((entry) => {
      const { revision: _revision, ...withoutRevision } = entry;
      return withoutRevision;
    });
    writeFileSync(storePath, JSON.stringify(legacy), 'utf8');
    let lockCalls = 0;
    const candidate = new NotificationService(new EventBus(), dir, 999_999, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        // Model a concurrent current-version writer which completes before
        // this holder reads. A pre-lock read would incorrectly migrate the
        // older legacy bytes over this revision-7 record.
        writeFileSync(storePath, currentBytes, 'utf8');
        return async () => {};
      },
    });

    await candidate.start();

    expect(lockCalls).toBe(1);
    expect(readFileSync(storePath, 'utf8')).toBe(currentBytes);
    expect(JSON.parse(readFileSync(storePath, 'utf8'))[0]).toMatchObject({
      id: notification.id,
      revision: 7,
    });
    await candidate.shutdown();
  });

  test('fails closed on a corrupt startup document without changing its bytes', async () => {
    const storePath = join(dir, 'notifications.json');
    const bytes = '{ damaged startup document';
    writeFileSync(storePath, bytes, 'utf8');
    const candidate = new NotificationService(new EventBus(), dir, 999_999);

    await expect(candidate.start()).rejects.toThrow(/JSON store is corrupt/);
    expect(readFileSync(storePath, 'utf8')).toBe(bytes);
    expect(existsSync(`${storePath}.mutation`)).toBe(false);
  });

  test.each([
    [
      'a non-positive current revision',
      (document: Array<Record<string, unknown>>) => {
        document[0].revision = 0;
      },
    ],
    [
      'mixed legacy and current revisions',
      (document: Array<Record<string, unknown>>) => {
        delete document[0].revision;
      },
    ],
    [
      'a legacy record with a lease',
      (document: Array<Record<string, unknown>>) => {
        delete document[0].revision;
        document[0].actionLease = {
          id: crypto.randomUUID(),
          actionId: 'allow',
          phase: 'reserved',
          revision: 1,
          expiresAt: document[0].updatedAt,
        };
      },
    ],
  ])(
    'fails closed without rewriting %s during startup migration',
    async (_label, edit) => {
      await svc.schedule('test', {
        title: 'Strict startup state',
        body: '',
        category: 'test',
      });
      const second = await svc.schedule('test', {
        title: 'Second strict state',
        body: '',
        category: 'test',
      });
      const storePath = join(dir, 'notifications.json');
      const document = JSON.parse(readFileSync(storePath, 'utf8')) as Array<
        Record<string, unknown>
      >;
      if (_label === 'mixed legacy and current revisions') {
        expect(document[1].id).toBe(second.id);
      }
      edit(document);
      const bytes = JSON.stringify(document);
      writeFileSync(storePath, bytes, 'utf8');
      const candidate = new NotificationService(new EventBus(), dir, 999_999);

      await expect(candidate.start()).rejects.toThrow(
        'Notification store is invalid',
      );
      expect(readFileSync(storePath, 'utf8')).toBe(bytes);
      expect(existsSync(`${storePath}.mutation`)).toBe(false);
    },
  );

  test.each([
    [
      'unknown notification field',
      (document: Array<Record<string, unknown>>) => {
        document[0].unexpected = true;
      },
    ],
    [
      'nonpositive persisted revision',
      (document: Array<Record<string, unknown>>) => {
        document[0].revision = 0;
      },
    ],
    [
      'noncanonical createdAt',
      (document: Array<Record<string, unknown>>) => {
        document[0].createdAt = '2026-01-01';
      },
    ],
    [
      'invalid status/timestamp state',
      (document: Array<Record<string, unknown>>) => {
        document[0].status = 'pending';
      },
    ],
    [
      'duplicate dedupe tag',
      (document: Array<Record<string, unknown>>) => {
        document.push({ ...document[0], id: crypto.randomUUID() });
      },
    ],
    [
      'noncanonical action shape',
      (document: Array<Record<string, unknown>>) => {
        document[0].actions = [{ id: 'allow', label: 'Allow', extra: true }];
      },
    ],
    [
      'action lease on a terminal notification',
      (document: Array<Record<string, unknown>>) => {
        document[0].status = 'dismissed';
        document[0].actionLease = {
          id: crypto.randomUUID(),
          actionId: 'allow',
          phase: 'reserved',
          revision: document[0].revision,
          expiresAt: document[0].updatedAt,
        };
      },
    ],
  ])(
    'rejects %s without rewriting persisted notification bytes',
    async (_label, edit) => {
      const notification = await svc.schedule('test', {
        title: 'Strict state',
        body: '',
        category: 'test',
        dedupeTag: 'strict-state',
      });
      const storePath = join(dir, 'notifications.json');
      const document = JSON.parse(readFileSync(storePath, 'utf8')) as Array<
        Record<string, unknown>
      >;
      expect(document[0].id).toBe(notification.id);
      edit(document);
      const bytes = JSON.stringify(document);
      writeFileSync(storePath, bytes, 'utf8');

      await expect(svc.list()).rejects.toThrow('Notification store is invalid');
      await expect(svc.dismiss(notification.id)).rejects.toThrow(
        'Notification store is invalid',
      );
      expect(readFileSync(storePath, 'utf8')).toBe(bytes);
      expect(existsSync(`${storePath}.mutation`)).toBe(false);
    },
  );

  test('a dismiss that wins before action dispatch prevents the provider operation', async () => {
    const enteredDispatch = deferred();
    const releaseDispatch = deferred();
    const handleAction = vi.fn();
    const actor = new NotificationService(bus, dir, 999_999, {
      beforeActionDispatch: async () => {
        enteredDispatch.resolve();
        await releaseDispatch.promise;
      },
    });
    actor.addProvider({
      id: 'provider',
      displayName: 'Provider',
      categories: ['test'],
      handleAction,
    } as any);
    const notification = await svc.schedule('provider', {
      title: 'Act or dismiss',
      body: '',
      category: 'test',
    });

    const action = actor.action(notification.id, 'allow');
    await enteredDispatch.promise;

    expect(
      await new NotificationService(bus, dir, 999_999).dismiss(notification.id),
    ).toBe('dismissed');
    releaseDispatch.resolve();
    await action;

    expect(handleAction).not.toHaveBeenCalled();
    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: notification.id, status: 'dismissed' }),
    ]);
  });

  test('a dismissal cannot claim success after provider dispatch has begun', async () => {
    const enteredProvider = deferred();
    const releaseProvider = deferred();
    const actor = new NotificationService(bus, dir, 999_999);
    actor.addProvider({
      id: 'provider',
      displayName: 'Provider',
      categories: ['test'],
      handleAction: async () => {
        enteredProvider.resolve();
        await releaseProvider.promise;
      },
    } as any);
    const notification = await svc.schedule('provider', {
      title: 'Dispatch wins',
      body: '',
      category: 'test',
    });

    const action = actor.action(notification.id, 'allow');
    await enteredProvider.promise;

    expect(
      await new NotificationService(bus, dir, 999_999).dismiss(notification.id),
    ).toBe('action-dispatching');
    await expect(actor.action(notification.id, 'allow-again')).resolves.toBe(
      'action-dispatching',
    );
    releaseProvider.resolve();
    await action;

    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: notification.id, status: 'actioned' }),
    ]);
  });

  test('dispatching action makes clearAll and clearActivity atomic conflicts without partial provider dismissal', async () => {
    const enteredProvider = deferred();
    const releaseProvider = deferred();
    const handleDismiss = vi.fn();
    const actor = new NotificationService(bus, dir, 999_999);
    actor.addProvider({
      id: 'provider',
      displayName: 'Provider',
      categories: ['test'],
      handleAction: async () => {
        enteredProvider.resolve();
        await releaseProvider.promise;
      },
    } as any);
    const clearing = new NotificationService(bus, dir, 999_999);
    clearing.addProvider({
      id: 'provider',
      displayName: 'Provider',
      categories: ['test'],
      handleDismiss,
    } as any);
    const actionNotification = await svc.schedule('provider', {
      title: 'Action in flight',
      body: '',
      category: 'test',
    });
    const ordinaryNotification = await svc.schedule('provider', {
      title: 'Ordinary activity',
      body: '',
      category: 'test',
    });

    const action = actor.action(actionNotification.id, 'allow');
    await enteredProvider.promise;

    expect(await clearing.clearActivityWithOutcome()).toEqual({
      outcome: 'action-dispatching',
      dispatchingCount: 1,
    });
    expect(await clearing.clearAll()).toEqual({
      outcome: 'action-dispatching',
      dispatchingCount: 1,
    });
    expect(handleDismiss).not.toHaveBeenCalled();
    expect(
      (await new NotificationService(new EventBus(), dir, 999_999).list()).map(
        (notification) => notification.id,
      ),
    ).toEqual([actionNotification.id, ordinaryNotification.id]);

    releaseProvider.resolve();
    await action;
  });

  // station#1912: the latent hazard the issue named but did not reproduce —
  // `poll()` calling `schedule()` for the SAME still-open provider item (same
  // dedupeTag) used to resurrect it after a dismissal.
  test('a dismissed dedupeTag is not resurrected by a later schedule() call with the same tag', async () => {
    const first = await svc.schedule('test', {
      title: 'Pairing request',
      body: '',
      category: 'pairing-request',
      dedupeTag: 'pairing:req-1',
    });
    await svc.dismiss(first.id);
    expect(await svc.list({ status: ['dismissed'] })).toHaveLength(1);

    // The same provider item, same dedupeTag, offered again — exactly what
    // `poll()` does on its next cycle for an item still returned by the
    // provider.
    const resurrected = await svc.schedule('test', {
      title: 'Pairing request',
      body: '',
      category: 'pairing-request',
      dedupeTag: 'pairing:req-1',
    });

    expect(resurrected.id).toBe(first.id);
    expect(resurrected.status).toBe('dismissed');
    expect(await svc.list()).toHaveLength(1);
    expect(await svc.list({ status: ['delivered'] })).toHaveLength(0);
  });

  // Same hazard, exercised through the REAL poll() path (station#1912 AC:
  // "a regression test that a dismissed provider-contributed notification is
  // not re-added by the next poll()") rather than a direct schedule() call.
  test('poll() does not re-add a dismissed provider notification on its next cycle', async () => {
    const provider = {
      id: 'device-pairing',
      displayName: 'Device pairing',
      categories: ['pairing-request'],
      poll: async () => [
        {
          title: 'Pairing request from a phone',
          body: '',
          category: 'pairing-request',
          dedupeTag: 'device-pairing:req-1',
        },
      ],
    };
    svc.addProvider(provider as any);

    await svc.poll(); // schedule
    const delivered = await svc.list({ status: ['delivered'] });
    expect(delivered).toHaveLength(1);
    await svc.dismiss(delivered[0].id);

    // The provider still returns the SAME pending request on the next poll
    // cycle (it has not expired or been resolved yet) — this is the actual
    // shape station#1912 named: an already-dismissed notification whose
    // underlying request is still live at the provider.
    await svc.poll();

    expect(await svc.list()).toHaveLength(1);
    expect(await svc.list({ status: ['dismissed'] })).toHaveLength(1);
    expect(await svc.list({ status: ['delivered'] })).toHaveLength(0);
  });

  test('schedule emits notification:delivered event', async () => {
    const fn = vi.fn();
    bus.subscribe(fn);
    await svc.schedule('test', { title: 'E', body: '', category: 'c' });
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notification:delivered' }),
    );
  });

  test('dismiss emits notification:dismissed event', async () => {
    const n = await svc.schedule('test', {
      title: 'E',
      body: '',
      category: 'c',
    });
    const fn = vi.fn();
    bus.subscribe(fn);
    await svc.dismiss(n.id);
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notification:dismissed' }),
    );
  });

  test('listProviders returns empty when none registered', async () => {
    expect(svc.listProviders()).toEqual([]);
  });

  test('addProvider and listProviders', async () => {
    svc.addProvider({
      id: 'mock',
      displayName: 'Mock',
      categories: new Set(['test']),
      poll: async () => [],
    } as any);
    const providers = svc.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('mock');
  });
});

describe('NotificationService per-state TTL defaulting (station#1100 AC2)', () => {
  let dir: string;
  let bus: InstanceType<typeof EventBus>;
  let svc: InstanceType<typeof NotificationService>;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'notif-ttl-test-'));
    bus = new EventBus();
    svc = new NotificationService(bus, dir, 999_999);
  });

  afterEach(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  test('an approval-request notification defaults to the 24h waiting TTL when the caller sets none', async () => {
    const n = await svc.schedule('test', {
      title: 'Approval needed',
      category: 'approval-request',
    });
    expect(n.ttl).toBe(24 * 60 * 60 * 1000);
  });

  test('a job-missed notification defaults to the 24h TTL (station#872)', async () => {
    const n = await svc.schedule('test', {
      title: 'Job missed',
      category: 'job-missed',
    });
    expect(n.ttl).toBe(24 * 60 * 60 * 1000);
  });

  test('a scheduler-unhealthy notification defaults to the 24h TTL (station#872)', async () => {
    const n = await svc.schedule('test', {
      title: 'Scheduler unhealthy',
      category: 'scheduler-unhealthy',
    });
    expect(n.ttl).toBe(24 * 60 * 60 * 1000);
  });

  test('a category outside the ranking (e.g. general) gets no default ttl', async () => {
    const n = await svc.schedule('test', {
      title: 'General',
      category: 'general',
    });
    expect(n.ttl).toBeUndefined();
  });

  test('a caller-supplied ttl always wins over the default', async () => {
    const n = await svc.schedule('test', {
      title: 'Approval needed',
      category: 'approval-request',
      ttl: 5_000,
    });
    expect(n.ttl).toBe(5_000);
  });

  test('station#3442 round 2 (HIGH-2): a dedupe-update to a DIFFERENT category updates category, not just title/priority, and re-derives the default ttl for the NEW category', async () => {
    // Probe A's real order: turn.completed schedules first ('done' tier,
    // 15m ttl), runtime.error updates the SAME dedupeTag second ('failed'
    // tier, 24h ttl). Before the fix, category stayed 'turn-completed' and
    // ttl stayed 900_000 while title/priority correctly flipped to the
    // failed framing — a stored row whose title and category contradicted
    // each other, expiring 96x too early.
    await svc.schedule('test', {
      title: 'Your agent finished',
      category: 'turn-completed',
      priority: 'normal',
      dedupeTag: 'turn-completion:t1:turn-1',
    });
    const updated = await svc.schedule('test', {
      title: 'Your agent needs attention',
      category: 'turn-failed',
      priority: 'high',
      dedupeTag: 'turn-completion:t1:turn-1',
    });

    expect(await svc.list()).toEqual([
      expect.objectContaining({
        id: updated.id,
        category: 'turn-failed',
        title: 'Your agent needs attention',
        priority: 'high',
        ttl: 24 * 60 * 60 * 1000,
      }),
    ]);
  });

  test('station#3442 round 2 (HIGH-2), the other direction: a dedupe-update from failed to done also corrects category and shortens the ttl back to the done tier', async () => {
    // Probe B's order: runtime.error schedules first ('failed' tier, 24h),
    // a later turn.completed for the same turnId updates ('done' tier, 15m).
    await svc.schedule('test', {
      title: 'Your agent needs attention',
      category: 'turn-failed',
      priority: 'high',
      dedupeTag: 'turn-completion:t1:turn-1',
    });
    const updated = await svc.schedule('test', {
      title: 'Your agent finished',
      category: 'turn-completed',
      priority: 'normal',
      dedupeTag: 'turn-completion:t1:turn-1',
    });

    expect(await svc.list()).toEqual([
      expect.objectContaining({
        id: updated.id,
        category: 'turn-completed',
        title: 'Your agent finished',
        priority: 'normal',
        ttl: 15 * 60 * 1000,
      }),
    ]);
  });

  test('a dedupe-update still lets an explicit caller ttl win over the new category default', async () => {
    await svc.schedule('test', {
      title: 'V1',
      category: 'turn-completed',
      dedupeTag: 'turn-completion:t1:turn-2',
    });
    const updated = await svc.schedule('test', {
      title: 'V2',
      category: 'turn-failed',
      ttl: 5_000,
      dedupeTag: 'turn-completion:t1:turn-2',
    });
    expect(updated.ttl).toBe(5_000);
  });

  test('an approval-request notification expires at exactly its 24h default TTL, not before', async () => {
    const n = await svc.schedule('test', {
      title: 'Approval needed',
      category: 'approval-request',
    });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 1);
    await svc.drainAsyncDispatch();
    expect(
      (await svc.list({ status: ['delivered'] })).map((x) => x.id),
    ).toContain(n.id);

    await vi.advanceTimersByTimeAsync(1);
    await svc.drainAsyncDispatch();
    expect(
      (await svc.list({ status: ['expired'] })).map((x) => x.id),
    ).toContain(n.id);
  });

  test('a stale timer in another service cannot deliver after snooze changes its generation', async () => {
    const originalDue = new Date(Date.now() + 1_000).toISOString();
    const notification = await svc.schedule('test', {
      title: 'Snooze before delivery',
      category: 'test',
      scheduledAt: originalDue,
    });
    const laterDue = new Date(Date.now() + 10_000).toISOString();
    const other = new NotificationService(new EventBus(), dir, 999_999);

    await other.snooze(notification.id, laterDue);
    await vi.advanceTimersByTimeAsync(1_000);
    await svc.drainAsyncDispatch();

    expect(await svc.list()).toEqual([
      expect.objectContaining({
        id: notification.id,
        status: 'pending',
        scheduledAt: laterDue,
      }),
    ]);
  });

  test('a stale timer in another service cannot expire a dismissed notification', async () => {
    const notification = await svc.schedule('test', {
      title: 'Dismiss before expiry',
      category: 'test',
      ttl: 1_000,
    });
    const other = new NotificationService(new EventBus(), dir, 999_999);

    expect(await other.dismiss(notification.id)).toBe('dismissed');
    await vi.advanceTimersByTimeAsync(1_000);
    await svc.drainAsyncDispatch();

    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: notification.id, status: 'dismissed' }),
    ]);
  });

  test('a dedupe reschedule replaces its local timer while another service timer stays stale', async () => {
    const originalDue = new Date(Date.now() + 1_000).toISOString();
    const first = await svc.schedule('test', {
      title: 'Reschedule me',
      category: 'test',
      scheduledAt: originalDue,
      dedupeTag: 'reschedule:1',
    });
    const other = new NotificationService(new EventBus(), dir, 999_999);
    const laterDue = new Date(Date.now() + 10_000).toISOString();

    const rescheduled = await other.schedule('test', {
      title: 'Rescheduled',
      category: 'test',
      scheduledAt: laterDue,
      dedupeTag: 'reschedule:1',
    });
    expect(rescheduled.id).toBe(first.id);
    await vi.advanceTimersByTimeAsync(1_000);
    await svc.drainAsyncDispatch();

    expect(await svc.list()).toEqual([
      expect.objectContaining({
        id: first.id,
        status: 'pending',
        scheduledAt: laterDue,
      }),
    ]);

    await vi.advanceTimersByTimeAsync(9_000);
    await svc.drainAsyncDispatch();
    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: first.id, status: 'delivered' }),
    ]);
  });

  test('an action reservation invalidates an expiry timer owned by another service', async () => {
    const enteredDispatch = deferred();
    const releaseDispatch = deferred();
    const actor = new NotificationService(new EventBus(), dir, 999_999, {
      beforeActionDispatch: async () => {
        enteredDispatch.resolve();
        await releaseDispatch.promise;
      },
    });
    actor.addProvider({
      id: 'provider',
      displayName: 'Provider',
      categories: ['test'],
      handleAction: vi.fn(),
    } as any);
    const notification = await svc.schedule('provider', {
      title: 'Action before expiry',
      category: 'test',
      ttl: 1_000,
    });

    const action = actor.action(notification.id, 'allow');
    await enteredDispatch.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    await svc.drainAsyncDispatch();

    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: notification.id, status: 'delivered' }),
    ]);
    releaseDispatch.resolve();
    await action;
    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: notification.id, status: 'actioned' }),
    ]);
  });
});

describe('NotificationService syncStatus integration', () => {
  let dir: string;
  let bus: InstanceType<typeof EventBus>;
  let svc: InstanceType<typeof NotificationService>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'notif-sync-'));
    bus = new EventBus();
    svc = new NotificationService(bus, dir, 1000);
  });

  afterEach(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('syncStatus marks notification actioned and emits updated event', async () => {
    const provider = {
      id: 'test-sync',
      displayName: 'Test Sync',
      categories: ['test'],
      poll: async () => [
        {
          title: 'Sync Test',
          body: '',
          category: 'test',
          dedupeTag: 'test:req-1',
        },
      ],
      syncStatus: async () => [
        { dedupeTag: 'test:req-1', status: 'actioned', actionId: 'allow' },
      ],
    };

    svc.addProvider(provider as any);

    await svc.poll(); // schedule + syncStatus run in same cycle

    const actioned = await svc.list({ status: ['actioned'] });
    expect(actioned).toHaveLength(1);
  });

  test('syncStatus marks notification expired', async () => {
    const provider = {
      id: 'test-sync-expire',
      displayName: 'Test Sync Expire',
      categories: ['test'],
      poll: async () => [
        {
          title: 'Sync Expire Test',
          body: '',
          category: 'test',
          dedupeTag: 'test:req-2',
        },
      ],
      syncStatus: async () => [{ dedupeTag: 'test:req-2', status: 'expired' }],
    };

    svc.addProvider(provider as any);

    await svc.poll(); // schedule + syncStatus run in same cycle

    const expired = await svc.list({ status: ['expired'] });
    expect(expired).toHaveLength(1);
  });

  test('syncStatus ignored when no matching notification', async () => {
    const provider = {
      id: 'test-sync-none',
      displayName: 'Test Sync None',
      categories: ['test'],
      poll: async () => [],
      syncStatus: async () => [
        { dedupeTag: 'nonexistent', status: 'actioned' },
      ],
    };

    svc.addProvider(provider as any);

    await svc.poll(); // no notification scheduled
    await svc.poll(); // syncStatus runs but finds nothing

    expect(await svc.list()).toHaveLength(0);
  });
});

describe('metadata normalization (upstream regression #2247)', () => {
  let dir2: string;
  let bus2: InstanceType<typeof EventBus>;
  let svc2: InstanceType<typeof NotificationService>;

  beforeEach(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'notif-meta-'));
    bus2 = new EventBus();
    svc2 = new NotificationService(bus2, dir2, 999_999);
  });

  afterEach(async () => {
    await svc2.shutdown();
    rmSync(dir2, { recursive: true, force: true });
  });

  test('an undefined metadata value does not invalidate the whole store', async () => {
    // Exactly how approval-inbox builds metadata: optional fields read off
    // `message.data?.x`, several of which are absent on a given event.
    const notification = await svc2.schedule('test-source', {
      category: 'approval-request',
      title: 'Needs approval',
      priority: 'high',
      metadata: {
        approvalId: 'a-1',
        agentName: undefined,
        conversationId: undefined,
        requestKind: 'registry',
      },
    });

    expect(notification).toBeDefined();
    // Absent keys are dropped rather than stored as `undefined` — the same
    // shape JSON.stringify would have persisted.
    expect(notification.metadata).not.toHaveProperty('agentName');
    expect(notification.metadata?.approvalId).toBe('a-1');
    // The store still validates, so the notification is actually readable.
    expect((await svc2.list()).map((n) => n.id)).toContain(notification.id);
  });
});
