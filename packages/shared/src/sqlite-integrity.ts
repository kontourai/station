export interface SqliteIntegrityDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(): unknown[];
  };
}

export type SqliteIntegrityOutcome =
  | { kind: 'ok' }
  | { kind: 'corrupt' }
  | { kind: 'unavailable'; cause: unknown };

/** SQLITE_CORRUPT / SQLITE_NOTADB — the bytes are bad, whatever the wording. */
const SQLITE_CORRUPT_ERRCODE = 11;
const SQLITE_NOTADB_ERRCODE = 26;

/**
 * Exported for the reactive watch (station#3215): the same verdict must be
 * reached whether corruption is found by a deliberate check or by an ordinary
 * query failing, or the two paths could disagree about the same database.
 *
 * THIS FUNCTION IS AVAILABILITY-CRITICAL. It is no longer only a label:
 * `SchedulerLedger` latches on it (station#3220), so a `true` here stops a
 * live scheduler accepting any new job, edit, claim or invocation fence until
 * the process restarts — and a restart then meets a boot check that fails
 * closed. A false positive is therefore an outage, not a cosmetic mislabel.
 *
 * Which means the three matchers below are a safety boundary, and two of them
 * are TEXTUAL. Anything added here must be unreachable for contention
 * (SQLITE_BUSY/LOCKED) and for ordinary statement errors. The property is
 * pinned by real-lock negative controls — `scheduler-ledger-corruption.test.ts`
 * holds a genuine `BEGIN IMMEDIATE` from a second connection and asserts the
 * store keeps working — not by this paragraph.
 */
export function explicitCorruption(error: unknown): boolean {
  const record =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; errcode?: unknown; errstr?: unknown })
      : {};
  // `errcode` FIRST, and it is the only reliable signal here.
  //
  // Under `node:sqlite` the `code` property is the generic
  // 'ERR_SQLITE_ERROR' even for corruption, so the regex below never fires
  // on its own. And when corruption surfaces through a virtual table the
  // MESSAGE is replaced with `vtable constructor failed: <name>` — the exact
  // text a schema commit also produces — so a corrupt fts5 page could be
  // read as contention and retried instead of reported.
  //
  // Demonstrated against a hand-corrupted database: errcode 11 with that
  // message, classified as retryable (station#3188 adversarial review).
  if (
    record.errcode === SQLITE_CORRUPT_ERRCODE ||
    record.errcode === SQLITE_NOTADB_ERRCODE
  ) {
    return true;
  }
  const code = 'code' in record ? String(record.code) : '';
  const errstr = typeof record.errstr === 'string' ? record.errstr : '';
  const message = error instanceof Error ? error.message : '';
  return (
    /SQLITE_(?:CORRUPT|NOTADB)/i.test(code) ||
    /database disk image is malformed|file is not a database/i.test(
      `${message}\n${errstr}`,
    )
  );
}

/**
 * The virtual table a corruption error surfaced through, when it named one.
 *
 * DIAGNOSTIC ONLY. I originally added this as a routing key — record the fts5
 * index and rebuild it rather than quarantine 61 MB of history to fix a
 * search index — and that use does not exist. Probed five ways against real
 * byte-corrupted fts5 shadow tables (station#3217): `DROP TABLE` and
 * `INSERT INTO t(t) VALUES('rebuild')` BOTH fail with errcode 11, because
 * SQLite must construct and traverse the index to destroy it, and node:sqlite
 * blocks writing the shadow tables directly. So there is no in-place repair
 * to route to.
 *
 * The capture is still worth making, for two reasons. It tells an operator
 * where the damage surfaced, and it is only available at the moment of
 * observation — SQLite puts it in the message text and nowhere else.
 *
 * Read its ABSENCE carefully: fts5 emits this wording only when xConnect
 * fails on `_config`. Four of the five corruption shapes probed produced the
 * generic malformed message with no table name at all, so absent does not
 * mean "the damage was not in a virtual table".
 */
export function corruptVirtualTableName(error: unknown): string | undefined {
  const record =
    typeof error === 'object' && error !== null
      ? (error as { errstr?: unknown })
      : {};
  const errstr = typeof record.errstr === 'string' ? record.errstr : '';
  const message = error instanceof Error ? error.message : '';
  const match = /vtable constructor failed:\s*(\S+)/i.exec(
    `${message}\n${errstr}`,
  );
  return match?.[1];
}

/** SQLITE_SCHEMA — the connection's cached schema was invalidated mid-statement. */
const SQLITE_SCHEMA_ERRCODE = 17;

/**
 * Reports whether an `unavailable` cause is a concurrent-DDL collision rather
 * than a storage fault (station#3145).
 *
 * When a peer process commits DDL between this connection loading the schema
 * and preparing the check, SQLite raises SQLITE_SCHEMA (17). If the statement
 * touches a virtual table it surfaces as `vtable constructor failed: <name>`,
 * because `sqlite3VtabCallConnect` overwrites the empty error message while
 * propagating the original code — so the MESSAGE is not the discriminator and
 * must not be matched on: a genuinely broken FTS5 index reports the same text
 * under a corruption code. `errcode` is the discriminator.
 *
 * SQLITE_SCHEMA is a statement about timing, not about bytes: it means the
 * check never ran. SQLite's own prepare loop already re-prepares once on this
 * code (`sqlite3LockAndPrepare`'s `cnt++ == 0`) and then gives up, which is
 * not enough while a peer is mid-migration — so the caller decides whether to
 * look again. It never means "the data is bad": corruption arrives as
 * SQLITE_CORRUPT/SQLITE_NOTADB, which `explicitCorruption` claims first here
 * so a corruption verdict can never be read as contention.
 */
export function isSqliteSchemaContention(error: unknown): boolean {
  if (explicitCorruption(error)) return false;
  const record =
    typeof error === 'object' && error !== null
      ? (error as { errcode?: unknown; errstr?: unknown })
      : {};
  if (record.errcode === SQLITE_SCHEMA_ERRCODE) return true;
  const text = [
    typeof record.errstr === 'string' ? record.errstr : '',
    error instanceof Error ? error.message : '',
  ].join('\n');
  return /database schema has changed/i.test(text);
}

/** Content-free integrity classification shared by runtime and backup seams. */
export function checkSqliteIntegrity(
  database: SqliteIntegrityDatabase,
  options: { checkpoint?: boolean } = {},
): SqliteIntegrityOutcome {
  try {
    if (options.checkpoint) {
      const checkpoint = database
        .prepare('PRAGMA wal_checkpoint(TRUNCATE)')
        .all();
      const row = checkpoint.length === 1 ? checkpoint[0] : undefined;
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        (row as Record<string, unknown>).busy !== 0 ||
        !Number.isSafeInteger((row as Record<string, unknown>).log) ||
        !Number.isSafeInteger((row as Record<string, unknown>).checkpointed) ||
        (row as Record<string, unknown>).log !==
          (row as Record<string, unknown>).checkpointed
      ) {
        return {
          kind: 'unavailable',
          cause: new Error('SQLite checkpoint did not fully drain WAL'),
        };
      }
    }
    const rows = database.prepare('PRAGMA quick_check').all();
    if (
      rows.length !== 1 ||
      typeof rows[0] !== 'object' ||
      rows[0] === null ||
      Array.isArray(rows[0]) ||
      Object.values(rows[0] as Record<string, unknown>).length !== 1 ||
      Object.values(rows[0] as Record<string, unknown>)[0] !== 'ok'
    )
      return { kind: 'corrupt' };
    return { kind: 'ok' };
  } catch (error) {
    return explicitCorruption(error)
      ? { kind: 'corrupt' }
      : { kind: 'unavailable', cause: error };
  }
}
