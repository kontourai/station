import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  parseProjectRoomBrowserView,
  parseProjectRoomHistory,
  parseProjectRoomMessage,
  parseProjectRoomNote,
} from '@kontourai/station-contracts/project-room-browser';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { ProjectManifestStore } from '../../services/projects/project-manifest-store.js';
import {
  type ProjectMembershipAuthority,
  ProjectMembershipService,
} from '../../services/projects/project-membership-service.js';
import {
  ProjectMembershipRefusal,
  ProjectMembershipStore,
} from '../../services/projects/project-membership-store.js';
import {
  type ProjectRoomAccessPort,
  ProjectRoomService,
} from '../../services/projects/project-room-service.js';
import {
  createProjectRoomRuntime,
  ProjectRoomStore,
} from '../../services/projects/project-room-store.js';
import { ProjectService } from '../../services/projects/project-service.js';
import { createProjectRoomRoutes } from './project-room-routes.js';

const owner = humanPrincipal('deployment', 'alice', 'Alice');
const member = humanPrincipal('deployment', 'bob', 'Bob');
const makeTempDir = trackTempDirs();
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
async function data(response: Response): Promise<unknown> {
  const envelope: unknown = await response.json();
  if (!envelope || typeof envelope !== 'object' || !('data' in envelope))
    throw new Error('Missing response data');
  return envelope.data;
}
async function harness(
  role: 'viewer' | 'contributor' = 'contributor',
  provision = true,
) {
  const home = makeTempDir('station-room-http-');
  const storage = new FileStorageAdapter(home);
  const manifests = new ProjectManifestStore(home, storage);
  const projects = new ProjectService(storage, manifests);
  const project = await projects.createProject({
    name: 'Example',
    slug: 'example',
  });
  const db = new DatabaseSync(join(home, 'members.sqlite'));
  cleanup.push(() => db.close());
  const members = new ProjectMembershipStore(db, 'station');
  const membership = new ProjectMembershipService(
    'station',
    storage,
    manifests,
    members,
  );
  let aliceLive = true;
  let bobLive = true;
  const authority = (
    principal: typeof owner,
    live: () => boolean,
  ): ProjectMembershipAuthority => ({
    current: async () => {
      if (!live()) throw new ProjectMembershipRefusal('forbidden');
      return { principal, verifiedEmails: [] };
    },
    operator: async () => {
      if (principal.id !== owner.id)
        throw new ProjectMembershipRefusal('forbidden');
    },
  });
  const alice = authority(owner, () => aliceLive);
  const bob = authority(member, () => bobLive);
  const enabled = await membership.enable('example', project.id, alice);
  const offer = await membership.invite(
    enabled.scope,
    {
      email: null,
      role,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    alice,
  );
  await membership.accept(offer.token, bob);
  const resolve = (request: Request) => {
    const credential = request.headers.get('authorization');
    if (credential === 'Bearer alice-session')
      return { auth: alice, live: () => aliceLive };
    if (credential === 'Bearer bob-session')
      return { auth: bob, live: () => bobLive };
    throw new ProjectMembershipRefusal('forbidden');
  };
  let beforeCommit: (() => void) | undefined;
  const port: ProjectRoomAccessPort = {
    async withAction(request, slug, action, expected, operation) {
      const { auth, live } = resolve(request);
      const actor = await auth.current();
      const scope = members.scopeForMember(slug, actor.principal, action);
      return membership.withProjectAction(
        scope,
        action,
        auth,
        expected ?? actor.principal.id,
        (fresh, assertCurrent) => {
          const actions = members.require(
            scope,
            fresh.principal,
            'view',
          ).actions;
          return operation(
            scope,
            {
              id: fresh.principal.id,
              displayName: fresh.principal.display,
              kind: 'person',
            },
            {
              view: actions.includes('view'),
              discuss: actions.includes('discuss'),
              edit: actions.includes('edit'),
              execute: actions.includes('execute'),
            },
            () => {
              const commit = beforeCommit;
              beforeCommit = undefined;
              commit?.();
              assertCurrent();
            },
          );
        },
        live,
      );
    },
    async current(request, scope, actorId, action) {
      const { auth, live } = resolve(request);
      return membership.currentActionAdmission(
        scope,
        action,
        auth,
        actorId,
        live,
      );
    },
  };
  const runtime = createProjectRoomRuntime(home);
  cleanup.push(() => runtime.close());
  const service = new ProjectRoomService(runtime.store, port);
  cleanup.push(() => service.close());
  if (provision)
    await service.open(
      new Request('http://localhost', {
        headers: { authorization: 'Bearer alice-session' },
      }),
      'example',
    );
  const app = new Hono();
  app.route('/api/projects', createProjectRoomRoutes(service));
  const request = (
    who: 'alice' | 'bob',
    path = '',
    method = 'GET',
    value?: unknown,
  ) =>
    app.request(`/api/projects/example/room${path}`, {
      method,
      headers: {
        authorization: `Bearer ${who}-session`,
        'content-type': 'application/json',
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  const discover = async (who: 'alice' | 'bob') => {
    const response = await request(who);
    expect(response.status).toBe(200);
    return parseProjectRoomBrowserView(await data(response));
  };
  return {
    home,
    app,
    service,
    runtime,
    request,
    discover,
    membership,
    members,
    projects,
    alice,
    bob,
    scope: enabled.scope,
    armCommit: (fn: () => void) => {
      beforeCommit = fn;
    },
    revokeMember: () => {
      const current = members.require(enabled.scope, member, 'view');
      members.changeMember(enabled.scope, owner, member.id, current.revision, {
        role: 'viewer',
        status: 'revoked',
      });
    },
    revokeBob: () => {
      bobLive = false;
    },
    revokeAlice: () => {
      aliceLive = false;
    },
  };
}
function guard(
  view: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['discover']>>,
) {
  return {
    expectedRoomId: view.roomId,
    expectedProjectId: view.scope.localProjectId,
    expectedActorId: view.actor.id,
  };
}
test('two independent human authorities keep attribution, ordering, replay and note CAS through HTTP', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const b = await h.discover('bob');
  expect(a.roomId).toBe(b.roomId);
  expect(a.actor.id).not.toBe(b.actor.id);
  const input = { ...guard(a), intentId: randomUUID(), text: 'Alice decision' };
  const first = parseProjectRoomMessage(
    await data(await h.request('alice', '/messages', 'POST', input)),
  );
  expect(first.actor).toEqual({
    id: owner.id,
    displayName: 'Alice',
    kind: 'person',
  });
  expect(first.seq).toBe(1);
  expect(
    parseProjectRoomMessage(
      await data(await h.request('alice', '/messages', 'POST', input)),
    ),
  ).toEqual(first);
  expect(
    (
      await h.request('alice', '/messages', 'POST', {
        ...input,
        text: 'different',
      })
    ).status,
  ).toBe(409);
  const reply = parseProjectRoomMessage(
    await data(
      await h.request('bob', '/messages', 'POST', {
        ...guard(b),
        intentId: input.intentId,
        text: 'Bob reply',
        replyTo: first.messageId,
      }),
    ),
  );
  expect(reply.actor.id).toBe(member.id);
  expect(reply.seq).toBe(2);
  const history = parseProjectRoomHistory(
    await data(await h.request('bob', '/messages?after=0&limit=1')),
  );
  expect(history.messages).toEqual([first]);
  expect(history.nextAfter).toBe(1);
  expect(history.checkpoint.lastSeq).toBe(2);
  const note = {
    ...guard(a),
    expectedRevision: 0,
    markdown: 'Agreed',
    sourceMessageIds: [first.messageId, reply.messageId],
  };
  expect(
    parseProjectRoomNote(
      await data(await h.request('alice', '/note', 'PUT', note)),
    ).revision,
  ).toBe(1);
  expect(
    (await h.request('bob', '/note', 'PUT', { ...note, ...guard(b) })).status,
  ).toBe(409);
  expect((await h.request('bob', '/messages', 'POST', input)).status).toBe(403);
  expect(
    (
      await h.request('alice', '/messages', 'POST', {
        ...input,
        unexpected: true,
      })
    ).status,
  ).toBe(400);
});
test('viewer discovery permits viewing presence but refuses writes and history never creates a Room', async () => {
  const h = await harness('viewer', false);
  expect((await h.request('bob', '/messages')).status).toBe(404);
  expect((await h.request('bob')).status).toBe(404);
  await h.service.open(
    new Request('http://station.test', {
      headers: { authorization: 'Bearer alice-session' },
    }),
    'example',
  );
  const b = await h.discover('bob');
  expect(b.capabilities.discuss).toBe(false);
  expect(
    (
      await h.request('bob', '/messages', 'POST', {
        ...guard(b),
        intentId: randomUUID(),
        text: 'refused',
      })
    ).status,
  ).toBe(403);
  const clientId = randomUUID();
  const joined = await h.request('bob', '/presence', 'POST', {
    ...guard(b),
    clientId,
    state: 'join',
  });
  expect(await data(joined)).toEqual([
    { clientId, actor: b.actor, expiresAt: expect.any(String) },
  ]);
  const restarted = new ProjectRoomService(h.runtime.store, h.service.access);
  cleanup.push(() => restarted.close());
  expect(restarted.presence(b.roomId)).toEqual([]);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30001);
  expect(h.service.presence(b.roomId)).toEqual([]);
  vi.restoreAllMocks();
});
test('revocation at the synchronous transaction admission rolls back and queued HTTP delivery is withheld', async () => {
  const h = await harness();
  const b = await h.discover('bob');
  h.armCommit(h.revokeMember);
  expect(
    (
      await h.request('bob', '/messages', 'POST', {
        ...guard(b),
        intentId: randomUUID(),
        text: 'never commit',
      })
    ).status,
  ).toBe(403);
  expect(h.runtime.store.history(h.scope).messages).toEqual([]);
  const response = await h.request('alice', '/messages');
  expect(response.status).toBe(200);
  h.revokeAlice();
  await expect(response.text()).rejects.toThrow();
});
test('same-slug replacement cannot expose old history or accept the old Room guards', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  await h.request('alice', '/messages', 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text: 'old incarnation',
  });
  await h.projects.deleteProject('example');
  const replacement = await h.projects.createProject({
    name: 'New',
    slug: 'example',
  });
  expect(replacement.id).not.toBe(a.scope.localProjectId);
  expect((await h.request('alice', '/messages')).status).toBe(403);
  expect(
    (
      await h.request('alice', '/messages', 'POST', {
        ...guard(a),
        intentId: randomUUID(),
        text: 'stale',
      })
    ).status,
  ).toBe(403);
  // The old durable record remains intact; the replacement has no authority
  // to read it and discovery cannot silently grant a new membership.
  expect(h.runtime.store.history(h.scope).messages[0]?.text).toBe(
    'old incarnation',
  );
});
test('SSE checkpoints are guarded at queued delivery and terminate with revoked while presence is removed', async () => {
  const h = await harness();
  const b = await h.discover('bob');
  await h.request('bob', '/presence', 'POST', {
    ...guard(b),
    clientId: randomUUID(),
    state: 'join',
  });
  const response = await h.request('bob', '/events');
  expect(response.status).toBe(200);
  expect(response.headers.get('x-accel-buffering')).toBe('no');
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('event: changed');
  h.revokeMember();
  const terminal = await reader.read();
  expect(new TextDecoder().decode(terminal.value)).toContain('event: revoked');
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(h.service.presence(b.roomId)).toEqual([]);
  const second = await h.request('alice', '/events');
  h.service.close();
  await second.body?.cancel();
  expect(h.service.presence(b.roomId)).toEqual([]);
});

test('presence capacity is enforced per Room and globally and leave frees a slot', async () => {
  const h = await harness();
  // Capacity and TTL are independent contracts: keep these live leases fresh
  // even when the host takes longer than their real 30-second TTL to fill.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const views: Awaited<ReturnType<typeof h.discover>>[] = [];
  for (let i = 0; i < 11; i++) {
    const slug = i === 0 ? 'example' : `room-${i}`;
    if (i > 0) {
      const project = await h.projects.createProject({
        name: `Room ${i}`,
        slug,
      });
      await h.membership.enable(slug, project.id, h.alice);
    }
    await h.service.open(
      new Request('http://station.test', {
        headers: { authorization: 'Bearer alice-session' },
      }),
      slug,
    );
    const view = (
      await h.service.discover(
        new Request('http://station.test', {
          headers: { authorization: 'Bearer alice-session' },
        }),
        slug,
      )
    ).data;
    views.push(view);
  }
  const request = new Request('http://station.test', {
    headers: { authorization: 'Bearer alice-session' },
  });
  const firstClient = randomUUID();
  for (let i = 0; i < 10; i++)
    for (let j = 0; j < 100; j++)
      await h.service.updatePresence(
        request,
        views[i].scope.localProjectSlug,
        guard(views[i]),
        i === 0 && j === 0 ? firstClient : randomUUID(),
        'join',
      );
  await expect(
    h.service.updatePresence(
      request,
      'example',
      guard(views[0]),
      randomUUID(),
      'join',
    ),
  ).rejects.toMatchObject({ code: 'capacity' });
  await expect(
    h.service.updatePresence(
      request,
      'room-10',
      guard(views[10]),
      randomUUID(),
      'join',
    ),
  ).rejects.toMatchObject({ code: 'capacity' });
  // A heartbeat renews an existing slot even at capacity.
  expect(
    (
      await h.service.updatePresence(
        request,
        'example',
        guard(views[0]),
        firstClient,
        'join',
      )
    ).data,
  ).toHaveLength(100);
  await h.service.updatePresence(
    request,
    'example',
    guard(views[0]),
    firstClient,
    'leave',
  );
  expect(
    (
      await h.service.updatePresence(
        request,
        'room-10',
        guard(views[10]),
        randomUUID(),
        'join',
      )
    ).data,
  ).toHaveLength(1);
}, 60000);

test('idle SSE periodically notices membership revocation and shutdown clears its timers', async () => {
  const h = await harness();
  await h.discover('bob');
  const response = await h.request('bob', '/events');
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    'event: changed',
  );
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    'event: presence',
  );
  h.revokeMember();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    'event: revoked',
  );
  expect((await reader.read()).done).toBe(true);
  vi.useFakeTimers();
  const next = await h.request('alice', '/events');
  const nextReader = next.body!.getReader();
  await nextReader.read();
  await nextReader.read();
  h.service.close();
  await nextReader.cancel();
  await vi.runAllTimersAsync();
  expect(vi.getTimerCount()).toBe(0);
});

test('a miswired asynchronous final admission guard cannot authorize Room writes', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const access = h.service.access;
  const invalid = new ProjectRoomService(h.runtime.store, {
    current: access.current.bind(access),
    withAction: (request, slug, action, expected, operation) =>
      access.withAction(request, slug, action, expected, (scope, actor, caps) =>
        operation(scope, actor, caps, async () => {}),
      ),
  });
  cleanup.push(() => invalid.close());
  await expect(
    invalid.append(
      new Request('http://station.test', {
        headers: { authorization: 'Bearer alice-session' },
      }),
      'example',
      guard(a),
      { intentId: randomUUID(), text: 'must not commit' },
    ),
  ).rejects.toMatchObject({ code: 'invalid' });
  expect(h.runtime.store.history(h.scope).messages).toEqual([]);
});

test('an unconsumed SSE response stops on its bounded write deadline without queued polling work', async () => {
  const h = await harness();
  await h.discover('alice');
  vi.useFakeTimers();
  const response = await h.request('alice', '/events');
  // Wait for asynchronous membership IO to reach the blocked writer. The
  // other timer belongs to the shared consistency owner.
  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
  await vi.advanceTimersByTimeAsync(2001);
  expect(vi.getTimerCount()).toBe(0);
  await response.body?.cancel();
  h.service.close();
  expect(vi.getTimerCount()).toBe(0);
});

// These mounted tests own transport timing, bounded queued work, and the durable
// writer boundary. Store CRUD tests cannot detect idle invalidation or lost wakes.
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  return new TextDecoder().decode((await reader.read()).value);
}
test('mounted SSE is idle without history reads, pushes direct Agent commits and note-only changes, and coalesces retries', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  vi.useFakeTimers();
  const history = vi.spyOn(h.runtime.store, 'history');
  const response = await h.request('alice', '/events');
  const reader = response.body!.getReader();
  expect(await frame(reader)).toContain('event: changed');
  expect(await frame(reader)).toContain('event: presence');
  history.mockClear();
  let delivered = false;
  const next = frame(reader).then((value) => {
    delivered = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(6500);
  expect(delivered).toBe(false);
  expect(history).not.toHaveBeenCalled();
  expect(() =>
    h.runtime.store.append(
      h.scope,
      a.actor,
      { intentId: randomUUID(), text: 'rollback' },
      () => {
        throw new Error('revoked');
      },
    ),
  ).toThrow('revoked');
  await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toBe(false);
  const input = { intentId: randomUUID(), text: 'Agent direct write' };
  const agent = { kind: 'agent' as const, id: 'agent', displayName: 'Agent' };
  for (let i = 0; i < 20; i++)
    h.runtime.store.append(h.scope, agent, input, () => {});
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(delivered).toBe(true));
  expect(await next).toContain('"lastSeq":1');
  const burst = frame(reader);
  for (let i = 0; i < 20; i++)
    h.runtime.store.append(
      h.scope,
      agent,
      { intentId: randomUUID(), text: `burst ${i}` },
      () => {},
    );
  await vi.advanceTimersByTimeAsync(0);
  expect(await burst).toContain('"lastSeq":21');
  const noteFrame = frame(reader);
  h.runtime.store.updateNote(
    h.scope,
    a.actor,
    { expectedRevision: 0, markdown: 'note only', sourceMessageIds: [] },
    () => {},
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(await noteFrame).toContain('event: changed');
  let extra = false;
  const pending = frame(reader).then((value) => {
    extra = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(6000);
  expect(extra).toBe(false);
  expect(history).not.toHaveBeenCalled();
  h.service.close();
  await pending;
  await reader.cancel();
  expect(vi.getTimerCount()).toBe(0);
});

test('mounted SSE reconciles another SQLite writer once per Room and heartbeat does not emit changed', async () => {
  const h = await harness();
  await h.discover('alice');
  vi.useFakeTimers();
  const checkpoint = vi.spyOn(h.runtime.store, 'checkpoint');
  const readers = [];
  for (let i = 0; i < 3; i++) {
    const response = await h.request('alice', '/events');
    const reader = response.body!.getReader();
    readers.push(reader);
    await frame(reader);
    await frame(reader);
  }
  checkpoint.mockClear();
  const pending = readers.map((reader) => frame(reader));
  await vi.advanceTimersByTimeAsync(20000);
  for (const value of await Promise.all(pending))
    expect(value).toContain(': ping');
  expect(checkpoint).toHaveBeenCalledTimes(1);
  const db = new DatabaseSync(join(h.home, 'security', 'project-rooms.sqlite'));
  try {
    const writer = new ProjectRoomStore(db);
    writer.append(
      h.scope,
      { kind: 'agent', id: 'external', displayName: 'External' },
      { intentId: randomUUID(), text: 'other connection' },
      () => {},
    );
    const changes = readers.map((reader) => frame(reader));
    await vi.advanceTimersByTimeAsync(20000);
    for (const value of await Promise.all(changes))
      expect(value).toContain('"lastSeq":1');
    writer.append(
      h.scope,
      { kind: 'agent', id: 'external', displayName: 'External' },
      { intentId: randomUUID(), text: 'reconnect gap' },
      () => {},
    );
    const reconnect = await h.request('alice', '/events');
    const reconnected = reconnect.body!.getReader();
    expect(await frame(reconnected)).toContain('"lastSeq":2');
    await reconnected.cancel();
  } finally {
    db.close();
  }
  for (const reader of readers) await reader.cancel();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});
