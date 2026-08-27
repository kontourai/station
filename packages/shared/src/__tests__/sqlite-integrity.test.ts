import { describe, expect, it, vi } from 'vitest';
import {
  checkSqliteIntegrity,
  corruptVirtualTableName,
  isSqliteSchemaContention,
} from '../sqlite-integrity.js';

describe('checkSqliteIntegrity', () => {
  it('classifies exact quick-check truth without exposing diagnostics', () => {
    expect(
      checkSqliteIntegrity({
        exec: vi.fn(),
        prepare: () => ({ all: () => [{ quick_check: 'ok' }] }),
      }),
    ).toEqual({ kind: 'ok' });
    expect(
      checkSqliteIntegrity({
        exec: vi.fn(),
        prepare: () => ({ all: () => [{ quick_check: 'bad page 2' }] }),
      }),
    ).toEqual({ kind: 'corrupt' });
  });

  it('classifies only proved corruption and treats other storage faults as unavailable', () => {
    const locked = Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_BUSY',
    });
    expect(
      checkSqliteIntegrity({
        exec: vi.fn(),
        prepare: () => ({
          all: () => {
            throw locked;
          },
        }),
      }),
    ).toEqual({ kind: 'unavailable', cause: locked });
    expect(
      checkSqliteIntegrity({
        exec: vi.fn(),
        prepare: () => ({
          all: () => {
            throw new Error('file is not a database');
          },
        }),
      }),
    ).toEqual({ kind: 'corrupt' });
    for (const error of [
      Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }),
      Object.assign(new Error('unable to open database file'), {
        code: 'SQLITE_CANTOPEN',
      }),
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      new Error('unexpected storage adapter failure'),
    ]) {
      expect(
        checkSqliteIntegrity({
          exec: vi.fn(),
          prepare: () => ({
            all: () => {
              throw error;
            },
          }),
        }),
      ).toEqual({ kind: 'unavailable', cause: error });
    }
  });

  it('checkpoints only when the caller owns an offline source', () => {
    expect(
      checkSqliteIntegrity(
        {
          exec: vi.fn(),
          prepare: (sql) => ({
            all: () =>
              sql.startsWith('PRAGMA wal_checkpoint')
                ? [{ busy: 0, log: 4, checkpointed: 4 }]
                : [{ quick_check: 'ok' }],
          }),
        },
        { checkpoint: true },
      ),
    ).toEqual({ kind: 'ok' });
  });

  it('fails closed when checkpoint leaves WAL frames behind', () => {
    expect(
      checkSqliteIntegrity(
        {
          exec: vi.fn(),
          prepare: (sql) => ({
            all: () =>
              sql.startsWith('PRAGMA wal_checkpoint')
                ? [{ busy: 1, log: 4, checkpointed: 3 }]
                : [{ quick_check: 'ok' }],
          }),
        },
        { checkpoint: true },
      ),
    ).toMatchObject({ kind: 'unavailable' });
  });
});

describe('isSqliteSchemaContention', () => {
  it('claims only SQLITE_SCHEMA, never the message it arrives under', () => {
    // The exact shape node:sqlite throws when a peer's DDL invalidates this
    // connection's schema while `PRAGMA quick_check` reaches an FTS5 table
    // (station#3145, captured from six concurrent first-boot constructors).
    expect(
      isSqliteSchemaContention(
        Object.assign(
          new Error(
            'vtable constructor failed: orchestration_message_search_v3',
          ),
          {
            code: 'ERR_SQLITE_ERROR',
            errcode: 17,
            errstr: 'database schema has changed',
          },
        ),
      ),
    ).toBe(true);
    // Byte-identical message, corruption code: a broken FTS5 index fails its
    // constructor too. Matching the message would have laundered it.
    expect(
      isSqliteSchemaContention(
        Object.assign(
          new Error(
            'vtable constructor failed: orchestration_message_search_v3',
          ),
          {
            code: 'ERR_SQLITE_ERROR',
            errcode: 267,
            errstr: 'database disk image is malformed',
          },
        ),
      ),
    ).toBe(false);
  });

  it('refuses every cause that is corruption or a storage fault', () => {
    for (const error of [
      // Corruption wins even when the transient code is also present.
      Object.assign(new Error('database disk image is malformed'), {
        errcode: 17,
      }),
      Object.assign(new Error('file is not a database'), { errcode: 17 }),
      Object.assign(new Error('malformed'), { code: 'SQLITE_CORRUPT' }),
      Object.assign(new Error('not a db'), { code: 'SQLITE_NOTADB' }),
      Object.assign(new Error('database is locked'), {
        code: 'ERR_SQLITE_BUSY',
        errcode: 5,
      }),
      Object.assign(new Error('disk I/O error'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 10,
      }),
      Object.assign(new Error('unable to open database file'), { errcode: 14 }),
      new Error('unexpected storage adapter failure'),
      'database schema has changed',
      undefined,
      null,
    ]) {
      expect(isSqliteSchemaContention(error)).toBe(false);
    }
  });

  it('reads the driver-independent message when no numeric code is exposed', () => {
    expect(
      isSqliteSchemaContention(new Error('database schema has changed')),
    ).toBe(true);
    expect(
      isSqliteSchemaContention(
        Object.assign(new Error('vtable constructor failed: t'), {
          errstr: 'database schema has changed',
        }),
      ),
    ).toBe(true);
  });
});

/**
 * station#3188 adversarial review. A vtable failure REPLACES the message with
 * `vtable constructor failed: <name>` — identical text whether the cause is a
 * peer committing a schema change (SQLITE_SCHEMA 17), a corrupt fts5 page
 * (SQLITE_CORRUPT 11), or a missing shadow table (SQLITE_ERROR 1). And under
 * `node:sqlite` the `code` property is the generic 'ERR_SQLITE_ERROR' even
 * for corruption, so message-and-code detection cannot separate them.
 *
 * If corruption is misread as contention it gets retried and then reported as
 * "temporarily unavailable" — turning the operator's remedy from "restore a
 * validated backup" into "try again".
 */
describe('corruption is claimed by errcode, not by wording', () => {
  const VTABLE = 'vtable constructor failed: orchestration_message_search_v3';

  function sqliteError(errcode: number, errstr: string) {
    return Object.assign(new Error(VTABLE), {
      code: 'ERR_SQLITE_ERROR',
      errcode,
      errstr,
    });
  }

  test('errcode 11 is corruption even when the message says vtable', () => {
    const error = sqliteError(11, 'unable to read fts5 structure');
    expect(isSqliteSchemaContention(error)).toBe(false);
  });

  test('errcode 26 (not a database) is corruption too', () => {
    expect(isSqliteSchemaContention(sqliteError(26, 'file is encrypted'))).toBe(
      false,
    );
  });

  test('errcode 17 under the same message is still contention', () => {
    // The negative control: claiming corruption too eagerly would turn a
    // recoverable boot race back into a hard failure.
    const error = sqliteError(17, 'database schema has changed');
    expect(isSqliteSchemaContention(error)).toBe(true);
  });

  test('a corrupt store is reported as corrupt, not as unavailable', () => {
    const db = {
      exec() {},
      prepare() {
        return {
          all() {
            throw sqliteError(11, 'unable to read fts5 structure');
          },
        };
      },
    };
    expect(checkSqliteIntegrity(db as never)).toEqual({ kind: 'corrupt' });
  });
});

describe('corruptVirtualTableName', () => {
  // The exact strings SQLite produced against real byte-corrupted fts5 shadow
  // tables (station#3217 probes). Nothing had asserted this field, so deleting
  // it would have left the suite green — on the one detail that is only
  // available at the moment of observation.
  test('names the table when fts5 fails to construct', () => {
    expect(
      corruptVirtualTableName(
        Object.assign(new Error('vtable constructor failed: fts'), {
          errcode: 11,
          errstr: 'database disk image is malformed',
        }),
      ),
    ).toBe('fts');
  });

  test('is absent for the four shapes that name no table', () => {
    // The discriminating half. fts5 emits the constructor wording ONLY when
    // xConnect fails on _config; damage to _data/_idx/_docsize/_content gives
    // the generic message. Absence must not be read as "not a virtual table".
    expect(
      corruptVirtualTableName(
        Object.assign(new Error('database disk image is malformed'), {
          errcode: 11,
        }),
      ),
    ).toBeUndefined();
  });

  test('is absent for an error that is not corruption at all', () => {
    expect(corruptVirtualTableName(new Error('database is locked'))).toBe(
      undefined,
    );
  });
});
