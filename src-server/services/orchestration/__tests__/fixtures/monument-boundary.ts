import type { OwnerIdentity } from '@kontourai/monument';
import type {
  SqliteKernelDatabase,
  SqliteKernelTables,
} from '@kontourai/monument/sqlite';
import { expect } from 'vitest';
import { EventStore } from '../../event-store.js';

export const owner: OwnerIdentity = {
  id: 'test-owner',
  pid: process.pid,
  identityKind: 'unverified',
};
const identity = {
  exact: () => null,
  probe: () => ({ state: 'unavailable' }) as const,
};
export function open(path: string) {
  return new EventStore(path, undefined, identity);
}
function head(db: SqliteKernelDatabase) {
  return Number(
    (
      db
        .prepare(
          'SELECT high_water FROM orchestration_stream_identity WHERE singleton = 1',
        )
        .get() as { high_water: number }
    ).high_water,
  );
}
export const tables: SqliteKernelTables = {
  turnDedup: 'unused',
  requestKeys: 'unused',
  // #3568: the inbox is another machine this storage does not own.
  inbox: 'unused',
  steerReceipts: 'unused',
  turnBoundary: {
    table: 'orchestration_turn_boundaries',
    ownerEncoding: 'columns',
    terminalFacts: 'host',
    terminalSeen: (db, thread, turn) => facts(db).terminalSeen(thread, turn),
    terminalSequence: (db, thread, id) =>
      facts(db).terminalSequence(thread, id),
    creationSequence: { column: 'created_sequence', read: head },
  },
};
function facts(db: SqliteKernelDatabase) {
  return {
    terminalSeen: (thread: string, turn: string) => {
      expect(db.isTransaction).toBe(true);
      return !!db
        .prepare(
          "SELECT 1 FROM orchestration_events WHERE thread_id = ? AND turn_id = ? AND method IN ('turn.completed','turn.aborted','runtime.error') LIMIT 1",
        )
        .get(thread, turn);
    },
    terminalSequence: (thread: string, id: string | undefined) => {
      expect(db.isTransaction).toBe(true);
      return (
        db
          .prepare(
            'SELECT global_sequence FROM orchestration_events WHERE thread_id = ? AND id = ?',
          )
          .get(thread, id ?? null) as { global_sequence: number } | undefined
      )?.global_sequence;
    },
  };
}
export function context() {
  return { liveness: () => 'unknown' as const };
}

export const at = (n: number) =>
  new Date(Date.UTC(2030, 0, 1, 0, 0, n)).toISOString();
