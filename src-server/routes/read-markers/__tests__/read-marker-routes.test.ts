/**
 * #3075: server-kept read markers, driven through the real routes. Every test
 * composes the real `/api/read-markers` and `/api/conversations` routes over
 * the real `ReadMarkerService`, the real version sources and the real file
 * store in a temporary directory. Only the conversation/room readers below
 * the version sources are fixtures.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import {
  READ_MARKER_REFUSAL_CODES,
  READ_MARKER_SUMMARY_MAX_TARGETS,
  READ_MARKER_UNREAD_COUNT_CAP,
  type ReadMarkerTarget,
} from '@kontourai/station-contracts/read-markers';
import {
  parseHostedTenantRegistry,
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { FileStorageNotFoundError } from '../../../domain/project-file-transactions.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { FileConversationAcknowledgementStore } from '../../../services/orchestration/conversation-acknowledgement-store.js';
import { ProjectRoomRefusal } from '../../../services/projects/project-room-store.js';
import {
  ReadMarkerService,
  readMarkerPersonKey,
} from '../../../services/read-markers/read-marker-service.js';
import {
  FileReadMarkerStore,
  READ_MARKER_STORE_FILE,
} from '../../../services/read-markers/read-marker-store.js';
import { upgradeReadMarkerStore } from '../../../services/read-markers/read-marker-upgrade.js';
import {
  projectRoomVersionSource,
  taskRoomVersionSource,
} from '../../../services/read-markers/room-version-sources.js';
import { createChatConversationId } from '../../chat/chat-persistence.js';
import {
  createAgentConversationVersionSource,
  createGlobalConversationRoutes,
} from '../../chat/conversations.js';
import { createReadMarkerRoutes } from '../read-marker-routes.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as any;

const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-01T10:05:00.000Z';
const V1 = Date.parse(T1);
const V2 = Date.parse(T2);

function conversation(id: string, updatedAt: string): ConversationListItem {
  return {
    id,
    source: 'runtime',
    agentSlug: agentId('default'),
    title: id,
    createdAt: T1,
    updatedAt,
    messageCount: 2,
    mutable: false,
    answerability: { answerable: true },
  };
}

/**
 * An inventory item as the wire carries it: `readState` is either the known
 * answer or `{ version, unavailable: true }`, so a test reads either field.
 */
type InventoryItem = Omit<ConversationListItem, 'readState'> & {
  readState?: {
    version: number;
    seenVersion?: number;
    unread?: boolean;
    unavailable?: true;
  };
};

let dir: string;
/** Everything either marker store holds: room markers and acknowledgements. */
const storedMarkers = () => {
  const acknowledgementsPath = join(dir, 'conversation-acknowledgements.json');
  return {
    ...JSON.parse(readFileSync(join(dir, READ_MARKER_STORE_FILE), 'utf8'))
      .markers,
    ...(existsSync(acknowledgementsPath)
      ? JSON.parse(readFileSync(acknowledgementsPath, 'utf8')).acknowledgements
      : {}),
  };
};
// Removed after each test whether it passed or not (#2421).
const makeTempDir = trackTempDirs();
beforeEach(() => {
  dir = makeTempDir('station-read-marker-routes-');
});

/**
 * One Station: mutable conversation versions (the history index the
 * inventory reads), a Project room and a Task room, and people told apart by
 * a test header standing in for the principal resolver. A header value with
 * no colon is a bare principal id, as the runtime resolves it.
 */
function station(
  options: {
    conversations?: Map<string, string>;
    /** Which person may read which conversation ids; absent = everyone. */
    readable?: (person: string, conversationId: string) => boolean;
    room?: { roomId: string; lastSeq: number; members: string[] };
    taskRoom?: {
      channelId: string;
      epoch: number;
      throughSeq: number;
      members: string[];
    };
    /**
     * Where read state began (the migration cutoff, in these fixtures'
     * epoch-ms versions); epoch 0 unless a test says otherwise.
     */
    baseline?: string;
    /**
     * A hosted Station with tenant `alpha`. The test header names a verified
     * person, or `tenant-only` for a request carrying only the tenant.
     */
    hosted?: boolean;
    /**
     * The real file memory adapter over this test's directory, so a
     * conversation id reaches the real path mapping (`agents/default/...`).
     */
    realFileMemory?: boolean;
    /** Personal file-backed conversations, as a memory adapter holds them. */
    fileConversations?: Array<{
      id: string;
      userId: string;
      resourceId: string;
      updatedAt: string;
    }>;
  } = {},
) {
  const conversations = options.conversations ?? new Map([['c1', T1]]);
  const personOf = (request: Request) =>
    request.headers.get('x-test-person') ?? '';
  // `owner-phone` is a paired device with owner standing, `visitor-phone`
  // one without; both reach the service as device principals.
  const principalOf = (person: string) =>
    person === 'operator'
      ? LOCAL_OPERATOR_PRINCIPAL_ID
      : person === 'owner-alias'
        ? 'owner-alias'
        : person.endsWith('-phone')
          ? `human:device:${person}`
          : `human:test:${person}`;
  const hostedRegistry = parseHostedTenantRegistry({
    schemaVersion: 1,
    tenants: [{ id: 'alpha', authority: 'alpha.station.test' }],
  });
  const authorityFor = (request: Request): SessionReadAuthority =>
    options.hosted
      ? sessionReadAuthorityFromRequest(
          personOf(request) === 'tenant-only'
            ? 'tenant:alpha'
            : principalOf(personOf(request) || 'nobody'),
          { tenantId: tenantId('alpha') },
          hostedRegistry,
        )
      : sessionReadAuthorityFromRequest(
          principalOf(personOf(request) || 'nobody'),
          undefined,
          undefined,
        );
  /** The request's resolved principal, as the runtime resolver reports it. */
  const principalFor = (request: Request): PrincipalRef =>
    personOf(request) === 'tenant-only'
      ? { id: 'tenant:alpha', kind: 'tenant', display: 'alpha' }
      : {
          id: principalOf(personOf(request) || 'nobody'),
          kind: 'human',
          display: personOf(request) || 'nobody',
        };
  const fileConversations = options.fileConversations ?? [];
  const fileAdapter = {
    getConversation: vi.fn(
      async (id: string) =>
        fileConversations.find((entry) => entry.id === id) ?? null,
    ),
    queryConversations: vi.fn(
      async (query: { userId: string; resourceId: string }) =>
        fileConversations
          .filter(
            (entry) =>
              entry.userId === query.userId &&
              entry.resourceId === query.resourceId,
          )
          .map((entry) => ({ ...entry, title: entry.id, createdAt: T1 })),
    ),
    getMessages: vi.fn(async () => []),
  };
  const memoryAdapters = new Map(
    options.realFileMemory
      ? [['default', new FileMemoryAdapter({ projectHomeDir: dir })]]
      : fileConversations.length > 0
        ? [['default', fileAdapter as never]]
        : [],
  );
  const changed: string[] = [];
  const reader = {
    listConversationHistoryPage: vi.fn(
      async (authority: SessionReadAuthority) => ({
        items: [...conversations]
          .filter(
            ([id]) =>
              options.readable?.(
                authority.userId.replace(/^human:test:/, ''),
                id,
              ) ?? true,
          )
          .map(([id, updatedAt]) => conversation(id, updatedAt)),
        hasMore: false,
      }),
    ),
    readSessionConversation: vi.fn(async () => null),
    searchSessionMessages: vi.fn(() => []),
    successorConversationId: () => undefined,
  };
  // The baseline in both spaces: the fixtures' versions are epoch ms.
  const baselineAt = options.baseline ? Date.parse(options.baseline) : 0;
  const store = new FileReadMarkerStore(dir);
  // Read state begins as the runtime begins it, once per home, here at a
  // cutoff and time both `baselineAt`.
  upgradeReadMarkerStore({
    store,
    events: { contentUpgradeFence: () => baselineAt },
    hosted: options.hosted === true,
    now: new Date(baselineAt),
  });
  const acknowledgements = new FileConversationAcknowledgementStore(dir);
  const service = new ReadMarkerService({
    store,
    conversations: acknowledgements,
    // As the runtime wires it (`readMarkerPersonKey`). No test person is a
    // caller that is not one.
    personKeyFor: (c) =>
      c.req.header('x-test-person')
        ? readMarkerPersonKey({
            authority: authorityFor(c.req.raw),
            principal: () => principalFor(c.req.raw),
            isOwnerDevice: (deviceId) => deviceId === 'owner-phone',
          })
        : undefined,
    onChanged: (personKey: string) => changed.push(personKey),
    agentConversations: createAgentConversationVersionSource({
      memoryAdapters,
      sessionConversationReader: reader,
      authorityFor,
      // These fixtures have no lifecycle bookkeeping, so each runtime
      // conversation's content version is the epoch ms of its `updatedAt`:
      // monotonic per conversation, as the event store's sequence is.
      conversationContent: {
        readConversationContentVersions: (ids) =>
          new Map(
            ids.flatMap((id) => {
              const at = conversations.get(id);
              return at ? [[id, Date.parse(at)] as const] : [];
            }),
          ),
      },
    }),
    projectRooms: projectRoomVersionSource({
      // The room service looks the id up as one of the Project's channels.
      async discover(request, slug, channelId) {
        const room = options.room;
        if (slug === 'missing') throw new FileStorageNotFoundError('missing');
        if (
          !room ||
          slug !== 'alpha' ||
          channelId !== room.roomId ||
          !room.members.includes(personOf(request))
        )
          throw new ProjectRoomRefusal('not_found');
        return {
          data: {
            roomId: room.roomId,
            checkpoint: { roomId: room.roomId, lastSeq: room.lastSeq },
          },
        };
      },
    }),
    taskRooms: taskRoomVersionSource({
      async history({ taskId, request }) {
        const room = options.taskRoom;
        if (
          !room ||
          taskId !== 'task-1' ||
          !room.members.includes(personOf(request))
        )
          return { kind: 'not-found' as const };
        return {
          kind: 'available' as const,
          records: [],
          hasMore: false,
          integrity: 'L0' as const,
          checkpoint: {
            channelId: room.channelId,
            epoch: room.epoch,
            throughSeq: room.throughSeq,
            checkpointDigest: 'd',
            retainedAnchorSeq: 0,
            retainedAnchorDigest: 'a',
          },
        };
      },
    }),
    now: () => new Date('2026-11-11T00:00:00.000Z'),
  });
  const app = new Hono();
  app.route('/api/read-markers', createReadMarkerRoutes({ service }));
  app.route(
    '/api/conversations',
    createGlobalConversationRoutes(
      memoryAdapters,
      { getConversation: () => null },
      logger,
      undefined,
      reader,
      () => 'unused',
      acknowledgements,
      authorityFor,
      undefined,
      undefined,
      undefined,
      service,
    ),
  );
  const post = (path: string, person: string | undefined, body: unknown) =>
    app.request(`/api/read-markers/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(person ? { 'x-test-person': person } : {}),
      },
      body: JSON.stringify(body),
    });
  return {
    conversations,
    options,
    changed,
    principalFor,
    mark: (
      person: string | undefined,
      target: ReadMarkerTarget,
      version: number,
    ) => post('mark', person, { target, version }),
    summary: (person: string | undefined, targets: unknown[]) =>
      post('summary', person, { targets }),
    /**
     * What a current client sends for a row it rendered: the inventory
     * `updatedAt` and the content version rendered (in these fixtures, the
     * same instant).
     */
    acknowledge: (person: string, conversationId: string, updatedAt: string) =>
      app.request(
        `/api/conversations/${encodeURIComponent(conversationId)}/acknowledgement`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-test-person': person,
          },
          body: JSON.stringify({
            updatedAt,
            readVersion: Date.parse(updatedAt),
          }),
        },
      ),
    async inventory(person: string) {
      const body = await json(
        await app.request('/api/conversations', {
          headers: { 'x-test-person': person },
        }),
      );
      return new Map<string, InventoryItem>(
        body.data.items.map((item: InventoryItem) => [item.id, item]),
      );
    },
  };
}

const c1: ReadMarkerTarget = {
  kind: 'agent-conversation',
  conversationId: 'c1',
};

describe('POST /api/read-markers/mark', () => {
  test('marking the displayed version clears unread in the inventory, for that person only', async () => {
    const s = station();
    expect((await s.inventory('ada')).get('c1')?.readState).toEqual({
      version: V1,
      seenVersion: 0,
      unread: true,
    });

    const response = await s.mark('ada', c1, V1);
    expect(response.status).toBe(200);
    expect((await json(response)).data).toEqual({
      target: c1,
      latestVersion: V1,
      seenVersion: V1,
      unread: false,
    });
    expect((await s.inventory('ada')).get('c1')?.readState?.unread).toBe(false);
    // A second person reading on their own device is unaffected.
    expect((await s.inventory('bo')).get('c1')?.readState?.unread).toBe(true);

    // New output makes it unread again, deterministically, with no client clock.
    s.conversations.set('c1', T2);
    expect((await s.inventory('ada')).get('c1')?.readState).toEqual({
      version: V2,
      seenVersion: V1,
      unread: true,
    });
  });

  test('is monotonic: an older or replayed mark never moves the marker backwards', async () => {
    const s = station({ conversations: new Map([['c1', T2]]) });
    expect((await s.mark('ada', c1, V2)).status).toBe(200);

    const late = await s.mark('ada', c1, V1);
    expect(late.status).toBe(200);
    expect((await json(late)).data).toMatchObject({
      seenVersion: V2,
      unread: false,
    });
    expect((await s.inventory('ada')).get('c1')?.readState).toEqual({
      version: V2,
      seenVersion: V2,
      unread: false,
    });
    const replay = await s.mark('ada', c1, V2);
    expect((await json(replay)).data.seenVersion).toBe(V2);
  });

  test('refuses a version past the conversation current version and writes nothing', async () => {
    const s = station();
    const response = await s.mark('ada', c1, V1 + 1);
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      success: false,
      code: READ_MARKER_REFUSAL_CODES.futureVersion,
      latestVersion: V1,
    });
    expect((await s.inventory('ada')).get('c1')?.readState?.seenVersion).toBe(
      0,
    );
  });

  test('a conversation the caller cannot read is 404 and leaves no marker', async () => {
    const s = station({
      readable: (person, id) => !(person === 'bo' && id === 'c1'),
    });
    const response = await s.mark('bo', c1, V1);
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Conversation not found',
    });
    const unknown = await s.mark(
      'ada',
      { kind: 'agent-conversation', conversationId: 'nope' },
      0,
    );
    expect(unknown.status).toBe(404);
    expect(storedMarkers()).toEqual({});
  });

  test('refuses malformed bodies and a caller that is not a person', async () => {
    const s = station();
    for (const version of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 2]) {
      expect((await s.mark('ada', c1, version as number)).status).toBe(400);
    }
    const unknownField = await s.summary('ada', [
      { kind: 'agent-conversation', conversationId: 'c1', owner: 'bo' },
    ]);
    expect(unknownField.status).toBe(400);
    // Not a person: refused as the acknowledgement route refuses one, and
    // nothing is written.
    for (const response of [
      await s.mark(undefined, c1, V1),
      await s.summary(undefined, [c1]),
    ]) {
      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({
        success: false,
        error: 'Only a person has read state',
      });
    }
    expect(storedMarkers()).toEqual({});
  });

  test('history from before the store existed reads as seen, and a mark below that baseline never regresses it', async () => {
    const s = station({
      conversations: new Map([
        ['c1', T1],
        ['c2', T2],
      ]),
      baseline: '2026-11-01T10:02:00.000Z',
    });
    // The owner (the local operator) is the one person with a baseline.
    const before = await s.inventory('operator');
    expect(before.get('c1')?.readState?.unread).toBe(false);
    expect(before.get('c2')?.readState?.unread).toBe(true);

    const low = await s.mark('operator', c1, V1 - 1);
    expect((await json(low)).data.unread).toBe(false);
    expect((await s.inventory('operator')).get('c1')?.readState?.unread).toBe(
      false,
    );
  });

  test('survives a reload: a new store over the same home reads the same markers', async () => {
    const s = station();
    await s.mark('ada', c1, V1);
    const reloaded = station({ conversations: s.conversations });
    expect((await reloaded.inventory('ada')).get('c1')?.readState?.unread).toBe(
      false,
    );
  });
});

describe('POST /api/read-markers/summary', () => {
  test('answers many conversations at once, in request order, without naming a mention state', async () => {
    const s = station({
      conversations: new Map([
        ['c1', T1],
        ['c2', T2],
      ]),
      room: { roomId: 'room-1', lastSeq: 7, members: ['ada'] },
      taskRoom: {
        channelId: 'ch-1',
        epoch: 1,
        throughSeq: 4,
        members: ['ada'],
      },
    });
    await s.mark('ada', c1, V1);
    await s.mark(
      'ada',
      { kind: 'project-room', projectSlug: 'alpha', roomId: 'room-1' },
      5,
    );

    const response = await s.summary('ada', [
      { kind: 'task-room', taskId: 'task-1' },
      { kind: 'agent-conversation', conversationId: 'c2' },
      { kind: 'project-room', projectSlug: 'alpha', roomId: 'room-1' },
      c1,
      { kind: 'agent-conversation', conversationId: 'missing' },
    ]);
    expect(response.status).toBe(200);
    expect((await json(response)).data.items).toEqual([
      {
        target: { kind: 'task-room', taskId: 'task-1' },
        latestVersion: 4,
        seenVersion: 0,
        unread: true,
        unreadCount: 4,
      },
      {
        target: { kind: 'agent-conversation', conversationId: 'c2' },
        latestVersion: V2,
        seenVersion: 0,
        unread: true,
      },
      {
        target: {
          kind: 'project-room',
          projectSlug: 'alpha',
          roomId: 'room-1',
        },
        latestVersion: 7,
        seenVersion: 5,
        unread: true,
        unreadCount: 2,
      },
      { target: c1, latestVersion: V1, seenVersion: V1, unread: false },
      {
        target: { kind: 'agent-conversation', conversationId: 'missing' },
        unavailable: true,
      },
    ]);
  });

  test(`refuses more than ${READ_MARKER_SUMMARY_MAX_TARGETS} targets rather than truncating`, async () => {
    expect(READ_MARKER_SUMMARY_MAX_TARGETS).toBe(100);
    const s = station();
    const targets = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: 'agent-conversation',
        conversationId: `c${i}`,
      }));
    const atBound = await s.summary('ada', targets(100));
    expect(atBound.status).toBe(200);
    expect((await json(atBound)).data.items).toHaveLength(100);

    const past = await s.summary('ada', targets(101));
    expect(past.status).toBe(400);
    expect(await json(past)).toMatchObject({
      success: false,
      code: READ_MARKER_REFUSAL_CODES.tooManyTargets,
    });
  });
});

describe('room markers', () => {
  test('a Project room is keyed by its room id and refuses another room id or a non-member', async () => {
    const s = station({
      room: { roomId: 'room-1', lastSeq: 3, members: ['ada'] },
    });
    const room: ReadMarkerTarget = {
      kind: 'project-room',
      projectSlug: 'alpha',
      roomId: 'room-1',
    };
    expect((await s.mark('ada', room, 4)).status).toBe(409);
    expect((await s.mark('ada', room, 3)).status).toBe(200);
    expect((await s.mark('ada', { ...room, roomId: 'room-2' }, 1)).status).toBe(
      404,
    );
    expect((await s.mark('bo', room, 1)).status).toBe(404);
    // An unknown Project answers exactly as a room the caller cannot read.
    expect(
      (await s.mark('ada', { ...room, projectSlug: 'missing' }, 1)).status,
    ).toBe(404);
    const missing = await json(
      await s.summary('ada', [{ ...room, projectSlug: 'missing' }]),
    );
    expect(missing.data.items).toEqual([
      { target: { ...room, projectSlug: 'missing' }, unavailable: true },
    ]);
    const summary = await json(await s.summary('ada', [room]));
    expect(summary.data.items[0]).toMatchObject({
      seenVersion: 3,
      unread: false,
      unreadCount: 0,
    });
  });

  test('a room marker is monotonic: an older or replayed mark never moves it back', async () => {
    const s = station({
      room: { roomId: 'room-1', lastSeq: 9, members: ['ada'] },
    });
    const room: ReadMarkerTarget = {
      kind: 'project-room',
      projectSlug: 'alpha',
      roomId: 'room-1',
    };
    expect((await json(await s.mark('ada', room, 7))).data.seenVersion).toBe(7);
    const late = await json(await s.mark('ada', room, 2));
    expect(late.data).toMatchObject({ seenVersion: 7, unreadCount: 2 });
    const summary = await json(await s.summary('ada', [room]));
    expect(summary.data.items[0].seenVersion).toBe(7);
  });

  test('a Task room marker belongs to its epoch; a re-homed room starts unread', async () => {
    const taskRoom = {
      channelId: 'ch-1',
      epoch: 1,
      throughSeq: 9,
      members: ['ada'],
    };
    const s = station({ taskRoom });
    const target: ReadMarkerTarget = { kind: 'task-room', taskId: 'task-1' };
    expect((await s.mark('ada', target, 9)).status).toBe(200);
    taskRoom.epoch = 2;
    taskRoom.throughSeq = 2;
    const summary = await json(await s.summary('ada', [target]));
    expect(summary.data.items[0]).toMatchObject({
      latestVersion: 2,
      seenVersion: 0,
      unread: true,
      unreadCount: 2,
    });
  });

  test(`room unread counts stop at ${READ_MARKER_UNREAD_COUNT_CAP}`, async () => {
    expect(READ_MARKER_UNREAD_COUNT_CAP).toBe(99);
    const s = station({
      room: { roomId: 'room-1', lastSeq: 500, members: ['ada'] },
    });
    const summary = await json(
      await s.summary('ada', [
        { kind: 'project-room', projectSlug: 'alpha', roomId: 'room-1' },
      ]),
    );
    expect(summary.data.items[0].unreadCount).toBe(99);
  });
});

describe('one marker per person', () => {
  test('the inventory acknowledgement route is the same marker, and refuses a version the conversation has not reached', async () => {
    const s = station();
    const future = await s.acknowledge('ada', 'c1', '2026-11-01T10:00:00.001Z');
    expect(future.status).toBe(409);
    expect(await json(future)).toMatchObject({
      success: false,
      code: READ_MARKER_REFUSAL_CODES.futureVersion,
      latestVersion: V1,
    });
    expect(storedMarkers()).toEqual({});

    expect((await s.acknowledge('ada', 'c1', T1)).status).toBe(200);
    const summary = await json(await s.summary('ada', [c1]));
    expect(summary.data.items[0]).toMatchObject({
      seenVersion: V1,
      unread: false,
    });
    // An older acknowledgement through either route never moves it back.
    await s.mark('ada', c1, V1 - 1000);
    expect((await s.inventory('ada')).get('c1')?.readState?.seenVersion).toBe(
      V1,
    );
  });

  test("the owner's devices share one marker; another person keeps their own", async () => {
    const s = station();
    // The local operator (the desktop) reads it...
    expect((await s.mark('operator', c1, V1)).status).toBe(200);
    // ...and the owner's other principal sees it read, as their phone would.
    expect(
      (await s.inventory('owner-alias')).get('c1')?.readState?.unread,
    ).toBe(false);
    expect((await s.inventory('ada')).get('c1')?.readState?.unread).toBe(true);
  });
});

describe('review fixes (#4813)', () => {
  test('hosted: one person reading marks it read for them only, and a tenant-only caller has no read state', async () => {
    const s = station({
      hosted: true,
      room: { roomId: 'room-1', lastSeq: 4, members: ['alice', 'bob'] },
    });
    const room: ReadMarkerTarget = {
      kind: 'project-room',
      projectSlug: 'alpha',
      roomId: 'room-1',
    };
    expect((await s.mark('alice', room, 4)).status).toBe(200);
    expect((await s.mark('alice', c1, V1)).status).toBe(200);
    const bob = await json(await s.summary('bob', [room, c1]));
    expect(
      bob.data.items.map((item: { unread: boolean }) => item.unread),
    ).toEqual([true, true]);
    expect((await s.inventory('bob')).get('c1')?.readState?.unread).toBe(true);
    const alice = await json(await s.summary('alice', [room, c1]));
    expect(
      alice.data.items.map((item: { unread: boolean }) => item.unread),
    ).toEqual([false, false]);
    // Only the tenant is known: not a person, so no person's read state.
    expect((await s.mark('tenant-only', room, 4)).status).toBe(403);
    expect((await s.summary('tenant-only', [room])).status).toBe(403);
  });

  test('a successful advance announces the change for that person; a no-op does not', async () => {
    const s = station({
      room: { roomId: 'room-1', lastSeq: 4, members: ['ada'] },
    });
    const room: ReadMarkerTarget = {
      kind: 'project-room',
      projectSlug: 'alpha',
      roomId: 'room-1',
    };
    await s.mark('ada', c1, V1);
    await s.mark('ada', room, 3);
    await s.mark('ada', room, 2);
    await s.mark('ada', c1, V1);
    expect(s.changed).toEqual(['human:test:ada', 'human:test:ada']);
  });

  test("an owned file-backed conversation past the inventory window can still be marked; another owner's cannot", async () => {
    const s = station({
      conversations: new Map(
        Array.from({ length: 100 }, (_, i) => [`recent-${i}`, T2] as const),
      ),
      fileConversations: [
        {
          id: 'old-file',
          userId: 'human:test:ada',
          resourceId: 'default',
          updatedAt: T1,
        },
        {
          id: 'bos-file',
          userId: 'human:test:bo',
          resourceId: 'default',
          updatedAt: T1,
        },
      ],
    });
    const old: ReadMarkerTarget = {
      kind: 'agent-conversation',
      conversationId: 'old-file',
    };
    const mark = await s.mark('ada', old, V1);
    expect(mark.status).toBe(200);
    expect((await json(mark)).data).toMatchObject({
      seenVersion: V1,
      unread: false,
    });
    expect((await s.acknowledge('ada', 'old-file', T1)).status).toBe(200);
    expect(
      (
        await s.mark(
          'ada',
          { kind: 'agent-conversation', conversationId: 'bos-file' },
          V1,
        )
      ).status,
    ).toBe(404);
  });

  test('a corrupt marker store is refused, never read as "read"', async () => {
    const s = station({
      room: { roomId: 'room-1', lastSeq: 4, members: ['ada'] },
    });
    writeFileSync(
      join(dir, READ_MARKER_STORE_FILE),
      JSON.stringify({
        version: 2,
        createdAt: 0,
        baselineSequence: 0,
        markers: {
          'human:test:ada': { 'project-room:room-1': { v: 'bad', at: T1 } },
        },
      }),
    );
    const response = await s.summary('ada', [
      { kind: 'project-room', projectSlug: 'alpha', roomId: 'room-1' },
    ]);
    expect(response.status).toBe(503);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Read state is unavailable.',
    });
  });
});

/** Writes a conversation record under `agents/default/memory/<relative>`. */
function plantFileConversation(relative: string, record: { id: string }) {
  const path = join(dir, 'agents', 'default', 'memory', relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      resourceId: 'default',
      userId: 'human:test:ada',
      title: record.id,
      metadata: {},
      createdAt: T1,
      updatedAt: T1,
      ...record,
    }),
  );
}

describe('delta review fixes (#4813)', () => {
  test('a file conversation id is one parsed path segment inside its directory, and the record must carry that id', async () => {
    const s = station({
      realFileMemory: true,
      // Pushes every file conversation past the first inventory page, so
      // each id below reaches the point lookup.
      conversations: new Map(
        Array.from({ length: 100 }, (_, i) => [`recent-${i}`, T2] as const),
      ),
    });
    plantFileConversation('escaped.json', { id: '../escaped' });
    plantFileConversation('conversations/sub/escaped.json', {
      id: 'sub/escaped',
    });
    plantFileConversation('conversations/real-1.json', { id: 'other-1' });
    plantFileConversation('conversations/default:1794.json', {
      id: 'default:1794',
    });
    const target = (conversationId: string): ReadMarkerTarget => ({
      kind: 'agent-conversation',
      conversationId,
    });
    for (const id of ['../escaped', 'sub/escaped', 'real-1', '..', '.']) {
      const response = await s.mark('ada', target(id), V1);
      expect(response.status, id).toBe(404);
    }
    // The router decodes `..%2Fescaped` to `../escaped` before the route.
    expect((await s.acknowledge('ada', '../escaped', T1)).status).toBe(404);
    // A double-encoded separator stays literal and is refused, not decoded.
    expect((await s.acknowledge('ada', '..%2Fescaped', T1)).status).toBe(404);
    const summary = await s.summary('ada', [
      target('../escaped'),
      target('real-1'),
    ]);
    expect((await json(summary)).data.items).toEqual([
      { target: target('../escaped'), unavailable: true },
      { target: target('real-1'), unavailable: true },
    ]);
    expect(storedMarkers()['human:test:ada'] ?? {}).toEqual({});
    // A real id, with the engine's colon, still resolves past the window.
    const real = await s.mark('ada', target('default:1794'), V1);
    expect(real.status).toBe(200);
    expect(storedMarkers()['human:test:ada']).toMatchObject({
      'agent-conversation:default:1794': { v: V1 },
    });
  });

  test('one person’s corrupt marker is theirs alone: another person keeps their read state and everyone keeps their conversations', async () => {
    const s = station({
      room: { roomId: 'room-1', lastSeq: 4, members: ['ada', 'bo'] },
    });
    expect((await s.acknowledge('ada', 'c1', T1)).status).toBe(200);
    writeFileSync(
      join(dir, READ_MARKER_STORE_FILE),
      // Ada's markers stay as they are; only Bo's record is broken.
      JSON.stringify({
        ...JSON.parse(readFileSync(join(dir, READ_MARKER_STORE_FILE), 'utf8')),
        markers: {
          ...JSON.parse(readFileSync(join(dir, READ_MARKER_STORE_FILE), 'utf8'))
            .markers,
          'human:test:bo': { 'project-room:room-1': { v: 'bad', at: T1 } },
        },
      }),
    );
    const room = {
      kind: 'project-room',
      projectSlug: 'alpha',
      roomId: 'room-1',
    };
    expect((await s.inventory('ada')).get('c1')?.readState).toEqual({
      version: V1,
      seenVersion: V1,
      unread: false,
    });
    expect((await s.summary('ada', [room])).status).toBe(200);
    // Bo's own record is refused, never read as "read": his room marker
    // and his conversation read state (unknown), and his conversations stay
    // listed.
    expect((await s.summary('bo', [room])).status).toBe(503);
    const bos = await s.inventory('bo');
    expect([...bos.keys()]).toEqual(['c1']);
    expect(bos.get('c1')?.readState).toEqual({
      version: V1,
      unavailable: true,
    });
  });

  test.each([
    [
      'a marker store nobody can decode',
      READ_MARKER_STORE_FILE,
      JSON.stringify({
        version: 2,
        createdAt: 'x',
        baselineSequence: 0,
        markers: {},
      }),
    ],
  ])(
    '%s reads as unknown for everyone, never as read, and the conversations stay listed',
    async (_name, file, text) => {
      const s = station();
      expect((await s.acknowledge('ada', 'c1', T1)).status).toBe(200);
      writeFileSync(join(dir, file), text);
      const inventory = await s.inventory('ada');
      expect([...inventory.keys()]).toEqual(['c1']);
      expect(inventory.get('c1')?.readState).toEqual({
        version: V1,
        unavailable: true,
      });
    },
  );

  test('an acknowledgement store nobody can decode costs only "last viewed": read state and conversations stay', async () => {
    const s = station();
    expect((await s.acknowledge('ada', 'c1', T1)).status).toBe(200);
    writeFileSync(
      join(dir, 'conversation-acknowledgements.json'),
      '{"version":',
    );
    const inventory = await s.inventory('ada');
    expect([...inventory.keys()]).toEqual(['c1']);
    // Read state lives in the read-marker store, never in "last viewed".
    expect(inventory.get('c1')?.readState).toEqual({
      version: V1,
      seenVersion: V1,
      unread: false,
    });
    expect(inventory.get('c1')?.acknowledgedAt).toBeUndefined();
  });
});

describe('file conversation ids keep their contract (#4813 round 3)', () => {
  test('an id `createChatConversationId` makes for a tailnet person resolves; separators, `..`, NUL and encoded separators do not', async () => {
    const s = station({
      realFileMemory: true,
      conversations: new Map(
        Array.from({ length: 100 }, (_, i) => [`recent-${i}`, T2] as const),
      ),
    });
    const tailnetId = createChatConversationId(
      'human:tailscale-serve:casey@example.test',
    );
    plantFileConversation(`conversations/${tailnetId}.json`, {
      id: tailnetId,
    });
    const target = (conversationId: string): ReadMarkerTarget => ({
      kind: 'agent-conversation',
      conversationId,
    });
    expect((await s.mark('ada', target(tailnetId), V1)).status).toBe(200);
    for (const id of [
      'a/b',
      'a\\b',
      '..',
      'a\u0000b',
      '..%2Fescaped',
      '..%2fescaped',
      '..%5Cescaped',
    ]) {
      // A record at the very path the id names, so a refusal is the rule's,
      // not a missing file's. A NUL cannot be in a file name.
      if (!id.includes('\u0000'))
        plantFileConversation(`conversations/${id}.json`, { id });
      const response = await s.mark('ada', target(id), V1);
      expect(response.status, JSON.stringify(id)).toBe(404);
    }
  });
});

describe('the migration baseline belongs to the personal owner alone (#4813 owner rule)', () => {
  const history = new Map([
    ['c1', T1],
    ['c2', T2],
  ]);

  test('a device with owner standing keeps its read state; a visitor device and any other person start unread', async () => {
    // Everyone below viewed c1 before the upgrade; none of that is sampled.
    for (const userId of ['human:device:visitor-phone', 'human:test:ada'])
      new FileConversationAcknowledgementStore(dir).acknowledge({
        userId,
        conversationId: 'c1',
        updatedAt: T1,
      });
    const s = station({
      conversations: history,
      baseline: '2026-11-01T10:02:00.000Z',
    });
    for (const owner of ['owner-phone', 'operator'])
      expect(
        (await s.inventory(owner)).get('c1')?.readState?.unread,
        owner,
      ).toBe(false);
    for (const other of ['visitor-phone', 'ada', 'bob'])
      expect(
        (await s.inventory(other)).get('c1')?.readState?.unread,
        other,
      ).toBe(true);
  });

  test('hosted: nobody has a baseline, including a person with a first-format record; their room markers carry over', async () => {
    writeFileSync(
      join(dir, READ_MARKER_STORE_FILE),
      JSON.stringify({
        version: 1,
        createdAt: 0,
        markers: {
          'tenant:alpha#human:test:ada': {
            'project-room:room-1': { v: 2, at: T1 },
          },
        },
      }),
    );
    const s = station({
      hosted: true,
      conversations: history,
      baseline: '2026-11-01T10:02:00.000Z',
      room: { roomId: 'room-1', lastSeq: 3, members: ['ada'] },
    });
    const room = {
      kind: 'project-room',
      projectSlug: 'alpha',
      roomId: 'room-1',
    };
    const adaRoom = await json(await s.summary('ada', [room]));
    expect(adaRoom.data.items[0].unreadCount).toBe(1);
    expect((await s.inventory('ada')).get('c1')?.readState).toMatchObject({
      unread: true,
    });
  });
});
