/**
 * #3075: server-kept read markers, driven through the real routes. Every test
 * composes the real `/api/read-markers` and `/api/conversations` routes over
 * the real `ReadMarkerService`, the real version sources and the real file
 * store in a temporary directory. Only the conversation/room readers below
 * the version sources are fixtures.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import {
  READ_MARKER_REFUSAL_CODES,
  READ_MARKER_SUMMARY_MAX_TARGETS,
  READ_MARKER_UNREAD_COUNT_CAP,
  type ReadMarkerTarget,
} from '@kontourai/station-contracts/read-markers';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { FileStorageNotFoundError } from '../../../domain/project-file-transactions.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import {
  conversationAcknowledgementKey,
  FileConversationAcknowledgementStore,
} from '../../../services/orchestration/conversation-acknowledgement-store.js';
import { ProjectRoomRefusal } from '../../../services/projects/project-room-store.js';
import { ReadMarkerService } from '../../../services/read-markers/read-marker-service.js';
import {
  FileReadMarkerStore,
  READ_MARKER_STORE_FILE,
} from '../../../services/read-markers/read-marker-store.js';
import {
  projectRoomVersionSource,
  taskRoomVersionSource,
} from '../../../services/read-markers/room-version-sources.js';
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
    agentSlug: 'default' as ConversationListItem['agentSlug'],
    title: id,
    createdAt: T1,
    updatedAt,
    messageCount: 2,
    mutable: false,
    answerability: { answerable: true },
  };
}

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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'station-read-marker-routes-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
    /** When the store is first created; epoch 0 unless a test says otherwise. */
    baseline?: string;
  } = {},
) {
  const conversations = options.conversations ?? new Map([['c1', T1]]);
  const personOf = (request: Request) =>
    request.headers.get('x-test-person') ?? '';
  const principalOf = (person: string) =>
    person === 'operator'
      ? LOCAL_OPERATOR_PRINCIPAL_ID
      : person === 'owner-alias'
        ? 'owner-alias'
        : `human:test:${person}`;
  const authorityFor = (request: Request): SessionReadAuthority =>
    sessionReadAuthorityFromRequest(
      principalOf(personOf(request) || 'nobody'),
      undefined,
      undefined,
    );
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
  const store = new FileReadMarkerStore(
    dir,
    () => new Date(options.baseline ?? 0),
  );
  const acknowledgements = new FileConversationAcknowledgementStore(dir);
  const service = new ReadMarkerService({
    store,
    conversations: acknowledgements,
    // As the runtime wires it: the inventory's own per-person key. No test
    // person is a caller that is not a person.
    personKeyFor: (c) =>
      c.req.header('x-test-person')
        ? conversationAcknowledgementKey(authorityFor(c.req.raw))
        : undefined,
    agentConversations: createAgentConversationVersionSource({
      memoryAdapters: new Map(),
      sessionConversationReader: reader,
      authorityFor,
    }),
    projectRooms: projectRoomVersionSource({
      async discover(request, slug) {
        const room = options.room;
        if (slug === 'missing') throw new FileStorageNotFoundError('missing');
        if (
          !room ||
          slug !== 'alpha' ||
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
      new Map(),
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
    mark: (
      person: string | undefined,
      target: ReadMarkerTarget,
      version: number,
    ) => post('mark', person, { target, version }),
    summary: (person: string | undefined, targets: unknown[]) =>
      post('summary', person, { targets }),
    acknowledge: (person: string, conversationId: string, updatedAt: string) =>
      app.request(
        `/api/conversations/${encodeURIComponent(conversationId)}/acknowledgement`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-test-person': person,
          },
          body: JSON.stringify({ updatedAt }),
        },
      ),
    async inventory(person: string) {
      const body = await json(
        await app.request('/api/conversations', {
          headers: { 'x-test-person': person },
        }),
      );
      return new Map<string, ConversationListItem>(
        body.data.items.map((item: ConversationListItem) => [item.id, item]),
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
    const before = await s.inventory('ada');
    expect(before.get('c1')?.readState?.unread).toBe(false);
    expect(before.get('c2')?.readState?.unread).toBe(true);

    const low = await s.mark('ada', c1, V1 - 1);
    expect((await json(low)).data.unread).toBe(false);
    expect((await s.inventory('ada')).get('c1')?.readState?.unread).toBe(false);
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
