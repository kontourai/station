/**
 * #4771: what became of a worktree Session's output, one row per Session.
 *
 * A row is `settled` once and never changes or goes away again (the
 * triggers). `pending` exists only for a discard: the intent is written
 * before the Git effect, so a crash between the effect and the record
 * leaves a row a retry completes, never a gone worktree with no decision.
 * A pending row may still be replaced or removed, because nothing about it
 * is final. `owner_json` names the process that wrote a pending intent
 * (pid and birth fingerprint), so another process abandons it only once
 * that owner is provably gone.
 */
export const WORKTREE_OUTPUT_SETTLEMENTS_MIGRATION = `
CREATE TABLE IF NOT EXISTS worktree_output_settlements (
  session_id TEXT PRIMARY KEY CHECK (length(session_id) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (state IN ('pending', 'settled')),
  outcome TEXT NOT NULL CHECK (outcome IN ('discarded', 'kept', 'released', 'cleaned-up-without-decision')),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK (length(request_digest) BETWEEN 1 AND 128),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('person', 'station')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
  repo_path TEXT NOT NULL CHECK (length(repo_path) BETWEEN 1 AND 4096),
  worktree_path TEXT NOT NULL CHECK (length(worktree_path) BETWEEN 1 AND 4096),
  branch TEXT NOT NULL CHECK (length(branch) BETWEEN 1 AND 512),
  base_ref TEXT NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 512),
  base_commit TEXT CHECK (base_commit IS NULL OR length(base_commit) IN (40, 64)),
  head_commit TEXT CHECK (head_commit IS NULL OR length(head_commit) IN (40, 64)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND length(evidence_json) <= 8192),
  requested_at TEXT NOT NULL,
  settled_at TEXT,
  owner_json TEXT CHECK (owner_json IS NULL OR (json_valid(owner_json) AND length(owner_json) <= 1024)),
  CHECK ((state = 'settled') = (settled_at IS NOT NULL)),
  CHECK (state = 'settled' OR outcome = 'discarded'),
  CHECK ((actor_kind = 'station') = (outcome = 'cleaned-up-without-decision'))
);
CREATE TRIGGER IF NOT EXISTS worktree_output_settlements_final_update
BEFORE UPDATE ON worktree_output_settlements
WHEN OLD.state = 'settled'
BEGIN
  SELECT RAISE(ABORT, 'a settled worktree output is final');
END;
CREATE TRIGGER IF NOT EXISTS worktree_output_settlements_final_delete
BEFORE DELETE ON worktree_output_settlements
WHEN OLD.state = 'settled'
BEGIN
  SELECT RAISE(ABORT, 'a settled worktree output is final');
END;
`;

/**
 * A database created by an earlier build of this migration has the table
 * without `owner_json`, and `CREATE TABLE IF NOT EXISTS` leaves it so. Add the
 * column once; another EventStore may add it first.
 */
export function ensureWorktreeOutputSettlementOwnerColumn(db: {
  prepare(sql: string): { all(): unknown[] };
  exec(sql: string): void;
}): void {
  const hasColumn = () =>
    (
      db
        .prepare('PRAGMA table_info(worktree_output_settlements)')
        .all() as Array<{ name?: unknown }>
    ).some((column) => column.name === 'owner_json');
  if (hasColumn()) return;
  try {
    db.exec(
      'ALTER TABLE worktree_output_settlements ADD COLUMN owner_json TEXT CHECK (owner_json IS NULL OR (json_valid(owner_json) AND length(owner_json) <= 1024))',
    );
  } catch (error) {
    if (!hasColumn()) throw error;
  }
}
