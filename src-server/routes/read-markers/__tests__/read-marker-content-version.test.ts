/**
 * #3075 owner review: a read marker compares against the conversation's
 * CONTENT version, which moves only when something a person would read
 * arrives (a turn finishing or failing). Lifecycle bookkeeping, such as the
 * `session.exited` every open session gets when Station stops, moves the
 * inventory's `updatedAt` but must never make a read conversation unread.
 *
 * Real seam: a real event store and orchestration service behind the real
 * `/api/conversations`, acknowledgement and read-marker routes; the restart
 * closes both and reopens them on the same database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { FileConversationAcknowledgementStore } from '../../../services/orchestration/conversation-acknowledgement-store.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import {
  ReadMarkerService,
  readMarkerPersonKey,
} from '../../../services/read-markers/read-marker-service.js';
import { FileReadMarkerStore } from '../../../services/read-markers/read-marker-store.js';
import {
  createAgentConversationVersionSource,
  createGlobalConversationRoutes,
} from '../../chat/conversations.js';
import { createReadMarkerRoutes } from '../read-marker-routes.js';

const OWNER = 'owner-alpha';
const THREAD = 'thread-1';
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as never;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'read-marker-content-version-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One running Station over `dir`: event store, service and routes. */
function boot() {
  const eventStore = new EventStore(join(dir, 'orchestration.sqlite'));
  const service = new OrchestrationService({
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    eventBus: new EventBus(),
    eventStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
  } as never);
  const authorityFor = (): SessionReadAuthority =>
    sessionReadAuthorityFromRequest(OWNER, undefined, undefined);
  const acknowledgements = new FileConversationAcknowledgementStore(dir);
  const readMarkers = new ReadMarkerService({
    // Read state began long before this conversation.
    store: new FileReadMarkerStore(dir, () => new Date(0)),
    conversations: acknowledgements,
    personKeyFor: () =>
      readMarkerPersonKey({
        authority: authorityFor(),
        principal: () => ({ id: OWNER, kind: 'human', display: OWNER }),
      }),
    agentConversations: createAgentConversationVersionSource({
      memoryAdapters: new Map(),
      sessionConversationReader: service,
      authorityFor,
      conversationContent: eventStore,
    }),
    now: () => new Date('2026-11-12T00:00:00.000Z'),
  });
  const app = new Hono();
  app.route(
    '/api/read-markers',
    createReadMarkerRoutes({ service: readMarkers }),
  );
  app.route(
    '/api/conversations',
    createGlobalConversationRoutes(
      new Map(),
      { getConversation: () => null },
      logger,
      undefined,
      service as never,
      () => 'unused',
      acknowledgements,
      authorityFor,
      undefined,
      undefined,
      undefined,
      readMarkers,
    ),
  );
  return {
    eventStore,
    async inventory(): Promise<ConversationListItem> {
      const body = await json(await app.request('/api/conversations'));
      expect(body.data.items).toHaveLength(1);
      return body.data.items[0];
    },
    /** What the dock sends for the row on screen: the inventory version. */
    acknowledge(conversationId: string, updatedAt: string) {
      return app.request(
        `/api/conversations/${encodeURIComponent(conversationId)}/acknowledgement`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ updatedAt }),
        },
      );
    },
    mark(conversationId: string, version: number) {
      return app.request('/api/read-markers/mark', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: { kind: 'agent-conversation', conversationId },
          version,
        }),
      });
    },
    async stop() {
      await service.shutdown();
      eventStore.close();
    },
  };
}

function seedTurn(
  eventStore: EventStore,
  turnId: string,
  startedAt: string,
  completedAt: string,
) {
  eventStore.appendEvent({
    eventId: `${turnId}-start`,
    provider: 'claude',
    threadId: THREAD,
    createdAt: startedAt,
    method: 'turn.started',
    turnId,
    prompt: `prompt ${turnId}`,
  } as never);
  eventStore.appendEvent({
    eventId: `${turnId}-done`,
    provider: 'claude',
    threadId: THREAD,
    createdAt: completedAt,
    method: 'turn.completed',
    turnId,
  } as never);
}

test('a read conversation stays read across a stop and restart, and a new reply makes it unread again', async () => {
  let station = boot();
  station.eventStore.upsertSession({
    provider: 'claude',
    threadId: THREAD,
    status: 'running',
    createdAt: '2026-11-11T10:00:00.000Z',
    updatedAt: '2026-11-11T10:00:00.000Z',
  });
  station.eventStore.appendEvent({
    eventId: 'started',
    provider: 'claude',
    threadId: THREAD,
    createdAt: '2026-11-11T10:00:00.000Z',
    method: 'session.started',
    sessionId: THREAD,
    metadata: { userId: OWNER, agentSlug: 'claude' },
  } as never);
  seedTurn(
    station.eventStore,
    'first',
    '2026-11-11T10:00:01.000Z',
    '2026-11-11T10:00:05.000Z',
  );

  const fresh = await station.inventory();
  expect(fresh.readState).toMatchObject({ unread: true });
  // Read the way the dock records the row on screen.
  expect((await station.acknowledge(fresh.id, fresh.updatedAt)).status).toBe(
    200,
  );
  expect((await station.inventory()).readState).toMatchObject({
    unread: false,
  });

  // Station stops: every open session gets `session.exited`, exactly as
  // `finalizeStoppedAdapterSessions` writes it. It moves `updatedAt`.
  station.eventStore.appendEvent({
    eventId: 'exited',
    provider: 'claude',
    threadId: THREAD,
    createdAt: '2026-11-11T10:15:00.000Z',
    method: 'session.exited',
    sessionId: THREAD,
    reason: 'Station stopped',
  } as never);
  await station.stop();

  station = boot();
  try {
    const afterRestart = await station.inventory();
    // The bump reached the inventory, so this checks something real.
    expect(Date.parse(afterRestart.updatedAt)).toBe(
      Date.parse('2026-11-11T10:15:00.000Z'),
    );
    expect(afterRestart.readState).toMatchObject({ unread: false });
    // Opening it again sends the bumped inventory version; that is accepted.
    expect(
      (await station.acknowledge(afterRestart.id, afterRestart.updatedAt))
        .status,
    ).toBe(200);
    expect((await station.inventory()).readState).toMatchObject({
      unread: false,
    });

    // A new reply is something to read.
    seedTurn(
      station.eventStore,
      'second',
      '2026-11-11T10:20:00.000Z',
      '2026-11-11T10:20:04.000Z',
    );
    const replied = await station.inventory();
    expect(replied.readState).toMatchObject({ unread: true });
    if (!replied.readState || 'unavailable' in replied.readState)
      throw new Error('expected a known read state');
    // Marking it read takes the version the server reported, and no more.
    expect(
      (await station.mark(replied.id, replied.readState.version + 1)).status,
    ).toBe(409);
    expect(
      (await station.mark(replied.id, replied.readState.version)).status,
    ).toBe(200);
    expect((await station.inventory()).readState).toMatchObject({
      unread: false,
    });
  } finally {
    await station.stop();
  }
}, 60_000);

test('a marker recorded before the content version keeps the conversation read on upgrade', async () => {
  const station = boot();
  try {
    station.eventStore.upsertSession({
      provider: 'claude',
      threadId: THREAD,
      status: 'running',
      createdAt: '2026-11-11T10:00:00.000Z',
      updatedAt: '2026-11-11T10:00:00.000Z',
    });
    station.eventStore.appendEvent({
      eventId: 'started',
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-11-11T10:00:00.000Z',
      method: 'session.started',
      sessionId: THREAD,
      metadata: { userId: OWNER, agentSlug: 'claude' },
    } as never);
    seedTurn(
      station.eventStore,
      'first',
      '2026-11-11T10:00:01.000Z',
      '2026-11-11T10:00:05.000Z',
    );
    station.eventStore.appendEvent({
      eventId: 'exited',
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-11-11T10:15:00.000Z',
      method: 'session.exited',
      sessionId: THREAD,
      reason: 'Station stopped',
    } as never);
    // A marker the previous build recorded: the inventory `updatedAt` it
    // showed, which is at or after the content it covered.
    const item = await station.inventory();
    new FileConversationAcknowledgementStore(dir).acknowledge({
      userId: 'personal:owner',
      conversationId: item.id,
      updatedAt: '2026-11-11T10:00:05.000Z',
    });
    expect((await station.inventory()).readState).toMatchObject({
      unread: false,
    });
  } finally {
    await station.stop();
  }
}, 60_000);
