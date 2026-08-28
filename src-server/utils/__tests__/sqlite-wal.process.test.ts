import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  applyWalJournalMode,
  enableWalJournalMode,
  isSqliteContentionError,
  WalJournalModeUnavailableError,
} from '../sqlite-wal.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { timeout?: number },
  ) => {
    exec(sql: string): unknown;
    prepare(sql: string): {
      get(): { journal_mode?: string };
      all(): Array<{ id: string }>;
    };
    close(): void;
  };
};

/**
 * archive#3661. The claim under test is not "WAL gets set" — it is that a
 * SECOND process reaching `PRAGMA journal_mode = WAL` while a first holds the
 * write lock on a never-WAL database survives.
 *
 * Real child processes, because the whole defect is cross-process, and the
 * children import the REAL helper and the REAL scheduler ledger (rather than
 * a copy of the algorithm) so a passing run is evidence about shipped code.
 *
 * THE ORDERING IS PROVEN, NOT TIMED, and it took two failed fault injections
 * to get there. The first version released the lock 60ms after spawning, and
 * reverting the ledger to its pre-fix bare pragma still PASSED: the child's
 * own startup (worse under the tsx loader) outran the release, so it never
 * met the lock. The second version had the child WAIT for a go-ahead before
 * attempting — which released the lock first by construction, and passed the
 * injection again.
 *
 * What holds: the child announces `ATTEMPTING` only once its imports are done
 * and it is milliseconds from the pragma, and the holder then keeps the lock
 * for a further `HOLD_AFTER_ANNOUNCE_MS`. The remaining assumption is a
 * ~20-100x margin (a few ms of post-announce work against 120ms of holding),
 * not a guess about process startup, which is what the first version got
 * wrong — and the fault injection below is what proves the margin is real:
 * reverting the ledger to its bare pragma reddens this file.
 *
 * Process-heavy by classification — see `scripts/vitest-resource-manifest.mjs`.
 */
/**
 * How long the lock is held AFTER the child says it is about to attempt.
 * Comfortably longer than the child's remaining work (single-digit ms) and
 * comfortably inside the helper's ~254ms retry budget, so the first attempt
 * is refused and a later one succeeds.
 */
const HOLD_AFTER_ANNOUNCE_MS = 120;

const HELPER_URL = pathToFileURL(
  join(import.meta.dirname, '../sqlite-wal.ts'),
).href;
const LEDGER_URL = pathToFileURL(
  join(import.meta.dirname, '../../services/scheduling/scheduler-ledger.ts'),
).href;

/**
 * Line protocol shared by every handshaking child:
 *   child → `ATTEMPTING` : imports done, connection open, pragma is next
 *   parent → `GO`        : proceed; the lock you must meet has been arranged
 *   child → `{json}`     : the outcome
 */
const CHILD_PROTOCOL_PRELUDE = `
const lines = [];
let waiter = null;
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let index = buffer.indexOf('\\n');
  while (index !== -1) {
    lines.push(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
  }
  if (waiter) { const resume = waiter; waiter = null; resume(); }
});
const nextLine = async () => {
  while (lines.length === 0) await new Promise((r) => { waiter = r; });
  return lines.shift();
};
`;

/** Opens, announces, waits for GO, then calls the real helper. */
const CHILD_CONVERT = `${CHILD_PROTOCOL_PRELUDE}
(async () => {
  const [helperUrl, dbPath] = process.argv.slice(1);
  const { DatabaseSync } = require('node:sqlite');
  const { enableWalJournalMode } = await import(helperUrl);
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 5000');
  process.stdout.write('ATTEMPTING\\n');
  const result = enableWalJournalMode(db);
  const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  process.stdout.write(JSON.stringify({
    enabled: result.enabled,
    attempts: result.attempts,
    error: result.lastError ? result.lastError.message : null,
    mode,
  }) + '\\n');
  db.close();
  process.exit(0);
})().catch((error) => {
  process.stderr.write(String(error && error.message));
  process.exit(9);
});
`;

/** The pre-fix statement, verbatim: one bare attempt, no retry. */
const CHILD_BARE_PRAGMA = `
(() => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 5000');
  const startedAt = Date.now();
  try {
    db.exec('PRAGMA journal_mode = WAL');
    process.stdout.write(JSON.stringify({ ok: true, ms: Date.now() - startedAt }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      ms: Date.now() - startedAt,
      message: error.message,
      errcode: error.errcode,
    }));
  }
  db.close();
})();
`;

/**
 * Two Station instances first-opening one home. The peer that wins the file
 * takes its write lock BEFORE anyone converts the journal mode — a conversion
 * cannot happen inside a transaction, so this is the only ordering in which
 * the second process meets a rollback-journal database that is already locked
 * — and holds it until the parent has seen the other peer announce that the
 * pragma is its next statement.
 */
const CHILD_PEER = `${CHILD_PROTOCOL_PRELUDE}
(async () => {
  const [helperUrl, dbPath, role] = process.argv.slice(1);
  const { DatabaseSync } = require('node:sqlite');
  const { enableWalJournalMode } = await import(helperUrl);
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 5000');
  if (role === 'holder') {
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO ledger (id) VALUES ('holder')");
  }
  process.stdout.write('ATTEMPTING\\n');
  if (role === 'holder') {
    await nextLine();
    db.exec('COMMIT');
  }
  const result = enableWalJournalMode(db);
  db.exec("INSERT INTO ledger (id) VALUES ('" + role + "-done')");
  const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  process.stdout.write(JSON.stringify({
    role,
    enabled: result.enabled,
    attempts: result.attempts,
    mode,
  }) + '\\n');
  db.close();
  process.exit(0);
})().catch((error) => {
  process.stderr.write(String(error && error.message));
  process.exit(9);
});
`;

/**
 * The reported defect end to end: a real `SqliteSchedulerLedger` constructed
 * in a second process while a first holds the write lock on a never-WAL
 * scheduler database. Everything else in that constructor — the integrity
 * check, the schema statements — is governed by `busy_timeout` and simply
 * waits; the journal-mode pragma was the one statement that did not, so this
 * is a startup-survival claim about the real class, not about the helper.
 *
 * It announces BEFORE constructing, since the construction is what must meet
 * the lock, and the parent arranges the release only after that announcement.
 */
const CHILD_SCHEDULER_LEDGER = `${CHILD_PROTOCOL_PRELUDE}
(async () => {
  const [ledgerUrl, directory] = process.argv.slice(1);
  const { createSchedulerLedger } = await import(ledgerUrl);
  process.stdout.write('ATTEMPTING\\n');
  const ledger = createSchedulerLedger({ directory });
  const created = ledger.create({
    name: 'nightly',
    prompt: 'run',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  process.stdout.write(JSON.stringify({ created }) + '\\n');
  process.exit(0);
})().catch((error) => {
  process.stderr.write(String(error && error.message));
  process.exit(9);
});
`;

function runChild(script: string, args: string[]): unknown {
  return JSON.parse(
    execFileSync(process.execPath, ['-e', script, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
    }),
  );
}

interface HandshakingChild {
  readonly child: ChildProcess;
  /** Resolves on the child's next complete stdout line. */
  nextLine(): Promise<string>;
  go(): void;
  settled(): Promise<{ code: number | null; stderr: string }>;
}

function spawnHandshakingChild(
  script: string,
  args: string[],
  options: { loader?: 'tsx' } = {},
): HandshakingChild {
  const child = spawn(process.execPath, [
    // Every child here reaches server TypeScript whose `.js` specifiers
    // resolve to `.ts` sources — something Node's bare type stripping cannot
    // do — so they all run under the repo's own loader.
    ...(options.loader === 'tsx'
      ? ['--import', pathToFileURL(require.resolve('tsx')).href]
      : []),
    '-e',
    script,
    ...args,
  ]);
  const pending: string[] = [];
  let resume: (() => void) | null = null;
  let buffer = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      pending.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
    const waiter = resume;
    resume = null;
    waiter?.();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const closed = new Promise<{ code: number | null; stderr: string }>(
    (resolve) => {
      child.on('close', (code) => resolve({ code, stderr }));
    },
  );
  // A dead child must not leave the parent waiting until the suite times out
  // — and the check has to be a FLAG, not just a wake-up, because the child
  // can (and under a fault injection routinely does) die before the parent
  // has registered its waiter at all. That is exactly how an injection that
  // should have reddened this file instead hung it for 30 seconds.
  let exited = false;
  void closed.then(() => {
    exited = true;
    const waiter = resume;
    resume = null;
    waiter?.();
  });
  return {
    child,
    async nextLine() {
      while (pending.length === 0) {
        if (exited) {
          const { code, stderr: why } = await closed;
          throw new Error(
            `child exited (${code}) before its next line: ${why.trim()}`,
          );
        }
        await new Promise<void>((r) => {
          resume = r;
        });
      }
      return pending.shift() as string;
    },
    go() {
      child.stdin?.write('GO\n');
    },
    settled: () => closed,
  };
}

function hold(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, HOLD_AFTER_ANNOUNCE_MS));
}

function journalMode(path: string): string {
  const db = new DatabaseSync(path, { timeout: 5_000 });
  try {
    return String(db.prepare('PRAGMA journal_mode').get().journal_mode);
  } finally {
    db.close();
  }
}

describe('enableWalJournalMode classification', () => {
  test('contention is errcode 5 or its message, and nothing else', () => {
    expect(isSqliteContentionError({ errcode: 5 })).toBe(true);
    expect(isSqliteContentionError(new Error('database is locked'))).toBe(true);
    expect(isSqliteContentionError(new Error('SQLITE_BUSY: busy'))).toBe(true);
    // A damaged file is not something waiting can fix.
    expect(
      isSqliteContentionError(new Error('database disk image is malformed')),
    ).toBe(false);
    expect(isSqliteContentionError({ errcode: 11 })).toBe(false);
    expect(isSqliteContentionError(undefined)).toBe(false);
  });

  test('a non-contention failure is returned immediately, not retried', () => {
    let calls = 0;
    const result = enableWalJournalMode({
      exec() {
        calls += 1;
        throw new Error('database disk image is malformed');
      },
    });
    expect(result).toMatchObject({ enabled: false, attempts: 1 });
    expect(calls).toBe(1);
  });

  test('persistent contention exhausts the bounded budget and never throws', () => {
    let calls = 0;
    const result = enableWalJournalMode(
      {
        exec() {
          calls += 1;
          const error = new Error('database is locked') as Error & {
            errcode?: number;
          };
          error.errcode = 5;
          throw error;
        },
      },
      { attempts: 4, initialBackoffMs: 0 },
    );
    expect(calls).toBe(4);
    expect(result.enabled).toBe(false);
    expect(result.attempts).toBe(4);
    expect(result.lastError?.message).toBe('database is locked');
  });
});

describe('applyWalJournalMode reports, and fails closed where asked (#3661 review MEDIUM-1)', () => {
  const ioError = () => {
    const error = new Error('disk I/O error') as Error & { errcode?: number };
    error.errcode = 10;
    return error;
  };
  const busyError = () => {
    const error = new Error('database is locked') as Error & {
      errcode?: number;
    };
    error.errcode = 5;
    return error;
  };
  const stubDb = (throwing: () => Error) => ({
    exec(sql: string) {
      if (sql.startsWith('PRAGMA journal_mode =')) throw throwing();
      return undefined;
    },
    prepare() {
      return { get: () => ({ journal_mode: 'delete' }) };
    },
  });

  test('a store asking to fail closed throws on a NON-contention failure', () => {
    // What `scheduler-ledger.ts` and the working-state worker did before
    // archive#3661, restored: an unwritable or failing database does not come up
    // pretending to be healthy.
    expect(() =>
      applyWalJournalMode(stubDb(ioError), {
        store: 'scheduler ledger',
        onUnavailable: 'throw',
      }),
    ).toThrow(WalJournalModeUnavailableError);
  });

  test('…but NOT on contention, which is the defect #3661 exists to fix', () => {
    const result = applyWalJournalMode(stubDb(busyError), {
      store: 'scheduler ledger',
      onUnavailable: 'throw',
      attempts: 2,
      initialBackoffMs: 0,
    });
    expect(result.enabled).toBe(false);
    expect(result.attempts).toBe(2);
  });

  test('the advisory stores never throw, on either kind of failure', () => {
    for (const error of [ioError, busyError]) {
      expect(
        applyWalJournalMode(stubDb(error), {
          store: 'orchestration event store',
          attempts: 1,
        }).enabled,
      ).toBe(false);
    }
  });

  test('the error names the store and the mode actually in effect', () => {
    try {
      applyWalJournalMode(stubDb(ioError), {
        store: 'scheduler ledger',
        onUnavailable: 'throw',
      });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WalJournalModeUnavailableError);
      const failure = error as WalJournalModeUnavailableError;
      expect(failure.store).toBe('scheduler ledger');
      expect(failure.journalMode).toBe('delete');
      expect(failure.message).toContain('scheduler ledger');
      expect(failure.message).toContain('delete');
    }
  });
});

describe('two processes first-opening a never-WAL database (#3661)', () => {
  let dir: string;
  let databasePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-wal-race-'));
    databasePath = join(dir, 'scheduler.sqlite');
    // A rollback-journal database — the state a home no Station has opened
    // is in, and the only state in which the pragma is a CONVERSION.
    const db = new DatabaseSync(databasePath, { timeout: 5_000 });
    db.exec('CREATE TABLE ledger (id TEXT PRIMARY KEY)');
    db.close();
    expect(journalMode(databasePath)).toBe('delete');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('the bare pragma is refused INSTANTLY under a held write lock', () => {
    // The premise, measured rather than assumed: `busy_timeout` is set to 5s
    // on the connection AND by pragma, and the conversion still fails in
    // single-digit milliseconds. That is why a retry — not a longer timeout —
    // is the fix. The holder never lets go here, so no timing is involved.
    const holder = new DatabaseSync(databasePath, { timeout: 5_000 });
    holder.exec('PRAGMA busy_timeout = 5000');
    holder.exec('BEGIN IMMEDIATE');
    holder.exec("INSERT INTO ledger (id) VALUES ('lock')");
    try {
      const outcome = runChild(CHILD_BARE_PRAGMA, [databasePath]) as {
        ok: boolean;
        ms: number;
        message?: string;
        errcode?: number;
      };
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/database is locked/i);
      expect(outcome.errcode).toBe(5);
      expect(outcome.ms).toBeLessThan(1_000);
    } finally {
      holder.exec('COMMIT');
      holder.close();
    }
    expect(journalMode(databasePath)).toBe('delete');
  });

  test('the helper waits out a held write lock and converts', async () => {
    const holder = new DatabaseSync(databasePath, { timeout: 5_000 });
    holder.exec('PRAGMA busy_timeout = 5000');
    holder.exec('BEGIN IMMEDIATE');
    holder.exec("INSERT INTO ledger (id) VALUES ('lock')");

    const converter = spawnHandshakingChild(
      CHILD_CONVERT,
      [HELPER_URL, databasePath],
      { loader: 'tsx' },
    );
    expect(await converter.nextLine()).toBe('ATTEMPTING');
    await hold();
    holder.exec('COMMIT');
    holder.close();

    const outcome = JSON.parse(await converter.nextLine()) as {
      enabled: boolean;
      attempts: number;
      mode: string;
    };
    const { code, stderr } = await converter.settled();
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(outcome.enabled).toBe(true);
    expect(outcome.mode).toBe('wal');
    // Review verification gap: `attempts` was captured and never asserted, so
    // a child that missed the lock entirely would have passed without ever
    // exercising the retry. It must have been refused at least once.
    expect(outcome.attempts).toBeGreaterThan(1);
    expect(journalMode(databasePath)).toBe('wal');
  });

  test('the scheduler ledger STARTS UP through the race it used to die on', async () => {
    // archive#3661 as reported: `PRAGMA journal_mode = WAL` sat unguarded in
    // the ledger constructor, so a second instance opening a brand-new home
    // threw `SQLITE_BUSY: database is locked` before the ledger existed and
    // took scheduler startup with it.
    const holder = new DatabaseSync(databasePath, { timeout: 5_000 });
    holder.exec('PRAGMA busy_timeout = 5000');
    holder.exec('BEGIN IMMEDIATE');
    holder.exec("INSERT INTO ledger (id) VALUES ('lock')");

    const instance = spawnHandshakingChild(
      CHILD_SCHEDULER_LEDGER,
      [LEDGER_URL, dir],
      { loader: 'tsx' },
    );
    expect(await instance.nextLine()).toBe('ATTEMPTING');
    await hold();
    holder.exec('COMMIT');
    holder.close();

    const created = JSON.parse(await instance.nextLine());
    const { code, stderr } = await instance.settled();
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(created).toEqual({ created: { kind: 'created' } });
    expect(journalMode(databasePath)).toBe('wal');
  });

  test('two real peers both survive the first open, and the file ends WAL', async () => {
    const holder = spawnHandshakingChild(
      CHILD_PEER,
      [HELPER_URL, databasePath, 'holder'],
      { loader: 'tsx' },
    );
    // The holder owns the write lock before the joiner is even spawned.
    expect(await holder.nextLine()).toBe('ATTEMPTING');

    const joiner = spawnHandshakingChild(
      CHILD_PEER,
      [HELPER_URL, databasePath, 'joiner'],
      { loader: 'tsx' },
    );
    expect(await joiner.nextLine()).toBe('ATTEMPTING');

    // The joiner is attempting the conversion against the locked
    // rollback-journal file for the whole of this hold.
    await hold();
    holder.go();

    const joinerOutcome = JSON.parse(await joiner.nextLine()) as {
      enabled: boolean;
      mode: string;
      attempts: number;
    };
    const holderOutcome = JSON.parse(await holder.nextLine()) as {
      enabled: boolean;
    };
    const [joinerExit, holderExit] = await Promise.all([
      joiner.settled(),
      holder.settled(),
    ]);
    expect([joinerExit.stderr, holderExit.stderr]).toEqual(['', '']);
    expect([joinerExit.code, holderExit.code]).toEqual([0, 0]);
    expect(joinerOutcome.enabled).toBe(true);
    expect(joinerOutcome.mode).toBe('wal');
    // Same gap: the joiner must have MET the lock, not merely arrived late.
    expect(joinerOutcome.attempts).toBeGreaterThan(1);
    expect(holderOutcome.enabled).toBe(true);
    expect(journalMode(databasePath)).toBe('wal');

    // Both peers got their write through, which is the point of surviving.
    const db = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      expect(
        db
          .prepare('SELECT id FROM ledger ORDER BY id')
          .all()
          .map((row) => row.id),
      ).toEqual(['holder', 'holder-done', 'joiner-done']);
    } finally {
      db.close();
    }
  });
});
