import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { orchestrationStorePath } from '@kontourai/station-shared/sqlite-store-integrity';
import { CHAT_APPS_MIGRATION } from '../../domain/migrations/025-chat-apps.js';
import { applyWalJournalMode } from '../../utils/sqlite-wal.js';

/** Short-lived handles avoid giving each transport another runtime shutdown owner. */
export class ChatAppStore {
  private initialized = false;

  constructor(private readonly homeDir: string) {}

  read<T>(operation: (db: DatabaseSync) => T): T {
    const path = orchestrationStorePath(this.homeDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const existed = existsSync(path);
    const db = new DatabaseSync(path, { timeout: 5_000 });
    try {
      if (!existed) chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout=5000;');
      if (!this.initialized) {
        applyWalJournalMode(db, { store: 'chat apps' });
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(CHAT_APPS_MIGRATION);
          db.exec('COMMIT');
          this.initialized = true;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      return operation(db);
    } finally {
      db.close();
    }
  }

  transaction<T>(
    operation: (db: DatabaseSync) => T,
    beforeCommit: () => boolean,
  ): T {
    return this.read((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!beforeCommit()) throw new Error('Chat app authority changed');
        const result = operation(db);
        if (!beforeCommit()) throw new Error('Chat app authority changed');
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
  }
}

export function readChatRecord<T>(row: unknown): T | undefined {
  if (row === undefined) return undefined;
  if (
    !row ||
    typeof row !== 'object' ||
    !('record' in row) ||
    typeof row.record !== 'string'
  ) {
    throw new Error('Chat app record is unavailable');
  }
  return JSON.parse(row.record) as T;
}
