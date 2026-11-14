import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  PROJECT_ROOM_FORBIDDEN_CODE,
  PROJECT_ROOM_LIMITS,
  parseProjectRoomChannel,
  parseProjectRoomChannelList,
} from '@kontourai/station-contracts/project-room';
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
import { RoomAttachments } from '../../services/projects/task-room-attachments.js';
import { projectRoomVersionSource } from '../../services/read-markers/room-version-sources.js';
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
  const service = new ProjectRoomService(
    runtime.store,
    port,
    new RoomAttachments(join(home, 'project-room-attachments'), 'room'),
  );
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

type Harness = Awaited<ReturnType<typeof harness>>;
function api(
  h: Harness,
  who: 'alice' | 'bob',
  path: string,
  method = 'GET',
  value?: unknown,
) {
  return h.app.request(`/api/projects/example${path}`, {
    method,
    headers: {
      authorization: `Bearer ${who}-session`,
      'content-type': 'application/json',
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
async function code(response: Response) {
  return {
    status: response.status,
    code: ((await response.json()) as { error?: { code?: string } }).error
      ?.code,
  };
}
async function channelGuard(h: Harness, who: 'alice' | 'bob') {
  const view = await h.discover(who);
  return {
    expectedProjectId: view.scope.localProjectId,
    expectedActorId: view.actor.id,
  };
}
async function createChannel(
  h: Harness,
  who: 'alice' | 'bob',
  name: string,
  topic?: string,
) {
  return api(h, who, '/channels', 'POST', {
    ...(await channelGuard(h, who)),
    name,
    ...(topic === undefined ? {} : { topic }),
  });
}
test('channels: the default room lists as #general and per-channel routes address separate rooms', async () => {
  const h = await harness();
  const general = await h.discover('alice');
  const listed = parseProjectRoomChannelList(
    await data(await api(h, 'bob', '/channels')),
  );
  expect(listed).toEqual([
    { channelId: general.roomId, name: 'general', isDefault: true },
  ]);
  const design = parseProjectRoomChannel(
    await data(await createChannel(h, 'alice', 'design', 'Screens and flows')),
  );
  const view = parseProjectRoomBrowserView(
    await data(await api(h, 'bob', `/channels/${design.channelId}`)),
  );
  expect(view.roomId).toBe(design.channelId);
  const posted = parseProjectRoomMessage(
    await data(
      await api(h, 'bob', `/channels/${design.channelId}/messages`, 'POST', {
        ...guard(view),
        intentId: randomUUID(),
        text: 'Design only',
      }),
    ),
  );
  expect(posted.roomId).toBe(design.channelId);
  // #general (both addresses) does not see it; the channel does.
  for (const path of ['/room/messages', `/channels/${general.roomId}/messages`])
    expect(
      parseProjectRoomHistory(await data(await api(h, 'bob', path))).messages,
    ).toEqual([]);
  expect(
    parseProjectRoomHistory(
      await data(await api(h, 'bob', `/channels/${design.channelId}/messages`)),
    ).messages,
  ).toEqual([posted]);
  // A guard naming #general cannot post into another channel.
  expect(
    await code(
      await api(h, 'bob', `/channels/${design.channelId}/messages`, 'POST', {
        ...guard(general),
        expectedActorId: view.actor.id,
        intentId: randomUUID(),
        text: 'wrong room',
      }),
    ),
  ).toEqual({ status: 409, code: 'project_room_conflict' });
  expect((await api(h, 'bob', `/channels/${randomUUID()}`)).status).toBe(404);
  expect((await api(h, 'bob', '/channels/not-a-uuid')).status).toBe(400);
});
test('channels: create, rename, topic and archive need edit; viewers read but cannot manage', async () => {
  const h = await harness('viewer');
  expect((await api(h, 'bob', '/channels')).status).toBe(200);
  expect((await createChannel(h, 'bob', 'design')).status).toBe(403);
  const design = parseProjectRoomChannel(
    await data(await createChannel(h, 'alice', 'design')),
  );
  expect(
    (
      await api(h, 'bob', `/channels/${design.channelId}`, 'PATCH', {
        ...(await channelGuard(h, 'bob')),
        archived: true,
      })
    ).status,
  ).toBe(403);
  const patch = async (value: object) =>
    api(h, 'alice', `/channels/${design.channelId}`, 'PATCH', {
      ...(await channelGuard(h, 'alice')),
      ...value,
    });
  expect(
    parseProjectRoomChannel(
      await data(await patch({ name: 'ux', topic: 'Flows' })),
    ),
  ).toMatchObject({ name: 'ux', topic: 'Flows' });
  expect(
    parseProjectRoomChannel(await data(await patch({ topic: null }))).topic,
  ).toBeUndefined();
  expect((await patch({})).status).toBe(400);
  const topicLimit = PROJECT_ROOM_LIMITS.channelTopicBytes;
  expect(250).toBe(topicLimit);
  expect((await patch({ topic: 'x'.repeat(topicLimit) })).status).toBe(200);
  expect((await patch({ topic: 'x'.repeat(topicLimit + 1) })).status).toBe(400);
  const general = (await h.discover('alice')).roomId;
  expect(
    await code(
      await api(h, 'alice', `/channels/${general}`, 'PATCH', {
        ...(await channelGuard(h, 'alice')),
        archived: true,
      }),
    ),
  ).toEqual({ status: 400, code: 'project_room_invalid' });
});
test('channels: names are parsed, unique per Project, and bounded at the limit', async () => {
  const h = await harness();
  const nameLimit = PROJECT_ROOM_LIMITS.channelNameLength;
  expect(80).toBe(nameLimit);
  for (const name of [
    'Design',
    'design_x',
    '-design',
    'design-',
    'de--sign',
    'design team',
    '',
    'a'.repeat(nameLimit + 1),
  ])
    expect((await createChannel(h, 'alice', name)).status, name).toBe(400);
  expect((await createChannel(h, 'alice', 'a'.repeat(nameLimit))).status).toBe(
    200,
  );
  expect((await createChannel(h, 'alice', 'design')).status).toBe(200);
  expect(await code(await createChannel(h, 'bob', 'design'))).toEqual({
    status: 409,
    code: 'project_room_duplicate',
  });
  expect(await code(await createChannel(h, 'bob', 'general'))).toEqual({
    status: 409,
    code: 'project_room_duplicate',
  });
  const channels = parseProjectRoomChannelList(
    await data(await api(h, 'alice', '/channels')),
  );
  const design = channels.find((c) => c.name === 'design')!;
  expect(
    await code(
      await api(h, 'alice', `/channels/${design.channelId}`, 'PATCH', {
        ...(await channelGuard(h, 'alice')),
        name: 'general',
      }),
    ),
  ).toEqual({ status: 409, code: 'project_room_duplicate' });
});
test('channels: the Project refuses a channel past its limit, archived ones included', async () => {
  const h = await harness();
  const limit = PROJECT_ROOM_LIMITS.channelsPerProject;
  expect(50).toBe(limit);
  // #general is the first of the limit.
  for (let index = 1; index < limit; index++)
    expect((await createChannel(h, 'alice', `topic-${index}`)).status).toBe(
      200,
    );
  const listed = parseProjectRoomChannelList(
    await data(await api(h, 'alice', '/channels')),
  );
  expect(listed).toHaveLength(limit);
  await api(h, 'alice', `/channels/${listed[1].channelId}`, 'PATCH', {
    ...(await channelGuard(h, 'alice')),
    archived: true,
  });
  expect(await code(await createChannel(h, 'alice', 'one-more'))).toEqual({
    status: 429,
    code: 'project_room_capacity',
  });
});
// Agent requests into an archived channel are refused at the Agent module seam
// (project-room-agent-module.test.ts); this harness mounts no Agent routes.
test('channels: an archived channel refuses posts and note edits but still serves history', async () => {
  const h = await harness();
  const design = parseProjectRoomChannel(
    await data(await createChannel(h, 'alice', 'design')),
  );
  const view = parseProjectRoomBrowserView(
    await data(await api(h, 'bob', `/channels/${design.channelId}`)),
  );
  const message = (text: string) =>
    api(h, 'bob', `/channels/${design.channelId}/messages`, 'POST', {
      ...guard(view),
      intentId: randomUUID(),
      text,
    });
  const before = parseProjectRoomMessage(await data(await message('kept')));
  const archived = parseProjectRoomChannel(
    await data(
      await api(h, 'alice', `/channels/${design.channelId}`, 'PATCH', {
        ...(await channelGuard(h, 'alice')),
        archived: true,
      }),
    ),
  );
  expect(archived.archivedAt).toEqual(expect.any(String));
  expect(await code(await message('late'))).toEqual({
    status: 409,
    code: 'project_room_archived',
  });
  expect(
    await code(
      await api(h, 'bob', `/channels/${design.channelId}/note`, 'PUT', {
        ...guard(view),
        expectedRevision: 0,
        markdown: 'late',
        sourceMessageIds: [],
      }),
    ),
  ).toEqual({ status: 409, code: 'project_room_archived' });
  expect(
    parseProjectRoomHistory(
      await data(await api(h, 'bob', `/channels/${design.channelId}/messages`)),
    ).messages,
  ).toEqual([before]);
  expect((await api(h, 'bob', `/channels/${design.channelId}`)).status).toBe(
    200,
  );
  await api(h, 'alice', `/channels/${design.channelId}`, 'PATCH', {
    ...(await channelGuard(h, 'alice')),
    archived: false,
  });
  expect((await message('back')).status).toBe(200);
});

/** A real 1x1 PNG, so the shared attachment checks see matching bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const png = (name = 'shot.png') => ({
  kind: 'image',
  name,
  mimeType: 'image/png',
  size: PNG.length,
  dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
});
async function history(
  h: Awaited<ReturnType<typeof harness>>,
  who: 'alice' | 'bob',
) {
  const response = await h.request(who, '/messages');
  expect(response.status).toBe(200);
  return parseProjectRoomHistory(await data(response));
}

test('message activity: another client sees a reaction, its removal and an edit after a refetch, and the read version stays', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const b = await h.discover('bob');
  const message = parseProjectRoomMessage(
    await data(
      await h.request('alice', '/messages', 'POST', {
        ...guard(a),
        intentId: randomUUID(),
        text: 'Ship it?',
      }),
    ),
  );
  const target = `/messages/${message.messageId}`;
  const react = (who: 'alice' | 'bob', reacted: boolean) =>
    h.request(who, `${target}/reactions`, 'POST', {
      ...guard(who === 'alice' ? a : b),
      emoji: '👍',
      reacted,
    });
  expect((await react('bob', true)).status).toBe(200);
  expect((await react('alice', true)).status).toBe(200);
  expect((await history(h, 'alice')).messages[0]!.reactions).toEqual([
    { emoji: '👍', actors: [b.actor, a.actor] },
  ]);
  expect((await react('bob', false)).status).toBe(200);
  expect((await history(h, 'alice')).messages[0]!.reactions).toEqual([
    { emoji: '👍', actors: [a.actor] },
  ]);
  const edited = await h.request('alice', `${target}/edit`, 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text: 'Ship it Friday?',
  });
  expect(edited.status).toBe(200);
  const seen = (await history(h, 'bob')).messages[0]!;
  expect(seen.text).toBe('Ship it Friday?');
  expect(seen.editedAt).toEqual(expect.any(String));
  // Neither moved the room's content version, which read state counts.
  expect((await h.discover('bob')).checkpoint.lastSeq).toBe(1);
});

test("message activity: the server refuses an edit or delete of another person's message", async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const b = await h.discover('bob');
  const message = parseProjectRoomMessage(
    await data(
      await h.request('alice', '/messages', 'POST', {
        ...guard(a),
        intentId: randomUUID(),
        text: 'Mine',
      }),
    ),
  );
  for (const action of ['edit', 'delete'] as const) {
    const response = await h.request(
      'bob',
      `/messages/${message.messageId}/${action}`,
      'POST',
      {
        ...guard(b),
        intentId: randomUUID(),
        ...(action === 'edit' ? { text: 'Yours now' } : {}),
      },
    );
    // Not a 403: clients read a 403 as lost access and stop the room.
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: PROJECT_ROOM_FORBIDDEN_CODE },
    });
    // Pinned literal beside the constant under test.
    expect(PROJECT_ROOM_FORBIDDEN_CODE).toBe('project_room_forbidden');
  }
  expect((await history(h, 'alice')).messages).toEqual([message]);
});

test('message activity: a deleted root keeps its replies reachable', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const b = await h.discover('bob');
  const root = parseProjectRoomMessage(
    await data(
      await h.request('alice', '/messages', 'POST', {
        ...guard(a),
        intentId: randomUUID(),
        text: 'Root',
      }),
    ),
  );
  const reply = parseProjectRoomMessage(
    await data(
      await h.request('bob', '/messages', 'POST', {
        ...guard(b),
        intentId: randomUUID(),
        text: 'Reply',
        replyTo: root.messageId,
      }),
    ),
  );
  const deleted = await h.request(
    'alice',
    `/messages/${root.messageId}/delete`,
    'POST',
    { ...guard(a), intentId: randomUUID() },
  );
  expect(deleted.status).toBe(200);
  const { messages } = await history(h, 'bob');
  expect(messages.map((m) => [m.messageId, m.text, !!m.deletedAt])).toEqual([
    [root.messageId, '', true],
    [reply.messageId, 'Reply', false],
  ]);
  expect(messages[1]!.replyTo).toBe(root.messageId);
});

test('message files: upload, send, read back; past the count or size limit is refused; a deleted message withholds them', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const upload = (attachments: unknown[]) =>
    h.request('alice', '/attachments', 'POST', { ...guard(a), attachments });
  expect((await upload(Array.from({ length: 6 }, () => png()))).status).toBe(
    400,
  );
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  PNG.copy(big);
  expect(
    (
      await upload([
        {
          ...png('big.png'),
          size: big.length,
          dataUrl: `data:image/png;base64,${big.toString('base64')}`,
        },
      ])
    ).status,
  ).toBe(400);
  const stored = await upload([png()]);
  expect(stored.status).toBe(200);
  const [file] = (await data(stored)) as { id: string }[];
  // A file is its uploader's: another member cannot send it as theirs.
  const b = await h.discover('bob');
  const borrowed = await h.request('bob', '/messages', 'POST', {
    ...guard(b),
    intentId: randomUUID(),
    text: 'Look what I made',
    attachments: [file],
  });
  expect(borrowed.status).toBe(400);
  // Unsent, the file is nobody's to read.
  expect((await h.request('bob', `/attachments/${file!.id}`)).status).toBe(404);
  // Six distinct stored files are refused at the message too, not only at
  // upload. Distinct ids keep the repeated-file refusal from answering first.
  const five = await upload(
    Array.from({ length: 5 }, (_, i) => png(`${i}.png`)),
  );
  expect(five.status).toBe(200);
  const six = [file, ...((await data(five)) as { id: string }[])];
  expect(new Set(six.map((stored) => stored!.id)).size).toBe(6);
  const tooMany = await h.request('alice', '/messages', 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text: '',
    attachments: six,
  });
  expect(tooMany.status).toBe(400);
  // The same file twice is refused, not a storage failure (503).
  const repeated = await h.request('alice', '/messages', 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text: '',
    attachments: [file, file],
  });
  expect(repeated.status).toBe(400);
  const message = parseProjectRoomMessage(
    await data(
      await h.request('alice', '/messages', 'POST', {
        ...guard(a),
        intentId: randomUUID(),
        text: '',
        attachments: [file],
      }),
    ),
  );
  const read = await h.request('bob', `/attachments/${file!.id}`);
  expect(read.status).toBe(200);
  expect(read.headers.get('content-type')).toBe('application/octet-stream');
  expect(Buffer.from(await read.arrayBuffer())).toEqual(PNG);
  expect((await history(h, 'bob')).messages[0]!.attachments).toEqual([file]);
  await h.request('alice', `/messages/${message.messageId}/delete`, 'POST', {
    ...guard(a),
    intentId: randomUUID(),
  });
  expect((await h.request('bob', `/attachments/${file!.id}`)).status).toBe(404);
});

test('message activity: SSE announces a reaction, an edit and a delete without advancing lastSeq', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const message = h.runtime.store.append(
    h.scope,
    a.actor,
    { intentId: randomUUID(), text: 'watch me' },
    () => {},
  );
  const response = await h.request('alice', '/events');
  const reader = response.body!.getReader();
  expect(await frame(reader)).toContain('event: changed');
  expect(await frame(reader)).toContain('event: presence');
  const changes = [
    () =>
      h.runtime.store.react(
        h.scope,
        a.actor,
        message.messageId,
        { emoji: '🎉', reacted: true },
        () => {},
      ),
    () =>
      h.runtime.store.edit(
        h.scope,
        a.actor,
        message.messageId,
        { intentId: randomUUID(), text: 'watch this' },
        () => {},
      ),
    () =>
      h.runtime.store.deleteMessage(
        h.scope,
        a.actor,
        message.messageId,
        { intentId: randomUUID() },
        () => {},
      ),
  ];
  for (const change of changes) {
    const next = frame(reader);
    change();
    const value = await next;
    expect(value).toContain('event: changed');
    expect(value).toContain('"lastSeq":1');
  }
  await reader.cancel();
});

test('read markers (#3075): each channel has its own room version, read through the room service', async () => {
  const h = await harness();
  const general = await h.discover('bob');
  const design = parseProjectRoomChannel(
    await data(await createChannel(h, 'alice', 'design')),
  );
  const view = parseProjectRoomBrowserView(
    await data(await api(h, 'bob', `/channels/${design.channelId}`)),
  );
  for (const text of ['one', 'two'])
    expect(
      (
        await api(h, 'bob', `/channels/${design.channelId}/messages`, 'POST', {
          ...guard(view),
          intentId: randomUUID(),
          text,
        })
      ).status,
    ).toBe(200);
  const versions = projectRoomVersionSource(h.service);
  const as = (who: 'alice' | 'bob') =>
    new Request('http://localhost', {
      headers: { authorization: `Bearer ${who}-session` },
    });
  expect(
    await versions.latest(
      { projectSlug: 'example', roomId: design.channelId },
      as('bob'),
    ),
  ).toEqual({ key: `project-room:${design.channelId}`, latestVersion: 2 });
  // #general keeps its own key and version.
  expect(
    await versions.latest(
      { projectSlug: 'example', roomId: general.roomId },
      as('bob'),
    ),
  ).toEqual({ key: `project-room:${general.roomId}`, latestVersion: 0 });
  // A room id that is not one of this Project's channels stays unavailable.
  expect(
    await versions.latest(
      { projectSlug: 'example', roomId: randomUUID() },
      as('bob'),
    ),
  ).toBeUndefined();
});

test('read markers: a reaction, an edit and a delete in a named channel leave its read version where it was (#4796, #4797)', async () => {
  const h = await harness();
  const design = parseProjectRoomChannel(
    await data(await createChannel(h, 'alice', 'design')),
  );
  const view = parseProjectRoomBrowserView(
    await data(await api(h, 'alice', `/channels/${design.channelId}`)),
  );
  const channel = `/channels/${design.channelId}`;
  const posted = parseProjectRoomMessage(
    await data(
      await api(h, 'alice', `${channel}/messages`, 'POST', {
        ...guard(view),
        intentId: randomUUID(),
        text: 'Draft one',
      }),
    ),
  );
  const versions = projectRoomVersionSource(h.service);
  const asAlice = new Request('http://localhost', {
    headers: { authorization: 'Bearer alice-session' },
  });
  const latest = () =>
    versions.latest(
      { projectSlug: 'example', roomId: design.channelId },
      asAlice,
    );
  expect(await latest()).toEqual({
    key: `project-room:${design.channelId}`,
    latestVersion: 1,
  });
  const target = `${channel}/messages/${posted.messageId}`;
  for (const [leaf, body] of [
    ['reactions', { emoji: '👀', reacted: true }],
    ['edit', { intentId: randomUUID(), text: 'Draft two' }],
    ['delete', { intentId: randomUUID() }],
  ] as const) {
    const response = await api(h, 'alice', `${target}/${leaf}`, 'POST', {
      ...guard(view),
      ...body,
    });
    expect(response.status, leaf).toBe(200);
    expect(await latest(), leaf).toEqual({
      key: `project-room:${design.channelId}`,
      latestVersion: 1,
    });
  }
});

/** Where alice's files in the default room live, and how to read them. */
async function aliceFiles(h: Awaited<ReturnType<typeof harness>>) {
  const { existsSync, readdirSync, readFileSync } = await import('node:fs');
  const a = await h.discover('alice');
  const root = join(h.home, 'project-room-attachments');
  const binding = [
    h.scope.stationId,
    h.scope.localProjectId,
    h.scope.portableProjectId,
    a.roomId,
    a.actor.kind,
    a.actor.id,
  ];
  const directory = () => {
    const bindings = join(root, 'bindings');
    const [key] = existsSync(bindings) ? readdirSync(bindings) : [];
    return key ? join(bindings, key) : undefined;
  };
  const blobOf = (id: string) => {
    const { blobRef } = JSON.parse(
      readFileSync(join(directory()!, `${id}.json`), 'utf8'),
    ) as { blobRef: string };
    const digest = blobRef.slice('sha256-'.length);
    return join(root, 'blobs', digest.slice(0, 2), digest);
  };
  const upload = async (...files: Record<string, unknown>[]) => {
    const response = await h.request('alice', '/attachments', 'POST', {
      ...guard(a),
      attachments: files,
    });
    return response.status === 200
      ? ((await data(response)) as { id: string }[])
      : response.status;
  };
  const send = async (attachments: unknown[]) =>
    parseProjectRoomMessage(
      await data(
        await h.request('alice', '/messages', 'POST', {
          ...guard(a),
          intentId: randomUUID(),
          text: '',
          attachments,
        }),
      ),
    );
  const remove = async (messageId: string) =>
    (
      await h.request('alice', `/messages/${messageId}/delete`, 'POST', {
        ...guard(a),
        intentId: randomUUID(),
      })
    ).status;
  return { a, root, binding, directory, blobOf, upload, send, remove };
}

test('message files: deleting a message removes its files from disk, and shared bytes stay while another file names them (#4812)', async () => {
  const { existsSync } = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  // The same bytes twice: two files, one deduplicated blob.
  const [first, second] = (await f.upload(png('one.png'), png('two.png'))) as {
    id: string;
  }[];
  const blob = f.blobOf(first!.id);
  expect(f.blobOf(second!.id)).toBe(blob);
  const one = await f.send([first]);
  const two = await f.send([second]);
  expect(await f.remove(one.messageId)).toBe(200);
  expect(existsSync(join(f.directory()!, `${first!.id}.json`))).toBe(false);
  // The other message still names the bytes, so they stay readable.
  expect(existsSync(blob)).toBe(true);
  expect((await h.request('bob', `/attachments/${second!.id}`)).status).toBe(
    200,
  );
  expect(await f.remove(two.messageId)).toBe(200);
  expect(existsSync(join(f.directory()!, `${second!.id}.json`))).toBe(false);
  expect(existsSync(blob)).toBe(false);
  // A repeated delete (the same message again) changes nothing and still answers.
  expect(await f.remove(two.messageId)).toBe(200);
});

test('message files: a full quota recovers from deleted messages and old unsent uploads, but keeps sent files and recent uploads (#4812)', async () => {
  const { existsSync, readdirSync, utimesSync } = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const [kept] = (await f.upload(png('kept.png'))) as { id: string }[];
  await f.send([kept]);
  const [gone] = (await f.upload(png('gone.png'))) as { id: string }[];
  const deleted = await f.send([gone]);
  const [recent] = (await f.upload(png('recent.png'))) as { id: string }[];
  // Fill the binding to its 1280 files with uploads no message names.
  const bytes = new RoomAttachments(f.root, 'room');
  const unsent = Array.from(
    { length: 1280 - 3 },
    () =>
      bytes.store(f.binding, [
        png() as Parameters<RoomAttachments['store']>[1][number],
      ])[0]!.id,
  );
  expect(await f.upload(png('over.png'))).toBe(400);
  // Deleting a message frees its file's place at once.
  expect(await f.remove(deleted.messageId)).toBe(200);
  const [freed] = (await f.upload(png('freed.png'))) as { id: string }[];
  expect(freed).toBeTruthy();
  expect(await f.upload(png('full-again.png'))).toBe(400);
  // Unsent uploads older than a day are released by the next upload. The
  // sent file is made as old, to show it stays for its message, not its age.
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  for (const id of [...unsent, kept!.id])
    utimesSync(join(f.directory()!, `${id}.json`), old, old);
  const [after] = (await f.upload(png('after.png'))) as { id: string }[];
  expect(after).toBeTruthy();
  expect(readdirSync(f.directory()!).sort()).toEqual(
    [kept!.id, recent!.id, freed!.id, after!.id]
      .map((id) => `${id}.json`)
      .sort(),
  );
  expect((await h.request('bob', `/attachments/${kept!.id}`)).status).toBe(200);
  // The recent unsent upload is still there to send.
  await f.send([recent]);
  expect(existsSync(f.blobOf(recent!.id))).toBe(true);
});

test('message files: bytes that are not the declared image are refused (#4812)', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const declared = (bytes: Buffer, mimeType = 'image/png') => ({
    kind: 'image',
    name: 'claimed.png',
    mimeType,
    size: bytes.length,
    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
  });
  const upload = async (file: Record<string, unknown>) =>
    (
      await h.request('alice', '/attachments', 'POST', {
        ...guard(a),
        attachments: [file],
      })
    ).status;
  expect(await upload(declared(Buffer.from('<html>not a PNG</html>')))).toBe(
    400,
  );
  // A real image of another type is refused under the wrong name too.
  expect(await upload(declared(Buffer.from('GIF89a\x01\x00\x01\x00')))).toBe(
    400,
  );
  // The control: the same route takes a real PNG.
  expect(await upload(declared(PNG))).toBe(200);
});

test('viewers cannot react, edit, delete or upload, and a file is read only through its own channel', async () => {
  const h = await harness('viewer');
  const a = await h.discover('alice');
  const b = await h.discover('bob');
  const files = await data(
    await h.request('alice', '/attachments', 'POST', {
      ...guard(a),
      attachments: [png()],
    }),
  );
  const message = parseProjectRoomMessage(
    await data(
      await h.request('alice', '/messages', 'POST', {
        ...guard(a),
        intentId: randomUUID(),
        text: 'owner',
        attachments: files,
      }),
    ),
  );
  for (const [leaf, extra] of [
    ['reactions', { emoji: '👍', reacted: true }],
    ['edit', { intentId: randomUUID(), text: 'mine' }],
    ['delete', { intentId: randomUUID() }],
  ] as const)
    expect(
      (
        await h.request(
          'bob',
          `/messages/${message.messageId}/${leaf}`,
          'POST',
          { ...guard(b), ...extra },
        )
      ).status,
    ).toBe(403);
  expect(
    (
      await h.request('bob', '/attachments', 'POST', {
        ...guard(b),
        attachments: [png()],
      })
    ).status,
  ).toBe(403);
  const channel = h.runtime.store.createChannel(
    h.scope,
    { name: 'other' },
    () => {},
  );
  const fileId = message.attachments![0]!.id;
  const read = await h.app.request(
    `/api/projects/example/channels/${channel.channelId}/attachments/${fileId}`,
    { headers: { authorization: 'Bearer bob-session' } },
  );
  expect(read.status).toBe(404);
  const original = await h.request('bob', `/attachments/${fileId}`);
  expect(original.status).toBe(200);
});
