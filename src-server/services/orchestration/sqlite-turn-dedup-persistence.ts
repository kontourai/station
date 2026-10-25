import {
  type KernelCommand,
  type KernelResult,
  type OwnerLiveness,
  resolveKernelLimits,
} from '@kontourai/monument';
import {
  openSqliteKernelStorage,
  type SqliteKernelTables,
} from '@kontourai/monument/sqlite';
import type { TurnIdempotencyPersistence } from '../turn-idempotency.js';
import type { SqliteDatabase } from './sqlite-database.js';

/**
 * Bound on retained turn-dedup rows. Exported so the `/chat` facade and this
 * store share ONE constant rather than each hardcoding 2000 — they did, in
 * two files, which is a drift waiting to happen.
 */
export const TURN_DEDUP_MAX_ENTRIES = 2000;

/**
 * #3559 / #3606 review: how long an evicted `chat:` key's tombstone answers
 * `expired`. Far past every client retry window Station has (the longest,
 * the UI outbound queue, is seven days); after it the key is new again. The
 * bound exists because a relayed station-agent turn writes a thread key AND a
 * `chat:` key, and `chat:` tombstones have no thread whose deletion would
 * remove them. They go on the first dedup write after the bound, not at it.
 *
 * Thread tombstones are NOT time-bounded: a session-control start re-drives
 * its unresolved request key forever with the same clientTurnId, so its
 * thread tombstone must last as long. Both leave with `deleteThread`.
 */
const TURN_DEDUP_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * archive#1224 (offline): folds `(threadId, clientTurnId)` into the
 * flat key the shared `TurnIdempotencyStore` (`../turn-idempotency.ts`)
 * deals in, so the same `clientTurnId` reused on two different threads never
 * collides.
 *
 * archive#1224 HIGH fix (independent review): a plain `${threadId}::${id}`
 * join is NOT collision-free -- `orchestration.ts`'s schema allows any
 * string for `threadId`, so `threadId = 'thread::evil'` with
 * `clientTurnId = 'id'` and `threadId = 'thread'` with
 * `clientTurnId = 'evil::id'` would both join to the literal string
 * `thread::evil::id`. Length-prefixing `threadId` makes the encoding
 * unambiguous regardless of what characters either part contains: the first
 * `threadId.length` characters after the length prefix ARE `threadId`, full
 * stop, so no content inside `threadId` (including `::` itself) can ever be
 * misread as the separator.
 */
export function turnDedupKey(threadId: string, clientTurnId: string): string {
  return `${turnDedupThreadPrefix(threadId)}${clientTurnId}`;
}

/**
 * The length-prefixed, unambiguous prefix identifying every dedup key for
 * `threadId` — see `turnDedupKey`'s doc comment. `forgetThread`'s exact-prefix
 * cleanup uses it.
 */
function turnDedupThreadPrefix(threadId: string): string {
  return `${threadId.length}:${threadId}::`;
}
const CHAT_KEY_PREFIX = 'chat:';
export function chatTurnDedupKey(clientTurnId: string): string {
  return `${CHAT_KEY_PREFIX}${clientTurnId.length}:${clientTurnId}`;
}

/**
 * Station's turn-dedup tables, bound in place of the kernel's own: they stay
 * the source of truth, and an older binary that writes them directly keeps
 * working, but cannot enforce digest conflicts. A nullable input_digest
 * column is trusted only with its matching current-owner JSON marker.
 * Two encodings here predate the kernel:
 *
 * - `owner_json` names the owner `token`, and a thread row written before
 *   #3559 carries no invocation record. Thread keys start with the thread
 *   id's length, so they never start with `chat:`.
 * - #3559: a `chat:` row with NO invocation record was written before #3581
 *   by the /chat facade, which then recorded none, so it keeps the untracked
 *   reclaim rule. A record this build does not recognise is unknown on every
 *   key and fails closed.
 */
export const STATION_TURN_DEDUP_KERNEL_TABLES: SqliteKernelTables = {
  turnDedup: {
    table: 'orchestration_turn_dedup',
    tombstoneTable: 'orchestration_turn_dedup_expired',
    ownerIdField: 'token',
    inputDigestColumn: 'input_digest',
    ownerErrorMessage: 'Invalid orchestration turn claim owner_json',
    legacyUntrackedKeyPrefixes: [CHAT_KEY_PREFIX],
  },
  requestKeys: 'unused',
  turnBoundary: 'unused',
  inbox: 'unused',
};

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Liveness is consulted only by a claim; the other commands never ask. */
const NO_LIVENESS: OwnerLiveness = () => 'unknown';

export interface SqliteTurnDedupPersistence extends TurnIdempotencyPersistence {
  /**
   * Forget every claim and tombstone of `threadId`, as part of the transaction
   * the caller already holds: they commit or roll back together.
   */
  forgetThread(threadId: string): void;
}

/**
 * The storage half of the turn-dedup algorithm: Monument's `node:sqlite`
 * adapter over `orchestration_turn_dedup` on `EventStore`'s own connection.
 * `EventStore` composes this into the behavioral TurnDeduplicator while
 * retaining SQLite and transaction ownership privately.
 */
export function createSqliteTurnDedupPersistence({
  db,
  maxEntries = TURN_DEDUP_MAX_ENTRIES,
}: {
  db: SqliteDatabase;
  maxEntries?: number;
}): SqliteTurnDedupPersistence {
  const kernel = openSqliteKernelStorage({
    database: db,
    tables: STATION_TURN_DEDUP_KERNEL_TABLES,
  });
  // Resolved rows are the only eviction candidates: an unresolved claim is
  // never evicted, regardless of owner liveness, so a turn in flight can never
  // become claimable again because of retention (#3559).
  const limits = {
    turnDedupMaxEntries: maxEntries,
    turnDedupMinResolvedEntries: maxEntries,
    turnDedupTombstoneRetention: [
      {
        keyPrefix: CHAT_KEY_PREFIX,
        maxAgeMs: TURN_DEDUP_TOMBSTONE_RETENTION_MS,
      },
    ],
  };
  // Refuse a bad limit now, not at the first claim.
  resolveKernelLimits(limits);
  return {
    execute<C extends KernelCommand>(
      command: C,
      liveness: OwnerLiveness,
    ): KernelResult<C> {
      return kernel.executeSync(command, { liveness, limits });
    },
    forgetThread(threadId) {
      // archive#1224 HIGH fix (independent review): an exact prefix, never a
      // `LIKE`, so `%` and `_` inside a thread id cannot over-match another
      // thread's keys. SQLite keeps a lone surrogate as U+FFFD, so that is
      // what the stored keys hold and what the prefix must name.
      kernel.executeSync(
        {
          type: 'turnDedup.forgetPrefix',
          prefix: turnDedupThreadPrefix(threadId).replace(
            LONE_SURROGATE,
            '\uFFFD',
          ),
        },
        { liveness: NO_LIVENESS },
        { withinHostTransaction: true },
      );
    },
  };
}
