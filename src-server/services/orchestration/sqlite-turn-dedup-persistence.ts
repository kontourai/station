import type {
  TurnIdempotencyPersistence,
  TurnIdempotencyRecord,
} from '../turn-idempotency.js';

/**
 * The `orchestration_turn_dedup` half of EventStore's SQLite ownership,
 * extracted verbatim so the store composes it rather than embedding it.
 * `EventStore` still opens and owns the connection; this module never opens
 * one and holds no lifecycle of its own.
 */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: unknown[]): unknown;
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
  };
}

/**
 * Bound on retained turn-dedup rows. Exported so the `/chat` facade and this
 * store share ONE constant rather than each hardcoding 2000 — they did, in
 * two files, which is a drift waiting to happen.
 */
export const TURN_DEDUP_MAX_ENTRIES = 2000;

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
    if (!row) return undefined;
    return {
      value: row.value,
      createdAt: row.createdAt,
      ...(row.ownerJson === null
        ? {}
        : { owner: parseTurnClaimOwner(row.ownerJson) }),
    };
  }

  function prune(): void {
    // This is intentionally a soft cap. Resolved rows are safe to evict;
    // unresolved claims are never evicted, regardless of owner liveness, so a
    // turn in flight can never become claimable again because of retention.
    // The single statement deletes at most the overflow, oldest first, without
    // materializing rows or probing processes while the write lock is held.
    db.prepare(`DELETE FROM orchestration_turn_dedup
        WHERE dedup_key IN (
          SELECT dedup_key FROM orchestration_turn_dedup
          WHERE value IS NOT NULL
          ORDER BY created_at ASC, dedup_key ASC
          LIMIT MAX(0, (SELECT count(*) FROM orchestration_turn_dedup) - ?)
        )`).run(maxEntries);
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
        const decision = updater(read(key));
        if (decision.record)
          db.prepare(
            `INSERT INTO orchestration_turn_dedup (dedup_key, value, created_at, owner_json) VALUES (?, ?, ?, ?) ON CONFLICT(dedup_key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, owner_json = excluded.owner_json`,
          ).run(
            key,
            decision.record.value,
            decision.record.createdAt,
            decision.record.owner
              ? JSON.stringify(decision.record.owner)
              : null,
          );
        else
          db.prepare(
            'DELETE FROM orchestration_turn_dedup WHERE dedup_key = ?',
          ).run(key);
        prune();
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

function parseTurnClaimOwner(
  raw: string,
): import('../turn-idempotency.js').TurnClaimOwner {
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
  return value as import('../turn-idempotency.js').TurnClaimOwner;
}
