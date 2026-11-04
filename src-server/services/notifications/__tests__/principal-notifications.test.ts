import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NotificationEnvelopeV1 } from '@kontourai/station-contracts/notification';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { ProjectManifestStore } from '../../projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../projects/project-membership-runtime.js';
import type { ProjectMembershipAuthority } from '../../projects/project-membership-service.js';
import { ProjectService } from '../../projects/project-service.js';
import { NotificationService } from '../notification-service.js';

const temp = trackTempDirs();
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of close.splice(0).reverse()) await dispose();
});
const owner = humanPrincipal('fixture', 'owner', 'Owner');
const alice = humanPrincipal('fixture', 'alice', 'Alice');
const bob = humanPrincipal('fixture', 'bob', 'Bob');

async function fixture() {
  const home = temp('principal-notifications-');
  const storage = new FileStorageAdapter(home);
  const projects = new ProjectService(
    storage,
    new ProjectManifestStore(home, storage),
  );
  const project = await projects.createProject({
    name: 'Example',
    slug: 'example',
  });
  const membership = createProjectMembershipRuntime(home, 'station', storage);
  close.push(() => membership.close());
  let actor = owner;
  const authority: ProjectMembershipAuthority = {
    current: async () => ({ principal: actor, verifiedEmails: [] }),
    operator: async () => {
      if (actor.id !== owner.id) throw new Error('operator required');
    },
  };
  const enabled = await membership.service.enable(
    'example',
    project.id,
    authority,
  );
  for (const person of [alice, bob]) {
    actor = owner;
    const invitation = await membership.service.invite(
      enabled.scope,
      {
        email: null,
        role: 'viewer',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      authority,
    );
    actor = person;
    await membership.service.accept(invitation.token, authority);
  }
  actor = owner;
  const bus = new EventBus();
  const events: string[] = [];
  bus.subscribe((event) => events.push(event.event));
  const service = new NotificationService(bus, home, 999_999, {
    projectMembership: membership.service,
  });
  close.push(() => service.shutdown());
  const envelope = (principalId: string): NotificationEnvelopeV1 => ({
    v: 1,
    source: { kind: 'system', subsystem: 'review' },
    audience: { kind: 'principal', principalId, projectId: project.id },
    urgency: 'info',
    interrupt: 'default',
  });
  const send = (principalId: string, title = 'Private review') =>
    service.scheduleEnveloped(
      'review',
      { category: 'review-request', title },
      envelope(principalId),
    );
  return {
    home,
    project,
    membership,
    authority,
    enabled,
    service,
    bus,
    events,
    send,
  };
}

test('a member receives a durable private feed entry without shared delivery events', async () => {
  const f = await fixture();
  const result = await f.send(alice.id);
  expect(result.outcome).toBe('created');
  expect(result.notification?.status).toBe('delivered');
  expect(await f.service.listForPrincipal(alice.id)).toEqual([
    result.notification,
  ]);
  expect(await f.service.listForPrincipal(bob.id)).toEqual([]);
  expect(await f.service.list()).toEqual([]);
  expect(f.events).not.toContain(SERVER_EVENTS.NOTIFICATION_DELIVERED);
  expect(f.events).not.toContain(SERVER_EVENTS.NOTIFICATION_UPDATED);
  const reopened = new NotificationService(new EventBus(), f.home, 999_999, {
    projectMembership: f.membership.service,
  });
  close.push(() => reopened.shutdown());
  expect(await reopened.listForPrincipal(alice.id)).toEqual([
    result.notification,
  ]);
});

test('a member revoked before creation is suppressed and no notification is stored', async () => {
  const f = await fixture();
  const current = f.membership.service.admissionsForResolvedPrincipal(
    alice.id,
  )[0].member;
  await f.membership.service.changeMember(
    f.enabled.scope,
    alice.id,
    current.revision,
    {
      role: 'viewer',
      status: 'revoked',
    },
    f.authority,
  );
  const result = await f.send(alice.id);
  expect(result.outcome).toBe('suppressed');
  expect(result.notification).toBeUndefined();
  expect(await f.service.listForPrincipal(alice.id)).toEqual([]);
  expect(await f.service.listForPrincipal(bob.id)).toEqual([]);
  expect(await f.service.list()).toEqual([]);
  expect(f.events).not.toContain(SERVER_EVENTS.NOTIFICATION_DELIVERED);
});

test('membership is rechecked after a pending feed lock is acquired', async () => {
  const f = await fixture();
  const release = await acquireFileMutationLockAsync(
    join(f.home, 'principal-notifications.json.mutation'),
  );
  let pending: ReturnType<typeof f.send> | undefined;
  try {
    pending = f.send(alice.id);
    const current = f.membership.service.admissionsForResolvedPrincipal(
      alice.id,
    )[0].member;
    await f.membership.service.changeMember(
      f.enabled.scope,
      alice.id,
      current.revision,
      {
        role: 'viewer',
        status: 'revoked',
      },
      f.authority,
    );
  } finally {
    await release();
  }
  expect((await pending).outcome).toBe('suppressed');
  expect(await f.service.listForPrincipal(alice.id)).toEqual([]);
});

test('read and dismiss are confined to the intended principal', async () => {
  const f = await fixture();
  const result = await f.send(alice.id);
  if (!result.notification) throw new Error('expected delivery');
  const id = result.notification.id;
  expect(await f.service.markReadForPrincipal(bob.id, id, 'device:bob')).toBe(
    'not-found',
  );
  expect(await f.service.dismissForPrincipal(bob.id, id, 'device:bob')).toBe(
    'not-found',
  );
  expect(
    await f.service.markReadForPrincipal(alice.id, id, 'device:alice'),
  ).toBe('read');
  expect(
    await f.service.markReadForPrincipal(alice.id, id, 'device:alice'),
  ).toBe('already-read');
  expect(
    await f.service.dismissForPrincipal(alice.id, id, 'device:alice'),
  ).toBe('dismissed');
  const [record] = await f.service.listForPrincipal(alice.id);
  expect(record.status).toBe('dismissed');
  expect(readNotificationEnvelope(record)).toMatchObject({
    readBy: 'device:alice',
    dismissedBy: 'device:alice',
  });
  expect(await f.service.listForPrincipal(bob.id)).toEqual([]);
  expect(f.events).not.toContain(SERVER_EVENTS.NOTIFICATION_UPDATED);
  expect(f.events).not.toContain(SERVER_EVENTS.NOTIFICATION_DISMISSED);
  const reopened = new NotificationService(new EventBus(), f.home);
  close.push(() => reopened.shutdown());
  expect(await reopened.listForPrincipal(alice.id)).toEqual([record]);
});

test('expired principal records settle on the next feed read without a shared event', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  try {
    const result = await f.service.scheduleEnveloped(
      'review',
      {
        category: 'review-request',
        title: 'Expires',
        ttl: 1_000,
      },
      {
        v: 1,
        source: { kind: 'system', subsystem: 'review' },
        audience: {
          kind: 'principal',
          principalId: alice.id,
          projectId: f.project.id,
        },
        urgency: 'info',
        interrupt: 'default',
      },
    );
    expect(result.outcome).toBe('created');
    vi.setSystemTime(Date.now() + 1_001);
    expect((await f.service.listForPrincipal(alice.id))[0].status).toBe(
      'expired',
    );
    expect(f.events).not.toContain(SERVER_EVENTS.NOTIFICATION_UPDATED);
  } finally {
    vi.useRealTimers();
  }
});

test('a principal feed write failure is reported to its producer', async () => {
  const f = await fixture();
  const first = await f.send(alice.id);
  expect(first.outcome).toBe('created');
  mkdirSync(join(f.home, 'principal-notifications.json.previous'));
  await expect(f.send(alice.id, 'Write must fail')).rejects.toThrow();
  expect(await f.service.listForPrincipal(alice.id)).toEqual([
    first.notification,
  ]);
  expect(await f.service.list()).toEqual([]);
  expect(f.events).not.toContain(SERVER_EVENTS.NOTIFICATION_DELIVERED);
});

test('a member cannot schedule a future principal delivery', async () => {
  const f = await fixture();
  await expect(
    f.service.scheduleEnveloped(
      'review',
      {
        category: 'review-request',
        title: 'Later',
        scheduledAt: '2099-01-01T00:00:00.000Z',
      },
      {
        v: 1,
        source: { kind: 'system', subsystem: 'review' },
        audience: {
          kind: 'principal',
          principalId: alice.id,
          projectId: f.project.id,
        },
        urgency: 'info',
        interrupt: 'default',
      },
    ),
  ).rejects.toThrow('Principal delivery cannot be scheduled');
  expect(await f.service.listForPrincipal(alice.id)).toEqual([]);
});

test('the feed keeps the newest 100 records for each principal', async () => {
  const f = await fixture();
  for (let index = 0; index < 101; index += 1) {
    expect((await f.send(alice.id, `Notice ${index}`)).outcome).toBe('created');
  }
  await f.send(bob.id, 'Bob keeps his own record');
  const records = await f.service.listForPrincipal(alice.id);
  expect(records).toHaveLength(100);
  expect(records[0].title).toBe('Notice 1');
  expect(records[99].title).toBe('Notice 100');
  expect(
    (await f.service.listForPrincipal(bob.id)).map((item) => item.title),
  ).toEqual(['Bob keeps his own record']);
});

// These are the public storage boundaries, deliberately independent of the service constants.
const MAX_FEED_BYTES = 16 * 1024 * 1024;
const MAX_FEED_RECORDS = 100;

test('an oversized write is refused without changing the existing document', async () => {
  const f = await fixture();
  await f.send(alice.id);
  const path = join(f.home, 'principal-notifications.json');
  const before = readFileSync(path);
  const document = JSON.parse(before.toString());
  const record = document[alice.id][0];
  document[alice.id].push({ ...record, title: 'x' });
  const baseSize = Buffer.byteLength(JSON.stringify(document, null, 2));
  const title = 'x'.repeat(MAX_FEED_BYTES + 2 - baseSize);
  expect(
    Buffer.byteLength(
      JSON.stringify(
        { ...document, [alice.id]: [record, { ...record, title }] },
        null,
        2,
      ),
    ),
  ).toBe(MAX_FEED_BYTES + 1);
  await expect(f.send(alice.id, title)).rejects.toThrow(
    'Notification store is invalid',
  );
  expect(Buffer.compare(readFileSync(path), before)).toBe(0);
  expect(await f.service.listForPrincipal(alice.id)).toHaveLength(1);
});

test('the read byte boundary refuses one extra byte and preserves the document', async () => {
  const f = await fixture();
  await f.send(alice.id);
  const path = join(f.home, 'principal-notifications.json');
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const record = document[alice.id][0];
  record.title = 'x';
  const baseSize = Buffer.byteLength(JSON.stringify(document, null, 2));
  record.title = 'x'.repeat(MAX_FEED_BYTES + 1 - baseSize);
  const atLimit = JSON.stringify(document, null, 2);
  expect(Buffer.byteLength(atLimit)).toBe(MAX_FEED_BYTES);
  writeFileSync(path, atLimit);
  expect(await f.service.listForPrincipal(alice.id)).toHaveLength(1);
  record.title += 'x';
  const oversized = Buffer.from(JSON.stringify(document, null, 2));
  expect(oversized.length).toBe(MAX_FEED_BYTES + 1);
  writeFileSync(path, oversized);
  await expect(f.service.listForPrincipal(alice.id)).rejects.toThrow(
    'JSON read exceeds its allowance',
  );
  expect(Buffer.compare(readFileSync(path), oversized)).toBe(0);
});

test('the persisted record count accepts 100 and refuses 101 without changing the document', async () => {
  const f = await fixture();
  await f.send(alice.id);
  const path = join(f.home, 'principal-notifications.json');
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const record = document[alice.id][0];
  document[alice.id] = Array.from({ length: MAX_FEED_RECORDS }, () => ({
    ...record,
    id: randomUUID(),
  }));
  writeFileSync(path, JSON.stringify(document, null, 2));
  expect(await f.service.listForPrincipal(alice.id)).toHaveLength(
    MAX_FEED_RECORDS,
  );
  document[alice.id].push({ ...record, id: randomUUID() });
  const oversized = Buffer.from(JSON.stringify(document, null, 2));
  writeFileSync(path, oversized);
  await expect(f.service.listForPrincipal(alice.id)).rejects.toThrow(
    'Notification store is invalid',
  );
  expect(Buffer.compare(readFileSync(path), oversized)).toBe(0);
});
