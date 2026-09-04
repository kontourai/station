import { createLogger } from './logger.js';

/**
 * Turning a SQLite database's journal mode to WAL at open — the one place
 * that knows this pragma is special (archive#3661).
 *
 * `PRAGMA journal_mode = WAL` on a database that is still in rollback-journal
 * mode is a mode CONVERSION, and a conversion needs an exclusive lock on the
 * file. `busy_timeout` does not govern that acquisition: with a 5-second busy
 * timeout set both on the connection and by pragma, a second process running
 * this while a first holds a write lock is refused in ZERO milliseconds with
 * `database is locked` (errcode 5) — measured, not assumed. So the ordinary
 * "SQLite will wait for us" reasoning that covers every other statement in
 * these open paths is simply false here.
 *
 * That only bites on a database no Station has ever opened: the mode lives in
 * the file header, so once any uncontended open has converted it, every later
 * `PRAGMA journal_mode = WAL` is a no-op that succeeds even under contention.
 * The exposure is therefore exactly first boot with a concurrent second
 * instance — a brand-new home opened by the desktop app and `station start`
 * at once, or two agent instances sharing a home. It was reproduced in
 * archive#3646's three-process upgrade test at roughly one run in two.
 *
 * A short bounded retry is the whole fix, and it belongs here rather than in
 * each store: five call sites set WAL at open, four of them swallowed the
 * failure silently (leaving a rollback-journal database in production and
 * hoping a later boot converts it) and the scheduler ledger let it abort
 * startup. Neither is a decision anyone made per store.
 *
 * `enableWalJournalMode` NEVER THROWS. A store's own schema statements
 * immediately after it are what fail truthfully on a genuinely unreadable or
 * damaged file; making the journal-mode pragma fatal would fail precisely in
 * the contended boot this exists to survive, and would fail a boot over a
 * header property the next uncontended open will set anyway.
 *
 * Callers do not use it directly. `applyWalJournalMode` is the wrapper every
 * store shares (archive#3661 review MEDIUM-1): it names the store, reads the
 * journal mode actually in effect afterwards, and logs a failure once — so a
 * database left in rollback-journal mode is an observable event rather than a
 * silence six call sites each chose independently. It also carries the one
 * knob that differs between them: `onUnavailable: 'throw'` restores the
 * fail-closed startup two stores had before this change, for NON-contention
 * failures only. Contention is exactly what archive#3661 says must not kill a boot.
 */

/** Just enough of `node:sqlite`'s DatabaseSync for this pragma. */
export interface SqliteJournalModeDatabase {
  exec(sql: string): unknown;
}

/** …plus the read-back the shared wrapper reports. */
export interface SqliteJournalModeReadableDatabase
  extends SqliteJournalModeDatabase {
  prepare(sql: string): { get(): unknown };
}

export interface EnableWalJournalModeOptions {
  /** Total attempts, including the first. */
  readonly attempts?: number;
  /** Backoff before attempt N+1; doubles each time, capped at 128ms. */
  readonly initialBackoffMs?: number;
}

export interface WalJournalModeResult {
  /** The pragma ran without a contention refusal. */
  readonly enabled: boolean;
  /** How many attempts were made (1 when it succeeded immediately). */
  readonly attempts: number;
  /** The refusal that ended the last attempt, when `enabled` is false. */
  readonly lastError?: Error;
}

/** ~250ms of total backoff across 8 attempts: 2+4+8+16+32+64+128. */
const DEFAULT_ATTEMPTS = 8;
const DEFAULT_INITIAL_BACKOFF_MS = 2;
const MAX_BACKOFF_MS = 128;

/**
 * SQLITE_BUSY (errcode 5) or its message — the same detection
 * `003-orchestration-events.ts`'s migration retry and
 * `orchestration-service.ts` already use. `node:sqlite` carries the numeric
 * code on `errcode`; the message check covers wrapped errors that only
 * preserved the text.
 */
export function isSqliteContentionError(error: unknown): boolean {
  if ((error as { errcode?: unknown })?.errcode === 5) return true;
  return (
    error instanceof Error &&
    /SQLITE_BUSY|database is locked/i.test(error.message)
  );
}

/**
 * Synchronous sleep, the same way `runConcurrentSafeMigration` does it. These
 * open paths are synchronous end to end (`new DatabaseSync(...)` through
 * `db.exec(SCHEMA)`), and SQLite's own `busy_timeout` already blocks this
 * thread for seconds elsewhere in them, so a bounded block here is the local
 * idiom rather than a new one.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function enableWalJournalMode(
  db: SqliteJournalModeDatabase,
  options: EnableWalJournalModeOptions = {},
): WalJournalModeResult {
  const attempts = Math.max(
    1,
    Math.floor(options.attempts ?? DEFAULT_ATTEMPTS),
  );
  let backoffMs = Math.max(
    0,
    Math.floor(options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS),
  );
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return { enabled: true, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Anything that is not contention will not become true by waiting.
      if (!isSqliteContentionError(error) || attempt === attempts) {
        return { enabled: false, attempts: attempt, lastError };
      }
      sleepSync(backoffMs);
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
    }
  }
  /* c8 ignore next */
  return { enabled: false, attempts, ...(lastError ? { lastError } : {}) };
}

/** Raised only by `applyWalJournalMode({ onUnavailable: 'throw' })`. */
export class WalJournalModeUnavailableError extends Error {
  readonly code = 'WAL_JOURNAL_MODE_UNAVAILABLE';
  readonly store: string;
  readonly journalMode: string | null;

  constructor(
    store: string,
    journalMode: string | null,
    cause: Error | undefined,
  ) {
    super(
      `${store} could not be opened in WAL journal mode (currently ${journalMode ?? 'unknown'})`,
      cause ? { cause } : undefined,
    );
    this.store = store;
    this.journalMode = journalMode;
  }
}

const logger = createLogger({ name: 'sqlite-wal' });

/**
 * The journal mode a connection is ACTUALLY in — the fact worth logging, as
 * opposed to "the pragma failed". Best-effort: a database too broken to
 * answer this is about to fail its caller's own statements anyway.
 */
function observedJournalMode(db: SqliteJournalModeDatabase): string | null {
  const readable = db as Partial<SqliteJournalModeReadableDatabase>;
  if (typeof readable.prepare !== 'function') return null;
  try {
    const row = readable.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: unknown }
      | undefined;
    return typeof row?.journal_mode === 'string' ? row.journal_mode : null;
  } catch {
    return null;
  }
}

export interface ApplyWalJournalModeOptions
  extends EnableWalJournalModeOptions {
  /** Names the database in the log line — `'scheduler ledger'`, etc. */
  readonly store: string;
  /**
   * `'throw'` restores the fail-closed open two stores had before
   * archive#3661, for NON-contention failures only: a store that cannot be
   * opened because of I/O or a read-only home should not come up pretending
   * to be healthy, but a boot that merely lost a race must.
   */
  readonly onUnavailable?: 'warn' | 'throw';
  /**
   * Environment consulted for `STATION_SQLITE_FIXTURE_SYNCHRONOUS`. Defaults
   * to `process.env`; tests pass an explicit map so the outcome never depends
   * on the developer's shell.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Fixture-only durability relaxation, read from the environment the caller
 * hands in (`process.env` by default).
 *
 * `PRAGMA synchronous = OFF` skips the fsync a WAL store otherwise pays on
 * every commit. SQLite documents OFF as safe against an application crash --
 * a killed process still finds every committed transaction on reopen -- and
 * unsafe only against an operating-system crash or power loss, which is the
 * one failure a throwaway test fixture never has to survive. `vitest.setup.ts`
 * sets `STATION_SQLITE_FIXTURE_SYNCHRONOUS=off` for every Vitest worker (and
 * the child processes they spawn); no shipped entry point sets it, so a real
 * Station keeps SQLite's own default (FULL under WAL). `synchronous` is a
 * per-connection setting, which is why it is applied here, on the one path
 * every store's open sequence already takes, rather than per store.
 *
 * Measured on the orchestration EventStore (Apple M-series, APFS):
 * construct+ledger+close 32-40ms -> 19-23ms, appends 0.15-0.25ms/row ->
 * 0.09ms/row. Fifty-five test files build a store per case.
 */
export const SQLITE_FIXTURE_SYNCHRONOUS_ENV =
  'STATION_SQLITE_FIXTURE_SYNCHRONOUS';

function applyFixtureSynchronousMode(
  db: SqliteJournalModeDatabase,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (env[SQLITE_FIXTURE_SYNCHRONOUS_ENV] !== 'off') return;
  db.exec('PRAGMA synchronous = OFF');
}

export function applyWalJournalMode(
  db: SqliteJournalModeDatabase,
  options: ApplyWalJournalModeOptions,
): WalJournalModeResult {
  const result = enableWalJournalMode(db, options);
  if (result.enabled) {
    applyFixtureSynchronousMode(db, options.env ?? process.env);
    return result;
  }
  const journalMode = observedJournalMode(db);
  const contention = isSqliteContentionError(result.lastError);
  logger.warn('SQLite store is not in WAL journal mode', {
    store: options.store,
    journalMode,
    attempts: result.attempts,
    contention,
    error: result.lastError?.message,
  });
  if (options.onUnavailable === 'throw' && !contention) {
    throw new WalJournalModeUnavailableError(
      options.store,
      journalMode,
      result.lastError,
    );
  }
  return result;
}
