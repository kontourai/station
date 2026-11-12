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
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { beforeEach, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileConversationAcknowledgementStore } from '../../../services/orchestration/conversation-acknowledgement-store.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import {
  ReadMarkerService,
  readMarkerPersonKey,
} from '../../../services/read-markers/read-marker-service.js';
import {
  FileReadMarkerStore,
  READ_MARKER_STORE_FILE,
} from '../../../services/read-markers/read-marker-store.js';
import {
  readMarkerMigrationRecipients,
  upgradeReadMarkerStore,
} from '../../../services/read-markers/read-marker-upgrade.js';
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
// Removed after each test whether it passed or not (#2421).
const makeTempDir = trackTempDirs();
beforeEach(() => {
  dir = makeTempDir('read-marker-content-version-');
});

/** One running Station over `dir`: event store, service and routes. */
function boot() {
  // As the runtime opens it: the read-state recipients are frozen with the
  // content migration's cutoff.
  const eventStore = new EventStore(
    join(dir, 'orchestration.sqlite'),
    undefined,
    undefined,
    undefined,
    {
      contentMigrationRecipients: () =>
        readMarkerMigrationRecipients(dir, () => false),
    },
  );
  const service = new OrchestrationService({
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    eventBus: new EventBus(),
    eventStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
  } as never);
  const authorityFor = (): SessionReadAuthority =>
    sessionReadAuthorityFromRequest(OWNER, undefined, undefined);
  const acknowledgements = new FileConversationAcknowledgementStore(dir);
  const store = new FileReadMarkerStore(dir);
  // As the runtime does at every start: read state begins once per home (a
  // first-format store, or none).
  upgradeReadMarkerStore({
    store,
    events: eventStore,
    now: new Date('2026-11-12T00:00:00.000Z'),
  });
  const readMarkers = new ReadMarkerService({
    store,
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
    async inventoryAll(): Promise<ConversationListItem[]> {
      return (await json(await app.request('/api/conversations'))).data.items;
    },
    async inventory(): Promise<ConversationListItem> {
      const body = await json(await app.request('/api/conversations'));
      expect(body.data.items).toHaveLength(1);
      return body.data.items[0];
    },
    /**
     * An older client's acknowledgement: only the inventory `updatedAt` it
     * showed.
     */
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
    /**
     * What the dock sends for the row on screen: the content version it
     * rendered (`readState.version`) and its `updatedAt` (last viewed).
     */
    acknowledgeRendered(item: ConversationListItem) {
      const rendered = item.readState;
      if (!rendered || 'unavailable' in rendered)
        throw new Error('expected a known read state');
      return app.request(
        `/api/conversations/${encodeURIComponent(item.id)}/acknowledgement`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            updatedAt: item.updatedAt,
            readVersion: rendered.version,
          }),
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
  expect((await station.acknowledgeRendered(fresh)).status).toBe(200);
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
    expect((await station.acknowledgeRendered(afterRestart)).status).toBe(200);
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

test('an upgrade at the fence: nothing from before it reads unread, and content after it does until rendered', async () => {
  const seedThread = (
    station: ReturnType<typeof boot>,
    threadId: string,
    completedAt: string,
  ) => {
    station.eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'running',
      createdAt: '2026-11-11T10:00:00.000Z',
      updatedAt: '2026-11-11T10:00:00.000Z',
    });
    station.eventStore.appendEvent({
      eventId: `${threadId}-started`,
      provider: 'claude',
      threadId,
      createdAt: '2026-11-11T10:00:00.000Z',
      method: 'session.started',
      sessionId: threadId,
      metadata: { userId: OWNER, agentSlug: 'claude' },
    } as never);
    for (const [suffix, method, at] of [
      ['start', 'turn.started', '2026-11-11T10:00:01.000Z'],
      ['done', 'turn.completed', completedAt],
    ] as const)
      station.eventStore.appendEvent({
        eventId: `${threadId}-${suffix}`,
        provider: 'claude',
        threadId,
        createdAt: at,
        method,
        turnId: `${threadId}-turn`,
        ...(method === 'turn.started' ? { prompt: 'hello' } : {}),
      } as never);
  };
  // What an older build left: three conversations, one read before a stop.
  let station = boot();
  seedThread(station, 'read-before-stop', '2026-11-11T10:00:05.000Z');
  seedThread(station, 'older-than-baseline', '2026-11-11T10:00:02.000Z');
  seedThread(station, 'never-read', '2026-11-11T10:00:30.000Z');
  station.eventStore.appendEvent({
    eventId: 'exited',
    provider: 'claude',
    threadId: 'read-before-stop',
    createdAt: '2026-11-11T10:15:00.000Z',
    method: 'session.exited',
    sessionId: 'read-before-stop',
    reason: 'Station stopped',
  } as never);
  const ids = new Map(
    ['read-before-stop', 'older-than-baseline', 'never-read'].map((thread) => [
      thread,
      station.eventStore.conversationForSession(thread)!.conversationId,
    ]),
  );
  expect((await station.inventoryAll()).map((item) => item.id).sort()).toEqual(
    [...ids.values()].sort(),
  );
  await station.stop();
  // The older build had no projection (so no fence yet), a time baseline,
  // and its views in the acknowledgement store as the `updatedAt` shown.
  const db = new DatabaseSync(join(dir, 'orchestration.sqlite'));
  db.exec(
    'DELETE FROM orchestration_thread_content; DELETE FROM orchestration_thread_content_migration;',
  );
  db.close();
  writeFileSync(
    join(dir, READ_MARKER_STORE_FILE),
    JSON.stringify({
      version: 1,
      createdAt: Date.parse('2026-11-11T10:00:10.000Z'),
      markers: {},
    }),
  );
  rmSync(join(dir, `${READ_MARKER_STORE_FILE}.previous`), { force: true });
  new FileConversationAcknowledgementStore(dir).acknowledge({
    userId: 'personal:owner',
    conversationId: ids.get('read-before-stop')!,
    updatedAt: '2026-11-11T10:15:00.000Z',
  });

  station = boot();
  try {
    const after = new Map(
      (await station.inventoryAll()).map((item) => [item.id, item.readState]),
    );
    // Before server-kept unread there was none: everything up to the fence
    // reads as seen, whatever the timestamps say.
    for (const thread of [
      'read-before-stop',
      'older-than-baseline',
      'never-read',
    ])
      expect(after.get(ids.get(thread)!), thread).toMatchObject({
        unread: false,
      });
    expect(station.eventStore.contentUpgradeFence()).toBeGreaterThan(0);
    // Content appended after the fence reads unread until rendered, even
    // with a timestamp older than the fence.
    station.eventStore.appendEvent({
      eventId: 'after-fence',
      provider: 'claude',
      threadId: 'never-read',
      createdAt: '2026-11-11T09:00:00.000Z',
      method: 'content.text-delta',
      turnId: 'never-read-turn',
      itemId: 'late',
      delta: 'backdated but new',
    } as never);
    const later = new Map(
      (await station.inventoryAll()).map((item) => [item.id, item.readState]),
    );
    expect(later.get(ids.get('never-read')!)).toMatchObject({ unread: true });
    expect(later.get(ids.get('read-before-stop')!)).toMatchObject({
      unread: false,
    });
  } finally {
    await station.stop();
  }
}, 60_000);

/** A conversation whose first turn finished, read by its owner. */
async function readConversation(station: ReturnType<typeof boot>) {
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
  const item = await station.inventory();
  expect((await station.acknowledgeRendered(item)).status).toBe(200);
  expect((await station.inventory()).readState).toMatchObject({
    unread: false,
  });
}

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test.each([
  [
    'a new user message',
    {
      method: 'turn.started',
      turnId: 'second',
      prompt: 'one more thing',
    },
  ],
  [
    'assistant text',
    {
      method: 'content.text-delta',
      turnId: 'first',
      itemId: 'late-text',
      delta: 'and another thought',
    },
  ],
  [
    'a tool result',
    {
      method: 'tool.completed',
      turnId: 'first',
      itemId: 'late-tool',
      toolCallId: 'late-tool',
      toolName: 'Read',
      status: 'success',
      output: 'file contents',
    },
  ],
  [
    'host images',
    {
      method: 'content.host-images',
      turnId: 'first',
      attachments: [
        {
          kind: 'image',
          name: 'shot.png',
          mimeType: 'image/png',
          size: Buffer.from(ONE_PIXEL_PNG, 'base64').length,
          dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG}`,
        },
      ],
    },
  ],
])(
  '%s arriving after the reply makes a read conversation unread',
  async (_name, content) => {
    const station = boot();
    try {
      await readConversation(station);
      station.eventStore.appendEvent({
        eventId: 'late-content',
        provider: 'claude',
        threadId: THREAD,
        createdAt: '2026-11-11T10:00:09.000Z',
        ...content,
      } as never);
      expect((await station.inventory()).readState).toMatchObject({
        unread: true,
      });
    } finally {
      await station.stop();
    }
  },
  60_000,
);

test.each([
  ['a client that sends the rendered version', true],
  ['an older client that sends only updatedAt', false],
])(
  'content persisted out of order after a stop is unread for %s',
  async (_name, rendered) => {
    const station = boot();
    try {
      await readConversation(station);
      // Station stops: the exit moves `updatedAt` to 10:15.
      station.eventStore.appendEvent({
        eventId: 'exited',
        provider: 'claude',
        threadId: THREAD,
        createdAt: '2026-11-11T10:15:00.000Z',
        method: 'session.exited',
        sessionId: THREAD,
        reason: 'Station stopped',
      } as never);
      const shown = await station.inventory();
      expect(Date.parse(shown.updatedAt)).toBe(
        Date.parse('2026-11-11T10:15:00.000Z'),
      );
      const acknowledged = rendered
        ? await station.acknowledgeRendered(shown)
        : await station.acknowledge(shown.id, shown.updatedAt);
      expect(acknowledged.status).toBe(200);
      expect((await station.inventory()).readState).toMatchObject({
        unread: false,
      });
      // A reply the provider timestamped at 10:10 is persisted only now, after
      // that view: nobody could have seen it.
      seedTurn(
        station.eventStore,
        'delayed',
        '2026-11-11T10:09:00.000Z',
        '2026-11-11T10:10:00.000Z',
      );
      expect((await station.inventory()).readState).toMatchObject({
        unread: true,
      });
    } finally {
      await station.stop();
    }
  },
  60_000,
);

test('reading content versions is an indexed lookup that never touches the event history', async () => {
  const station = boot();
  try {
    await readConversation(station);
    const item = await station.inventory();
    // Every statement the version lookup prepares, as the store runs it.
    const db = (station.eventStore as unknown as { db: DatabaseSync }).db;
    const prepared: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      prepared.push(sql);
      return prepare(sql);
    });
    try {
      createAgentConversationVersionSource({
        memoryAdapters: new Map(),
        // Only the point read is reached here (never, for this item).
        sessionConversationReader: {
          readSessionConversation: async () => null,
        } as never,
        authorityFor: () =>
          sessionReadAuthorityFromRequest(OWNER, undefined, undefined),
        conversationContent: station.eventStore,
      }).versionsOf([item]);
    } finally {
      spy.mockRestore();
    }
    expect(prepared.length).toBeGreaterThan(0);
    for (const sql of prepared) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(
          ...sql
            .split('?')
            .slice(1)
            .map(() => item.id),
        )
        .map((row) => String((row as { detail: unknown }).detail));
      // The plan names tables by alias, so the statement itself is checked
      // for the event history, and the plan for any full scan.
      expect(sql).not.toMatch(/\borchestration_events\b/);
      expect(plan.join(' | '), sql).not.toMatch(/\bSCAN\b/);
    }
  } finally {
    await station.stop();
  }
}, 60_000);

// #4813 delta review of `fe31ce9` (the reviewer's scenarios, verbatim in
// substance): nothing inferred from timestamps may mark content read.

test('a legacy acknowledgement of a provider snapshot never reads content ingested after it', async () => {
  const station = boot();
  try {
    await readConversation(station);
    // `upsertSession` publishes an `updatedAt` before its content arrives.
    station.eventStore.upsertSession({
      provider: 'claude',
      threadId: THREAD,
      status: 'running',
      createdAt: '2026-11-11T10:00:00.000Z',
      updatedAt: '2026-11-11T10:15:00.000Z',
    });
    const shown = await station.inventory();
    expect(shown.updatedAt).toBe('2026-11-11T10:15:00.000Z');
    station.eventStore.appendEvent({
      eventId: 'late-snapshot-text',
      provider: 'claude',
      threadId: THREAD,
      createdAt: shown.updatedAt,
      method: 'content.text-delta',
      turnId: 'first',
      itemId: 'late',
      delta: 'unseen content',
    } as never);
    expect((await station.inventory()).readState).toMatchObject({
      unread: true,
    });
    // An older client acknowledges the stale view: last viewed only.
    expect((await station.acknowledge(shown.id, shown.updatedAt)).status).toBe(
      200,
    );
    expect((await station.inventory()).readState).toMatchObject({
      unread: true,
    });
  } finally {
    await station.stop();
  }
}, 60_000);

/**
 * Back to a genuinely old home: a first-format read-marker store (`createdAt`
 * as given) and an event store with no content projection, migration
 * progress or cutoff, so the next start runs a real first migration.
 */
function makeGenuinelyOld(createdAt: number): void {
  writeFileSync(
    join(dir, READ_MARKER_STORE_FILE),
    JSON.stringify({ version: 1, createdAt, markers: {} }),
  );
  rmSync(join(dir, `${READ_MARKER_STORE_FILE}.previous`), { force: true });
  const db = new DatabaseSync(join(dir, 'orchestration.sqlite'));
  db.exec(
    'DELETE FROM orchestration_thread_content; DELETE FROM orchestration_thread_content_migration;',
  );
  db.close();
}

test('a genuinely old home: the person who had viewed keeps reading what they saw, and content persisted after the cutoff is unread', async () => {
  let station = boot();
  await readConversation(station);
  station.eventStore.appendEvent({
    eventId: 'exit',
    provider: 'claude',
    threadId: THREAD,
    createdAt: '2026-11-11T10:15:00.000Z',
    method: 'session.exited',
    sessionId: THREAD,
  } as never);
  // The owner's view, recorded by the old build: an acknowledgement record.
  const shown = await station.inventory();
  expect((await station.acknowledge(shown.id, shown.updatedAt)).status).toBe(
    200,
  );
  // Before the upgrade there was no server unread: this reply was simply
  // there when the owner looked.
  seedTurn(
    station.eventStore,
    'before-upgrade',
    '2026-11-11T10:09:00.000Z',
    '2026-11-11T10:10:00.000Z',
  );
  await station.stop();
  makeGenuinelyOld(0);

  station = boot();
  try {
    expect(station.eventStore.contentUpgradeFence()).toBeGreaterThan(0);
    expect((await station.inventory()).readState).toMatchObject({
      unread: false,
    });
    // A delayed reply persisted after the cutoff, backdated before it all.
    seedTurn(
      station.eventStore,
      'after-cutoff',
      '2026-11-11T09:00:00.000Z',
      '2026-11-11T09:00:01.000Z',
    );
    expect((await station.inventory()).readState).toMatchObject({
      unread: true,
    });
  } finally {
    await station.stop();
  }
}, 60_000);

test('a genuinely old home where nobody had a record reads unread after the upgrade, whatever the old time baseline', async () => {
  let station = boot();
  await readConversation(station);
  seedTurn(
    station.eventStore,
    'new',
    '2026-11-11T10:00:20.000Z',
    '2026-11-11T10:00:30.000Z',
  );
  seedTurn(
    station.eventStore,
    'backdated',
    '2026-11-11T10:00:06.000Z',
    '2026-11-11T10:00:07.000Z',
  );
  await station.stop();
  rmSync(join(dir, 'conversation-acknowledgements.json'), { force: true });
  rmSync(join(dir, 'conversation-acknowledgements.json.previous'), {
    force: true,
  });
  makeGenuinelyOld(Date.parse('2026-11-11T10:00:10.000Z'));
  station = boot();
  try {
    expect((await station.inventory()).readState).toMatchObject({
      unread: true,
    });
  } finally {
    await station.stop();
  }
}, 60_000);
