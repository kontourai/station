import type {
  TurnClaimInvocation,
  TurnClaimOwner,
  TurnIdempotencyPersistence,
  TurnIdempotencyRecord,
} from '../turn-idempotency.js';
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
export const TURN_DEDUP_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
 * `threadId` — see `turnDedupKey`'s doc comment. Exported for
 * `EventStore.deleteThread`'s exact-prefix cleanup query.
 */
export function turnDedupThreadPrefix(threadId: string): string {
  return `${threadId.length}:${threadId}::`;
}
export function chatTurnDedupKey(clientTurnId: string): string {
  return `chat:${clientTurnId.length}:${clientTurnId}`;
}
/** Thread keys start with the thread id's length, so they never start with `chat:`. */
function isChatTurnDedupKey(key: string): boolean {
  return key.startsWith('chat:');
}

/**
 * SQLite-backed `TurnIdempotencyPersistence` adapter over
 * `orchestration_turn_dedup` — the storage half of the shared algorithm.
 * `EventStore` composes this into the behavioral TurnDeduplicator while
 * retaining SQLite and transaction ownership privately.
 */
export function createSqliteTurnDedupPersistence({
  db,
  maxEntries = TURN_DEDUP_MAX_ENTRIES,
}: {
  db: SqliteDatabase;
  maxEntries?: number;
}): TurnIdempotencyPersistence {
  function read(key: string): TurnIdempotencyRecord | undefined {
    const row = db
      .prepare(
        `SELECT value, created_at AS createdAt, owner_json AS ownerJson
         FROM orchestration_turn_dedup
         WHERE dedup_key = ?`,
      )
      .get(key) as
      | { value: string | null; createdAt: number; ownerJson: string | null }
      | undefined;
    if (!row) {
      const tombstone = db
        .prepare(
          `SELECT expired_at AS expiredAt FROM orchestration_turn_dedup_expired
           WHERE dedup_key = ?`,
        )
        .get(key) as { expiredAt: number } | undefined;
      return tombstone
        ? { value: null, createdAt: tombstone.expiredAt, expired: true }
        : undefined;
    }
    const claimant =
      row.ownerJson === null ? undefined : parseTurnClaimOwner(row.ownerJson);
    // #3559: a `chat:` row with NO invocation record was written before
    // #3581 by the /chat facade, which then recorded none, so it keeps the
    // untracked reclaim rule. A record this build does not recognise is
    // unknown on every key and fails closed.
    const invocation =
      claimant?.invocation ??
      (isChatTurnDedupKey(key) && !claimant?.invocationRecorded
        ? 'untracked'
        : undefined);
    return {
      value: row.value,
      createdAt: row.createdAt,
      ...(claimant ? { owner: claimant.owner } : {}),
      ...(invocation ? { invocation } : {}),
    };
  }

  function prune(now: number): void {
    // This is intentionally a soft cap. Resolved rows are the only eviction
    // candidates; unresolved claims are never evicted, regardless of owner
    // liveness, so a turn in flight can never become claimable again because
    // of retention. The statements touch at most the overflow, oldest first,
    // without materializing rows or probing processes under the write lock.
    //
    // #3559: an evicted row leaves a tombstone, so a late retry of its key
    // answers `expired` instead of claiming it afresh and sending the turn
    // again. Tombstones hold only the key and do not count toward the cap.
    // `chat:` tombstones are removed once older than
    // TURN_DEDUP_TOMBSTONE_RETENTION_MS; thread tombstones only by deleteThread.
    // Both statements select the same overflow: nothing writes the dedup
    // table between them inside this transaction, and the order is total.
    const overflow = `SELECT dedup_key FROM orchestration_turn_dedup
          WHERE value IS NOT NULL
          ORDER BY created_at ASC, dedup_key ASC
          LIMIT MAX(0, (SELECT count(*) FROM orchestration_turn_dedup) - ?)`;
    db.prepare(
      `INSERT OR IGNORE INTO orchestration_turn_dedup_expired (dedup_key, expired_at)
       SELECT dedup_key, ? FROM (${overflow})`,
    ).run(now, maxEntries);
    db.prepare(
      `DELETE FROM orchestration_turn_dedup WHERE dedup_key IN (${overflow})`,
    ).run(maxEntries);
    db.prepare(
      `DELETE FROM orchestration_turn_dedup_expired
       WHERE expired_at < ? AND substr(dedup_key, 1, 5) = 'chat:'`,
    ).run(now - TURN_DEDUP_TOMBSTONE_RETENTION_MS);
  }

  return {
    read,

    update<T>(
      key: string,
      updater: (current: TurnIdempotencyRecord | undefined) => {
        record?: TurnIdempotencyRecord;
        result: T;
      },
    ): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = read(key);
        const decision = updater(current);
        // A tombstone is final: an expired key is never written again, and
        // no decision about it touches the live table.
        if (current?.expired) {
          db.exec('COMMIT');
          return decision.result;
        }
        if (decision.record?.expired)
          throw new Error('An expired turn claim cannot be written.');
        if (decision.record)
          db.prepare(
            `INSERT INTO orchestration_turn_dedup (dedup_key, value, created_at, owner_json) VALUES (?, ?, ?, ?) ON CONFLICT(dedup_key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, owner_json = excluded.owner_json`,
          ).run(
            key,
            decision.record.value,
            decision.record.createdAt,
            serializeTurnClaimOwner(decision.record),
          );
        else
          db.prepare(
            'DELETE FROM orchestration_turn_dedup WHERE dedup_key = ?',
          ).run(key);
        prune(Date.now());
        db.exec('COMMIT');
        return decision.result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw error;
      }
    },
  };
}

/**
 * #3559: the invocation record lives inside `owner_json`, beside the owner it
 * describes. A writer that replaces the owner without recording invocation
 * (an older peer or a downgraded runtime reclaiming the row) therefore drops
 * it, and the row reads as unknown rather than as a stale `pending` that a
 * later claimant would reclaim after that writer invoked and died. A record
 * with no owner cannot carry it and reads as unknown too.
 */
function serializeTurnClaimOwner(record: TurnIdempotencyRecord): string | null {
  if (!record.owner) return null;
  return JSON.stringify(
    record.invocation
      ? { ...record.owner, invocation: record.invocation }
      : record.owner,
  );
}

/**
 * Unknown invocation values read as absent, so a dead owner's claim is never
 * reclaimed. Only a `chat:` row with no invocation record at all falls back to
 * `untracked` in `read`.
 */
function parseTurnClaimInvocation(
  raw: unknown,
): TurnClaimInvocation | undefined {
  return raw === 'pending' || raw === 'begun' || raw === 'untracked'
    ? raw
    : undefined;
}

function parseTurnClaimOwner(raw: string): {
  owner: TurnClaimOwner;
  invocation?: TurnClaimInvocation;
  /** Whether the row carries any invocation record, recognised or not. */
  invocationRecorded: boolean;
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid orchestration turn claim owner_json');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isInteger((value as any).pid) ||
    (value as any).pid < 1 ||
    typeof (value as any).token !== 'string' ||
    !(value as any).token ||
    !(
      (value as any).identityKind === 'unverified' ||
      ((value as any).identityKind === 'exact' &&
        typeof (value as any).birth === 'string' &&
        (value as any).birth)
    )
  )
    throw new Error('Invalid orchestration turn claim owner_json');
  const parsed = value as TurnClaimOwner & { invocation?: unknown };
  // Rebuilt field by field so the invocation record never rides along as an
  // owner property.
  const owner: TurnClaimOwner =
    parsed.identityKind === 'exact'
      ? {
          pid: parsed.pid,
          birth: parsed.birth,
          token: parsed.token,
          identityKind: 'exact',
        }
      : { pid: parsed.pid, token: parsed.token, identityKind: 'unverified' };
  const invocation = parseTurnClaimInvocation(parsed.invocation);
  return {
    owner,
    ...(invocation ? { invocation } : {}),
    invocationRecorded: parsed.invocation !== undefined,
  };
}
