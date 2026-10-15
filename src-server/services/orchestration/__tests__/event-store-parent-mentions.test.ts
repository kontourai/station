import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
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
): CanonicalRuntimeEvent {
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
