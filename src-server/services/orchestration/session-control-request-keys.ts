import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './sqlite-database.js';

/**
 * #3160: the durable request-key table behind `send_to_session` and
 * `interrupt_session`.
 *
 * An agent that retries a tool call (a timeout, a model re-issuing the call)
 * must not deliver its message twice. The caller names one logical request
 * with a `requestKey`; this table maps `(callerSessionId, tool, key)` to the
 * digest of what the request asked for and, once it has an effect, the result:
 *
 * - the same key with the same digest returns the stored result;
 * - the same key with a different digest is `request_key_conflict` (the key
 *   names ANOTHER request: refuse rather than guess which one was meant);
 * - a claim with no result is an attempt that may have had its effect. It is
 *   never reclaimed blindly: a replay re-drives it with the delivery decision
 *   the first attempt recorded, and the downstream ids derived from the key
 *   (`clientTurnId`, `clientInputId`) make the delivery itself idempotent.
 *
 * The key is scoped by the VERIFIED calling session, never by anything the
 * tool input says, so one agent cannot replay or collide with another's keys.
 */

/** Rows older than this are forgotten; a retry that late is a new request. */
export const SESSION_CONTROL_REQUEST_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The most rows one calling Session keeps. Past it, that caller's OWN oldest
 * completed rows are evicted to make room (a key that old no longer replays);
 * only when every one of its rows is an unresolved claim is the caller refused.
 * One caller therefore cannot fill the table for the others.
 */
export const SESSION_CONTROL_REQUEST_KEY_MAX_ROWS_PER_CALLER = 300;
/**
 * Station-wide backstop: refuse new claims past this many live rows instead of
 * evicting another caller's row, whose eviction would silently re-allow a
 * duplicate delivery.
 */
export const SESSION_CONTROL_REQUEST_KEY_MAX_ROWS = 10_000;

export const SESSION_CONTROL_REQUEST_KEY_SCHEMA = `CREATE TABLE IF NOT EXISTS session_control_request_keys (
  caller_session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  request_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  decision TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (caller_session_id, tool, request_key)
)`;

export interface SessionControlRequestKeyId {
  readonly callerSessionId: string;
  readonly tool: string;
  readonly key: string;
}

export type SessionControlKeyClaim =
  /** A new request: run it. */
  | { readonly kind: 'claimed' }
  /** An earlier attempt left no result: run it again with its recorded decision. */
  | { readonly kind: 'resumed'; readonly decision?: string }
  /** The same request is running right now in this process. */
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'replay'; readonly result: unknown }
  | { readonly kind: 'conflict' }
  /** `caller`: all of this caller's rows are unresolved; `station`: the backstop. */
  | { readonly kind: 'capacity'; readonly scope: 'caller' | 'station' };

export interface SessionControlRequestKeys {
  /** Claim the key for a request with this digest. */
  claim(id: SessionControlRequestKeyId, digest: string): SessionControlKeyClaim;
  /** Persist what the attempt decided to do, before it does it. */
  recordDecision(id: SessionControlRequestKeyId, decision: string): void;
  /** Persist the final result; later same-digest claims replay it. */
  complete(id: SessionControlRequestKeyId, result: unknown): void;
  /** Free a key whose attempt provably had no effect, so a retry may run. */
  release(id: SessionControlRequestKeyId): void;
  /** Stop treating the attempt as running here; the claim stays for a replay. */
  settle(id: SessionControlRequestKeyId): void;
}

function sqliteChanges(result: unknown): number {
  return typeof result === 'object' &&
    result !== null &&
    typeof (result as { changes?: unknown }).changes === 'number'
    ? (result as { changes: number }).changes
    : 0;
}

const activeId = (id: SessionControlRequestKeyId): string =>
  JSON.stringify([id.callerSessionId, id.tool, id.key]);

/** The digest of what a request asks for; a different ask is a different digest. */
export function sessionControlRequestDigest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * The id the delivery layers see for a request (`clientTurnId` of a start,
 * `clientInputId` of a steer): a function of the verified caller, the tool and
 * the key, so a replay presents the same id and the layer below deduplicates.
 */
export function sessionControlDeliveryId(
  id: SessionControlRequestKeyId,
): string {
  return `sc-${createHash('sha256').update(activeId(id)).digest('hex').slice(0, 40)}`;
}

export function createSqliteSessionControlRequestKeys(
  db: SqliteDatabase,
  options: {
    now?: () => number;
    /** Test seam: smaller caps than the defaults, so a cap can be reached cheaply. */
    limits?: { perCaller?: number; station?: number };
  } = {},
): SessionControlRequestKeys {
  const now = options.now ?? (() => Date.now());
  const perCallerCap =
    options.limits?.perCaller ??
    SESSION_CONTROL_REQUEST_KEY_MAX_ROWS_PER_CALLER;
  const stationCap =
    options.limits?.station ?? SESSION_CONTROL_REQUEST_KEY_MAX_ROWS;
  // Attempts running in THIS process. A stored claim with no result and no
  // entry here is an attempt a crash or an indeterminate outcome left behind.
  const running = new Set<string>();

  const read = (id: SessionControlRequestKeyId) =>
    db
      .prepare(
        `SELECT digest, decision, result_json AS resultJson
         FROM session_control_request_keys
         WHERE caller_session_id = ? AND tool = ? AND request_key = ?`,
      )
      .get(id.callerSessionId, id.tool, id.key) as
      | {
          digest: string;
          decision: string | null;
          resultJson: string | null;
        }
      | undefined;

  return {
    claim(id, digest) {
      // A row past the TTL is forgotten before it can answer.
      db.prepare(
        'DELETE FROM session_control_request_keys WHERE created_at < ?',
      ).run(now() - SESSION_CONTROL_REQUEST_KEY_TTL_MS);
      const existing = read(id);
      if (existing) {
        if (existing.digest !== digest) return { kind: 'conflict' };
        if (existing.resultJson !== null)
          return {
            kind: 'replay',
            result: JSON.parse(existing.resultJson) as unknown,
          };
        const handle = activeId(id);
        if (running.has(handle)) return { kind: 'in-progress' };
        running.add(handle);
        return {
          kind: 'resumed',
          ...(existing.decision !== null
            ? { decision: existing.decision }
            : {}),
        };
      }
      // The caller's own quota first: make room by dropping ITS oldest
      // completed rows, never an unresolved claim and never another caller's.
      const owned = db
        .prepare(
          `SELECT COUNT(*) AS total FROM session_control_request_keys
           WHERE caller_session_id = ?`,
        )
        .get(id.callerSessionId) as { total: number };
      const excess = owned.total - perCallerCap + 1;
      if (excess > 0) {
        db.prepare(
          `DELETE FROM session_control_request_keys WHERE rowid IN (
             SELECT rowid FROM session_control_request_keys
             WHERE caller_session_id = ? AND result_json IS NOT NULL
             ORDER BY created_at ASC, rowid ASC LIMIT ?)`,
        ).run(id.callerSessionId, excess);
        const left = db
          .prepare(
            `SELECT COUNT(*) AS total FROM session_control_request_keys
             WHERE caller_session_id = ?`,
          )
          .get(id.callerSessionId) as { total: number };
        if (left.total >= perCallerCap)
          return { kind: 'capacity', scope: 'caller' };
      }
      const count = db
        .prepare('SELECT COUNT(*) AS total FROM session_control_request_keys')
        .get() as { total: number };
      if (count.total >= stationCap)
        return { kind: 'capacity', scope: 'station' };
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO session_control_request_keys
             (caller_session_id, tool, request_key, digest, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id.callerSessionId, id.tool, id.key, digest, now());
      // Another connection won the insert: it owns the attempt.
      if (sqliteChanges(inserted) !== 1) return { kind: 'in-progress' };
      running.add(activeId(id));
      return { kind: 'claimed' };
    },
    recordDecision(id, decision) {
      db.prepare(
        `UPDATE session_control_request_keys SET decision = ?
         WHERE caller_session_id = ? AND tool = ? AND request_key = ?`,
      ).run(decision, id.callerSessionId, id.tool, id.key);
    },
    complete(id, result) {
      try {
        const updated = db
          .prepare(
            `UPDATE session_control_request_keys SET result_json = ?
             WHERE caller_session_id = ? AND tool = ? AND request_key = ?`,
          )
          .run(JSON.stringify(result), id.callerSessionId, id.tool, id.key);
        if (sqliteChanges(updated) !== 1)
          throw new Error('Session control request result was not recorded.');
      } finally {
        running.delete(activeId(id));
      }
    },
    release(id) {
      try {
        db.prepare(
          `DELETE FROM session_control_request_keys
           WHERE caller_session_id = ? AND tool = ? AND request_key = ?
             AND result_json IS NULL`,
        ).run(id.callerSessionId, id.tool, id.key);
      } finally {
        running.delete(activeId(id));
      }
    },
    settle(id) {
      running.delete(activeId(id));
    },
  };
}

/** What one attempt reports back to {@link runWithSessionControlKey}. */
export type SessionControlAttempt<Result> =
  /** The request is answered; store the result for replays. */
  | { readonly settle: 'final'; readonly result: Result }
  /**
   * It provably had no effect (a clean failure): free the key. Honoured only
   * for a fresh claim; a re-driven (resumed) claim is kept instead.
   */
  | { readonly settle: 'release'; readonly result: Result }
  /** It may have had its effect: keep the claim, store nothing. */
  | { readonly settle: 'pending'; readonly result: Result };

export type SessionControlKeyedOutcome<Result> =
  | { readonly kind: 'executed'; readonly result: Result }
  | { readonly kind: 'replayed'; readonly result: Result }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'capacity'; readonly scope: 'caller' | 'station' };

/**
 * Run one keyed request exactly as the table says: claim, attempt, settle. A
 * thrown attempt is treated as `pending`: the effect may have happened, so the
 * claim stays and a replay re-drives it with its recorded decision.
 */
export async function runWithSessionControlKey<Result>(
  keys: SessionControlRequestKeys,
  id: SessionControlRequestKeyId,
  digest: string,
  attempt: (resume: {
    readonly decision?: string;
    recordDecision(decision: string): void;
  }) => Promise<SessionControlAttempt<Result>>,
): Promise<SessionControlKeyedOutcome<Result>> {
  const claim = keys.claim(id, digest);
  switch (claim.kind) {
    case 'conflict':
    case 'in-progress':
      return { kind: claim.kind };
    case 'capacity':
      return { kind: 'capacity', scope: claim.scope };
    case 'replay':
      return { kind: 'replayed', result: claim.result as Result };
    case 'claimed':
    case 'resumed':
      break;
  }
  let outcome: SessionControlAttempt<Result>;
  try {
    outcome = await attempt({
      ...(claim.kind === 'resumed' && claim.decision !== undefined
        ? { decision: claim.decision }
        : {}),
      recordDecision: (decision) => keys.recordDecision(id, decision),
    });
  } catch (error) {
    keys.settle(id);
    throw error;
  }
  if (outcome.settle === 'final') keys.complete(id, outcome.result);
  // Only a FRESH claim can be freed: no earlier attempt of it existed that
  // could have had its effect. A resumed claim is an earlier attempt that may
  // have delivered; deleting it would also delete the branch it pinned, and a
  // later call would claim afresh and could deliver the same text again by the
  // other branch. Whatever a re-drive reports, a resumed claim stays.
  else if (outcome.settle === 'release' && claim.kind === 'claimed')
    keys.release(id);
  else keys.settle(id);
  return { kind: 'executed', result: outcome.result };
}
