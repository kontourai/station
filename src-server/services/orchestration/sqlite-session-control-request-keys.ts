import {
  type KernelCommand,
  type KernelResult,
  resolveKernelLimits,
} from '@kontourai/monument';
import {
  createSessionControlRequestKeys,
  type SessionControlRequestKeys,
} from '@kontourai/monument/session-control';
import {
  openSqliteKernelStorage,
  type SqliteKernelTables,
} from '@kontourai/monument/sqlite';
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

/**
 * Completed rows older than this are forgotten; a retry that late is a new
 * request. Unresolved claims are kept whatever their age (#3559), and past
 * this age they stop counting toward the caps.
 */
export const SESSION_CONTROL_REQUEST_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The most rows one calling Session keeps. Past it, that caller's OWN oldest
 * completed rows are evicted to make room (a key that old no longer replays);
 * only when every one of its counted rows is an unresolved claim younger than
 * the TTL is the caller refused.
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

/**
 * Station's request-key table, bound in place of the kernel's own: it stays
 * the source of truth. The rules (the digest check, the quotas, and the TTL
 * purge that keeps an unresolved claim and stops counting it, #3606) are
 * Monument's.
 */
export const SESSION_CONTROL_REQUEST_KEY_KERNEL_TABLES: SqliteKernelTables = {
  requestKeys: {
    table: 'session_control_request_keys',
    resultColumn: 'result_json',
  },
  turnDedup: 'unused',
  turnBoundary: 'unused',
  inbox: 'unused',
};

export function createSqliteSessionControlRequestKeys(
  db: SqliteDatabase,
  options: {
    now?: () => number;
    /** Test seam: smaller caps than the defaults, so a cap can be reached cheaply. */
    limits?: { perCaller?: number; station?: number };
  } = {},
): SessionControlRequestKeys {
  const now = options.now ?? (() => Date.now());
  const kernel = openSqliteKernelStorage({
    database: db,
    tables: SESSION_CONTROL_REQUEST_KEY_KERNEL_TABLES,
  });
  const context = {
    // Request keys have no owner to be alive or dead.
    liveness: () => 'unknown' as const,
    limits: {
      requestKeyTtlMs: SESSION_CONTROL_REQUEST_KEY_TTL_MS,
      requestKeyMaxRowsPerCaller:
        options.limits?.perCaller ??
        SESSION_CONTROL_REQUEST_KEY_MAX_ROWS_PER_CALLER,
      requestKeyMaxRows:
        options.limits?.station ?? SESSION_CONTROL_REQUEST_KEY_MAX_ROWS,
    },
  };
  // Refuse a bad limit now, not at the first claim.
  resolveKernelLimits(context.limits);
  const execute = <C extends KernelCommand>(command: C): KernelResult<C> =>
    kernel.executeSync(command, context);
  return createSessionControlRequestKeys(execute, now);
}
