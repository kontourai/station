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
  PROJECT_ROOM_LIVE_AGENT_REQUESTS,
  PROJECT_ROOM_LIVE_WORKING_REQUESTS,
  PROJECT_ROOM_TYPING_TTL_MS,
  type ProjectRoomLiveFrame,
  parseProjectRoomBrowserView,
  parseProjectRoomHistory,
  parseProjectRoomLiveFrame,
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
import { createProjectRoomAgentRuntime } from '../../services/projects/project-room-agent-module.js';
import {
  type ProjectRoomAccessPort,
  type ProjectRoomMentionEvent,
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
import { projectRoomLiveResponse } from './project-room-live.js';
import { createProjectRoomRoutes } from './project-room-routes.js';

const owner = humanPrincipal('deployment', 'alice', 'Alice');
const member = humanPrincipal('deployment', 'bob', 'Bob');
/** A real, authenticated person who was never invited to the Project. */
const outsider = humanPrincipal('deployment', 'carol', 'Carol');
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
  const carol = authority(outsider, () => true);
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
    if (credential === 'Bearer carol-session')
      return { auth: carol, live: () => true };
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
    // The runtime's directory (#4799): the Project's viewing members.
    // An over-sharing port on purpose: the service must strip `email`.
    members: (scope) =>
      membership.viewingMembers(scope).map((principal) => ({
        id: principal.id,
        displayName: principal.display,
        kind: 'person' as const,
        email: `${principal.id}@example.invalid`,
      })),
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
  const mentions: ProjectRoomMentionEvent[] = [];
  const service = new ProjectRoomService(
    runtime.store,
    port,
    new ProjectRoomAttachments(join(home, 'project-room-attachments')),
    (event) => mentions.push(event),
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
    mentions,
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
  const [taskFile] = (await task.store(
    async () => scope,
    [asInput(png('task.png'))],
  ))!;
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
  utimesSync(f.blobOf(file!.id), old, old);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
  await task.store(
    async () => scope,
    [asInput(pngVariant('different.png', 'different'))],
  );
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

/** Reads whole SSE frames off one stream, in order (#4798). */
function liveReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (): Promise<ProjectRoomLiveFrame> => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (raw.startsWith(':')) continue;
        const event = /^event: (.*)$/m.exec(raw)?.[1] ?? '';
        const value = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? 'null');
        return parseProjectRoomLiveFrame(event, value);
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('stream ended');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  /** The next frame of `kind`, skipping others (presence, typing, agents). */
  const until = async <K extends ProjectRoomLiveFrame['kind']>(
    kind: K,
    key?: string,
  ) => {
    for (;;) {
      const value = await next();
      if (value.kind === kind && (key === undefined || value.key === key))
        return value as Extract<ProjectRoomLiveFrame, { kind: K }>;
    }
  };
  return { next, until, cancel: () => reader.cancel() };
}
function live(
  h: Harness,
  who: 'alice' | 'bob',
  channels: string[],
  client = randomUUID(),
) {
  const query = new URLSearchParams(channels.map((id) => ['channel', id]));
  query.set('client', client);
  return api(h, who, `/rooms/live?${query}`);
}

test('live (#4798): ten rooms stream over one connection, each admitted on its own', async () => {
  const h = await harness();
  const general = await h.discover('alice');
  const channels = [general.roomId];
  for (let index = 1; index < 10; index++)
    channels.push(
      parseProjectRoomChannel(
        await data(await createChannel(h, 'alice', `room-${index}`)),
      ).channelId,
    );
  const missing = randomUUID();
  const history = vi.spyOn(h.service, 'history');
  const response = await live(h, 'bob', [...channels, missing]);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const stream = liveReader(response);
  const subscribed = new Set<string>();
  let unavailable = '';
  while (subscribed.size < 10 || !unavailable) {
    const value = await stream.next();
    if (value.kind === 'subscribed') subscribed.add(value.key);
    if (value.kind === 'unavailable') unavailable = value.key;
  }
  expect([...subscribed].sort()).toEqual([...channels].sort());
  // A room nobody can read answers like one that does not exist.
  expect(unavailable).toBe(missing);
  // Each subscription was admitted by that channel's own history read.
  expect(history.mock.calls.map((call) => call[4]).sort()).toEqual(
    [...channels, missing].sort(),
  );
  // A message in the tenth room arrives as an append on the same stream.
  const tenth = channels[9]!;
  const view = parseProjectRoomBrowserView(
    await data(await api(h, 'alice', `/channels/${tenth}`)),
  );
  await api(h, 'alice', `/channels/${tenth}/messages`, 'POST', {
    ...guard(view),
    intentId: randomUUID(),
    text: 'over one connection',
  });
  const appended = await stream.until('append', tenth);
  expect(appended.message).toMatchObject({
    seq: 1,
    text: 'over one connection',
  });
  await stream.cancel();
});

test('live (#4798): appends carry the next sequence; a reaction, edit and delete are one update each with its activity range', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const stream = liveReader(await live(h, 'bob', [a.roomId]));
  const subscribed = await stream.until('subscribed');
  expect(subscribed).toMatchObject({ lastSeq: 0, activity: 0 });
  const message = parseProjectRoomMessage(
    await data(
      await h.request('alice', '/messages', 'POST', {
        ...guard(a),
        intentId: randomUUID(),
        text: 'first',
      }),
    ),
  );
  expect((await stream.until('append')).message).toEqual(message);
  let activity = 0;
  for (const change of [
    () =>
      h.request('alice', `/messages/${message.messageId}/reactions`, 'POST', {
        ...guard(a),
        emoji: '🎉',
        reacted: true,
      }),
    () =>
      h.request('alice', `/messages/${message.messageId}/edit`, 'POST', {
        ...guard(a),
        intentId: randomUUID(),
        text: 'first, edited',
      }),
    () =>
      h.request('alice', `/messages/${message.messageId}/delete`, 'POST', {
        ...guard(a),
        intentId: randomUUID(),
      }),
  ]) {
    expect((await change()).status).toBe(200);
    const update = await stream.until('update');
    expect(update).toMatchObject({
      fromActivity: activity,
      activity: activity + 1,
    });
    activity += 1;
    expect(update.messages.map((m) => m.messageId)).toEqual([
      message.messageId,
    ]);
  }
  const deleted = parseProjectRoomHistory(
    await data(await h.request('bob', '/messages')),
  ).messages[0];
  expect(deleted?.deletedAt).toBeDefined();
  await stream.cancel();
});

test('live (#4798): more appends than one pass may describe is a resync, never a silent skip', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const stream = liveReader(await live(h, 'bob', [a.roomId]));
  await stream.until('subscribed');
  // Synchronous commits: the stream cannot run between them, so it next
  // sees 30 new messages at once, more than one pass may carry.
  for (let index = 0; index < 30; index++)
    h.runtime.store.append(
      h.scope,
      a.actor,
      { intentId: randomUUID(), text: `bulk ${index}` },
      () => {},
    );
  const resync = await stream.until('resync');
  expect(resync).toMatchObject({ lastSeq: 30, activity: 0 });
  await stream.cancel();
});

test('live (#4798): typing shows, clears when the typist stops, and clears when their stream drops', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const b = await h.discover('bob');
  const bobClient = randomUUID();
  const watcher = liveReader(await live(h, 'alice', [a.roomId]));
  await watcher.until('subscribed');
  const typist = liveReader(await live(h, 'bob', [b.roomId], bobClient));
  await typist.until('subscribed');
  const type = (typing: boolean) =>
    h.request('bob', '/typing', 'POST', {
      ...guard(b),
      clientId: bobClient,
      typing,
    });
  const nextTyping = async () => (await watcher.until('typing')).actors;
  expect((await type(true)).status).toBe(200);
  // The first typing frame may be the empty baseline.
  let actors = await nextTyping();
  if (!actors.length) actors = await nextTyping();
  expect(actors.map((actor) => actor.id)).toEqual([member.id]);
  // Cleared by the stop itself, well before the signal would lapse.
  let stoppedAt = Date.now();
  expect((await type(false)).status).toBe(200);
  expect(await nextTyping()).toEqual([]);
  expect(Date.now() - stoppedAt).toBeLessThan(PROJECT_ROOM_TYPING_TTL_MS / 2);
  // Typing again, then the typist's stream goes away: cleared with it.
  await type(true);
  expect((await nextTyping()).map((actor) => actor.id)).toEqual([member.id]);
  stoppedAt = Date.now();
  await typist.cancel();
  expect(await nextTyping()).toEqual([]);
  expect(Date.now() - stoppedAt).toBeLessThan(PROJECT_ROOM_TYPING_TTL_MS / 2);
  // A viewer cannot type: typing is a discuss action.
  await watcher.cancel();
});

test('live (#4798): typing expires on its own when it is not renewed', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const b = await h.discover('bob');
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  await h.request('bob', '/typing', 'POST', {
    ...guard(b),
    clientId: randomUUID(),
    typing: true,
  });
  expect(h.service.typing(a.roomId).map((actor) => actor.id)).toEqual([
    member.id,
  ]);
  clock.mockReturnValue(now + PROJECT_ROOM_TYPING_TTL_MS + 1);
  expect(h.service.typing(a.roomId)).toEqual([]);
});

test('live (#4798): losing access ends that room with revoked, and a viewer cannot type', async () => {
  const h = await harness('viewer');
  const a = await h.discover('alice');
  const b = await h.discover('bob');
  expect(
    (
      await h.request('bob', '/typing', 'POST', {
        ...guard(b),
        clientId: randomUUID(),
        typing: true,
      })
    ).status,
  ).toBe(403);
  const stream = liveReader(await live(h, 'bob', [a.roomId]));
  await stream.until('subscribed');
  h.revokeMember();
  await h.request('alice', '/messages', 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text: 'after revocation',
  });
  const next = await Promise.race([
    stream.until('revoked').then(() => 'revoked'),
    stream.until('append').then(() => 'leaked'),
  ]).catch(() => 'closed');
  expect(next).not.toBe('leaked');
  await stream.cancel().catch(() => {});
});

test('live (#4800): an Agent request shows from reserved to settled, from the request record alone', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const stream = liveReader(await live(h, 'bob', [a.roomId]));
  await stream.until('subscribed');
  expect((await stream.until('agents')).requests).toEqual([]);
  const request = h.runtime.store.reserveRequest(
    h.scope,
    a.actor,
    { intentId: randomUUID(), agentId: 'writer', text: 'draft it' },
    () => {},
  );
  expect((await stream.until('agents')).requests).toMatchObject([
    { requestId: request.requestId, agentId: 'writer', state: 'reserved' },
  ]);
  h.runtime.store.markStarted(h.scope, request.requestId, () => {});
  expect((await stream.until('agents')).requests[0]?.state).toBe('started');
  h.runtime.store.cancelRequest(h.scope, request.requestId, () => {});
  expect((await stream.until('agents')).requests[0]?.state).toBe('cancelled');
  await stream.cancel();
});

test('live (#4800): a request still working is carried however many newer requests have settled', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const first = h.runtime.store.reserveRequest(
    h.scope,
    a.actor,
    { intentId: randomUUID(), agentId: 'scout', text: 'long running' },
    () => {},
  );
  h.runtime.store.markStarted(h.scope, first.requestId, () => {});
  // As many newer, settled requests as the frame's recent-outcome limit.
  expect(PROJECT_ROOM_LIVE_AGENT_REQUESTS).toBe(20);
  for (let index = 0; index < PROJECT_ROOM_LIVE_AGENT_REQUESTS; index++) {
    const request = h.runtime.store.reserveRequest(
      h.scope,
      a.actor,
      { intentId: randomUUID(), agentId: 'scout', text: `newer ${index}` },
      () => {},
    );
    h.runtime.store.cancelRequest(h.scope, request.requestId, () => {});
  }
  const stream = liveReader(await live(h, 'bob', [a.roomId]));
  try {
    await stream.until('subscribed');
    // Parsed by the contract's own reader, as the client parses it.
    const frame = await stream.until('agents');
    expect(
      frame.requests.find((request) => request.requestId === first.requestId)
        ?.state,
    ).toBe('started');
  } finally {
    await stream.cancel();
  }
});

test('live (#4800): failed preparations never crowd a request still working out of the frame', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  let unavailable = false;
  const agents = createProjectRoomAgentRuntime(h.home, h.runtime.store, {
    async prepare() {
      if (unavailable) throw new Error('unavailable');
      return { label: 'Scout' };
    },
    async launch() {},
    async answer() {
      return null;
    },
    async cancel() {},
  });
  cleanup.push(() => agents.close());
  const authority = {
    scope: h.scope,
    requester: a.actor,
    executionRoot: h.home,
    assertCurrent: () => {},
  };
  const first = await agents.module.request(authority, {
    intentId: randomUUID(),
    agentId: 'scout',
    text: 'really working',
  });
  expect(first.state).toBe('started');
  expect(first.failure).toBeUndefined();
  unavailable = true;
  // As many failed preparations as the frame keeps working requests: each
  // stays reserved with a recorded failure.
  expect(PROJECT_ROOM_LIVE_WORKING_REQUESTS).toBe(50);
  for (let index = 0; index < PROJECT_ROOM_LIVE_WORKING_REQUESTS; index++) {
    const failed = await agents.module.request(authority, {
      intentId: randomUUID(),
      agentId: 'scout',
      text: `failed preparation ${index}`,
    });
    expect(failed.state).toBe('reserved');
    expect(failed.failure).toBe('agent_unavailable');
  }
  const app = new Hono();
  app.get('/api/projects/:slug/rooms/live', (c) =>
    projectRoomLiveResponse(c, h.service, (ids) => agents.module.failures(ids)),
  );
  const stream = liveReader(
    await app.request(
      `/api/projects/example/rooms/live?channel=${a.roomId}&client=${randomUUID()}`,
      { headers: { authorization: 'Bearer bob-session' } },
    ),
  );
  try {
    await stream.until('subscribed');
    const frame = await stream.until('agents');
    const working = frame.requests.find(
      (request) => request.requestId === first.requestId,
    );
    expect(working?.state).toBe('started');
    expect(working?.failure).toBeUndefined();
  } finally {
    await stream.cancel();
  }
});

test('live (#4800): working requests are found past more failed ones than one page of the selection holds', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const reserve = (text: string) =>
    h.runtime.store.reserveRequest(
      h.scope,
      a.actor,
      { intentId: randomUUID(), agentId: 'scout', text },
      () => {},
    );
  const running = reserve('running');
  h.runtime.store.markStarted(h.scope, running.requestId, () => {});
  // 150 newer unsettled requests, all failed: more than one page of 100.
  const failed = new Set(
    Array.from({ length: 150 }, (_, i) => reserve(`failed ${i}`).requestId),
  );
  const requests = h.service.recentRequests(
    a.roomId,
    PROJECT_ROOM_LIVE_AGENT_REQUESTS,
    PROJECT_ROOM_LIVE_WORKING_REQUESTS,
    (ids) => new Set(ids.filter((id) => failed.has(id))),
  );
  expect(requests).toHaveLength(PROJECT_ROOM_LIVE_AGENT_REQUESTS + 1);
  expect(requests.at(-1)?.requestId).toBe(running.requestId);
});

test('live (#4800): a frame reads the failure journal a fixed number of times, however many requests failed', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  let unavailable = false;
  const agents = createProjectRoomAgentRuntime(h.home, h.runtime.store, {
    async prepare() {
      if (unavailable) throw new Error('unavailable');
      return { label: 'Scout' };
    },
    async launch() {},
    async answer() {
      return null;
    },
    async cancel() {},
  });
  cleanup.push(() => agents.close());
  const authority = {
    scope: h.scope,
    requester: a.actor,
    executionRoot: h.home,
    assertCurrent: () => {},
  };
  const first = await agents.module.request(authority, {
    intentId: randomUUID(),
    agentId: 'scout',
    text: 'really running',
  });
  unavailable = true;
  // One room's whole request allowance, all but the first failed.
  for (let index = 1; index < 1000; index++)
    await agents.module.request(authority, {
      intentId: randomUUID(),
      agentId: 'scout',
      text: `failure ${index}`,
    });
  // Every execution of a statement that reads the failure journal.
  let journalReads = 0;
  const prepare = DatabaseSync.prototype.prepare;
  const spy = vi
    .spyOn(DatabaseSync.prototype, 'prepare')
    .mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (/^\s*SELECT\b[\s\S]*\bproject_room_agent_failures\b/i.test(sql))
        for (const method of ['get', 'all', 'iterate'] as const) {
          const run = statement[method].bind(statement);
          (statement as unknown as Record<string, unknown>)[method] = (
            ...args: unknown[]
          ) => {
            journalReads += 1;
            return (run as (...values: unknown[]) => unknown)(...args);
          };
        }
      return statement;
    });
  const app = new Hono();
  app.get('/api/projects/:slug/rooms/live', (c) =>
    projectRoomLiveResponse(c, h.service, (ids) => agents.module.failures(ids)),
  );
  const open = async () =>
    liveReader(
      await app.request(
        `/api/projects/example/rooms/live?channel=${a.roomId}&client=${randomUUID()}`,
        { headers: { authorization: 'Bearer bob-session' } },
      ),
    );
  const one = await open();
  let two: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await one.until('subscribed');
    const frame = await one.until('agents');
    expect(
      frame.requests.find((r) => r.requestId === first.requestId)?.state,
    ).toBe('started');
    // One batched read answers the selection; the newest 20 are among the
    // unsettled requests it already asked about, so projecting the frame
    // asks again for nothing.
    const opened = journalReads;
    expect(opened).toBe(1);
    two = await open();
    await two.until('subscribed');
    await two.until('agents');
    expect(journalReads - opened).toBe(1);
    // One change re-sends both subscribers' frames. The settled request is
    // neither among the newest 20 nor working, so it leaves the frame.
    const before = journalReads;
    h.runtime.store.cancelRequest(h.scope, first.requestId, () => {});
    for (const stream of [one, two]) {
      const settled = await stream.until('agents');
      expect(
        settled.requests.some((r) => r.requestId === first.requestId),
      ).toBe(false);
    }
    expect(journalReads - before).toBe(2);
  } finally {
    spy.mockRestore();
    await one.cancel();
    await two?.cancel();
  }
});

test('live (#4800): with more than fifty working, the newest fifty are kept and a settled one is replaced', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const reserve = () =>
    h.runtime.store.reserveRequest(
      h.scope,
      a.actor,
      { intentId: randomUUID(), agentId: 'scout', text: 'working' },
      () => {},
    );
  const working = Array.from({ length: 55 }, () => {
    const request = reserve();
    h.runtime.store.markStarted(h.scope, request.requestId, () => {});
    return request.requestId;
  });
  for (let index = 0; index < 20; index++)
    h.runtime.store.cancelRequest(h.scope, reserve().requestId, () => {});
  const none = () => new Map();
  let requests = h.service.recentRequests(a.roomId, 20, 50, none);
  expect(requests).toHaveLength(70);
  expect(
    requests.filter((r) => r.state === 'started').map((r) => r.requestId),
  ).toEqual(working.slice(5).reverse());
  h.runtime.store.cancelRequest(h.scope, working[54]!, () => {});
  requests = h.service.recentRequests(a.roomId, 20, 50, none);
  expect(
    requests.filter((r) => r.state === 'started').map((r) => r.requestId),
  ).toEqual(working.slice(4, 54).reverse());
});

test('mentions (#4799): a message names a member by id; only that person is told, once, and an edit tells only someone newly named', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const text = '@Bob can you check this?';
  const mention = {
    kind: 'person',
    actorId: member.id,
    display: 'Bob',
    offset: 0,
  };
  const response = await h.request('alice', '/messages', 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text,
    mentions: [mention],
  });
  if (response.status !== 200) throw new Error(await response.text());
  const sent = parseProjectRoomMessage(await data(response));
  expect(sent.mentions).toEqual([mention]);
  expect(h.mentions.map((event) => event.recipients)).toEqual([[member.id]]);
  expect(h.mentions[0]?.message.messageId).toBe(sent.messageId);
  // History serves the same structured mention.
  expect(
    parseProjectRoomHistory(await data(await h.request('bob', '/messages')))
      .messages[0]?.mentions,
  ).toEqual([mention]);
  // An edit that keeps Bob tells nobody again; naming yourself tells nobody.
  await h.request('alice', `/messages/${sent.messageId}/edit`, 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text: '@Bob and @Alice, please check',
    mentions: [
      mention,
      { kind: 'person', actorId: owner.id, display: 'Alice', offset: 9 },
    ],
  });
  expect(h.mentions).toHaveLength(1);
  // Mentioning someone who is not a member is refused at send time.
  expect(
    await code(
      await h.request('alice', '/messages', 'POST', {
        ...guard(a),
        intentId: randomUUID(),
        text: '@Mallory hi',
        mentions: [
          {
            kind: 'person',
            actorId: 'human:deployment:mallory',
            display: 'Mallory',
            offset: 0,
          },
        ],
      }),
    ),
  ).toEqual({ status: 400, code: 'project_room_invalid' });
  // A span that does not read `@display` is not a mention.
  expect(
    (
      await h.request('alice', '/messages', 'POST', {
        ...guard(a),
        intentId: randomUUID(),
        text: 'hello Bob',
        mentions: [{ ...mention, offset: 6 }],
      })
    ).status,
  ).toBe(400);
  expect(h.mentions).toHaveLength(1);
});

test('mentions (#4799): the member directory lists the Project people with current names', async () => {
  const h = await harness();
  const listed = (await data(await h.request('bob', '/members'))) as {
    members: { id: string; displayName: string }[];
  };
  expect(listed.members.map((m) => [m.id, m.displayName]).sort()).toEqual(
    [
      [owner.id, 'Alice'],
      [member.id, 'Bob'],
    ].sort(),
  );
});

test('mentions (#4799): the read summary marks a room whose unread messages name the reader', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const source = projectRoomVersionSource(h.service);
  const bobRequest = new Request('http://localhost', {
    headers: { authorization: 'Bearer bob-session' },
  });
  const target = { projectSlug: 'example', roomId: a.roomId };
  expect(await source.mentionedAfter?.(target, 0, bobRequest)).toBe(false);
  // A message naming only someone else is no mention of Bob.
  await h.request('alice', '/messages', 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text: '@Alice note to self',
    mentions: [
      { kind: 'person', actorId: owner.id, display: 'Alice', offset: 0 },
    ],
  });
  expect(await source.mentionedAfter?.(target, 0, bobRequest)).toBe(false);
  await h.request('alice', '/messages', 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text: '@Bob look',
    mentions: [
      { kind: 'person', actorId: member.id, display: 'Bob', offset: 0 },
    ],
  });
  await h.request('alice', '/messages', 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text: 'no mention here',
  });
  expect(await source.mentionedAfter?.(target, 0, bobRequest)).toBe(true);
  // Read past the mention: nothing unread names Bob.
  expect(await source.mentionedAfter?.(target, 2, bobRequest)).toBe(false);
  // Alice wrote it; it does not mention her.
  const aliceRequest = new Request('http://localhost', {
    headers: { authorization: 'Bearer alice-session' },
  });
  expect(await source.mentionedAfter?.(target, 0, aliceRequest)).toBe(false);
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
    const damaged = await bobsRecord(h, f);
    const intact = fs.readFileSync(damaged.path, 'utf8');
    fs.writeFileSync(damaged.path, '{');
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
    fs.writeFileSync(damaged.path, intact);
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

test('message files: a linked bindings root pauses uploads until it is a plain directory again (#4852 review)', async () => {
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
});

test('message files: a non-empty repair/ left by an earlier build blocks uploads and releases, and nothing in it is applied or deleted (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const h = await harness();
  const f = await aliceFiles(h);
  const damaged = await bobsRecord(h, f);
  const intact = fs.readFileSync(damaged.path, 'utf8');
  const [file] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
    id: string;
  }[];
  const sent = await f.send([file]);
  const blob = await aliceBlob(f, file!.id);
  // What the 03fd8507 build's inbox could hold: an unclaimed corrected
  // record and a claimed one for Bob's file.
  const repair = join(f.root, 'repair');
  const key = join(repair, dirname(damaged.path).split('/').pop()!);
  const name = damaged.path.split('/').pop()!;
  const claimed = `${name}.claimed-${String(Date.now()).padStart(15, '0')}-${randomUUID()}`;
  fs.mkdirSync(key, { recursive: true });
  fs.writeFileSync(join(key, name), intact);
  fs.writeFileSync(join(key, claimed), intact);
  const attempt = () =>
    h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('blocked.png')],
    });
  // Every binding is healthy: the leftover inbox alone refuses.
  await unavailable(await attempt());
  // With Bob's record damaged, the inbox's corrected copies are still not
  // applied.
  fs.writeFileSync(damaged.path, '{');
  await unavailable(await attempt());
  const marker = JSON.parse(
    fs.readFileSync(join(f.root, 'reclamation-blocked.json'), 'utf8'),
  );
  expect(marker.records).toContainEqual({
    path: repair,
    reason:
      'left by an earlier build and not empty: stop Station, apply any intended repair to bindings/ by hand, then remove it',
  });
  // A release is blocked too: the inbox may name bytes.
  await f.remove(sent.messageId);
  expect(fs.existsSync(blob)).toBe(true);
  // Nothing applied, nothing deleted.
  expect(fs.readFileSync(damaged.path, 'utf8')).toBe('{');
  expect(fs.readdirSync(key).sort()).toEqual([name, claimed].sort());
  // The documented recovery: repair bindings/ by hand, remove repair/.
  fs.writeFileSync(damaged.path, intact);
  fs.rmSync(repair, { recursive: true });
  expect(Array.isArray(await f.upload(png('resumed.png')))).toBe(true);
  expect(fs.existsSync(blob)).toBe(false);
});

test('message files: an empty repair/ left by an earlier build is fine (#4852 review)', async () => {
  const fs = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  const [file] = (await f.upload(pngVariant('gone.png', 'gone'))) as {
    id: string;
  }[];
  const sent = await f.send([file]);
  const blob = await aliceBlob(f, file!.id);
  fs.mkdirSync(join(f.root, 'repair'));
  expect(Array.isArray(await f.upload(png('admitted.png')))).toBe(true);
  expect(await f.remove(sent.messageId)).toBe(200);
  expect(fs.existsSync(blob)).toBe(false);
  expect(fs.existsSync(join(f.root, 'reclamation-blocked.json'))).toBe(false);
});

test.skipIf(process.getuid?.() === 0)(
  'message files: a linked or unreadable repair/ is storage unavailable (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const h = await harness();
    const f = await aliceFiles(h);
    await f.upload(png('warm.png'));
    const repair = join(f.root, 'repair');
    const attempt = () =>
      h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [png('next.png')],
      });
    const reasons = () =>
      JSON.parse(
        fs.readFileSync(join(f.root, 'reclamation-blocked.json'), 'utf8'),
      ).records;
    // A link to an empty directory: following it would find nothing.
    const target = join(h.home, 'empty-inbox');
    fs.mkdirSync(target);
    fs.symlinkSync(target, repair, 'dir');
    await unavailable(await attempt());
    expect(reasons()).toContainEqual({
      path: repair,
      reason: 'a link, which is not supported',
    });
    fs.unlinkSync(repair);
    // An empty directory that cannot be listed.
    fs.mkdirSync(repair);
    fs.chmodSync(repair, 0o000);
    try {
      await unavailable(await attempt());
      expect(reasons()).toContainEqual({ path: repair, reason: 'EACCES' });
    } finally {
      fs.chmodSync(repair, 0o700);
    }
    fs.rmdirSync(repair);
    expect((await attempt()).status).toBe(200);
  },
);

for (const [writer, damaged] of [
  ['binding record', false],
  ['blob bytes', false],
  ['diagnostic marker', true],
] as const)
  test(`message files: a ${writer} staging write that creates bytes then fails leaves no copy on retry (#4852 review)`, async () => {
    const fs = await import('node:fs');
    const { basename, dirname } = await import('node:path');
    const { syncBuiltinESMExports } = await import('node:module');
    const h = await harness();
    const f = await aliceFiles(h);
    const bob = await bobsRecord(h, f);
    const intact = fs.readFileSync(bob.path, 'utf8');
    if (damaged) fs.writeFileSync(bob.path, '{');
    const staging = join(f.root, 'staging');
    const blobs = join(f.root, 'blobs');
    const targeted = (path: string) =>
      writer === 'blob bytes'
        ? path.startsWith(blobs) && path.endsWith('.part')
        : dirname(path) === staging &&
          (writer === 'diagnostic marker'
            ? basename(path).startsWith('reclamation-blocked.')
            : /^[0-9a-f-]{36}\.json$/.test(basename(path)));
    const leftovers = () => [
      ...(fs.existsSync(staging) ? fs.readdirSync(staging) : []),
      ...(fs.existsSync(blobs)
        ? fs
            .readdirSync(blobs, { recursive: true, encoding: 'utf8' })
            .filter((name) => name.endsWith('.part'))
        : []),
    ];
    // Real exclusive creation and real partial bytes precede the error,
    // whether the writer stages with writeFileSync or with open and write.
    const open = fs.openSync;
    const write = fs.writeSync;
    const close = fs.closeSync;
    const writeFile = fs.writeFileSync;
    const owned = new Set<number>();
    let reached = 0;
    const bytesOf = (data: unknown) =>
      typeof data === 'string'
        ? Buffer.from(data)
        : Buffer.from(data as Uint8Array);
    const fail = (fd: number, data: unknown): never => {
      const bytes = bytesOf(data);
      Reflect.apply(write, fs, [fd, bytes, 0, Math.min(1, bytes.length)]);
      reached++;
      throw Object.assign(new Error('injected partial staging write'), {
        code: 'ENOSPC',
      });
    };
    const spies = [
      vi
        .spyOn(fs.default, 'openSync')
        .mockImplementation((...args: Parameters<typeof fs.openSync>) => {
          const fd: number = Reflect.apply(open, fs, args);
          if (targeted(String(args[0]))) owned.add(fd);
          return fd;
        }),
      vi.spyOn(fs.default, 'writeSync').mockImplementation(((
        ...args: [number, unknown, ...unknown[]]
      ) => {
        if (owned.delete(args[0])) fail(args[0], args[1]);
        return Reflect.apply(write, fs, args);
      }) as typeof fs.writeSync),
      vi
        .spyOn(fs.default, 'writeFileSync')
        .mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
          if (typeof args[0] === 'string' && targeted(args[0])) {
            const fd: number = Reflect.apply(open, fs, [args[0], 'w', 0o600]);
            try {
              fail(fd, args[1]);
            } finally {
              Reflect.apply(close, fs, [fd]);
            }
          }
          return Reflect.apply(writeFile, fs, args);
        }),
    ];
    syncBuiltinESMExports();
    // Bytes no file has stored yet, so the blob writer runs every attempt.
    const attempt = () =>
      h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [pngVariant('next.png', `staging-${writer}`)],
      });
    const statuses: number[] = [];
    const codes: (string | undefined)[] = [];
    let afterFailures: string[];
    try {
      for (let i = 0; i < 3; i++) {
        const response = await attempt();
        statuses.push(response.status);
        codes.push(
          ((await response.json()) as { error?: { code?: string } }).error
            ?.code,
        );
      }
      afterFailures = leftovers();
    } finally {
      for (const spy of spies) spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(reached).toBeGreaterThanOrEqual(3);
    // A failed write is the store's condition, never invalid input.
    expect(codes).toEqual(
      [1, 2, 3].map(() => PROJECT_ROOM_FILES_UNAVAILABLE_CODE),
    );
    expect(statuses).toEqual([503, 503, 503]);
    expect(afterFailures!).toEqual([]);
    if (damaged) fs.writeFileSync(bob.path, intact);
    expect((await attempt()).status).toBe(200);
    expect(leftovers()).toEqual([]);
  });

test('message files: a Station home reached through a linked ancestor directory still works (#4852 review)', async () => {
  const fs = await import('node:fs');
  // macOS temporary paths sit under /var, itself a link; only the store's
  // own levels are checked.
  const home = makeTempDir('r7-alias-home-');
  const real = join(home, 'real');
  const alias = join(home, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, 'dir');
  const files = new ProjectRoomAttachments(
    join(alias, 'project-room-attachments'),
  );
  const [file] = await files.locked(() =>
    files.store(['owner'], [asInput(png('alias.png'))]),
  );
  expect(files.read(['owner'], file!.id)?.bytes).toEqual(PNG);
  expect(await files.locked(() => files.release(['owner'], [file!.id]))).toBe(
    'reclaimed',
  );
  expect(files.read(['owner'], file!.id)).toBeUndefined();
});

test.each([false, true])(
  'message files: an exact send retry after the message was deleted acknowledges its tombstone (files=%s) (#4852 review)',
  async (withFiles) => {
    const fs = await import('node:fs');
    const h = await harness();
    const f = await aliceFiles(h);
    const attachments = withFiles
      ? await f.upload(pngVariant('retry.png', 'retry-receipt'))
      : undefined;
    const input = {
      ...guard(f.a),
      intentId: randomUUID(),
      text: 'Lost send acknowledgement',
      ...(withFiles ? { attachments } : {}),
    };
    const initial = await h.request('alice', '/messages', 'POST', input);
    expect(initial.status).toBe(200);
    const sent = parseProjectRoomMessage(await data(initial));
    expect((await h.request('alice', '/messages', 'POST', input)).status).toBe(
      200,
    );
    let blob: string | undefined;
    if (withFiles) blob = await aliceBlob(f, sent.attachments![0]!.id);
    expect(await f.remove(sent.messageId)).toBe(200);
    // The files are released with the message, so a replay cannot need them.
    if (blob) expect(fs.existsSync(blob)).toBe(false);
    const replay = await h.request('alice', '/messages', 'POST', input);
    const envelope = (await replay.json()) as {
      data: {
        messageId: string;
        text: string;
        deletedAt?: string;
        editedAt?: string;
        attachments?: { id: string }[];
      };
    };
    expect(replay.status).toBe(200);
    expect(envelope.data.messageId).toBe(sent.messageId);
    expect(envelope.data.deletedAt).toBeDefined();
    expect(envelope.data.text).toBe('');
    expect(envelope.data.attachments).toBeUndefined();
    // A changed payload under the same intent still conflicts.
    expect(
      (
        await h.request('alice', '/messages', 'POST', {
          ...input,
          text: 'A different message',
        })
      ).status,
    ).toBe(409);
  },
);

test.each([false, true])(
  'message files: an exact send retry after the message was edited acknowledges its latest text (files=%s) (#4852 review)',
  async (withFiles) => {
    const h = await harness();
    const f = await aliceFiles(h);
    const attachments = withFiles
      ? ((await f.upload(pngVariant('edited.png', 'edited-receipt'))) as {
          id: string;
        }[])
      : undefined;
    const input = {
      ...guard(f.a),
      intentId: randomUUID(),
      text: 'Before the edit',
      ...(withFiles ? { attachments } : {}),
    };
    const sent = parseProjectRoomMessage(
      await data(await h.request('alice', '/messages', 'POST', input)),
    );
    const edited = await h.request(
      'alice',
      `/messages/${sent.messageId}/edit`,
      'POST',
      { ...guard(f.a), intentId: randomUUID(), text: 'After the edit' },
    );
    expect(edited.status).toBe(200);
    const replay = await h.request('alice', '/messages', 'POST', input);
    const envelope = (await replay.json()) as {
      data: {
        messageId: string;
        text: string;
        deletedAt?: string;
        editedAt?: string;
        attachments?: { id: string }[];
      };
    };
    expect(replay.status).toBe(200);
    expect(envelope.data.messageId).toBe(sent.messageId);
    expect(envelope.data.text).toBe('After the edit');
    expect(envelope.data.editedAt).toBeDefined();
    expect(envelope.data.deletedAt).toBeUndefined();
    expect((envelope.data.attachments ?? []).map((file) => file.id)).toEqual(
      (attachments ?? []).map((file) => file.id),
    );
  },
);

test('message files: an accepted send retried after the sender loses room access is refused (#4852 review)', async () => {
  const refusalOf = async (response: Response) => ({
    status: response.status,
    code: ((await response.json()) as { error?: { code?: string } }).error
      ?.code,
  });
  // What a send that is not a replay meets when its sender's membership is
  // revoked at the synchronous admission.
  const control = await harness();
  const c = await control.discover('bob');
  control.armCommit(control.revokeMember);
  const fresh = await refusalOf(
    await control.request('bob', '/messages', 'POST', {
      ...guard(c),
      intentId: randomUUID(),
      text: 'never commit',
    }),
  );
  expect(fresh.status).toBe(403);
  const h = await harness();
  const b = await h.discover('bob');
  const uploaded = await h.request('bob', '/attachments', 'POST', {
    ...guard(b),
    attachments: [pngVariant('bob.png', 'revoked-replay')],
  });
  expect(uploaded.status).toBe(200);
  const input = {
    ...guard(b),
    intentId: randomUUID(),
    text: 'Sent before access was revoked',
    attachments: (await data(uploaded)) as { id: string }[],
  };
  const accepted = await h.request('bob', '/messages', 'POST', input);
  expect(accepted.status).toBe(200);
  const sent = parseProjectRoomMessage(await data(accepted));
  // Bob's membership is revoked as the exact retry reaches its synchronous
  // admission, after the asynchronous check let it in: only the replay
  // path's own fresh check stands between the retry and the stored message.
  h.armCommit(h.revokeMember);
  const replay = await refusalOf(
    await h.request('bob', '/messages', 'POST', input),
  );
  expect(replay).toEqual(fresh);
  // No new or changed message.
  const messages = h.runtime.store.history(h.scope).messages;
  expect(messages.map((message) => message.messageId)).toEqual([
    sent.messageId,
  ]);
  expect(messages[0]).toMatchObject({
    text: 'Sent before access was revoked',
  });
  expect(messages[0]!.editedAt).toBeUndefined();
  expect(messages[0]!.deletedAt).toBeUndefined();
});

test('message files: a store root that cannot be created is files unavailable, not the room (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const h = await harness();
  const f = await aliceFiles(h);
  const mkdir = fs.mkdirSync;
  let reached = 0;
  const spy = vi
    .spyOn(fs.default, 'mkdirSync')
    .mockImplementation((...args: Parameters<typeof fs.mkdirSync>) => {
      if (args[0] === f.root) {
        reached++;
        throw Object.assign(new Error('root directory ENOSPC'), {
          code: 'ENOSPC',
        });
      }
      return Reflect.apply(mkdir, fs, args);
    });
  syncBuiltinESMExports();
  let response: Response;
  try {
    response = await h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('root.png')],
    });
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(reached).toBe(1);
  await unavailable(response!);
  expect(Array.isArray(await f.upload(png('recovered.png')))).toBe(true);
});

test('message files: an exclusive staging write never touches a file it did not create (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { publishThroughOwnedFile } = await import(
    '../../services/orchestration/owned-staging-file.js'
  );
  const root = makeTempDir('r8-owned-collision-');
  const path = join(root, 'staging');
  fs.writeFileSync(path, 'prior-owner');
  let published = false;
  expect(() =>
    publishThroughOwnedFile(path, 'new-data', () => {
      published = true;
    }),
  ).toThrow(expect.objectContaining({ code: 'EEXIST' }));
  expect(published).toBe(false);
  expect(fs.readFileSync(path, 'utf8')).toBe('prior-owner');
});

test.skipIf(process.getuid?.() === 0)(
  'message files: when the diagnostic cannot be written, the server log still names each damaged record (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const { installLoggerLineSink } = await import('../../utils/logger.js');
    const h = await harness();
    const f = await aliceFiles(h);
    const damaged = await bobsRecord(h, f);
    const [gone] = (await f.upload(
      pngVariant('gone.png', 'diagnostic-signal'),
    )) as { id: string }[];
    const sent = await f.send([gone]);
    fs.writeFileSync(damaged.path, '{');
    const staging = join(f.root, 'staging');
    fs.chmodSync(staging, 0o500);
    const lines: string[] = [];
    installLoggerLineSink({
      writeLine(line) {
        lines.push(line);
      },
    });
    let response: Response;
    try {
      expect(await f.remove(sent.messageId)).toBe(200);
      response = await h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [png('paused.png')],
      });
    } finally {
      installLoggerLineSink(undefined);
      fs.chmodSync(staging, 0o700);
    }
    // The room is told only the generic code; the path is operator-only.
    const body = JSON.stringify(await response!.clone().json());
    expect(body).not.toContain(damaged.path);
    await unavailable(response!);
    expect(fs.existsSync(join(f.root, 'reclamation-blocked.json'))).toBe(false);
    expect(
      lines.some(
        (line) =>
          line.includes(damaged.path) &&
          line.includes('no readable blob reference'),
      ),
    ).toBe(true);
  },
);

test('message files: the diagnostic words each item by its kind (#4852 review)', async () => {
  const fs = await import('node:fs');
  const h = await harness();
  const f = await aliceFiles(h);
  await f.upload(png('warm.png'));
  const marker = join(f.root, 'reclamation-blocked.json');
  const attempt = () =>
    h.request('alice', '/attachments', 'POST', {
      ...guard(f.a),
      attachments: [png('next.png')],
    });
  // Only a leftover repair/: no bindings/ instruction.
  fs.mkdirSync(join(f.root, 'repair', 'operator'), { recursive: true });
  fs.writeFileSync(join(f.root, 'repair', 'operator', 'pending.json'), '{');
  await unavailable(await attempt());
  const repairOnly = JSON.parse(fs.readFileSync(marker, 'utf8')).note;
  expect(repairOnly).toContain('remove repair/');
  expect(repairOnly).not.toContain('fix each listed path under bindings/');
  // Only a damaged record: no repair/ instruction.
  fs.rmSync(join(f.root, 'repair'), { recursive: true });
  const damaged = await bobsRecord(h, f);
  fs.writeFileSync(damaged.path, '{');
  await unavailable(await attempt());
  const bindingsOnly = JSON.parse(fs.readFileSync(marker, 'utf8')).note;
  expect(bindingsOnly).toContain('fix each listed path under bindings/');
  expect(bindingsOnly).not.toContain('repair/');
});

test.skipIf(process.getuid?.() === 0)(
  'message files: a bindings root linked through an untraversable target is unavailable and keeps its bytes (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const h = await harness();
    const f = await aliceFiles(h);
    const [file] = (await f.upload(
      pngVariant('retained.png', 'bindings-eacces'),
    )) as { id: string }[];
    const sent = await f.send([file]);
    const blob = await aliceBlob(f, file!.id);
    const bindings = join(f.root, 'bindings');
    const parent = join(h.home, 'offline-moved');
    fs.mkdirSync(parent);
    const target = join(parent, 'bindings');
    fs.renameSync(bindings, target);
    fs.symlinkSync(target, bindings, 'dir');
    fs.chmodSync(parent, 0o000);
    let lookupCode: string | undefined;
    let response: Response;
    try {
      try {
        fs.statSync(bindings);
      } catch (e) {
        lookupCode = (e as NodeJS.ErrnoException).code;
      }
      response = await h.request('alice', '/attachments', 'POST', {
        ...guard(f.a),
        attachments: [png('blocked.png')],
      });
      expect(await f.remove(sent.messageId)).toBe(200);
    } finally {
      fs.chmodSync(parent, 0o700);
    }
    expect(lookupCode).toBe('EACCES');
    await unavailable(response!);
    expect(fs.existsSync(blob)).toBe(true);
    fs.unlinkSync(bindings);
    fs.renameSync(target, bindings);
    expect(Array.isArray(await f.upload(png('recovered.png')))).toBe(true);
    expect(fs.existsSync(blob)).toBe(false);
  },
);

test('members (#4799): only a current room reader may list, and the list is active people with id, name and kind only', async () => {
  const h = await harness('viewer');
  const general = await h.discover('alice');
  // A viewer already reads this Project's rooms, so it may list. Exactly
  // three public fields leave the service, even when the port offers more.
  const response = await h.request('bob', '/members');
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).not.toContain('example.invalid');
  const listed = JSON.parse(text).data as {
    members: Record<string, unknown>[];
  };
  expect(listed.members).toHaveLength(2);
  for (const entry of listed.members)
    expect(Object.keys(entry).sort()).toEqual(['displayName', 'id', 'kind']);
  // A signed-in person who is not a member is refused and sees no roster,
  // on the default room and on a channel address alike.
  for (const path of [
    '/api/projects/example/room/members',
    `/api/projects/example/channels/${general.roomId}/members`,
  ]) {
    const refused = await h.app.request(path, {
      headers: { authorization: 'Bearer carol-session' },
    });
    expect(refused.status, path).toBe(403);
    expect(await refused.text()).not.toContain('Alice');
  }
  // A revoked member is refused too, and no longer listed for anyone.
  h.revokeMember();
  const revoked = await h.request('bob', '/members');
  expect(revoked.status).toBe(403);
  expect(await revoked.text()).not.toContain('Alice');
  const after = (await data(await h.request('alice', '/members'))) as {
    members: { id: string }[];
  };
  expect(after.members.map((m) => m.id)).toEqual([owner.id]);
});

test('live (#4798): a member revoked mid-stream gets revoked and nothing after it: no typing, presence or messages', async () => {
  const h = await harness();
  const a = await h.discover('alice');
  const stream = liveReader(await live(h, 'bob', [a.roomId]));
  await stream.until('subscribed');
  const seen: ProjectRoomLiveFrame['kind'][] = [];
  const reading = (async () => {
    try {
      for (;;) {
        const frame = await stream.next();
        seen.push(frame.kind);
        if (frame.kind === 'revoked') return;
      }
    } catch {
      /* The stream ended. */
    }
  })();
  // Let the baseline frames arrive, then revoke and make the room busy.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const before = seen.length;
  h.revokeMember();
  const aliceClient = randomUUID();
  await h.request('alice', '/presence', 'POST', {
    ...guard(a),
    clientId: aliceClient,
    state: 'join',
  });
  await h.request('alice', '/typing', 'POST', {
    ...guard(a),
    clientId: aliceClient,
    typing: true,
  });
  await h.request('alice', '/messages', 'POST', {
    ...guard(a),
    intentId: randomUUID(),
    text: 'after the revocation',
  });
  await Promise.race([
    reading,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  // The per-frame re-check answers with `revoked`, and nothing else gets out.
  expect(seen.slice(before)).toEqual(['revoked']);
  await stream.cancel().catch(() => {});
});
