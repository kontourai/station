import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { orchestrationStorePath } from '@kontourai/station-shared/sqlite-store-integrity';
import { projectionFactKeysForEvent } from '../../services/orchestration/orchestration-session-state.js';
import { applyWalJournalMode } from '../../utils/sqlite-wal.js';
import { PROJECT_TASK_ROOM_RUNTIME_MIGRATION } from './006-project-task-room-runtime.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: typeof NodeDatabaseSync;
};

export const ORCHESTRATION_EVENT_STORE_MIGRATION = `
CREATE TABLE IF NOT EXISTS orchestration_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  method TEXT NOT NULL,
  request_id TEXT,
  session_state TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Station receipt time. Existing rows intentionally remain NULL: their
  -- provider timestamp is not evidence of when this Station observed them.
  observed_at TEXT,
  sequence INTEGER NOT NULL,
  global_sequence INTEGER NOT NULL DEFAULT 0
);

-- Explicit native declarations are a private, bounded descriptor projection.
-- They never widen the generic event payload/transcript contract.
CREATE TABLE IF NOT EXISTS orchestration_declared_outputs (
  event_id TEXT NOT NULL,
  declaration_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  label TEXT,
  descriptor TEXT NOT NULL,
  PRIMARY KEY (event_id, declaration_id),
  FOREIGN KEY (event_id) REFERENCES orchestration_events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_declared_outputs_session_event
  ON orchestration_declared_outputs(thread_id, event_id);
CREATE TABLE IF NOT EXISTS orchestration_declared_output_handle_uses (
  handle TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES orchestration_events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orchestration_event_store_backfills (
  name TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_event_store_backfill_progress (
  name TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_request_state (
  thread_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('request.opened', 'request.resolved')),
  sequence INTEGER NOT NULL,
  PRIMARY KEY (thread_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_request_state_thread_sequence
  ON orchestration_request_state(thread_id, sequence);

CREATE TABLE IF NOT EXISTS orchestration_console_delivery_progress (
  thread_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  delivered_through INTEGER NOT NULL CHECK (delivered_through >= 0),
  PRIMARY KEY (thread_id, scope_id)
);

CREATE TABLE IF NOT EXISTS orchestration_session_projection_facts (
  thread_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, fact_key)
);

CREATE INDEX IF NOT EXISTS idx_events_thread
  ON orchestration_events(thread_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_method
  ON orchestration_events(method);
CREATE INDEX IF NOT EXISTS idx_events_history_projection
  ON orchestration_events(thread_id, method, sequence);
CREATE INDEX IF NOT EXISTS idx_events_turn_window
  ON orchestration_events(thread_id, method, created_at DESC, turn_id DESC);
-- idx_events_usage_observed is created additively by EventStore only after
-- legacy databases have gained the observed_at column.

-- Message search is deliberately a separate, write-time projection.  A
-- request must never replay every event (or every transcript) to answer a
-- palette keystroke.  Only user prompts and completed assistant output are
-- admitted; deltas, tools, reasoning, and system events are not chat text.
CREATE VIRTUAL TABLE IF NOT EXISTS orchestration_message_search USING fts5(
  thread_id UNINDEXED,
  event_id UNINDEXED,
  turn_id UNINDEXED,
  role UNINDEXED,
  content,
  created_at UNINDEXED,
  tokenize = 'unicode61'
);

-- v2 scopes the FTS postings themselves before content matching.  The v1
-- projection remains only so an upgrade never drops searchable bodies before
-- the bounded v2 projector has copied them.
CREATE VIRTUAL TABLE IF NOT EXISTS orchestration_message_search_v2 USING fts5(
  thread_id UNINDEXED,
  event_id UNINDEXED,
  turn_id UNINDEXED,
  role UNINDEXED,
  owner_scope_key,
  tenant_scope_key,
  content,
  created_at UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS orchestration_message_search_projection (
  event_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS orchestration_message_search_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_global_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- v3 adds a CJK n-gram term projection while retaining unicode61 for ordinary
-- text and opaque scope keys. It has an independent ledger so a concurrent v2
-- process cannot mark an event projected before this index has seen it.
CREATE VIRTUAL TABLE IF NOT EXISTS orchestration_message_search_v3 USING fts5(
  thread_id UNINDEXED,
  event_id UNINDEXED,
  turn_id UNINDEXED,
  role UNINDEXED,
  owner_scope_key,
  tenant_scope_key,
  cjk_terms,
  content,
  created_at UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS orchestration_message_search_projection_v3 (
  event_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS orchestration_message_search_backfill_v3 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_global_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- The completed-turn provenance projection is assembled once while the live
-- turn is still available, then replayed by its narrow primary key.  This is
-- deliberately a sidecar rather than another event: the canonical event log
-- remains byte-for-byte provider output.
CREATE TABLE IF NOT EXISTS orchestration_turn_provenance (
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  envelope TEXT NOT NULL,
  envelope_bytes INTEGER NOT NULL CHECK (envelope_bytes >= 0),
  PRIMARY KEY (thread_id, turn_id)
);

CREATE TABLE IF NOT EXISTS orchestration_command_receipts (
  command_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_session_state (
  thread_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  cwd TEXT,
  continuation_source_thread_id TEXT,
  adoption_idempotency_key TEXT,
  persist_session INTEGER NOT NULL DEFAULT 0,
  ephemeral INTEGER NOT NULL DEFAULT 0,
  tenant_execution_context TEXT,
  resume_cursor TEXT,
  control_mode TEXT NOT NULL DEFAULT 'station-owned',
  attached_source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_conversation_history (
  thread_id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  tenant_id TEXT,
  agent_slug TEXT,
  project_slug TEXT,
  title TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_history_owner_recency
  ON orchestration_conversation_history(owner_user_id, updated_at DESC, thread_id DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_history_owner_agent_recency
  ON orchestration_conversation_history(owner_user_id, agent_slug, updated_at DESC, thread_id DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_history_tenant_owner_recency
  ON orchestration_conversation_history(tenant_id, owner_user_id, updated_at DESC, thread_id DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_history_tenant_owner_agent_recency
  ON orchestration_conversation_history(tenant_id, owner_user_id, agent_slug, updated_at DESC, thread_id DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_history_bound_tenant_owner_recency
  ON orchestration_conversation_history(tenant_id, owner_user_id, updated_at DESC, thread_id DESC)
  WHERE agent_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_history_bound_tenant_owner_agent_recency
  ON orchestration_conversation_history(tenant_id, owner_user_id, agent_slug, updated_at DESC, thread_id DESC)
  WHERE agent_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_history_ownerless_recency
  ON orchestration_conversation_history(owner_user_id, updated_at DESC, thread_id DESC)
  WHERE owner_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_history_ownerless_agent_recency
  ON orchestration_conversation_history(owner_user_id, agent_slug, updated_at DESC, thread_id DESC)
  WHERE owner_user_id IS NULL;

CREATE TABLE IF NOT EXISTS orchestration_conversation_history_upgrade (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS orchestration_conversation_history_quarantine (
  thread_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orchestration_turn_dedup (
  dedup_key TEXT PRIMARY KEY,
  value TEXT,
  created_at INTEGER NOT NULL,
  owner_json TEXT
);

CREATE TABLE IF NOT EXISTS provider_session_adoptions (
  source_thread_id TEXT PRIMARY KEY,
  target_thread_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  cwd TEXT NOT NULL,
  project_root TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_resume_cursor TEXT,
  provider_cleanup_complete INTEGER NOT NULL DEFAULT 0,
  flow_run_id TEXT,
  flow_run_resumed INTEGER,
  flow_cleanup_complete INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_adoptions_provider_cursor
  ON provider_session_adoptions(provider, provider_resume_cursor);

-- Recovery rows deliberately contain only bounded classifications and opaque
-- canonical event/turn identifiers. Prompts, attachments, raw errors, and
-- credentials remain solely in their existing owning systems.
CREATE TABLE IF NOT EXISTS orchestration_recovery_intents (
  fingerprint TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  failure_kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  decision TEXT NOT NULL,
  due_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  dispatch_attempt_id TEXT,
  recovery_correlation_id TEXT,
  dispatch_settlement TEXT,
  dispatch_kind TEXT,
  dispatch_owner_id TEXT,
  dispatch_owner_pid INTEGER,
  dispatch_owner_birth TEXT,
  dispatch_owner_identity_kind TEXT,
  credential_attempt_id TEXT,
  resumed_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_intents_thread
  ON orchestration_recovery_intents(thread_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_recovery_intents_due
  ON orchestration_recovery_intents(outcome, due_at);

-- Private operational evidence for credential-profile application. This is
-- intentionally not AppConfig: full-config readers/writers cannot forge,
-- redact, or accidentally delete an exact recovery obligation.
CREATE TABLE IF NOT EXISTS credential_profile_applications (
  attempt_id TEXT PRIMARY KEY,
  recovery_fingerprint TEXT NOT NULL UNIQUE,
  connection_id TEXT NOT NULL,
  candidate_profile_ref TEXT NOT NULL,
  previous_profile_ref TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acknowledged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_credential_profile_applications_state
  ON credential_profile_applications(state, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_profile_applications_one_live_per_connection
  ON credential_profile_applications(connection_id)
  WHERE acknowledged_at IS NULL AND state IN ('reserved', 'staged', 'indeterminate', 'commit-pending');

-- A cross-process fence spans the separate config-store mutation. Owners use
-- an opaque token; a crashed owner is recoverable only after this deliberately
-- conservative lease window, never by another live caller guessing ownership.
CREATE TABLE IF NOT EXISTS credential_profile_connection_locks (
  connection_id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_birth TEXT,
  owner_identity_kind TEXT NOT NULL
);

-- Direct invoke endpoints are provider effects without orchestration sessions.
-- Their owner and lifecycle stay private; RunService receives only projections.
CREATE TABLE IF NOT EXISTS native_invocation_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'completed', 'failed', 'indeterminate')),
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_birth TEXT,
  owner_identity_kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  terminal_sequence INTEGER,
  failure_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_native_invocation_runs_updated
  ON native_invocation_runs(updated_at DESC, run_id DESC);
CREATE INDEX IF NOT EXISTS idx_native_invocation_runs_active
  ON native_invocation_runs(state, updated_at ASC, run_id ASC);

-- A session turn crosses a provider boundary before the canonical
-- turn.started event is necessarily observable. One active invocation plus a
-- bounded set of unresolved acceptances prevent lifecycle completion from
-- racing that boundary and retain possible-effect truth across restart.
CREATE TABLE IF NOT EXISTS orchestration_turn_boundaries (
  boundary_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('lifecycle', 'prepared', 'invoking', 'accepted', 'indeterminate')),
  provider_turn_id TEXT,
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_birth TEXT,
  owner_identity_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orchestration_turn_boundaries_owner
  ON orchestration_turn_boundaries(owner_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_turn_boundaries_one_invocation
  ON orchestration_turn_boundaries(thread_id)
  WHERE state IN ('lifecycle', 'prepared', 'invoking', 'indeterminate');

-- Provider-issued voice completion identity is the durable correlation key.
-- It is deliberately separate from orchestration sessions and never exposed
-- through voice WebSocket or plugin contracts.
CREATE TABLE IF NOT EXISTS voice_turn_runs (
  run_id TEXT PRIMARY KEY,
  voice_session_id TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  provider_turn_id TEXT NOT NULL,
  provider_prompt_id TEXT,
  provider_id TEXT NOT NULL DEFAULT 'legacy-voice-unknown',
  source_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'indeterminate')),
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_birth TEXT,
  owner_identity_kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  terminal_sequence INTEGER,
  failure_message TEXT,
  UNIQUE(voice_session_id, provider_session_id, provider_prompt_id, provider_turn_id)
);
CREATE INDEX IF NOT EXISTS idx_voice_turn_runs_active
  ON voice_turn_runs(state, updated_at ASC, run_id ASC);
CREATE INDEX IF NOT EXISTS idx_voice_turn_runs_run_id
  ON voice_turn_runs(run_id);
`;

/**
 * `CREATE TABLE IF NOT EXISTS` does not migrate existing Station homes. Keep
 * the additive control columns available for both fresh and legacy databases.
 */
interface SessionStateSchemaDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
}

function runConcurrentSafeMigration(
  db: SessionStateSchemaDatabase,
  migrate: () => void,
): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      db.exec('BEGIN IMMEDIATE');
      migrate();
      db.exec('COMMIT');
      return;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A failed BEGIN leaves no transaction to roll back.
      }
      if (
        attempt < 7 &&
        error instanceof Error &&
        /SQLITE_BUSY|database is locked/i.test(error.message)
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        continue;
      }
      throw error;
    }
  }
}

export function ensureOrchestrationSessionStateColumns(
  db: SessionStateSchemaDatabase,
): void {
  runConcurrentSafeMigration(db, () => {
    const columns = db
      .prepare('PRAGMA table_info(provider_session_state)')
      .all() as Array<{ name?: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('control_mode')) {
      db.exec(
        "ALTER TABLE provider_session_state ADD COLUMN control_mode TEXT NOT NULL DEFAULT 'station-owned'",
      );
    }
    if (!names.has('attached_source')) {
      db.exec(
        'ALTER TABLE provider_session_state ADD COLUMN attached_source TEXT',
      );
    }
    if (!names.has('cwd')) {
      db.exec('ALTER TABLE provider_session_state ADD COLUMN cwd TEXT');
    }
    if (!names.has('continuation_source_thread_id')) {
      db.exec(
        'ALTER TABLE provider_session_state ADD COLUMN continuation_source_thread_id TEXT',
      );
    }
    if (!names.has('persist_session')) {
      db.exec(
        'ALTER TABLE provider_session_state ADD COLUMN persist_session INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!names.has('ephemeral')) {
      db.exec(
        'ALTER TABLE provider_session_state ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!names.has('tenant_execution_context')) {
      db.exec(
        'ALTER TABLE provider_session_state ADD COLUMN tenant_execution_context TEXT',
      );
    }
    if (!names.has('adoption_idempotency_key')) {
      db.exec(
        'ALTER TABLE provider_session_state ADD COLUMN adoption_idempotency_key TEXT',
      );
    }
    // Recreate while this pre-release schema is additive so worktrees that ran
    // the earlier key-only draft receive the final source-scoped contract too.
    db.exec('DROP INDEX IF EXISTS idx_provider_session_adoption_idempotency');
    db.exec(
      `CREATE UNIQUE INDEX idx_provider_session_adoption_idempotency
         ON provider_session_state(continuation_source_thread_id, adoption_idempotency_key)
         WHERE adoption_idempotency_key IS NOT NULL`,
    );
  });
}

/**
 * Terminal retention is ordered by a SQLite-assigned sequence, not wall clock.
 * A provider or host clock may move backwards, but a receipt returned from a
 * successful transition must remain one of the newest retained facts.
 */
export function ensureNativeInvocationRunColumns(
  db: SessionStateSchemaDatabase,
): void {
  // Both constructor and standalone migration callers can race against the
  // same legacy Station home. Serialize probe, ALTER, backfill, and index
  // creation so `CREATE TABLE IF NOT EXISTS` can never expose the new index
  // before its additive column exists.
  runConcurrentSafeMigration(db, () => {
    const columns = db
      .prepare('PRAGMA table_info(native_invocation_runs)')
      .all() as Array<{ name?: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('terminal_sequence')) {
      db.exec(
        'ALTER TABLE native_invocation_runs ADD COLUMN terminal_sequence INTEGER',
      );
    }
    db.exec(
      `UPDATE native_invocation_runs
          SET terminal_sequence = rowid
        WHERE terminal_sequence IS NULL
          AND state IN ('completed', 'failed', 'indeterminate');
       CREATE INDEX IF NOT EXISTS idx_native_invocation_runs_terminal_sequence
         ON native_invocation_runs(terminal_sequence DESC, run_id DESC)
         WHERE terminal_sequence IS NOT NULL`,
    );
  });
}

/**
 * Voice attribution originally keyed completion IDs only by Station's control
 * session. AWS's provider session is part of the documented tuple, so upgrade
 * the private table atomically rather than accepting a lossy unique index.
 */
export function ensureVoiceTurnRunColumns(
  db: SessionStateSchemaDatabase,
): void {
  runConcurrentSafeMigration(db, () => {
    const columns = db
      .prepare('PRAGMA table_info(voice_turn_runs)')
      .all() as Array<{ name?: string }>;
    const names = new Set(columns.map((column) => column.name));
    const indexes = db
      .prepare('PRAGMA index_list(voice_turn_runs)')
      .all() as Array<{
      name?: string;
      unique?: number;
    }>;
    const hasFullTuple = indexes.some((index) => {
      if (index.unique !== 1 || !index.name) return false;
      const entries = db
        .prepare(`PRAGMA index_info(${index.name})`)
        .all() as Array<{
        name?: string;
      }>;
      return (
        entries.map((entry) => entry.name).join(',') ===
        'voice_session_id,provider_session_id,provider_prompt_id,provider_turn_id'
      );
    });
    if (
      !names.has('provider_id') ||
      !names.has('terminal_sequence') ||
      !hasFullTuple
    ) {
      db.exec(`
          CREATE TABLE voice_turn_runs_upgrade (
            run_id TEXT PRIMARY KEY,
            voice_session_id TEXT NOT NULL,
            provider_session_id TEXT NOT NULL,
            provider_turn_id TEXT NOT NULL,
            provider_prompt_id TEXT NOT NULL,
            provider_id TEXT NOT NULL DEFAULT 'legacy-voice-unknown',
            source_id TEXT,
            state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'indeterminate')),
            owner_id TEXT NOT NULL,
            owner_pid INTEGER NOT NULL,
            owner_birth TEXT,
            owner_identity_kind TEXT NOT NULL,
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            terminal_sequence INTEGER,
            failure_message TEXT,
            UNIQUE(voice_session_id, provider_session_id, provider_prompt_id, provider_turn_id)
          );
          INSERT INTO voice_turn_runs_upgrade
            (run_id, voice_session_id, provider_session_id, provider_turn_id, provider_prompt_id, provider_id, source_id,
             state, owner_id, owner_pid, owner_birth, owner_identity_kind, started_at, updated_at, completed_at, terminal_sequence, failure_message)
          SELECT run_id, voice_session_id, provider_session_id, provider_turn_id,
                 COALESCE(NULLIF(TRIM(provider_prompt_id), ''), 'legacy:' || run_id),
                 ${names.has('provider_id') ? 'provider_id' : "'legacy-voice-unknown'"}, source_id,
                 state, owner_id, owner_pid, owner_birth, owner_identity_kind, started_at, updated_at, completed_at,
                 ${names.has('terminal_sequence') ? 'terminal_sequence' : 'NULL'}, failure_message
            FROM voice_turn_runs;
          DROP TABLE voice_turn_runs;
          ALTER TABLE voice_turn_runs_upgrade RENAME TO voice_turn_runs;
        `);
    }
    db.exec(`
        UPDATE voice_turn_runs
           SET provider_prompt_id = 'legacy:' || run_id
         WHERE provider_prompt_id IS NULL OR TRIM(provider_prompt_id) = '';
        UPDATE voice_turn_runs SET terminal_sequence = rowid
          WHERE terminal_sequence IS NULL
            AND state IN ('completed', 'failed', 'indeterminate');
        CREATE INDEX IF NOT EXISTS idx_voice_turn_runs_active
          ON voice_turn_runs(state, updated_at ASC, run_id ASC);
        CREATE INDEX IF NOT EXISTS idx_voice_turn_runs_run_id
          ON voice_turn_runs(run_id);
        CREATE INDEX IF NOT EXISTS idx_voice_turn_runs_terminal_sequence
          ON voice_turn_runs(terminal_sequence DESC, run_id DESC)
          WHERE terminal_sequence IS NOT NULL;
      `);
  });
}

/**
 * Recovery dispatch identity must exist before an external provider call. A
 * legacy `resumed` row has no such proof, so migration preserves the observed
 * turn but makes the uncertainty durable rather than retrying it.
 */
export function ensureOrchestrationRecoverySettlementColumns(
  db: SessionStateSchemaDatabase,
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db
      .prepare('PRAGMA table_info(orchestration_recovery_intents)')
      .all() as Array<{ name?: string }>;
    const names = new Set(columns.map((column) => column.name));
    for (const [name, declaration] of [
      ['dispatch_attempt_id', 'TEXT'],
      ['recovery_correlation_id', 'TEXT'],
      ['dispatch_settlement', 'TEXT'],
      ['dispatch_kind', 'TEXT'],
      ['dispatch_owner_id', 'TEXT'],
      ['dispatch_owner_pid', 'INTEGER'],
      ['dispatch_owner_birth', 'TEXT'],
      ['dispatch_owner_identity_kind', 'TEXT'],
      ['credential_attempt_id', 'TEXT'],
      ['shutdown_cancel_requested_at', 'TEXT'],
    ] as const) {
      if (!names.has(name)) {
        db.exec(
          `ALTER TABLE orchestration_recovery_intents ADD COLUMN ${name} ${declaration}`,
        );
      }
    }
    db.exec(
      `UPDATE orchestration_recovery_intents
       SET outcome = 'indeterminate'
       WHERE outcome = 'resumed'
         AND (dispatch_attempt_id IS NULL OR recovery_correlation_id IS NULL
              OR dispatch_settlement IS NULL)`,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Rebuilds the live-application fence to include pending profile adoption. */
export function ensureCredentialApplicationCommitPendingIndex(
  db: SessionStateSchemaDatabase,
  hooks: {
    /** @internal Synchronizes real-SQLite migration fault tests. */
    beforeTransaction?: () => void;
    /** @internal Synchronizes real-SQLite migration fault tests. */
    afterIndexDrop?: () => void;
  } = {},
): void {
  hooks.beforeTransaction?.();
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db
      .prepare('PRAGMA table_info(credential_profile_connection_locks)')
      .all() as Array<{ name?: string }>;
    const names = new Set(columns.map((column) => column.name));
    // Old short leases are unsafe: an alive slow writer must never be stolen.
    // Rebuild the tiny lock table during startup before route work is accepted.
    if (names.has('expires_at')) {
      db.exec(
        `DROP TABLE credential_profile_connection_locks;
         CREATE TABLE credential_profile_connection_locks (
           connection_id TEXT PRIMARY KEY,
           owner_token TEXT NOT NULL,
           owner_pid INTEGER NOT NULL,
           owner_birth TEXT,
           owner_identity_kind TEXT NOT NULL
         );`,
      );
    }
    db.exec(
      'DROP INDEX IF EXISTS idx_credential_profile_applications_one_live_per_connection',
    );
    hooks.afterIndexDrop?.();
    db.exec(`CREATE UNIQUE INDEX idx_credential_profile_applications_one_live_per_connection
      ON credential_profile_applications(connection_id)
      WHERE acknowledged_at IS NULL
        AND state IN ('reserved', 'staged', 'indeterminate', 'commit-pending')`);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

/**
 * Fences Adoption ownership across restart and pid reuse. Legacy rows receive
 * an opaque tombstone token: they remain recoverable through their recorded
 * owner facts, while every new reservation/reclaim receives a fresh token.
 */
export function ensureOrchestrationAdoptionColumns(
  db: SessionStateSchemaDatabase,
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db
      .prepare('PRAGMA table_info(provider_session_adoptions)')
      .all() as Array<{ name?: string }>;
    if (!new Set(columns.map((column) => column.name)).has('owner_token')) {
      db.exec(
        "ALTER TABLE provider_session_adoptions ADD COLUMN owner_token TEXT NOT NULL DEFAULT 'legacy-unfenced'",
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

/**
 * Additive and concurrent-safe repair for homes created before owner fencing.
 *
 * A legacy unresolved row has no owner identity, so it cannot take part in
 * the new liveness protocol: an absent owner can never be PROVEN dead, so
 * such a row is deliberately non-reclaimable and persists as a tombstone.
 *
 * This migration is ADDITIVE ONLY -- it adds `owner_json` when absent and
 * nothing else. An earlier revision deleted those rows inside the IMMEDIATE
 * transaction on an offline-upgrade invariant, and that was withdrawn:
 * `BEGIN IMMEDIATE` fences concurrent writes until commit but cannot prove an
 * old runtime has stopped, so it could delete a row whose turn was still
 * executing and let the key be re-claimed. Trading a stuck turn for a
 * DUPLICATED one is the wrong trade. Retaining the tombstone is also the
 * pre-existing orchestration behaviour, so keeping it is not a regression.
 *
 * Garbage-collecting genuinely dead legacy claims needs its own mechanism
 * with a real liveness guarantee -- see the follow-up on #2238.
 */
export function ensureOrchestrationTurnDedupColumns(
  db: SessionStateSchemaDatabase,
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db
      .prepare('PRAGMA table_info(orchestration_turn_dedup)')
      .all() as Array<{ name?: string }>;
    if (!new Set(columns.map((column) => column.name)).has('owner_json')) {
      db.exec(
        'ALTER TABLE orchestration_turn_dedup ADD COLUMN owner_json TEXT',
      );
    }
    // This migration is deliberately additive-only. An ownerless unresolved
    // row may belong to an older runtime that is still executing its turn;
    // deleting it would permit a new runtime to execute that same turn.
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

/**
 * Delegates to the shared layout rather than repeating the join. The CLI's
 * `station home verify` and the scheduled probe (station#3218) both need this
 * path and neither can import from `src-server`, so the segments live where
 * every process can reach one spelling of them.
 */
export function getOrchestrationDatabasePath(projectHomeDir: string): string {
  return orchestrationStorePath(projectHomeDir);
}

interface EventStoreSchemaDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...args: any[]): unknown[];
    run: (...args: any[]) => unknown;
  };
}

/**
 * Rows backfilled per transaction (review follow-up, station#1092). A single
 * unbounded transaction over every unassigned row holds the write lock and
 * stalls startup on a large legacy store; batching keeps each transaction —
 * and the lock it holds — bounded regardless of how many rows are behind.
 */
export const GLOBAL_SEQUENCE_BACKFILL_BATCH_SIZE = 1000;

/**
 * Request identities are persisted as exact, canonical UTF-8 text. Keep this
 * validator shared by live appends and the one-time database upgrade: SQLite's
 * `trim()` deliberately has different Unicode whitespace semantics from
 * JavaScript's `String.prototype.trim()`.
 */
export function canonicalPersistedRequestId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('request identity must be a string');
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes === 0 || bytes > 512 || value !== value.trim()) {
    throw new Error(
      'request identity must be canonical UTF-8 text of 1..512 bytes',
    );
  }
  return value;
}

function currentGlobalSequenceMax(db: EventStoreSchemaDatabase): number {
  const rows = db
    .prepare(
      'SELECT COALESCE(MAX(global_sequence), 0) AS max_sequence FROM orchestration_events',
    )
    .all() as Array<{ max_sequence: number }>;
  return rows[0]?.max_sequence ?? 0;
}

/**
 * Backfills `global_sequence = 0` rows in `GLOBAL_SEQUENCE_BACKFILL_BATCH_SIZE`
 * batches, each its own transaction, so no single transaction holds the
 * write lock for the whole legacy backlog. Numbering starts from the current
 * max (not always 1) so a prior partially-completed run — batches already
 * committed, the process then restarted — resumes without colliding with
 * already-assigned values; ordering across batches stays
 * `created_at ASC, sequence ASC, id ASC`, identical to the single-transaction
 * version this replaces, because each batch re-queries for the next-lowest
 * unassigned rows in that same order.
 */
function backfillGlobalSequence(db: EventStoreSchemaDatabase): void {
  let next = currentGlobalSequenceMax(db) + 1;
  const selectBatch = db.prepare(
    `SELECT id FROM orchestration_events
     WHERE global_sequence = 0
     ORDER BY created_at ASC, sequence ASC, id ASC
     LIMIT ?`,
  );
  const update = db.prepare(
    'UPDATE orchestration_events SET global_sequence = ? WHERE id = ?',
  );
  while (true) {
    const batch = selectBatch.all(
      GLOBAL_SEQUENCE_BACKFILL_BATCH_SIZE,
    ) as Array<{ id: string }>;
    if (batch.length === 0) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of batch) {
        update.run(next, row.id);
        next += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (batch.length < GLOBAL_SEQUENCE_BACKFILL_BATCH_SIZE) return;
  }
}

/**
 * `CREATE TABLE IF NOT EXISTS` does not migrate existing Station homes onto
 * the `global_sequence` column added for station#1092's event-stream resume.
 * Additive for both fresh and legacy databases: adds the column if missing,
 * then backfills any never-assigned (`= 0`) rows in the same global order
 * `listEvents()` already uses (`created_at ASC, sequence ASC`) so the
 * backfilled ordering matches what clients have always observed from the
 * all-sessions stream. Idempotent — a second run finds no `= 0` rows left.
 *
 * The composite indexes live here rather than in
 * `ORCHESTRATION_EVENT_STORE_MIGRATION`'s raw SQL: a pre-column database's
 * `CREATE TABLE IF NOT EXISTS` is a no-op, so an index referencing a column
 * not added yet would fail before this function could repair the schema.
 * `(thread_id, global_sequence)` backs per-thread replay; the turn, request,
 * and session-state indexes back #1867's finite fact queries.
 */
const SETTLED_STOP_FACT_REPAIR_NAME = 'event-facts-v4';
const SETTLED_STOP_FACT_REPAIR_BATCH_SIZE = 100;

export function ensureOrchestrationEventStoreColumns(
  db: EventStoreSchemaDatabase,
): void {
  const columns = db
    .prepare('PRAGMA table_info(orchestration_events)')
    .all() as Array<{ name?: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('global_sequence')) {
    db.exec(
      'ALTER TABLE orchestration_events ADD COLUMN global_sequence INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!names.has('request_id')) {
    db.exec('ALTER TABLE orchestration_events ADD COLUMN request_id TEXT');
  }
  if (!names.has('session_state')) {
    db.exec('ALTER TABLE orchestration_events ADD COLUMN session_state TEXT');
  }
  const receiptColumns = db
    .prepare('PRAGMA table_info(orchestration_command_receipts)')
    .all() as Array<{ name?: string }>;
  if (!receiptColumns.some((column) => column.name === 'client_origin')) {
    db.exec(
      'ALTER TABLE orchestration_command_receipts ADD COLUMN client_origin TEXT',
    );
  }
  // v3 deliberately reruns the complete projection build once so existing v2
  // stores receive the JavaScript (rather than SQLite trim) request-identity
  // check. V4's much narrower settled-stop repair runs below.
  const backfillName = 'event-facts-v3';
  // A home built by the brief-lived original V4 implementation has only the
  // V4 marker. It already received V3's complete rebuild, so never replay it
  // just because that historical marker was not written on that code path.
  const settled = () =>
    (
      db
        .prepare(
          'SELECT name FROM orchestration_event_store_backfills WHERE name IN (?, ?)',
        )
        .all(backfillName, SETTLED_STOP_FACT_REPAIR_NAME) as Array<{
        name?: string;
      }>
    ).length > 0;
  let pending = !settled();
  if (pending) {
    db.exec('BEGIN IMMEDIATE');
    // The read above took no lock, so two runtimes first-booting one home can
    // both see an absent marker; only `BEGIN IMMEDIATE` serializes them, and
    // the loser then arrives here with the work already committed by the
    // winner. Re-reading under the writer lock is what makes the marker a
    // mutex rather than a hint: without it the loser re-derives the same
    // projection and dies on the marker's primary key, taking its whole
    // constructor down (station#3145 class, reproduced at ~1 in 80 concurrent
    // first-boot constructions).
    pending = !settled();
    if (!pending) db.exec('ROLLBACK');
  }
  if (pending) {
    try {
      const requestRows = db
        .prepare(
          `SELECT id, payload, request_id FROM orchestration_events
           WHERE method IN ('request.opened', 'request.resolved')`,
        )
        .all() as Array<{
        id?: unknown;
        payload?: unknown;
        request_id?: unknown;
      }>;
      const updateRequestId = db.prepare(
        'UPDATE orchestration_events SET request_id = ? WHERE id = ?',
      );
      for (const row of requestRows) {
        let payload: unknown;
        try {
          payload = JSON.parse(String(row.payload));
        } catch {
          throw new Error(
            `Malformed persisted request identity: ${String(row.id ?? 'unknown event')}`,
          );
        }
        const value =
          payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>).requestId
            : undefined;
        let requestId: string;
        try {
          requestId = canonicalPersistedRequestId(value);
        } catch {
          throw new Error(
            `Malformed persisted request identity: ${String(row.id ?? 'unknown event')}`,
          );
        }
        if (
          row.request_id !== null &&
          row.request_id !== undefined &&
          row.request_id !== requestId
        ) {
          throw new Error(
            `Malformed persisted request identity: ${String(row.id ?? 'unknown event')}`,
          );
        }
        updateRequestId.run(requestId, row.id);
      }
      db.exec(
        `UPDATE orchestration_events
         SET session_state = json_extract(payload, '$.sessionState')
         WHERE session_state IS NULL`,
      );
      db.exec('DELETE FROM orchestration_request_state');
      db.exec('DELETE FROM orchestration_session_projection_facts');
      db.exec(`
        INSERT INTO orchestration_request_state
          (thread_id, request_id, event_id, method, sequence)
        SELECT event.thread_id, event.request_id, event.id, event.method, event.sequence
        FROM orchestration_events AS event
        INNER JOIN (
          SELECT thread_id, request_id, MAX(sequence) AS sequence
          FROM orchestration_events
          WHERE request_id IS NOT NULL
          GROUP BY thread_id, request_id
        ) AS current
          ON event.thread_id = current.thread_id
         AND event.request_id = current.request_id
         AND event.sequence = current.sequence
      `);
      const factRows = db
        .prepare(
          `SELECT id, thread_id, payload FROM orchestration_events
           ORDER BY thread_id ASC, sequence ASC`,
        )
        .all() as Array<{
        id?: unknown;
        thread_id?: unknown;
        payload?: unknown;
      }>;
      const insertFirstFact = db.prepare(
        `INSERT OR IGNORE INTO orchestration_session_projection_facts
          (thread_id, fact_key, event_id) VALUES (?, ?, ?)`,
      );
      const writeLatestFact = db.prepare(
        `INSERT INTO orchestration_session_projection_facts
          (thread_id, fact_key, event_id) VALUES (?, ?, ?)
         ON CONFLICT(thread_id, fact_key) DO UPDATE SET event_id = excluded.event_id`,
      );
      for (const row of factRows) {
        let event: CanonicalRuntimeEvent;
        try {
          event = JSON.parse(String(row.payload)) as CanonicalRuntimeEvent;
        } catch {
          throw new Error(
            `Malformed persisted projection event: ${String(row.id ?? 'unknown event')}`,
          );
        }
        for (const fact of projectionFactKeysForEvent(event)) {
          (fact.first ? insertFirstFact : writeLatestFact).run(
            row.thread_id,
            fact.key,
            row.id,
          );
        }
      }
      db.prepare(
        'INSERT INTO orchestration_event_store_backfills (name, completed_at) VALUES (?, ?)',
      ).run(backfillName, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  // V4 repairs only settled-stop facts. Its global-sequence cursor needs the
  // legacy global sequence migration before it begins; this is the same call
  // that used to run at this function's end, moved before its first consumer.
  backfillGlobalSequence(db);
  repairSettledStopProjectionFacts(db);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_events_global_sequence ON orchestration_events(global_sequence)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_events_thread_global_sequence ON orchestration_events(thread_id, global_sequence)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_events_thread_turn_sequence ON orchestration_events(thread_id, turn_id, sequence)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_events_thread_request_sequence ON orchestration_events(thread_id, request_id, sequence) WHERE request_id IS NOT NULL',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_events_thread_session_state_sequence ON orchestration_events(thread_id, session_state, sequence) WHERE session_state IS NOT NULL',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_events_thread_method_session_state_sequence ON orchestration_events(thread_id, method, session_state, sequence) WHERE session_state IS NOT NULL',
  );
  // station#3495: the recency index behind `EventStore.findSessionOwnerUserId`,
  // the `/events` route's per-event authorization gate. Ordered
  // `(thread_id, created_at, sequence)` so a reverse scan satisfies that
  // query's `ORDER BY created_at DESC, sequence DESC` outright — measured
  // against 260k synthetic rows, EXPLAIN QUERY PLAN drops from
  // `SEARCH ... idx_events_history_projection` + `USE TEMP B-TREE FOR ORDER
  // BY` (sorting every matching row, payload column included) to a single
  // `SEARCH ... idx_events_thread_owner_recency (thread_id=?)` with no sort.
  //
  // `json_valid(payload)` is REQUIRED, not defensive: `json_extract` raises
  // `malformed JSON` on a non-JSON payload, and a partial index evaluates its
  // WHERE clause against EVERY row in the table, so one unparseable payload
  // anywhere would abort this migration and fail boot. Verified by building
  // both forms over a table containing one such row: unguarded fails,
  // guarded builds.
  //
  // Additive and re-runnable: `IF NOT EXISTS`, no table rewrite, no data
  // change. Only rows that actually carry a `metadata.userId` are indexed
  // (2.4% of the live store's rows), which is why the build is sub-second on
  // a 694 MB database (0.4 s measured on the live store for the equivalent
  // partial index; 46 ms for this predicate over 260k synthetic rows).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_events_thread_owner_recency
       ON orchestration_events(thread_id, created_at, sequence)
       WHERE json_valid(payload)
         AND json_extract(payload, '$.metadata.userId') IS NOT NULL`,
  );
}

/**
 * Resumable, bounded V4 repair for the one fact family this version adds.
 *
 * The progress record is created in the same first transaction that removes
 * stale settled-stop facts. Later transactions read at most 100 matching rows,
 * upsert their latest-per-initiator facts, and advance the durable cursor. The
 * final transaction writes the completion marker and removes progress. A
 * crash therefore resumes from the last committed cursor without touching any
 * non-stop fact family or replaying an unbounded event array.
 */
function repairSettledStopProjectionFacts(db: EventStoreSchemaDatabase): void {
  const settled = () =>
    (
      db
        .prepare(
          'SELECT name FROM orchestration_event_store_backfills WHERE name = ?',
        )
        .all(SETTLED_STOP_FACT_REPAIR_NAME) as Array<{ name?: string }>
    ).length > 0;

  while (!settled()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (settled()) {
        db.exec('ROLLBACK');
        return;
      }
      const progress = db
        .prepare(
          'SELECT cursor FROM orchestration_event_store_backfill_progress WHERE name = ?',
        )
        .all(SETTLED_STOP_FACT_REPAIR_NAME) as Array<{ cursor?: unknown }>;
      const cursor = progress[0]?.cursor;
      const hasProgress = typeof cursor === 'number';
      if (!hasProgress) {
        db.prepare(
          "DELETE FROM orchestration_session_projection_facts WHERE fact_key LIKE 'settled-stop:%'",
        ).run();
        db.prepare(
          'INSERT INTO orchestration_event_store_backfill_progress (name, cursor) VALUES (?, ?)',
        ).run(SETTLED_STOP_FACT_REPAIR_NAME, 0);
      }
      const batchCursor = hasProgress ? cursor : 0;
      const rows = db
        .prepare(
          `SELECT id, thread_id, payload, global_sequence
           FROM orchestration_events
           WHERE method = 'session.stop-settled' AND global_sequence > ?
           ORDER BY global_sequence ASC
           LIMIT ?`,
        )
        .all(batchCursor, SETTLED_STOP_FACT_REPAIR_BATCH_SIZE) as Array<{
        id?: unknown;
        thread_id?: unknown;
        payload?: unknown;
        global_sequence?: unknown;
      }>;
      const writeLatestFact = db.prepare(
        `INSERT INTO orchestration_session_projection_facts
          (thread_id, fact_key, event_id) VALUES (?, ?, ?)
         ON CONFLICT(thread_id, fact_key) DO UPDATE SET event_id = excluded.event_id`,
      );
      let nextCursor = batchCursor;
      for (const row of rows) {
        let event: CanonicalRuntimeEvent;
        try {
          event = JSON.parse(String(row.payload)) as CanonicalRuntimeEvent;
        } catch {
          throw new Error(
            `Malformed persisted projection event: ${String(row.id ?? 'unknown event')}`,
          );
        }
        for (const fact of projectionFactKeysForEvent(event)) {
          if (!fact.key.startsWith('settled-stop:')) continue;
          writeLatestFact.run(row.thread_id, fact.key, row.id);
        }
        if (typeof row.global_sequence !== 'number') {
          throw new Error(
            `Malformed settled-stop global sequence: ${String(row.id ?? 'unknown event')}`,
          );
        }
        nextCursor = row.global_sequence;
      }
      if (rows.length === SETTLED_STOP_FACT_REPAIR_BATCH_SIZE) {
        db.prepare(
          'UPDATE orchestration_event_store_backfill_progress SET cursor = ? WHERE name = ?',
        ).run(nextCursor, SETTLED_STOP_FACT_REPAIR_NAME);
      } else {
        db.prepare(
          'INSERT INTO orchestration_event_store_backfills (name, completed_at) VALUES (?, ?)',
        ).run(SETTLED_STOP_FACT_REPAIR_NAME, new Date().toISOString());
        db.prepare(
          'DELETE FROM orchestration_event_store_backfill_progress WHERE name = ?',
        ).run(SETTLED_STOP_FACT_REPAIR_NAME);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

// Mirrors event-store.ts's SQLITE_BUSY_TIMEOUT_MS: a STATION_HOME can be open
// by more than one runtime (#2895/#3304), so this boot path must wait for a
// peer's write lock rather than die instantly on SQLITE_BUSY.
const MIGRATION_BUSY_TIMEOUT_MS = 5_000;

export function runOrchestrationEventMigration(projectHomeDir: string): void {
  const dbPath = getOrchestrationDatabasePath(projectHomeDir);
  mkdirSync(join(projectHomeDir, 'data'), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: MIGRATION_BUSY_TIMEOUT_MS });
  // Both the option and the PRAGMA, for the same reason event-store.ts sets
  // both: the constructor timeout does not consistently govern explicit
  // BEGIN IMMEDIATE statements across supported builds.
  try {
    db.exec(`PRAGMA busy_timeout = ${MIGRATION_BUSY_TIMEOUT_MS}`);
  } catch {
    // Best-effort; a genuinely unreadable database fails truthfully below.
  }
  // WAL before the first write, outside any transaction (journal_mode cannot
  // change inside one). Best-effort: switching mode is itself a write that
  // needs an uncontended file, and the first uncontended open persists it.
  // station#3661: bounded retry. The conversion needs an exclusive lock that
  // `busy_timeout` does not govern, so a swallow here meant the very boot that
  // raced ran the migration below against a rollback-journal file.
  applyWalJournalMode(db, { store: 'orchestration event store migration' });
  runConcurrentSafeMigration(db, () => {
    db.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    db.exec(PROJECT_TASK_ROOM_RUNTIME_MIGRATION);
  });
  ensureOrchestrationSessionStateColumns(db);
  ensureNativeInvocationRunColumns(db);
  ensureOrchestrationRecoverySettlementColumns(db);
  ensureOrchestrationTurnDedupColumns(db);
  ensureOrchestrationEventStoreColumns(db);
  ensureOrchestrationAdoptionColumns(db);
  db.close();
}
