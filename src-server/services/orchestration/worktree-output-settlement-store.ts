import { type OwnerIdentity, parseOwnerIdentity } from '@kontourai/monument';
import type {
  WorktreeOutputSettlement,
  WorktreeOutputSettlementEvidence,
} from '@kontourai/station-contracts/workspace-isolation';
import type { SqliteDatabase } from './sqlite-database.js';

/** A record as stored: the public shape plus its request's digest. */
export interface StoredWorktreeOutputSettlement {
  readonly record: WorktreeOutputSettlement;
  /** Digest of the request that made it; a replay must match it. */
  readonly requestDigest: string;
  /** The process that wrote a pending intent; never part of the record. */
  readonly owner?: OwnerIdentity;
}

export type WorktreeOutputSettlementInsert =
  | {
      readonly kind: 'inserted';
      readonly stored: StoredWorktreeOutputSettlement;
    }
  | {
      readonly kind: 'exists';
      readonly stored: StoredWorktreeOutputSettlement;
    };

/**
 * #4771: the one row per worktree Session that says what became of its
 * output (`029-worktree-output-settlements.ts`). Every write is one
 * transaction that first reads the Session's row, so a second settlement
 * finds the first and changes nothing.
 */
export interface WorktreeOutputSettlementStore {
  read(sessionId: string): StoredWorktreeOutputSettlement | undefined;
  /** Inserts `stored` unless the Session already has a row. */
  insert(
    stored: StoredWorktreeOutputSettlement,
  ): WorktreeOutputSettlementInsert;
  /** Settles the Session's pending row made with `requestKey`. */
  settlePending(input: {
    sessionId: string;
    requestKey: string;
    evidence: WorktreeOutputSettlementEvidence;
    settledAt: string;
  }): StoredWorktreeOutputSettlement;
  /** Removes the Session's pending row made with `requestKey`, if any. */
  abandonPending(sessionId: string, requestKey: string): void;
}

interface Row {
  session_id: string;
  state: 'pending' | 'settled';
  outcome: WorktreeOutputSettlement['outcome'];
  request_key: string;
  request_digest: string;
  actor_kind: 'person' | 'station';
  actor_id: string;
  repo_path: string;
  worktree_path: string;
  branch: string;
  base_ref: string;
  base_commit: string | null;
  head_commit: string | null;
  evidence_json: string;
  requested_at: string;
  settled_at: string | null;
  owner_json: string | null;
}

/**
 * Strictly decoded, as Monument decodes its own owners: a malformed owner is
 * dropped, and an intent with no owner is never judged abandoned.
 */
function ownerFromRow(json: string | null): { owner?: OwnerIdentity } {
  if (!json) return {};
  try {
    return { owner: parseOwnerIdentity(JSON.parse(json)) };
  } catch {
    return {};
  }
}

function fromRow(row: Row): StoredWorktreeOutputSettlement {
  const actor: WorktreeOutputSettlement['actor'] =
    row.actor_kind === 'station'
      ? { kind: 'station', id: 'worktree-cleanup-policy' }
      : { kind: 'person', id: row.actor_id };
  return {
    requestDigest: row.request_digest,
    ...ownerFromRow(row.owner_json),
    record: {
      sessionId: row.session_id,
      state: row.state,
      outcome: row.outcome,
      actor,
      requestKey: row.request_key,
      repoPath: row.repo_path,
      worktreePath: row.worktree_path,
      branch: row.branch,
      baseRef: row.base_ref,
      ...(row.base_commit ? { baseCommit: row.base_commit } : {}),
      ...(row.head_commit ? { headCommit: row.head_commit } : {}),
      evidence: JSON.parse(
        row.evidence_json,
      ) as WorktreeOutputSettlementEvidence,
      requestedAt: row.requested_at,
      ...(row.settled_at ? { settledAt: row.settled_at } : {}),
    },
  };
}

export function createSqliteWorktreeOutputSettlementStore(
  db: SqliteDatabase,
): WorktreeOutputSettlementStore {
  const transaction = <T>(run: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const read = (sessionId: string) => {
    const row = db
      .prepare('SELECT * FROM worktree_output_settlements WHERE session_id = ?')
      .get(sessionId) as Row | undefined;
    return row ? fromRow(row) : undefined;
  };
  return {
    read,
    insert: (stored) =>
      transaction(() => {
        const existing = read(stored.record.sessionId);
        if (existing) return { kind: 'exists', stored: existing };
        const { record } = stored;
        db.prepare(`INSERT INTO worktree_output_settlements
          (session_id, state, outcome, request_key, request_digest, actor_kind, actor_id,
           repo_path, worktree_path, branch, base_ref, base_commit, head_commit,
           evidence_json, requested_at, settled_at, owner_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          record.sessionId,
          record.state,
          record.outcome,
          record.requestKey,
          stored.requestDigest,
          record.actor.kind,
          record.actor.id,
          record.repoPath,
          record.worktreePath,
          record.branch,
          record.baseRef,
          record.baseCommit ?? null,
          record.headCommit ?? null,
          JSON.stringify(record.evidence),
          record.requestedAt,
          record.settledAt ?? null,
          stored.owner ? JSON.stringify(stored.owner) : null,
        );
        const inserted = read(record.sessionId);
        if (!inserted)
          throw new Error('Worktree output settlement was not recorded.');
        return { kind: 'inserted', stored: inserted };
      }),
    settlePending: (input) =>
      transaction(() => {
        const updated = db
          .prepare(`UPDATE worktree_output_settlements
            SET state = 'settled', evidence_json = ?, settled_at = ?, owner_json = NULL
            WHERE session_id = ? AND request_key = ? AND state = 'pending'`)
          .run(
            JSON.stringify(input.evidence),
            input.settledAt,
            input.sessionId,
            input.requestKey,
          ) as { changes: number | bigint };
        const settled = read(input.sessionId);
        if (Number(updated.changes) !== 1 || !settled)
          throw new Error('No pending worktree output settlement to complete.');
        return settled;
      }),
    abandonPending: (sessionId, requestKey) => {
      db.prepare(
        `DELETE FROM worktree_output_settlements
         WHERE session_id = ? AND request_key = ? AND state = 'pending'`,
      ).run(sessionId, requestKey);
    },
  };
}
