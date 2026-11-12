/**
 * #3075 owner design: the content-version backfill for an existing home runs
 * in bounded batches, each committed with its progress, so an interrupted
 * start resumes where it stopped instead of from zero. Completion records the
 * upgrade fence (the store's contiguous sequence prefix) in the same write.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ReadMarkerService } from '../../read-markers/read-marker-service.js';
import { FileReadMarkerStore } from '../../read-markers/read-marker-store.js';
import {
  readMarkerMigrationRecipients,
  upgradeReadMarkerStore,
} from '../../read-markers/read-marker-upgrade.js';
import { FileConversationAcknowledgementStore } from '../conversation-acknowledgement-store.js';
import { EventStore, THREAD_CONTENT_BACKFILL_BATCH } from '../event-store.js';

let dir: string;
// Removed after each test whether it passed or not (#2421).
const makeTempDir = trackTempDirs();
beforeEach(() => {
  dir = makeTempDir('thread-content-backfill-');
});

/** A home from before content versions: history but no projection. */
function oldHome(path: string, events: number): void {
  new EventStore(path).close();
  const db = new DatabaseSync(path);
  db.exec('BEGIN');
  const insert = db.prepare(
    `INSERT INTO orchestration_events
       (id, provider, thread_id, turn_id, method, request_id, session_state, payload, created_at, observed_at, sequence, global_sequence)
     VALUES (?, 'claude', ?, 't', ?, NULL, NULL, '{}', ?, ?, ?, ?)`,
  );
  for (let index = 1; index <= events; index += 1) {
    const thread = index % 2 === 0 ? 'even' : 'odd';
    // Every third event is bookkeeping, which never moves a version.
    const method =
      index % 3 === 0 ? 'session.state-changed' : 'content.text-delta';
    const at = new Date(Date.UTC(2026, 10, 11, 10) + index).toISOString();
    insert.run(`e-${index}`, thread, method, at, at, index, index);
  }
  db.prepare(
    'UPDATE orchestration_stream_identity SET high_water = ? WHERE singleton = 1',
  ).run(events);
  db.exec(
    'DELETE FROM orchestration_thread_content; DELETE FROM orchestration_thread_content_migration;',
  );
  db.exec('COMMIT');
  db.close();
}

function progress(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT cutoff_sequence, cursor_sequence, completed_at FROM orchestration_thread_content_migration WHERE singleton = 1',
      )
      .get() as
      | {
          cutoff_sequence: number;
          cursor_sequence: number;
          completed_at: string | null;
        }
      | undefined;
  } finally {
    db.close();
  }
}

test('the backfill commits bounded batches and resumes an interrupted run where it stopped', () => {
  const path = join(dir, 'orchestration.sqlite');
  const events = THREAD_CONTENT_BACKFILL_BATCH * 2 + 123;
  oldHome(path, events);

  // A start interrupted after its first batch committed.
  expect(
    () =>
      new EventStore(path, undefined, undefined, {
        threadContentBackfillBatch: () => {
          throw new Error('interrupted');
        },
      }),
  ).toThrow('interrupted');
  const interrupted = progress(path);
  // The cutoff was written before the first batch; the cursor is the batch.
  expect(interrupted).toMatchObject({
    cutoff_sequence: events,
    cursor_sequence: THREAD_CONTENT_BACKFILL_BATCH,
    completed_at: null,
  });

  // The next start continues from that point, never from zero.
  const cursors: number[] = [];
  const store = new EventStore(path, undefined, undefined, {
    threadContentBackfillBatch: (cursor) => {
      cursors.push(cursor);
    },
  });
  try {
    expect(cursors[0]).toBe(THREAD_CONTENT_BACKFILL_BATCH * 2);
    let previous = THREAD_CONTENT_BACKFILL_BATCH;
    for (const cursor of cursors) {
      expect(cursor - previous).toBeLessThanOrEqual(
        THREAD_CONTENT_BACKFILL_BATCH,
      );
      previous = cursor;
    }
    const done = progress(path);
    expect(done?.completed_at).not.toBeNull();
    // Completion keeps the cutoff written before the first batch.
    expect(done?.cutoff_sequence).toBe(events);
    expect(store.contentUpgradeFence()).toBe(events);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const versions = Object.fromEntries(
        (
          db
            .prepare(
              'SELECT thread_id, content_sequence FROM orchestration_thread_content ORDER BY thread_id',
            )
            .all() as { thread_id: string; content_sequence: number }[]
        ).map((row) => [row.thread_id, row.content_sequence]),
      );
      // The highest content (never bookkeeping) sequence of each thread.
      const last = (parity: number) => {
        for (let index = events; index > 0; index -= 1)
          if (index % 2 === parity && index % 3 !== 0) return index;
        return 0;
      };
      expect(versions).toEqual({ even: last(0), odd: last(1) });
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
}, 60_000);

/** Back to a pre-upgrade home after a writer's own start migrated it. */
function forgetMigration(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(
    'DELETE FROM orchestration_thread_content; DELETE FROM orchestration_thread_content_migration;',
  );
  db.close();
}

/** Content written by a peer that was already running against the home. */
function appendContent(store: EventStore, eventId: string): void {
  store.appendEvent({
    eventId,
    provider: 'claude',
    threadId: 'odd',
    createdAt: '2026-11-11T10:00:00.000Z',
    method: 'content.text-delta',
    turnId: 't',
    itemId: eventId,
    delta: 'written during the migration',
  } as never);
}

function projected(path: string, thread: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(
      (
        db
          .prepare(
            'SELECT content_sequence FROM orchestration_thread_content WHERE thread_id = ?',
          )
          .get(thread) as { content_sequence: number }
      ).content_sequence,
    );
  } finally {
    db.close();
  }
}

test('content appended between batches is projected but stays outside the cutoff', () => {
  const path = join(dir, 'orchestration.sqlite');
  const events = THREAD_CONTENT_BACKFILL_BATCH * 2 + 123;
  oldHome(path, events);
  const writer = new EventStore(path);
  forgetMigration(path);
  let appended = false;
  const store = new EventStore(path, undefined, undefined, {
    threadContentBackfillBatch: () => {
      if (appended) return;
      appended = true;
      appendContent(writer, 'between-batches');
    },
  });
  try {
    writer.close();
    expect(appended).toBe(true);
    // The cutoff is the sequence when the migration began, never later.
    expect(store.contentUpgradeFence()).toBe(events);
    expect(projected(path, 'odd')).toBe(events + 1);
  } finally {
    store.close();
  }
}, 60_000);

test('an append during an interrupted run is projected and stays outside the cutoff after the resume', () => {
  const path = join(dir, 'orchestration.sqlite');
  const events = THREAD_CONTENT_BACKFILL_BATCH * 2 + 123;
  oldHome(path, events);
  // A writer already open on the pre-upgrade home.
  const writer = new EventStore(path);
  forgetMigration(path);
  expect(
    () =>
      new EventStore(path, undefined, undefined, {
        threadContentBackfillBatch: () => {
          appendContent(writer, 'during-backfill');
          throw new Error('interrupted');
        },
      }),
  ).toThrow('interrupted');
  writer.close();
  const resumed = new EventStore(path);
  try {
    // Projected (no cursor skipped it) and never inside the cutoff.
    expect(projected(path, 'odd')).toBe(events + 1);
    expect(resumed.contentUpgradeFence()).toBe(events);
  } finally {
    resumed.close();
  }
}, 60_000);

test('overlapping initializers: one completes, the other resumes and never moves the fence', () => {
  const path = join(dir, 'orchestration.sqlite');
  const events = THREAD_CONTENT_BACKFILL_BATCH * 2 + 123;
  oldHome(path, events);
  let peerFence: number | undefined;
  const store = new EventStore(path, undefined, undefined, {
    threadContentBackfillBatch: () => {
      if (peerFence !== undefined) return;
      // A second initializer runs to completion between A's batches, then
      // new content arrives.
      const peer = new EventStore(path);
      peerFence = peer.contentUpgradeFence();
      appendContent(peer, 'after-peer-completed');
      peer.close();
    },
  });
  try {
    expect(peerFence).toBe(events);
    expect(store.contentUpgradeFence()).toBe(peerFence);
    expect(projected(path, 'odd')).toBe(events + 1);
  } finally {
    store.close();
  }
}, 60_000);

test('a person first recorded after the cutoff, before an interrupted migration resumes, never inherits the baseline', async () => {
  const path = join(dir, 'orchestration.sqlite');
  const events = THREAD_CONTENT_BACKFILL_BATCH * 2 + 123;
  oldHome(path, events);
  const acknowledgements = new FileConversationAcknowledgementStore(dir);
  acknowledgements.acknowledge({
    userId: 'human:test:ada',
    conversationId: 'viewed-before',
    updatedAt: '2026-11-11T10:00:00.000Z',
  });
  // The runtime's recipients: everyone with a record, read with the cutoff.
  const recipients = () => readMarkerMigrationRecipients(dir, () => false);
  expect(
    () =>
      new EventStore(
        path,
        undefined,
        undefined,
        {
          threadContentBackfillBatch: () => {
            throw new Error('interrupted');
          },
        },
        { contentMigrationRecipients: recipients },
      ),
  ).toThrow('interrupted');
  expect(progress(path)).toMatchObject({
    cutoff_sequence: events,
    completed_at: null,
  });
  // Bob's first view, recorded while the migration was interrupted.
  acknowledgements.acknowledge({
    userId: 'human:test:bob',
    conversationId: 'viewed-later',
    updatedAt: '2026-11-11T10:01:00.000Z',
  });
  const resumed = new EventStore(path, undefined, undefined, undefined, {
    contentMigrationRecipients: recipients,
  });
  try {
    const store = new FileReadMarkerStore(dir);
    expect(
      upgradeReadMarkerStore({
        store,
        events: resumed,
        now: new Date('2026-11-12T00:00:00.000Z'),
      }),
    ).toBe(true);
    const odd = projected(path, 'odd');
    const stateFor = (person: string) =>
      new ReadMarkerService({
        store,
        conversations: acknowledgements,
        personKeyFor: () => person,
        agentConversations: {
          latestVersions: async () => new Map(),
          versionsOf: () =>
            new Map([
              [
                'history',
                { version: odd, space: 'content', acknowledgeableUntil: 0 },
              ],
            ]),
        },
      })
        .conversationReadStates({} as never, [])
        ?.get('history');
    // Ada had a record when the cutoff was written: her baseline holds.
    expect(stateFor('human:test:ada')).toMatchObject({ unread: false });
    // Bob's first record came after it: his history reads unread.
    expect(stateFor('human:test:bob')).toMatchObject({ unread: true });
  } finally {
    resumed.close();
  }
}, 60_000);

test('a migration begun without a recipient snapshot gives the baseline to nobody', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, 50);
  new FileConversationAcknowledgementStore(dir).acknowledge({
    userId: 'human:test:ada',
    conversationId: 'viewed-before',
    updatedAt: '2026-11-11T10:00:00.000Z',
  });
  // Opened with no recipients provider: the snapshot is missing.
  const store = new EventStore(path);
  try {
    expect(store.contentUpgradeFence()).toBe(50);
    expect(store.contentMigrationRecipients()).toBeUndefined();
    const markers = new FileReadMarkerStore(dir);
    expect(
      upgradeReadMarkerStore({
        store: markers,
        events: store,
        now: new Date('2026-11-12T00:00:00.000Z'),
      }),
    ).toBe(true);
    // Even Ada, who had a record, starts without the baseline: unread.
    expect(markers.baselineFor('human:test:ada')).toEqual({
      sequence: 0,
      time: 0,
    });
  } finally {
    store.close();
  }
});

test('an owner-device acknowledgement in a first-format store freezes the owner as the runtime resolves them', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, 50);
  // A v1 home whose only record is the owner's phone.
  writeFileSync(
    join(dir, 'conversation-acknowledgements.json'),
    JSON.stringify({
      version: 1,
      acknowledgements: {
        'human:device:owner-phone': {
          'viewed-before': '2026-11-11T10:00:00.000Z',
        },
      },
    }),
  );
  // The owner-device predicate the runtime gives its acknowledgement store.
  const ownerDevice = (id: string) => id === 'owner-phone';
  const runtime = new FileConversationAcknowledgementStore(dir, ownerDevice);
  expect(runtime.principals()).toEqual(['personal:owner']);
  const events = new EventStore(path, undefined, undefined, undefined, {
    contentMigrationRecipients: () =>
      readMarkerMigrationRecipients(dir, ownerDevice),
  });
  try {
    expect(events.contentMigrationRecipients()).toEqual(['personal:owner']);
    const markers = new FileReadMarkerStore(dir);
    expect(
      upgradeReadMarkerStore({
        store: markers,
        events,
        now: new Date('2026-11-12T00:00:00.000Z'),
      }),
    ).toBe(true);
    const state = new ReadMarkerService({
      store: markers,
      conversations: runtime,
      personKeyFor: () => 'personal:owner',
      agentConversations: {
        latestVersions: async () => new Map(),
        versionsOf: () =>
          new Map([
            [
              'history',
              {
                version: projected(path, 'odd'),
                space: 'content',
                acknowledgeableUntil: 0,
              },
            ],
          ]),
      },
    })
      .conversationReadStates({} as never, [])
      ?.get('history');
    expect(state).toMatchObject({ unread: false });
  } finally {
    events.close();
  }
});

/** Freezes `people` as the recipients of a fresh migration. */
let freezes = 0;
function freeze(people: () => readonly string[]) {
  freezes += 1;
  const path = join(dir, `orchestration-${freezes}.sqlite`);
  oldHome(path, 5);
  const diagnostics: string[] = [];
  const events = new EventStore(path, undefined, undefined, undefined, {
    contentMigrationRecipients: people,
    onContentMigrationDiagnostic: (reason) => diagnostics.push(reason),
  });
  try {
    return { recipients: events.contentMigrationRecipients(), diagnostics };
  } finally {
    events.close();
  }
}

const people = (count: number, keyLength = 12) =>
  Array.from({ length: count }, (_, index) =>
    `human:${String(index).padStart(keyLength - 6, '0')}`.slice(0, keyLength),
  );

test('the recipient snapshot admits its bounds exactly and refuses one past each, never truncating', () => {
  // Pinned beside the constants: 1,000 people, 512-character keys.
  expect(freeze(() => people(1000)).recipients).toHaveLength(1000);
  const tooMany = freeze(() => people(1001));
  expect(tooMany.recipients).toBeUndefined();
  expect(tooMany.diagnostics).toHaveLength(1);

  expect(freeze(() => people(1, 512)).recipients?.[0]).toHaveLength(512);
  const tooLong = freeze(() => people(1, 513));
  expect(tooLong.recipients).toBeUndefined();
  expect(tooLong.diagnostics).toHaveLength(1);

  // Within the count and key bounds, but over 256 KiB serialized.
  const tooBig = freeze(() => people(1000, 512));
  expect(tooBig.recipients).toBeUndefined();
  expect(tooBig.diagnostics).toHaveLength(1);
});

test('a recipient source over 4 MiB is refused unread, freezing a missing snapshot', () => {
  writeFileSync(
    join(dir, 'conversation-acknowledgements.json'),
    JSON.stringify({
      version: 2,
      acknowledgements: {
        'personal:owner': { pad: 'x'.repeat(4 * 1024 * 1024) },
      },
    }),
  );
  const refused = freeze(() => readMarkerMigrationRecipients(dir, () => false));
  expect(refused.recipients).toBeUndefined();
  expect(refused.diagnostics).toHaveLength(1);
});

test('a deferred migration keeps the construction cutoff and samples recipients only when it begins', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, 50);
  let ready = false;
  const sampled: boolean[] = [];
  const events = new EventStore(path, undefined, undefined, undefined, {
    contentMigrationRecipients: () => {
      sampled.push(ready);
      return ready ? ['personal:owner'] : ['human:device:owner-phone'];
    },
    deferContentMigration: true,
  });
  try {
    expect(progress(path)).toBeUndefined();
    expect(events.contentUpgradeFence()).toBeUndefined();
    // Appended before the migration begins: after the cutoff, so unread.
    appendContent(events, 'during-boot');
    ready = true;
    events.beginContentMigration();
    events.beginContentMigration();
    expect(sampled).toEqual([true]);
    expect(events.contentUpgradeFence()).toBe(50);
    expect(events.contentMigrationRecipients()).toEqual(['personal:owner']);
    expect(projected(path, 'odd')).toBeGreaterThan(50);
  } finally {
    events.close();
  }
});
