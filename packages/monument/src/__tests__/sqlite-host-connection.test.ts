import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteKernelStorage } from '../sqlite.js';
import {
  createSqliteKernelLocation,
  type SqliteKernelLocation,
} from '../testing/index.js';

const locations: SqliteKernelLocation[] = [];
afterEach(async () => {
  for (const created of locations.splice(0)) await created.dispose();
});

const pragma = (db: DatabaseSync, name: string) =>
  Object.values(
    db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>,
  )[0];

/** A connection a host has already configured, in a way it chose. */
function hostConnection() {
  const location = createSqliteKernelLocation();
  locations.push(location);
  const db = new DatabaseSync(location.path);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA synchronous = OFF');
  db.exec('PRAGMA busy_timeout = 1234');
  return db;
}

describe('node:sqlite adapter over a connection the host owns', () => {
  it("leaves the host connection's pragmas alone and reports what it found", () => {
    const db = hostConnection();
    const storage = openSqliteKernelStorage({ database: db });
    try {
      expect(pragma(db, 'synchronous')).toBe(0);
      expect(pragma(db, 'busy_timeout')).toBe(1234);
      expect(pragma(db, 'journal_mode')).toBe('delete');
      expect(storage.pragmas).toEqual({
        journalMode: 'delete',
        synchronous: 'OFF',
        busyTimeoutMs: 1234,
      });
    } finally {
      db.close();
    }
  });

  it('still runs commands, on the settings the host chose', () => {
    const db = hostConnection();
    const storage = openSqliteKernelStorage({ database: db });
    try {
      expect(
        storage.executeSync(
          { type: 'turnDedup.read', key: 'k' },
          { liveness: () => 'unknown' },
        ),
      ).toEqual({ kind: 'absent' });
      expect(pragma(db, 'synchronous')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('configures the connection only when the host asks it to own the pragmas', () => {
    const db = hostConnection();
    const storage = openSqliteKernelStorage({
      database: db,
      configureConnection: true,
      busyTimeoutMs: 4321,
    });
    try {
      expect(pragma(db, 'synchronous')).toBe(2);
      expect(pragma(db, 'busy_timeout')).toBe(4321);
      expect(pragma(db, 'journal_mode')).toBe('wal');
      expect(storage.pragmas).toEqual({
        journalMode: 'wal',
        synchronous: 'FULL',
        busyTimeoutMs: 4321,
      });
    } finally {
      db.close();
    }
  });

  it('keeps asserting FULL on a connection it opens itself', async () => {
    const location = createSqliteKernelLocation();
    locations.push(location);
    const storage = openSqliteKernelStorage({ path: location.path });
    expect(storage.pragmas.synchronous).toBe('FULL');
    await storage.close();
  });
});
