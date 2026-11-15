import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  PROJECT_ROOM_FILES_UNAVAILABLE_CODE,
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
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
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
import {
  ProjectRoomAttachments,
  ProjectRoomFilesUnavailable,
  RoomAttachments,
} from '../../services/projects/task-room-attachments.js';
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
    new ProjectRoomAttachments(join(home, 'project-room-attachments')),
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

test('message files: deleting a message releases its files, and its bytes go only once no other file names them (#4812)', async () => {
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
  // The other message's file is untouched and still reads.
  expect(existsSync(blob)).toBe(true);
  expect((await h.request('bob', `/attachments/${second!.id}`)).status).toBe(
    200,
  );
  expect(await f.remove(two.messageId)).toBe(200);
  expect(existsSync(join(f.directory()!, `${second!.id}.json`))).toBe(false);
  // No file names the bytes any more, so the release reclaimed them.
  expect(existsSync(blob)).toBe(false);
  // A repeated delete (the same message again) changes nothing and still answers.
  expect(await f.remove(two.messageId)).toBe(200);
});

/** Bytes other than `PNG` that are still a PNG, so each upload is a new blob. */
const pngVariant = (name: string, tail: string) => {
  const bytes = Buffer.concat([PNG, Buffer.from(tail)]);
  return {
    ...png(name),
    size: bytes.length,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  };
};

test('message files: a standing message keeps its file past the age the byte store would once have evicted (#4852)', async () => {
  const { utimesSync, existsSync } = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const [file] = (await f.upload(png('standing.png'))) as { id: string }[];
  await f.send([file]);
  const blob = f.blobOf(file!.id);
  // 91 days old, and a day later so any once-a-day sweep runs on this upload.
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
  utimesSync(blob, old, old);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
  expect(Array.isArray(await f.upload(pngVariant('next.png', 'next')))).toBe(
    true,
  );
  expect(existsSync(blob)).toBe(true);
  const read = await h.request('bob', `/attachments/${file!.id}`);
  expect(read.status).toBe(200);
  expect(Buffer.from(await read.arrayBuffer())).toEqual(PNG);
});

test('message files: a standing message keeps its file past a byte cap the store would once have enforced (#4852)', async () => {
  const { existsSync } = await import('node:fs');
  vi.stubEnv('STATION_ATTACHMENT_MAX_BYTES', String(PNG.length));
  try {
    const h = await harness();
    const f = await aliceFiles(h);
    const [file] = (await f.upload(png('standing.png'))) as { id: string }[];
    await f.send([file]);
    const blob = f.blobOf(file!.id);
    const now = Date.now();
    expect(
      Array.isArray(await f.upload(pngVariant('second.png', 'second'))),
    ).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000);
    expect(
      Array.isArray(await f.upload(pngVariant('third.png', 'third'))),
    ).toBe(true);
    expect(existsSync(blob)).toBe(true);
    expect((await h.request('bob', `/attachments/${file!.id}`)).status).toBe(
      200,
    );
  } finally {
    vi.unstubAllEnvs();
  }
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
  const bytes = new RoomAttachments(f.root, 'room', { retention: false });
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

/** A fixture file typed as the byte store's input. */
const asInput = (file: ReturnType<typeof png>) =>
  file as Parameters<RoomAttachments['store']>[1][number];
/** The store's own tuple-to-directory mapping, so a test never guesses. */
async function bindingDirectory(root: string, binding: readonly string[]) {
  const { createHash } = await import('node:crypto');
  return join(
    root,
    'bindings',
    createHash('sha256').update(JSON.stringify(binding)).digest('hex'),
  );
}
async function blobCount(root: string) {
  const { existsSync, readdirSync } = await import('node:fs');
  const blobs = join(root, 'blobs');
  return existsSync(blobs)
    ? readdirSync(blobs).flatMap((prefix) => readdirSync(join(blobs, prefix)))
        .length
    : 0;
}
/** One of bob's uploads, whose record a test then damages. */
async function bobsRecord(
  h: Awaited<ReturnType<typeof harness>>,
  f: Awaited<ReturnType<typeof aliceFiles>>,
) {
  const b = await h.discover('bob');
  const [file] = (await data(
    await h.request('bob', '/attachments', 'POST', {
      ...guard(b),
      attachments: [png('interrupted.png')],
    }),
  )) as { id: string }[];
  const directory = await bindingDirectory(f.root, [
    ...f.binding.slice(0, -1),
    b.actor.id,
  ]);
  return { file: file!, path: join(directory, `${file!.id}.json`) };
}
/** Alice's file's blob path, through her computed binding directory. */
async function aliceBlob(
  f: Awaited<ReturnType<typeof aliceFiles>>,
  id: string,
) {
  const { readFileSync } = await import('node:fs');
  const directory = await bindingDirectory(f.root, f.binding);
  const { blobRef } = JSON.parse(
    readFileSync(join(directory, `${id}.json`), 'utf8'),
  ) as { blobRef: string };
  const digest = blobRef.slice('sha256-'.length);
  return join(f.root, 'blobs', digest.slice(0, 2), digest);
}
const unavailable = async (response: Response) => {
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: PROJECT_ROOM_FILES_UNAVAILABLE_CODE },
  });
};

test('message files: a record whose reference is unknown stops reclamation and new uploads, and only that (#4852)', async () => {
  const { existsSync, readFileSync, writeFileSync, rmSync } = await import(
    'node:fs'
  );
  const h = await harness();
  const f = await aliceFiles(h);
  // A standing message keeps its file throughout.
  const [kept] = (await f.upload(pngVariant('kept.png', 'kept'))) as {
    id: string;
  }[];
  await f.send([kept]);
  const damaged = await bobsRecord(h, f);
  const blobsBefore = await blobCount(f.root);
  const [gone] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
    id: string;
  }[];
  const deleted = await f.send([gone]);
  // Uploads re-check the store, so the damage happens after this upload.
  writeFileSync(damaged.path, '{');
  // The delete commits; its release cannot prove references, so it deletes
  // nothing and keeps the released record.
  expect(await f.remove(deleted.messageId)).toBe(200);
  const aliceDirectory = await bindingDirectory(f.root, f.binding);
  expect(existsSync(join(aliceDirectory, `${gone!.id}.json`))).toBe(true);
  expect(await blobCount(f.root)).toBe(blobsBefore + 1);
  expect(readFileSync(damaged.path, 'utf8')).toBe('{');
  const marker = join(f.root, 'reclamation-blocked.json');
  expect(
    (
      JSON.parse(readFileSync(marker, 'utf8')) as {
        records: { path: string }[];
      }
    ).records[0]!.path,
  ).toBe(damaged.path);
  // New attachments are refused; text, reads and downloads keep working.
  await unavailable(
    await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [pngVariant('more.png', 'more')],
    }),
  );
  expect(await blobCount(f.root)).toBe(blobsBefore + 1);
  const text = await h.request('alice', '/messages', 'POST', {
    ...guard(f.a),
    intentId: randomUUID(),
    text: 'Text still sends.',
  });
  expect(text.status).toBe(200);
  expect((await h.request('bob', `/attachments/${kept!.id}`)).status).toBe(200);
  // The operator removes the damaged record: the next upload re-checks,
  // clears the block, and the kept release is reclaimed by its sweep.
  rmSync(damaged.path);
  const [after] = (await f.upload(pngVariant('after.png', 'after'))) as {
    id: string;
  }[];
  expect(after).toBeTruthy();
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(aliceDirectory, `${gone!.id}.json`))).toBe(false);
  expect((await h.request('bob', `/attachments/${kept!.id}`)).status).toBe(200);
});

test('message files: one damaged record cannot turn upload-delete cycles into unbounded bytes (#4852 review, six cycles)', async () => {
  const { writeFileSync } = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  writeFileSync(damaged.path, '{');
  const statuses: (number | string)[] = [];
  for (let n = 0; n < 6; n++) {
    const uploaded = await f.upload(
      pngVariant(`cycle-${n}.png`, `distinct-${n}`),
    );
    if (!Array.isArray(uploaded)) {
      statuses.push(uploaded);
      continue;
    }
    statuses.push('stored');
    const message = await f.send([uploaded[0]]);
    expect(await f.remove(message.messageId)).toBe(200);
  }
  // Every upload re-checks the store and finds the damaged record, so none
  // is admitted: only bob's interrupted upload is on disk (round 4 admitted
  // the first cycle before a release found the damage, so it kept 2).
  expect(statuses).toEqual([503, 503, 503, 503, 503, 503]);
  expect(await blobCount(f.root)).toBe(1);
});

test('message files: a damaged record whose reference is recoverable keeps its bytes, and other files still reclaim (#4852)', async () => {
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const { blobRef } = JSON.parse(readFileSync(damaged.path, 'utf8')) as {
    blobRef: string;
  };
  const digest = blobRef.slice('sha256-'.length);
  const bobsBlob = join(f.root, 'blobs', digest.slice(0, 2), digest);
  // Torn after the reference: unparseable, but the reference is there.
  writeFileSync(damaged.path, `{"blobRef":"${blobRef}","attachment":{"na`);
  // Alice deletes a message that names the same bytes, and another with
  // bytes nothing else names.
  const [same] = (await f.upload(png('interrupted.png'))) as { id: string }[];
  const [own] = (await f.upload(pngVariant('own.png', 'own'))) as {
    id: string;
  }[];
  const ownBlob = await aliceBlob(f, own!.id);
  expect(await aliceBlob(f, same!.id)).toBe(bobsBlob);
  expect(await f.remove((await f.send([same])).messageId)).toBe(200);
  expect(await f.remove((await f.send([own])).messageId)).toBe(200);
  expect(existsSync(bobsBlob)).toBe(true);
  expect(existsSync(ownBlob)).toBe(false);
  expect(existsSync(join(f.root, 'reclamation-blocked.json'))).toBe(false);
  expect(Array.isArray(await f.upload(pngVariant('next.png', 'next')))).toBe(
    true,
  );
});

test('message files: a record that cannot be read at all (EISDIR) fails closed (#4852)', async () => {
  const { mkdirSync, rmSync, existsSync } = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const [gone] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
    id: string;
  }[];
  const sent = await f.send([gone]);
  // Uploads re-check the store, so the damage happens after this upload.
  rmSync(damaged.path);
  mkdirSync(damaged.path);
  const blob = await aliceBlob(f, gone!.id);
  expect(await f.remove(sent.messageId)).toBe(200);
  expect(existsSync(blob)).toBe(true);
  await unavailable(
    await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [pngVariant('more.png', 'more')],
    }),
  );
});

test.skipIf(process.getuid?.() === 0)(
  'message files: a record the Station may not read (EACCES) fails closed, and recovers once readable (#4852)',
  async () => {
    const { chmodSync, existsSync } = await import('node:fs');
    const h = await harness();
    const f = await aliceFiles(h);
    const damaged = await bobsRecord(h, f);
    const [gone] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
      id: string;
    }[];
    const sent = await f.send([gone]);
    // Uploads re-check the store, so the damage happens after this upload.
    chmodSync(damaged.path, 0o000);
    try {
      const blob = await aliceBlob(f, gone!.id);
      expect(await f.remove(sent.messageId)).toBe(200);
      expect(existsSync(blob)).toBe(true);
      await unavailable(
        await h.request('alice', '/attachments', 'POST', {
          ...guard(f.a),
          attachments: [pngVariant('more.png', 'more')],
        }),
      );
      chmodSync(damaged.path, 0o600);
      expect(
        Array.isArray(await f.upload(pngVariant('after.png', 'after'))),
      ).toBe(true);
      expect(existsSync(blob)).toBe(false);
    } finally {
      chmodSync(damaged.path, 0o600);
    }
  },
);

test('message files: deduplicated bytes survive a different uploader and deleted file stays private', async () => {
  const h = await harness();
  const f = await aliceFiles(h);
  const [aliceFile] = (await f.upload(png('alice.png'))) as { id: string }[];
  const a = await f.send([aliceFile]);
  const bob = await h.discover('bob');
  const [bobFile] = (await data(
    await h.request('bob', '/attachments', 'POST', {
      ...guard(bob),
      attachments: [png('bob.png')],
    }),
  )) as { id: string }[];
  const b = parseProjectRoomMessage(
    await data(
      await h.request('bob', '/messages', 'POST', {
        ...guard(bob),
        intentId: randomUUID(),
        text: 'bob',
        attachments: [bobFile],
      }),
    ),
  );
  expect(await f.remove(a.messageId)).toBe(200);
  expect((await h.request('bob', `/attachments/${bobFile!.id}`)).status).toBe(
    200,
  );
  expect(
    Buffer.from(
      await (
        await h.request('alice', `/attachments/${bobFile!.id}`)
      ).arrayBuffer(),
    ),
  ).toEqual(PNG);
  for (const who of ['alice', 'bob'] as const)
    expect((await h.request(who, `/attachments/${aliceFile!.id}`)).status).toBe(
      404,
    );
  expect(
    (
      await h.request('bob', `/messages/${b.messageId}/delete`, 'POST', {
        ...guard(bob),
        intentId: randomUUID(),
      })
    ).status,
  ).toBe(200);
  expect((await h.request('alice', `/attachments/${bobFile!.id}`)).status).toBe(
    404,
  );
});

test('message files: deletion with cleanup suppressed still refuses both downloaders', async () => {
  const h = await harness();
  const f = await aliceFiles(h);
  const [file] = (await f.upload(png('private.png'))) as { id: string }[];
  const sent = await f.send([file]);
  vi.spyOn(ProjectRoomAttachments.prototype, 'release').mockImplementation(
    () => 'reclaimed',
  );
  expect(await f.remove(sent.messageId)).toBe(200);
  const { existsSync } = await import('node:fs');
  expect(existsSync(f.blobOf(file!.id))).toBe(true);
  for (const who of ['alice', 'bob'] as const)
    expect((await h.request(who, `/attachments/${file!.id}`)).status).toBe(404);
});

test('message files: Task retention and Project reclamation stay in separate roots', async () => {
  const { TaskRoomAttachments } = await import(
    '../../services/projects/task-room-attachments.js'
  );
  const { utimesSync } = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const [file] = (await f.upload(png('project.png'))) as { id: string }[];
  const sent = await f.send([file]);
  const task = new TaskRoomAttachments(join(h.home, 'task-room-attachments'));
  const scope = {
    projectId: 'task-project',
    taskId: 'task',
    taskCreatedAt: 'now',
  };
  const [taskFile] = task.store(scope, [asInput(png('task.png'))]);
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
  utimesSync(f.blobOf(file!.id), old, old);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
  task.store(scope, [asInput(pngVariant('different.png', 'different'))]);
  expect((await h.request('bob', `/attachments/${file!.id}`)).status).toBe(200);
  expect(await f.remove(sent.messageId)).toBe(200);
  expect(task.read(scope, taskFile!.id)?.bytes).toEqual(PNG);
});

test('message files: next route upload clears a repaired persisted block with no stale files to release, per store', async () => {
  const { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } =
    await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const good = readFileSync(damaged.path, 'utf8');
  writeFileSync(damaged.path, '{');
  const restarted = new ProjectRoomAttachments(f.root);
  expect(
    await restarted.locked(() =>
      restarted.release(['no-files'], [randomUUID()]),
    ),
  ).toBe('blocked');
  const marker = join(f.root, 'reclamation-blocked.json');
  expect(existsSync(marker)).toBe(true);
  const anotherRestart = new ProjectRoomAttachments(f.root);
  await expect(
    anotherRestart.locked(() =>
      anotherRestart.store(['no-files'], [asInput(png('blocked.png'))]),
    ),
  ).rejects.toThrow('unavailable');
  const other = new ProjectRoomAttachments(join(h.home, 'independent-store'));
  expect(
    await other.locked(() =>
      other.store(['other'], [asInput(png('allowed.png'))]),
    ),
  ).toHaveLength(1);
  const aliceDir = await bindingDirectory(f.root, f.binding);
  expect(existsSync(aliceDir) ? readdirSync(aliceDir) : []).toHaveLength(0);
  writeFileSync(damaged.path, good);
  // This uploader has never uploaded: sweep has no ids and cannot clear anything.
  expect(
    Array.isArray(await f.upload(pngVariant('recovered.png', 'recovered'))),
  ).toBe(true);
  expect(existsSync(marker)).toBe(false);
  // Repeat removal recovery, still using a new binding without any release.
  writeFileSync(damaged.path, '{');
  expect(
    await restarted.locked(() =>
      restarted.release(['empty-again'], [randomUUID()]),
    ),
  ).toBe('blocked');
  rmSync(damaged.path);
  expect(
    await anotherRestart.locked(() =>
      anotherRestart.store(['empty-again'], [asInput(png('after-remove.png'))]),
    ),
  ).toHaveLength(1);
  expect(existsSync(marker)).toBe(false);
});

test('message files: a 24h unsent sweep preserves all records and bytes on unknown references', async () => {
  const { writeFileSync, utimesSync, existsSync, readdirSync } = await import(
    'node:fs'
  );
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const [unsent] = (await f.upload(pngVariant('old.png', 'old'))) as {
    id: string;
  }[];
  const blob = await aliceBlob(f, unsent!.id);
  const dir = await bindingDirectory(f.root, f.binding);
  const path = join(dir, `${unsent!.id}.json`);
  const old = new Date(Date.now() - 25 * 3600000);
  utimesSync(path, old, old);
  writeFileSync(damaged.path, '{');
  await unavailable(
    await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [pngVariant('next.png', 'next')],
    }),
  );
  expect(existsSync(path)).toBe(true);
  expect(existsSync(blob)).toBe(true);
  expect(readdirSync(dir)).toHaveLength(1);
  expect(await blobCount(f.root)).toBe(2);
});

test.each(['ambiguous', 'short', 'overlong'])(
  'message files: a damaged reference (%s) is unknown, so nothing is deleted and uploads pause (#4852 review)',
  async (kind) => {
    const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
    const h = await harness();
    const f = await aliceFiles(h);
    const damaged = await bobsRecord(h, f);
    const { blobRef } = JSON.parse(readFileSync(damaged.path, 'utf8')) as {
      blobRef: string;
    };
    const [shared] = (await f.upload(png('same.png'))) as { id: string }[];
    const sharedBlob = await aliceBlob(f, shared!.id);
    const [distinct] = (await f.upload(
      pngVariant('distinct.png', 'distinct'),
    )) as { id: string }[];
    const distinctBlob = await aliceBlob(f, distinct!.id);
    const ref =
      kind === 'short'
        ? blobRef.slice(0, -1)
        : kind === 'overlong'
          ? `${blobRef}0`
          : `${blobRef} and sha256-${'b'.repeat(64)}`;
    writeFileSync(damaged.path, `{"blobRef":"${ref}","broken":`);
    expect(await f.remove((await f.send([shared])).messageId)).toBe(200);
    expect(existsSync(sharedBlob)).toBe(true);
    expect(await f.remove((await f.send([distinct])).messageId)).toBe(200);
    // Only a fully determined reference counts: a truncated, over-long or
    // second hash leaves the record unknown, so even unrelated bytes stay.
    expect(existsSync(distinctBlob)).toBe(true);
    expect(existsSync(damaged.path)).toBe(true);
    await unavailable(
      await h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [pngVariant('refused.png', 'refused')],
      }),
    );
  },
);

test.skipIf(process.getuid?.() === 0)(
  'message files: when the block cannot be written down, the next upload and a restarted store still refuse (#4852 review)',
  async () => {
    const { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } =
      await import('node:fs');
    const h = await harness();
    const f = await aliceFiles(h);
    const damaged = await bobsRecord(h, f);
    const [gone] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
      id: string;
    }[];
    const blob = await aliceBlob(f, gone!.id);
    const message = await f.send([gone]);
    // Uploads re-check the store, so the damage happens after this upload.
    writeFileSync(damaged.path, '{');
    // Nothing can be written into the store's staging directory now, so the
    // block marker cannot be published.
    const staging = join(f.root, 'staging');
    mkdirSync(staging, { recursive: true });
    chmodSync(staging, 0o500);
    try {
      expect(await f.remove(message.messageId)).toBe(200);
      expect(existsSync(blob)).toBe(true);
      expect(existsSync(join(f.root, 'reclamation-blocked.json'))).toBe(false);
      await unavailable(
        await h.request('alice', '/attachments', 'POST', {
          ...guard(f.a),
          attachments: [pngVariant('next.png', 'next')],
        }),
      );
      // A store with no memory of the block (a restarted Station) refuses on
      // its first upload too.
      const restarted = new ProjectRoomAttachments(f.root);
      await expect(
        restarted.locked(() =>
          restarted.store(f.binding, [
            asInput(pngVariant('fresh.png', 'fresh')),
          ]),
        ),
      ).rejects.toBeInstanceOf(ProjectRoomFilesUnavailable);
    } finally {
      chmodSync(staging, 0o700);
    }
    // Repaired (the record removed): uploads resume and the kept release is
    // reclaimed.
    rmSync(damaged.path);
    expect(
      Array.isArray(await f.upload(pngVariant('after.png', 'after'))),
    ).toBe(true);
    expect(existsSync(blob)).toBe(false);
  },
);

test.skipIf(process.getuid?.() === 0)(
  'message files: unlink failure must not discard release accounting and all retry custody',
  async () => {
    const { chmodSync, existsSync, readdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const h = await harness();
    const f = await aliceFiles(h);
    const [file] = (await f.upload(pngVariant('retained.png', 'retained'))) as {
      id: string;
    }[];
    const blob = await aliceBlob(f, file!.id);
    const dir = dirname(blob);
    chmodSync(dir, 0o500);
    try {
      expect(await f.remove((await f.send([file])).messageId)).toBe(200);
      expect(existsSync(blob)).toBe(true);
      const bindings = readdirSync(await bindingDirectory(f.root, f.binding));
      console.log(
        'R4_UNLINK_FAILURE',
        JSON.stringify({
          bindings: bindings.length,
          blobs: await blobCount(f.root),
        }),
      );
      expect(bindings).toHaveLength(1);
    } finally {
      chmodSync(dir, 0o700);
    }
  },
);

test('message files: lock timeout is an unavailable response, no mutation, then next upload succeeds', async () => {
  const { mkdirSync, existsSync } = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  mkdirSync(f.root, { recursive: true });
  const unlock = await acquireFileMutationLockAsync(join(f.root, 'store.lock'));
  try {
    const started = Date.now();
    const response = await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('late.png')],
    });
    console.log(
      'R4_LOCK_TIMEOUT',
      JSON.stringify({
        status: response.status,
        durationMs: Date.now() - started,
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'project_room_unavailable' },
    });
    expect(existsSync(join(f.root, 'bindings'))).toBe(false);
  } finally {
    await unlock();
  }
  expect(Array.isArray(await f.upload(png('after.png')))).toBe(true);
}, 20000);

test.skipIf(process.getuid?.() === 0)(
  'message files: unreadable binding directory blocks all release and admission',
  async () => {
    const { chmodSync, existsSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const h = await harness();
    const f = await aliceFiles(h);
    const damaged = await bobsRecord(h, f);
    const [gone] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
      id: string;
    }[];
    const blob = await aliceBlob(f, gone!.id);
    chmodSync(dirname(damaged.path), 0o000);
    try {
      expect(await f.remove((await f.send([gone])).messageId)).toBe(200);
      expect(existsSync(blob)).toBe(true);
      await unavailable(
        await h.request('alice', '/attachments', 'POST', {
          ...guard(f.a),
          attachments: [png('refused.png')],
        }),
      );
    } finally {
      chmodSync(dirname(damaged.path), 0o700);
    }
  },
);

test('message files: EIO reading a record blocks reclamation without deleting any bytes', async () => {
  const fs = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const [gone] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
    id: string;
  }[];
  const blob = await aliceBlob(f, gone!.id);
  const read = fs.readFileSync;
  const spy = vi
    .spyOn(fs.default, 'readFileSync')
    .mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === damaged.path)
        throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
      return Reflect.apply(read, fs, args);
    });
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
  try {
    expect(await f.remove((await f.send([gone])).messageId)).toBe(200);
    expect(fs.existsSync(blob)).toBe(true);
    expect(
      JSON.parse(read(join(f.root, 'reclamation-blocked.json'), 'utf8'))
        .records,
    ).toContainEqual({ path: damaged.path, reason: 'EIO' });
    await unavailable(
      await h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [png('refused.png')],
      }),
    );
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

/** Where a corrected record goes: `repair/` at its `bindings/` path. */
function repairPath(root: string, recordPath: string) {
  return recordPath.replace(join(root, 'bindings'), join(root, 'repair'));
}

/**
 * What a repair name holds for the operator: its own bytes and those of every
 * claim Station made of it (a pass claims an entry by renaming it beside
 * itself, so bytes an operator wrote survive under a claimed name).
 */
const repairBytes = async (path: string) => {
  const fs = await import('node:fs');
  const { basename, dirname } = await import('node:path');
  const names = fs.existsSync(dirname(path))
    ? fs
        .readdirSync(dirname(path))
        .filter(
          (name) =>
            name === basename(path) ||
            name.startsWith(`${basename(path)}.claimed-`),
        )
    : [];
  return names.map((name) =>
    fs.readFileSync(join(dirname(path), name), 'utf8'),
  );
};
const claimedNames = async (directory: string) => {
  const fs = await import('node:fs');
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.includes('.claimed-'))
    : [];
};

test('message files: a repair waits for the store lock, then replaces the damaged record and clears the block (#4852 review)', async () => {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import(
    'node:fs'
  );
  const { dirname } = await import('node:path');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const intact = readFileSync(damaged.path, 'utf8');
  const [gone] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
    id: string;
  }[];
  const sent = await f.send([gone]);
  // Uploads re-check the store, so the damage happens after this upload.
  writeFileSync(damaged.path, '{');
  // Blocked: a release finds the damaged record.
  expect(await f.remove(sent.messageId)).toBe(200);
  await unavailable(
    await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [pngVariant('refused.png', 'refused')],
    }),
  );
  // The operator writes the corrected record into repair/ while another
  // holder (as another process would) has the store lock.
  const unlock = await acquireFileMutationLockAsync(join(f.root, 'store.lock'));
  const repaired = repairPath(f.root, damaged.path);
  mkdirSync(dirname(repaired), { recursive: true });
  writeFileSync(repaired, intact);
  let settled = false;
  const upload = Promise.resolve(
    h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [pngVariant('after.png', 'after')],
    }),
  ).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Nothing applied it without the lock.
  expect(settled).toBe(false);
  expect(existsSync(repaired)).toBe(true);
  expect(readFileSync(damaged.path, 'utf8')).toBe('{');
  await unlock();
  expect((await upload).status).toBe(200);
  expect(existsSync(repaired)).toBe(false);
  expect(readFileSync(damaged.path, 'utf8')).toBe(intact);
  expect(existsSync(join(f.root, 'reclamation-blocked.json'))).toBe(false);
});

test('message files: a repair written while a release scans cannot cost its bytes, because the damaged record still blocks (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const intact = fs.readFileSync(damaged.path, 'utf8');
  // Alice sends and deletes the same bytes Bob's record names.
  const [same] = (await f.upload(png('interrupted.png'))) as { id: string }[];
  const blob = await aliceBlob(f, same!.id);
  const sent = await f.send([same]);
  // Uploads re-check the store, so the damage happens after this upload.
  fs.writeFileSync(damaged.path, '{');
  const repaired = repairPath(f.root, damaged.path);
  const list = fs.readdirSync;
  let written = false;
  const spy = vi
    .spyOn(fs.default, 'readdirSync')
    .mockImplementation((...args: Parameters<typeof fs.readdirSync>) => {
      const entries = Reflect.apply(list, fs, args);
      if (args[0] === dirname(damaged.path) && !written) {
        // The operator writes the corrected record after this listing.
        fs.mkdirSync(dirname(repaired), { recursive: true });
        fs.writeFileSync(repaired, intact);
        written = true;
      }
      return entries;
    });
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
  try {
    expect(await f.remove(sent.messageId)).toBe(200);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(written).toBe(true);
  expect(fs.existsSync(blob)).toBe(true);
  // The next upload applies the repair under the lock and resumes.
  expect(Array.isArray(await f.upload(pngVariant('after.png', 'after')))).toBe(
    true,
  );
  expect(fs.readFileSync(damaged.path, 'utf8')).toBe(intact);
  expect(fs.existsSync(blob)).toBe(true);
});

test('message files: actual membership revocation while waiting denies the upload and releases its lock', async () => {
  const { mkdirSync, readdirSync, existsSync } = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const bob = await h.discover('bob');
  mkdirSync(f.root, { recursive: true });
  const unlock = await acquireFileMutationLockAsync(join(f.root, 'store.lock'));
  let settled = false;
  const pending = Promise.resolve(
    h.request('bob', '/attachments', 'POST', {
      ...guard(bob),
      attachments: [png('revoked.png')],
    }),
  ).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(settled).toBe(false);
  h.revokeMember();
  await unlock();
  expect((await pending).status).toBe(403);
  const bindings = join(f.root, 'bindings');
  expect(
    existsSync(bindings)
      ? readdirSync(bindings).flatMap((k) => readdirSync(join(bindings, k)))
      : [],
  ).toEqual([]);
  expect(Array.isArray(await f.upload(png('still-allowed.png')))).toBe(true);
});

test('message files: one recovered hash cannot make a second truncated reference known', async () => {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const { blobRef } = JSON.parse(readFileSync(damaged.path, 'utf8')) as {
    blobRef: string;
  };
  const [same] = (await f.upload(png('same.png'))) as { id: string }[];
  const blob = await aliceBlob(f, same!.id);
  const sent = await f.send([same]);
  writeFileSync(
    damaged.path,
    `{"blobRef":"${blobRef.slice(0, -1)}","other":"sha256-${'b'.repeat(64)}","attachment":`,
  );
  expect(await f.remove(sent.messageId)).toBe(200);
  expect(existsSync(damaged.path)).toBe(true);
  console.log(
    'R4_MIXED_REFERENCE',
    JSON.stringify({
      blobExists: existsSync(blob),
      markerExists: existsSync(join(f.root, 'reclamation-blocked.json')),
    }),
  );
  expect(existsSync(blob)).toBe(true);
  await unavailable(
    await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('refused.png')],
    }),
  );
});

// Independent round-5 review probes. No production seam is added.
test.skipIf(process.getuid?.() === 0)(
  'message files: a blob directory that cannot be traversed keeps the record and its charge until deletion is proven, and recovers once readable (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const { dirname } = await import('node:path');
    const h = await harness();
    const f = await aliceFiles(h);
    const [file] = (await f.upload(pngVariant('hidden.png', 'hidden'))) as {
      id: string;
    }[];
    const blob = await aliceBlob(f, file!.id);
    const dir = dirname(blob);
    const record = join(
      await bindingDirectory(f.root, f.binding),
      `${file!.id}.json`,
    );
    const sent = await f.send([file]);
    fs.chmodSync(dir, 0o000);
    let status: number;
    try {
      status = await f.remove(sent.messageId);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    console.log(
      'R5_INACCESSIBLE_UNLINK',
      JSON.stringify({
        status,
        blob: fs.existsSync(blob),
        record: fs.existsSync(record),
      }),
    );
    expect(fs.existsSync(blob)).toBe(true);
    expect(fs.existsSync(record)).toBe(true);
    await f.upload(pngVariant('retry.png', 'retry'));
    expect(fs.existsSync(blob)).toBe(false);
  },
);

for (const [label, raw] of [
  ['partial', '{'],
  ['garbage', 'garbage'],
  ['oversize', '{' + 'x'.repeat(8 * 1024 * 1024)],
] as const)
  test(`message files: a warmed store refuses an upload while the repair inbox holds ${label} content (#4852 review)`, async () => {
    const fs = await import('node:fs');
    const h = await harness();
    const f = await aliceFiles(h);
    await f.upload(pngVariant('warm.png', 'warm'));
    const repair = join(f.root, 'repair', 'operator');
    fs.mkdirSync(repair, { recursive: true });
    fs.writeFileSync(join(repair, 'pending.json'), raw);
    const response = await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [pngVariant('next.png', 'next')],
    });
    const body = (await response.clone().json()) as {
      error?: { code?: string };
    };
    console.log(
      'R5_REPAIR_ADMISSION',
      JSON.stringify({
        label,
        status: response.status,
        code: body.error?.code,
        marker: fs.existsSync(join(f.root, 'reclamation-blocked.json')),
      }),
    );
    await unavailable(response);
  });

test('message files: a stray entry directly under repair/ is storage unavailable, not invalid input (#4852 review)', async () => {
  const fs = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  await f.upload(png('warm.png'));
  fs.mkdirSync(join(f.root, 'repair'), { recursive: true });
  fs.writeFileSync(join(f.root, 'repair', 'partial.tmp'), '{');
  const response = await h.request('alice', '/attachments', 'POST', {
    ...guard(f.a),
    attachments: [png('next.png')],
  });
  console.log(
    'R5_REPAIR_TOPLEVEL',
    response.status,
    JSON.stringify(await response.clone().json()),
  );
  await unavailable(response);
});

test('message files: a repair whose bytes are gone stays pending and blocks, then a corrected repair resumes uploads (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const intact = fs.readFileSync(damaged.path, 'utf8');
  const parsed = JSON.parse(intact);
  const path = repairPath(f.root, damaged.path);
  const attempt = () =>
    h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('next.png')],
    });
  // A release finds the damage (uploads re-check the store, so the damage
  // and the pending repair happen after this upload).
  const [gone] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
    id: string;
  }[];
  const sent = await f.send([gone]);
  fs.writeFileSync(damaged.path, '{');
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(
    path,
    JSON.stringify({ ...parsed, blobRef: 'sha256-' + 'f'.repeat(64) }),
  );
  await f.remove(sent.messageId);
  await unavailable(await attempt());
  expect(fs.readFileSync(damaged.path, 'utf8')).toBe('{');
  const [claimed] = await claimedNames(dirname(path));
  expect(claimed).toBeDefined();
  const marker = JSON.parse(
    fs.readFileSync(join(f.root, 'reclamation-blocked.json'), 'utf8'),
  );
  expect(marker.records).toContainEqual({
    path: join(dirname(path), claimed!),
    reason: 'its bytes are no longer stored',
  });
  // Writing the correction under the same name supersedes the stuck claim.
  fs.writeFileSync(path, intact);
  expect((await attempt()).status).toBe(200);
  expect(fs.readFileSync(damaged.path, 'utf8')).toBe(intact);
  console.log('R5_MISSING_BLOB_REPAIR blocked, diagnosed, corrected, resumed');
});

test('message files: a repair is published from the bytes Station validated, even if the operator rewrites it meanwhile (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const { syncBuiltinESMExports } = await import('node:module');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const intact = fs.readFileSync(damaged.path, 'utf8');
  fs.writeFileSync(damaged.path, '{');
  const path = repairPath(f.root, damaged.path);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, intact);
  const rename = fs.renameSync;
  let raced = false;
  const spy = vi
    .spyOn(fs.default, 'renameSync')
    .mockImplementation((from, to) => {
      // The operator rewrites the repair entry after Station read and
      // validated it, just before Station publishes into bindings/.
      if (to === damaged.path && !raced) {
        raced = true;
        fs.writeFileSync(path, '{');
      }
      return rename(from, to);
    });
  syncBuiltinESMExports();
  let response: Response;
  try {
    response = await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('next.png')],
    });
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  console.log(
    'R5_REPAIR_TOCTOU',
    JSON.stringify({
      raced,
      status: response!.status,
      inbox: fs.existsSync(path),
      binding: fs.readFileSync(damaged.path, 'utf8'),
    }),
  );
  expect(raced).toBe(true);
  expect(fs.readFileSync(damaged.path, 'utf8')).toBe(intact);
  // The newer, incomplete entry is kept (claimed by the next pass, which
  // reports it).
  expect(await repairBytes(path)).toEqual(['{']);
});

test.skipIf(process.getuid?.() === 0)(
  'message files: the same process keeps refusing after marker writes work again, until the record is repaired (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const h = await harness();
    const f = await aliceFiles(h);
    const damaged = await bobsRecord(h, f);
    const [gone] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
      id: string;
    }[];
    const sent = await f.send([gone]);
    fs.writeFileSync(damaged.path, '{');
    const staging = join(f.root, 'staging');
    fs.chmodSync(staging, 0o500);
    try {
      expect(await f.remove(sent.messageId)).toBe(200);
    } finally {
      fs.chmodSync(staging, 0o700);
    }
    expect(fs.existsSync(join(f.root, 'reclamation-blocked.json'))).toBe(false);
    const bob = await h.discover('bob');
    const response = await h.request('bob', '/attachments', 'POST', {
      ...guard(bob),
      attachments: [pngVariant('next.png', 'next')],
    });
    console.log(
      'R5_LATCH_AFTER_IO_RECOVERY',
      response.status,
      JSON.stringify(await response.clone().json()),
    );
    await unavailable(response);
  },
);

// Round-7 review probes (#4852): repair custody, cleanup and tree lookups.
test('message files: an operator write to a repair name after Station claims it stays as a new entry (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const { syncBuiltinESMExports } = await import('node:module');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const intact = fs.readFileSync(damaged.path, 'utf8');
  fs.writeFileSync(damaged.path, '{');
  const path = repairPath(f.root, damaged.path);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, intact);
  const read = fs.readFileSync;
  let reads = 0;
  let raced = false;
  // The operator rewrites the original name while Station holds what it
  // read: on the second read of that name (the old unchanged-check), or on
  // the read of the claimed file that replaced it.
  const spy = vi
    .spyOn(fs.default, 'readFileSync')
    .mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      const bytes = Reflect.apply(read, fs, args);
      const target = String(args[0]);
      if (
        !raced &&
        ((target === path && ++reads === 2) ||
          target.startsWith(`${path}.claimed-`))
      ) {
        fs.writeFileSync(path, '{');
        raced = true;
      }
      return bytes;
    });
  syncBuiltinESMExports();
  let response: Response;
  try {
    response = await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('next.png')],
    });
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(raced).toBe(true);
  expect(fs.readFileSync(damaged.path, 'utf8')).toBe(intact);
  // The rewrite survives, at its name or claimed by the admission pass.
  expect(await repairBytes(path)).toEqual(['{']);
  await unavailable(response!);
});

test('message files: a repair arriving as Station tidies an emptied repair directory is kept (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const { syncBuiltinESMExports } = await import('node:module');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const intact = fs.readFileSync(damaged.path, 'utf8');
  fs.writeFileSync(damaged.path, '{');
  const path = repairPath(f.root, damaged.path);
  const directory = dirname(path);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path, intact);
  const next = join(directory, `${randomUUID()}.json`);
  let raced = false;
  // The repair arrives just as Station removes the directory it emptied,
  // whichever removal call it uses. (The probe's original hook, an empty
  // readdir, has no counterpart once removal itself refuses a non-empty
  // directory.)
  const arrive = (target: unknown) => {
    if (target === directory && !raced) {
      fs.writeFileSync(next, '{');
      raced = true;
    }
  };
  const rm = fs.rmSync;
  const rmdir = fs.rmdirSync;
  const spies = [
    vi
      .spyOn(fs.default, 'rmSync')
      .mockImplementation((...args: Parameters<typeof fs.rmSync>) => {
        arrive(args[0]);
        return Reflect.apply(rm, fs, args);
      }),
    vi
      .spyOn(fs.default, 'rmdirSync')
      .mockImplementation((...args: Parameters<typeof fs.rmdirSync>) => {
        arrive(args[0]);
        return Reflect.apply(rmdir, fs, args);
      }),
  ];
  syncBuiltinESMExports();
  let response: Response;
  try {
    response = await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('next.png')],
    });
  } finally {
    for (const spy of spies) spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(raced).toBe(true);
  expect(fs.readFileSync(damaged.path, 'utf8')).toBe(intact);
  // The arrival survives, at its name or claimed by the admission pass.
  expect(await repairBytes(next)).toEqual(['{']);
  await unavailable(response!);
});

test.skipIf(process.getuid?.() === 0)(
  'message files: a repair that cannot be published leaves no staging copies and is retried until it lands (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const { dirname } = await import('node:path');
    const h = await harness();
    const f = await aliceFiles(h);
    const damaged = await bobsRecord(h, f);
    const intact = fs.readFileSync(damaged.path, 'utf8');
    fs.writeFileSync(damaged.path, '{');
    const path = repairPath(f.root, damaged.path);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, intact);
    const staging = join(f.root, 'staging');
    const copies = () =>
      fs.readdirSync(staging).filter((name) => name.startsWith('repair.'));
    const attempt = () =>
      h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [png('next.png')],
      });
    const statuses: number[] = [];
    let afterFailures: string[];
    let reasons: { path: string; reason: string }[];
    let pending: string[];
    fs.chmodSync(dirname(damaged.path), 0o500);
    try {
      for (let i = 0; i < 3; i++) statuses.push((await attempt()).status);
      afterFailures = copies();
      pending = await claimedNames(dirname(path));
      reasons = JSON.parse(
        fs.readFileSync(join(f.root, 'reclamation-blocked.json'), 'utf8'),
      ).records;
    } finally {
      fs.chmodSync(dirname(damaged.path), 0o700);
    }
    expect(statuses).toEqual([503, 503, 503]);
    expect(afterFailures!).toEqual([]);
    expect(pending!).toHaveLength(1);
    expect(reasons!).toContainEqual({
      path: join(dirname(path), pending![0]!),
      reason: 'EACCES',
    });
    const recovered = await attempt();
    expect(recovered.status).toBe(200);
    expect(fs.readFileSync(damaged.path, 'utf8')).toBe(intact);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(dirname(path))).toBe(false);
    expect(copies()).toEqual([]);
  },
);

test.skipIf(process.getuid?.() === 0)(
  'message files: an unreadable binding directory blocks admission and deletion, then recovers (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const { dirname } = await import('node:path');
    const h = await harness();
    const f = await aliceFiles(h);
    const damaged = await bobsRecord(h, f);
    const [file] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
      id: string;
    }[];
    const sent = await f.send([file]);
    const blob = await aliceBlob(f, file!.id);
    fs.chmodSync(dirname(damaged.path), 0o000);
    try {
      await f.remove(sent.messageId);
      await unavailable(
        await h.request('alice', '/attachments', 'POST', {
          ...guard(f.a),
          attachments: [png('blocked.png')],
        }),
      );
      expect(fs.existsSync(blob)).toBe(true);
    } finally {
      fs.chmodSync(dirname(damaged.path), 0o700);
    }
    expect(Array.isArray(await f.upload(png('recovered.png')))).toBe(true);
    expect(fs.existsSync(blob)).toBe(false);
  },
);

test.skipIf(process.getuid?.() === 0)(
  'message files: admission refuses even when its diagnostic cannot be written (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const h = await harness();
    const f = await aliceFiles(h);
    await f.upload(png('warm.png'));
    const repair = join(f.root, 'repair', 'operator');
    fs.mkdirSync(repair, { recursive: true });
    fs.writeFileSync(join(repair, 'pending.json'), '{');
    const staging = join(f.root, 'staging');
    fs.chmodSync(staging, 0o500);
    try {
      const response = await h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [png('blocked.png')],
      });
      expect(fs.existsSync(join(f.root, 'reclamation-blocked.json'))).toBe(
        false,
      );
      await unavailable(response);
    } finally {
      fs.chmodSync(staging, 0o700);
    }
    fs.rmSync(repair, { recursive: true });
    expect(Array.isArray(await f.upload(png('recovered.png')))).toBe(true);
  },
);

test('message files: a missing blob parent directory confirms absence and releases the record (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const h = await harness();
  const f = await aliceFiles(h);
  const [file] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
    id: string;
  }[];
  const sent = await f.send([file]);
  const blob = await aliceBlob(f, file!.id);
  fs.unlinkSync(blob);
  fs.rmdirSync(dirname(blob));
  expect(await f.remove(sent.messageId)).toBe(200);
  const record = join(
    await bindingDirectory(f.root, f.binding),
    `${file!.id}.json`,
  );
  expect(fs.existsSync(record)).toBe(false);
  expect(Array.isArray(await f.upload(png('resumed.png')))).toBe(true);
});

test('message files: every upload scans every record of a larger store and notices late damage (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { syncBuiltinESMExports } = await import('node:module');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const raw = fs.readFileSync(damaged.path);
  let last = '';
  for (let b = 0; b < 32; b++) {
    const key = createHash('sha256').update(`r6-${b}`).digest('hex');
    const dir = join(f.root, 'bindings', key);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 256; i++) {
      last = join(dir, `${randomUUID()}.json`);
      fs.writeFileSync(last, raw);
    }
  }
  let reads = 0;
  const read = fs.readFileSync;
  const spy = vi
    .spyOn(fs.default, 'readFileSync')
    .mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).startsWith(join(f.root, 'bindings'))) reads++;
      return Reflect.apply(read, fs, args);
    });
  syncBuiltinESMExports();
  let result: unknown;
  try {
    result = await f.upload(png('first.png'));
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(Array.isArray(result)).toBe(true);
  // 32 × 256 seeded records plus Bob's.
  expect(reads).toBeGreaterThanOrEqual(8193);
  fs.writeFileSync(last, '{');
  await unavailable(
    await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('second.png')],
    }),
  );
});

test('message files: a repair naming known bytes but no file descriptor still blocks admission (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const h = await harness();
  const f = await aliceFiles(h);
  const original = await bobsRecord(h, f);
  const { blobRef } = JSON.parse(fs.readFileSync(original.path, 'utf8'));
  const path = repairPath(f.root, original.path);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify({ blobRef }));
  await unavailable(
    await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('next.png')],
    }),
  );
  const [claimed] = await claimedNames(dirname(path));
  const marker = JSON.parse(
    fs.readFileSync(join(f.root, 'reclamation-blocked.json'), 'utf8'),
  );
  expect(marker.records).toContainEqual({
    path: join(dirname(path), claimed!),
    reason: 'not a complete file record',
  });
  fs.rmSync(join(dirname(path), claimed!));
  expect(Array.isArray(await f.upload(png('resumed.png')))).toBe(true);
});

test.skipIf(process.getuid?.() === 0)(
  'message files: a repair root that cannot be looked up is unavailable, not absent (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const h = await harness();
    const f = await aliceFiles(h);
    await f.upload(png('warm.png'));
    const parent = join(h.home, 'operator-repair-parent');
    const target = join(parent, 'inbox');
    fs.mkdirSync(join(target, 'operator'), { recursive: true });
    fs.writeFileSync(join(target, 'operator', 'pending.json'), '{');
    fs.symlinkSync(target, join(f.root, 'repair'), 'dir');
    fs.chmodSync(parent, 0o000);
    let response: Response;
    let lookupCode: string | undefined;
    try {
      try {
        fs.statSync(join(f.root, 'repair'));
      } catch (error) {
        lookupCode = (error as NodeJS.ErrnoException).code;
      }
      response = await h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [png('next.png')],
      });
    } finally {
      fs.chmodSync(parent, 0o700);
    }
    expect(lookupCode).toBe('EACCES');
    await unavailable(response!);
    await unavailable(
      await h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [png('after.png')],
      }),
    );
  },
);

test.skipIf(process.getuid?.() === 0)(
  'message files: a store directory that cannot be looked up is unavailable, not absent (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const { dirname } = await import('node:path');
    const h = await harness();
    const f = await aliceFiles(h);
    const damaged = await bobsRecord(h, f);
    const bindings = join(f.root, 'bindings');
    // Listable but not searchable: each key directory's lookup is EACCES.
    fs.chmodSync(bindings, 0o400);
    let response: Response;
    let records: { path: string; reason: string }[];
    try {
      response = await h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [png('blocked.png')],
      });
      const marker = join(f.root, 'reclamation-blocked.json');
      records = fs.existsSync(marker)
        ? JSON.parse(fs.readFileSync(marker, 'utf8')).records
        : [];
    } finally {
      fs.chmodSync(bindings, 0o700);
    }
    await unavailable(response!);
    expect(records!).toContainEqual({
      path: dirname(damaged.path),
      reason: 'EACCES',
    });
    expect(Array.isArray(await f.upload(png('resumed.png')))).toBe(true);
  },
);

test('message files: a linked bindings or repair root pauses uploads until it is a plain directory again (#4852 review)', async () => {
  const fs = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  await f.upload(png('warm.png'));
  const bindings = join(f.root, 'bindings');
  const moved = join(h.home, 'moved-bindings');
  fs.renameSync(bindings, moved);
  fs.symlinkSync(moved, bindings, 'dir');
  await unavailable(
    await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('linked.png')],
    }),
  );
  const marker = JSON.parse(
    fs.readFileSync(join(f.root, 'reclamation-blocked.json'), 'utf8'),
  );
  expect(marker.records).toContainEqual({
    path: bindings,
    reason: 'a link, which is not supported',
  });
  fs.unlinkSync(bindings);
  fs.renameSync(moved, bindings);
  expect(Array.isArray(await f.upload(png('plain.png')))).toBe(true);
  const inbox = join(h.home, 'linked-inbox');
  fs.mkdirSync(inbox);
  fs.symlinkSync(inbox, join(f.root, 'repair'), 'dir');
  await unavailable(
    await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('linked-repair.png')],
    }),
  );
  fs.unlinkSync(join(f.root, 'repair'));
  expect(Array.isArray(await f.upload(png('resumed.png')))).toBe(true);
});

test('message files: claimed repair files left by an earlier process are pending, and the newest claim of a record wins (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const intact = fs.readFileSync(damaged.path, 'utf8');
  fs.writeFileSync(damaged.path, '{');
  const directory = dirname(repairPath(f.root, damaged.path));
  fs.mkdirSync(directory, { recursive: true });
  const name = damaged.path.slice(dirname(damaged.path).length + 1);
  const claim = (ms: number, bytes: string) => {
    const path = join(
      directory,
      `${name}.claimed-${String(ms).padStart(15, '0')}-${randomUUID()}`,
    );
    fs.writeFileSync(path, bytes);
    return path;
  };
  const attempt = () =>
    h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('next.png')],
    });
  const blocked = async () =>
    JSON.parse(
      fs.readFileSync(join(f.root, 'reclamation-blocked.json'), 'utf8'),
    ).records;
  // A crash left a complete claim, then a newer incomplete one: the newest
  // write is the operator's intent, so nothing is published and both block.
  const olderComplete = claim(Date.now() - 3000, intact);
  const newerIncomplete = claim(Date.now() - 2000, '{');
  await unavailable(await attempt());
  expect(fs.readFileSync(damaged.path, 'utf8')).toBe('{');
  expect(fs.readFileSync(olderComplete, 'utf8')).toBe(intact);
  expect(await blocked()).toEqual(
    expect.arrayContaining([
      { path: newerIncomplete, reason: 'not a complete file record' },
      {
        path: olderComplete,
        reason: 'superseded by a later repair that is not yet applied',
      },
    ]),
  );
  // A still newer complete claim publishes and retires both older claims.
  const newest = claim(Date.now() - 1000, intact);
  expect((await attempt()).status).toBe(200);
  expect(fs.readFileSync(damaged.path, 'utf8')).toBe(intact);
  for (const path of [olderComplete, newerIncomplete, newest])
    expect(fs.existsSync(path)).toBe(false);
  expect(fs.existsSync(directory)).toBe(false);
});

test('message files: a lone incomplete claimed repair blocks uploads until it is removed (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const directory = dirname(repairPath(f.root, damaged.path));
  fs.mkdirSync(directory, { recursive: true });
  const name = damaged.path.slice(dirname(damaged.path).length + 1);
  const claimed = join(
    directory,
    `${name}.claimed-${String(Date.now()).padStart(15, '0')}-${randomUUID()}`,
  );
  fs.writeFileSync(claimed, '{');
  for (let i = 0; i < 2; i++)
    await unavailable(
      await h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [png('blocked.png')],
      }),
    );
  expect(
    JSON.parse(
      fs.readFileSync(join(f.root, 'reclamation-blocked.json'), 'utf8'),
    ).records,
  ).toContainEqual({ path: claimed, reason: 'not a complete file record' });
  expect(fs.readFileSync(claimed, 'utf8')).toBe('{');
  fs.rmSync(claimed);
  expect(Array.isArray(await f.upload(png('resumed.png')))).toBe(true);
});

for (const [label, raw] of [
  ['partial', '{'],
  ['garbage', 'garbage'],
  ['oversize', `{${'x'.repeat(8 * 1024 * 1024)}`],
] as const)
  test(`message files: a ${label} repair at a valid path reaches content validation and is refused (#4852 review)`, async () => {
    const fs = await import('node:fs');
    const { dirname } = await import('node:path');
    const h = await harness();
    const f = await aliceFiles(h);
    const original = await bobsRecord(h, f);
    const path = repairPath(f.root, original.path);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, raw);
    const response = await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('next.png')],
    });
    const [claimed] = await claimedNames(dirname(path));
    const records = JSON.parse(
      fs.readFileSync(join(f.root, 'reclamation-blocked.json'), 'utf8'),
    ).records;
    expect(records).toContainEqual({
      path: join(dirname(path), claimed!),
      reason: 'not a complete file record',
    });
    expect(fs.readFileSync(join(dirname(path), claimed!), 'utf8')).toBe(raw);
    await unavailable(response);
  });
