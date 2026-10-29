import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { scanSessionsNamingParents } from './parent-mentions-scan-oracle.js';

const makeTempDir = trackTempDirs();
const parents = Array.from(
  { length: 503 },
  (_, i) => `parent-${String(i).padStart(3, '0')}`,
);
const time = '2026-10-15T00:00:00.000Z';
function namingEvent(
  threadId: string,
  metadata: Record<string, unknown>,
  method: 'session.started' | 'session.configured' = 'session.started',
  eventId = `${threadId}:${method}`,
): Extract<
  CanonicalRuntimeEvent,
  { method: 'session.started' | 'session.configured' }
> {
  return {
    eventId,
    threadId,
    sessionId: threadId,
    provider: 'codex',
    method,
    createdAt: time,
    metadata,
  };
}

/** Conflicts are intentionally per event, including a parent outside each query. */
function legacyFixture(path: string) {
  new EventStore(path).close();
  const db = new DatabaseSync(path);
  const insert = db.prepare(`INSERT INTO orchestration_events
    (id, provider, thread_id, method, payload, created_at, sequence, global_sequence)
    VALUES (?, 'codex', ?, ?, ?, ?, ?, ?)`);
  let seq = 0;
  const append = (
    event: CanonicalRuntimeEvent,
    payload = JSON.stringify(event),
  ) => {
    seq++;
    insert.run(
      event.eventId,
      event.threadId,
      event.method,
      payload,
      time,
      seq,
      seq,
    );
  };
  append(
    namingEvent('conflict', {
      delegation: { parentConversationId: parents[0] },
      stationDelegationProvenance: 'caller-derived',
    }),
  );
  append(
    namingEvent(
      'conflict',
      {
        delegation: { parentConversationId: parents[502] },
        parentTaskId: parents[1],
      },
      'session.configured',
    ),
  );
  append(
    namingEvent('legacy', {
      parentConversationId: parents[1],
      stationDelegationProvenance: 'runtime-attested',
    }),
  );
  append(
    namingEvent(
      'legacy',
      { parentConversationId: parents[2] },
      'session.configured',
    ),
  );
  append(
    namingEvent('claim', {
      parentTaskId: parents[2],
      stationDelegationProvenance: 'caller-derived',
      rootConversationId: parents[0],
    }),
  );
  append(
    namingEvent('direct', {
      delegation: { parentConversationId: parents[3] },
      stationDelegationProvenance: 'direct-claim',
    }),
  );
  append(namingEvent('configured-stamp', { parentTaskId: parents[4] }));
  append(
    namingEvent(
      'configured-stamp',
      {
        parentConversationId: parents[4],
        stationDelegationProvenance: 'caller-derived',
      },
      'session.configured',
    ),
  );
  append(
    namingEvent('coalesce', {
      delegation: { parentConversationId: 'outside' },
      parentConversationId: parents[5],
      parentTaskId: parents[5],
    }),
  );
  append(
    namingEvent('types', {
      delegation: { parentConversationId: 9 },
      parentConversationId: parents[6],
      parentTaskId: parents[6],
    }),
  );
  append(
    namingEvent(
      'types',
      { parentConversationId: parents[7] },
      'session.configured',
    ),
  );
  append(
    namingEvent('object', {
      delegation: { parentConversationId: { bad: true } },
      parentTaskId: parents[8],
    }),
  );
  append(
    namingEvent('bool', {
      delegation: { parentConversationId: false },
      parentTaskId: parents[9],
    }),
  );
  append(
    namingEvent('empty', {
      parentConversationId: '',
      parentTaskId: parents[10],
    }),
  );
  append(namingEvent('corrupt', {}), '{bad json');
  append(
    namingEvent('unrelated', {
      ownerAttribution: { parentConversationId: parents[0] },
      rootConversationId: parents[0],
      text: parents[0],
    }),
  );
  for (let i = 0; i < 12; i++)
    append(namingEvent(`many-${i}`, { parentTaskId: parents[i % 3] }));
  // Model a pre-index database, with unrelated migrations already completed.
  db.exec(`DROP TRIGGER IF EXISTS session_parent_mentions_insert;
    DROP TRIGGER IF EXISTS session_parent_mentions_update;
    DROP TRIGGER IF EXISTS session_parent_mentions_delete;
    DROP TABLE IF EXISTS orchestration_session_parent_mentions;
    DELETE FROM orchestration_event_store_backfills WHERE name = 'session-parent-mentions-v1'`);
  db.close();
}

describe('parent naming query parity', () => {
  test('migrated conflicting and configured mentions preserve chunk-local selection, order, dedup and truncation across reopen and deletion', () => {
    const path = join(makeTempDir('parent-mentions-'), 'events.sqlite');
    legacyFixture(path);
    let store = new EventStore(path);
    const peer = new DatabaseSync(path);
    const queries = [
      [],
      [parents[0]],
      [parents[502]],
      [parents[0], parents[502]],
      [parents[1], parents[2]],
      parents,
      [...parents].reverse(),
      [...parents, parents[0]],
      ['', ...parents],
      ['missing'],
    ];
    const parity = () => {
      for (const ids of queries)
        for (const limit of [0, 1, 2, 100]) {
          expect(
            store.listSessionsNamingParents(ids, limit),
            `parents=${ids.length}, limit=${limit}`,
          ).toEqual(scanSessionsNamingParents(peer, ids, limit));
        }
    };
    try {
      parity();
      expect(
        store.listSessionsNamingParents([parents[0]], 100).sessions,
      ).toContainEqual({
        threadId: 'conflict',
        parentId: parents[0],
        binding: 'delegation-context',
        stationDerived: true,
      });
      expect(
        store.listSessionsNamingParents([parents[0], parents[502]], 100)
          .sessions,
      ).toContainEqual({
        threadId: 'conflict',
        parentId: parents[502],
        binding: 'delegation-context',
        stationDerived: false,
      });
      store.close();
      store = new EventStore(path);
      parity();
      peer
        .prepare('UPDATE orchestration_events SET method = ? WHERE id = ?')
        .run('turn.completed', 'legacy:session.configured');
      parity();
      peer
        .prepare('UPDATE orchestration_events SET method = ? WHERE id = ?')
        .run('session.configured', 'legacy:session.configured');
      parity();
      store.deleteThread('conflict');
      // Retaining only a later configured mention must also remove its start provenance.
      peer
        .prepare('DELETE FROM orchestration_events WHERE id = ?')
        .run('legacy:session.started');
      parity();
      expect(
        store.listSessionsNamingParents([parents[2]], 100).sessions,
      ).toContainEqual({
        threadId: 'legacy',
        parentId: parents[2],
        binding: 'delegation-context',
        stationDerived: false,
      });
    } finally {
      store.close();
      peer.close();
    }
  });
});

describe('parent mention append durability', () => {
  test.each(['appendEvent', 'appendEventIfAbsent'] as const)(
    '%s rolls back source and mentions together, then replay preserves the committed event',
    (appendMethod) => {
      const path = join(makeTempDir('parent-append-'), 'events.sqlite');
      const store = new EventStore(path);
      const peer = new DatabaseSync(path);
      const writer = Reflect.get(store, 'db') as DatabaseSync;
      const event = namingEvent('atomic-child', {
        delegation: { parentConversationId: 'atomic-parent' },
        parentConversationId: 'legacy-parent',
        parentTaskId: 'task-parent',
        stationDelegationProvenance: 'runtime-attested',
      });
      const visible = () => ({
        events: peer
          .prepare('SELECT id FROM orchestration_events WHERE id = ?')
          .all(event.eventId),
        mentions: peer
          .prepare(
            'SELECT event_id FROM orchestration_session_parent_mentions WHERE event_id = ?',
          )
          .all(event.eventId),
      });
      const observations: ReturnType<typeof visible>[] = [];
      writer.function('peer_visibility', () => {
        observations.push(visible());
        return 1;
      });
      writer.exec(`CREATE TEMP TRIGGER observe_parent_mention AFTER INSERT ON orchestration_session_parent_mentions
        BEGIN SELECT peer_visibility(); END;
        CREATE TEMP TRIGGER reject_later_fact BEFORE INSERT ON orchestration_conversation_history
        WHEN NEW.thread_id = 'atomic-child'
        BEGIN SELECT RAISE(ABORT, 'injected later projection failure'); END;`);
      try {
        expect(() => store[appendMethod](event)).toThrow(
          'injected later projection failure',
        );
        expect(observations).toEqual([{ events: [], mentions: [] }]);
        expect(visible()).toEqual({ events: [], mentions: [] });
        expect(
          store.listSessionsNamingParents(['atomic-parent'], 10).sessions,
        ).toEqual([]);
        writer.exec('DROP TRIGGER reject_later_fact');
        store[appendMethod](event);
        expect(observations).toEqual([
          { events: [], mentions: [] },
          { events: [], mentions: [] },
        ]);
        expect(visible()).toEqual({
          events: [{ id: event.eventId }],
          mentions: [{ event_id: event.eventId }],
        });
        const committed = peer
          .prepare(`SELECT m.event_id, m.child_session_id, m.sequence, m.global_sequence,
          m.context_parent, m.legacy_parent, m.task_parent, m.start_provenance,
          e.sequence AS event_sequence, e.global_sequence AS event_global_sequence
          FROM orchestration_session_parent_mentions m JOIN orchestration_events e ON e.id = m.event_id`)
          .all();
        expect(committed).toEqual([
          {
            event_id: event.eventId,
            child_session_id: 'atomic-child',
            sequence: 1,
            global_sequence: 1,
            event_sequence: 1,
            event_global_sequence: 1,
            context_parent: 'atomic-parent',
            legacy_parent: 'legacy-parent',
            task_parent: 'task-parent',
            start_provenance: 'runtime-attested',
          },
        ]);
        expect(
          store.appendEventIfAbsent({
            ...event,
            metadata: { parentTaskId: 'replacement' },
          }),
        ).toBeUndefined();
        expect(
          peer
            .prepare(
              'SELECT COUNT(*) AS n FROM orchestration_session_parent_mentions',
            )
            .get(),
        ).toEqual({ n: 1 });
        expect(store.listSessionsNamingParents(['atomic-parent'], 10)).toEqual(
          scanSessionsNamingParents(peer, ['atomic-parent'], 10),
        );
        // A repair to malformed JSON must have the same skip behavior as the scan.
        peer
          .prepare('UPDATE orchestration_events SET payload = ? WHERE id = ?')
          .run('{bad json', event.eventId);
        expect(store.listSessionsNamingParents(['atomic-parent'], 10)).toEqual(
          scanSessionsNamingParents(peer, ['atomic-parent'], 10),
        );
        expect(
          peer
            .prepare(
              'SELECT COUNT(*) AS n FROM orchestration_session_parent_mentions',
            )
            .get(),
        ).toEqual({ n: 0 });
      } finally {
        store.close();
        peer.close();
      }
    },
  );

  test('a failed migration leaves neither a completion marker nor partial naming rows and can be retried', () => {
    const path = join(makeTempDir('parent-backfill-'), 'events.sqlite');
    legacyFixture(path);
    const peer = new DatabaseSync(path);
    const before = peer
      .prepare('SELECT * FROM orchestration_events ORDER BY id')
      .all();
    peer.exec(`CREATE TRIGGER reject_parent_backfill BEFORE INSERT ON orchestration_event_store_backfills
      WHEN NEW.name = 'session-parent-mentions-v1'
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;`);
    try {
      expect(() => new EventStore(path)).toThrow('injected migration failure');
      expect(
        peer
          .prepare(
            "SELECT name FROM orchestration_event_store_backfills WHERE name = 'session-parent-mentions-v1'",
          )
          .all(),
      ).toEqual([]);
      expect(
        peer
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'orchestration_session_parent_mentions' OR name LIKE 'session_parent_mentions_%'",
          )
          .all(),
      ).toEqual([]);
      expect(
        peer.prepare('SELECT * FROM orchestration_events ORDER BY id').all(),
      ).toEqual(before);
      peer.exec('DROP TRIGGER reject_parent_backfill');
      const store = new EventStore(path);
      try {
        expect(store.listSessionsNamingParents(parents, 100)).toEqual(
          scanSessionsNamingParents(peer, parents, 100),
        );
        expect(
          peer
            .prepare(
              'SELECT COUNT(*) AS n FROM orchestration_session_parent_mentions',
            )
            .get(),
        ).toEqual({ n: before.length - 1 });
      } finally {
        store.close();
      }
    } finally {
      peer.close();
    }
  });

  test('the usage-tree caller searches indexed mentions with unrelated history present', () => {
    const path = join(makeTempDir('parent-plan-'), 'events.sqlite');
    const store = new EventStore(path);
    const db = Reflect.get(store, 'db') as DatabaseSync;
    for (const [threadId, metadata] of [
      ['root', { userId: 'owner' }],
      ['child', { userId: 'owner', parentTaskId: 'root' }],
    ] as const) {
      store.upsertSession({
        provider: 'codex',
        threadId,
        status: 'closed',
        createdAt: time,
        updatedAt: time,
      });
      store.appendEvent(namingEvent(threadId, metadata));
    }
    db.exec('BEGIN');
    try {
      const insert = db.prepare(`INSERT INTO orchestration_events
        (id, provider, thread_id, method, payload, created_at, sequence, global_sequence)
        VALUES (?, 'codex', ?, 'session.configured', ?, ?, 1, ?)`);
      for (let i = 0; i < 3000; i++)
        insert.run(
          `noise-${i}`,
          `noise-${i}`,
          JSON.stringify(
            namingEvent(
              `noise-${i}`,
              { parentTaskId: `unrelated-${i}` },
              'session.configured',
            ),
          ),
          time,
          i + 3,
        );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const svc = new OrchestrationService({
      eventStore: store,
      eventBus: new EventBus(),
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      logger: { debug() {}, warn() {} },
    });
    svc.initialize();
    const statements: Array<{ sql: string; values: SQLInputValue[] }> = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes('FROM orchestration_session_parent_mentions'))
        return statement;
      return new Proxy(statement, {
        get(target, key) {
          if (key === 'all')
            return (...values: SQLInputValue[]) => {
              statements.push({ sql, values });
              return target.all(...values);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    try {
      const outcome = svc.readThreadUsageTree(
        'root',
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      );
      expect(outcome.status).toBe('found');
      if (outcome.status !== 'found') throw new Error(outcome.status);
      expect(outcome.tree.root.children).toEqual([
        expect.objectContaining({ kind: 'station-delegate', id: 'child' }),
      ]);
      expect(statements).toHaveLength(2); // One lookup per discovered tree level.
      for (const statement of statements) {
        const plan = prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
          .all(...statement.values)
          .map((row) => String(row.detail))
          .join(' | ');
        expect(plan).toMatch(/SEARCH .* USING INDEX/);
        expect(plan).not.toMatch(
          /SCAN (orchestration_events|orchestration_session_parent_mentions)/,
        );
      }
    } finally {
      spy.mockRestore();
      store.close();
    }
  });
});
