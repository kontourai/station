import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { agentStatement } from './turn-statements.js';

/** Backpressure at 4 MiB, plus at most one command's WAL footprint. */
export function agentCheckpoint(
  database: DatabaseSync,
  port?: {
    run(): Promise<void>;
    close(): Promise<void>;
  },
) {
  const path = database.location()!;
  let pending: Promise<void> | undefined;
  let closed = false;
  return {
    beforeTransaction() {
      if (closed) throw new Error('DURABLE_AGENT_STORAGE_CLOSED');
      if (!port) return;
      if (pending) return pending;
      // Only committed WAL can be checkpointed.
      if (
        database.isTransaction ||
        (statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0) <
          4 * 1024 * 1024
      )
        return;
      pending = port.run().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    commit() {
      if (!port) return database.exec('COMMIT');
      const pages = Number(
        agentStatement(database, 'PRAGMA wal_autocheckpoint').get()
          ?.wal_autocheckpoint,
      );
      database.exec('PRAGMA wal_autocheckpoint=0');
      try {
        database.exec('COMMIT');
      } finally {
        database.exec(`PRAGMA wal_autocheckpoint=${pages}`);
      }
    },
    async close() {
      closed = true;
      await port?.close();
    },
  };
}
