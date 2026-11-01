import { randomUUID } from 'node:crypto';
import {
  type OwnerIdentity,
  ownerLivenessFromProbe,
  type ProcessIdentityProbe,
  type TurnDedupHost,
} from '@kontourai/monument';
import type { SqliteKernelTables } from '@kontourai/monument/sqlite';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import { ClientTurnInputConflictError } from '../../providers/adapter-shape.js';
import { turnDedupClaims } from '../../telemetry/metrics.js';

export interface TurnIdempotencyProcessIdentity {
  exact(pid: number): { pid: number; start: string } | null;
  probe: ProcessIdentityProbe;
}
const defaultProcessIdentity: TurnIdempotencyProcessIdentity = {
  exact: exactProcessIdentity,
  probe: probeExactProcessIdentity,
};
const custody = new WeakMap<
  object,
  { key: string; owner: OwnerIdentity; createdAt: number }
>();
export function readPreparedClaimCustody(claim: object) {
  return custody.get(claim);
}
export function stationTurnDedupHost(
  identity: TurnIdempotencyProcessIdentity = defaultProcessIdentity,
): TurnDedupHost {
  const exact = identity.exact(process.pid);
  const owner: OwnerIdentity = exact
    ? {
        id: randomUUID(),
        pid: process.pid,
        identityKind: 'exact',
        birth: exact.start,
      }
    : { id: randomUUID(), pid: process.pid, identityKind: 'unverified' };
  return {
    owner,
    liveness: ownerLivenessFromProbe(identity.probe),
    conflictError: () => new ClientTurnInputConflictError(),
    bindPreparedClaim: (claim, record) => custody.set(claim, record),
    recordClaim: (outcome) => turnDedupClaims.add(1, { outcome }),
  };
}

/**
 * The legacy soft cap, retained for callers that report it. Station's timed
 * policy protects live retry windows even when this count is exceeded.
 */
export const TURN_DEDUP_MAX_ENTRIES = 2000;

/** A resolved result remains replayable for seven days after resolution. */
export const TURN_DEDUP_RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * archive#1224 (offline): folds `(threadId, clientTurnId)` into the
 * flat key the Monument `TurnIdempotencyStore`
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
export function turnDedupThreadPrefix(threadId: string): string {
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
    resolvedAtColumn: 'resolved_at',
    deletionPermitTable: 'orchestration_turn_dedup_delete_permits',
    ownerErrorMessage: 'Invalid orchestration turn claim owner_json',
    legacyUntrackedKeyPrefixes: [CHAT_KEY_PREFIX],
  },
  requestKeys: 'unused',
  turnBoundary: 'unused',
  inbox: 'unused',
};
