/**
 * AutomationLedger: durable delivery dedupe, episodes and action claims for
 * Station Automations (epic kontourai/station#3439).
 *
 * It follows the SchedulerLedger protocol (`../scheduling/scheduler-ledger.ts`):
 * SQLite serializes every transition across processes; an action is
 * `claim` -> `beginInvocation` -> `settle`, each persisted before its effect.
 * A claim whose owner died before `beginInvocation` is released and may be
 * claimed again. A claim whose owner died after it is recorded as
 * `indeterminate` and is never replayed: its episode stops acting until an
 * operator resolves it.
 *
 * Three dedupe layers, all in storage:
 * - transport: `sha256(sourceId, transportId)` (the GitHub delivery id, or
 *   the semantic key for a polled event). A repeat is not recorded again.
 * - semantic: the same `(sourceId, semanticKey)` under a new transport id
 *   (a redelivery with a fresh GUID) is recorded as `duplicate`.
 * - episode: one open episode per episode key; one action claim per episode.
 *
 * Rows hold a bounded projection only: hashed transport keys, closed outcome
 * and reason codes, and identifiers. No payload, secret or delivery GUID is
 * stored in clear.
 *
 * A rule without an episode policy is expected to use a per-delivery episode
 * (its semantic key, one attempt), so every action goes through a claim.
 *
 * Retention: rows that take part in semantic dedupe
 * (`AUTOMATION_SEMANTIC_DEDUPE_OUTCOMES`) require an authenticated delivery,
 * so they are bounded only by the retention window. The row ceiling applies
 * to every other row (refused, received, duplicate), which an
 * unauthenticated sender can create; a flood of refusals therefore can never
 * evict the row that makes a genuine redelivery a duplicate.
 *
 * Accepted residuals:
 * - A redelivery that races the first delivery across two processes while
 *   the first row is still `received` is not a semantic duplicate. Station
 *   runs one process per home, so the race needs a second server on the
 *   same home.
 * - An indeterminate per-delivery episode closes on settle, so only its
 *   delivery row (outcome `indeterminate`) blocks a replay. That row
 *   outlives the 72-hour freshness bound (`maxEventAgeMs`) because
 *   retention is seven days and accepted rows are not row-capped, so a
 *   replay old enough to escape it is refused as stale.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  AUTOMATION_EXECUTION_LIMITS,
  AUTOMATION_SEMANTIC_DEDUPE_OUTCOMES,
  type AutomationDeliveryOutcome,
  type AutomationEpisodeState,
  type AutomationRefusalReason,
  type AutomationSuppressionReason,
} from '@kontourai/station-contracts/automation';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import { checkSqliteIntegrity } from '@kontourai/station-shared/sqlite-integrity';
import { resolveHomeDir } from '../../utils/paths.js';
import { applyWalJournalMode } from '../../utils/sqlite-wal.js';
import { AutomationPolicyUnavailableError } from './automation-store.js';

const require = createRequire(import.meta.url);
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
/** Same-process owners need a finer fence than PID/birth alone. */
const LIVE_OWNER_IDS = new Set<string>();
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { timeout?: number },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run: (...args: unknown[]) => { changes?: number | bigint };
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
    close(): void;
  };
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS automation_deliveries (
  dedupe_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  rule_id TEXT,
  episode_id TEXT,
  task_id TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS automation_deliveries_semantic
  ON automation_deliveries(source_id, semantic_key);
CREATE INDEX IF NOT EXISTS automation_deliveries_received
  ON automation_deliveries(received_ms);
CREATE TABLE IF NOT EXISTS automation_episodes (
  rule_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  episode_key TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('open', 'exhausted', 'indeterminate', 'closed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  closes_on_settle INTEGER NOT NULL DEFAULT 0,
  opened_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (rule_id, episode_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS automation_episodes_one_unclosed
  ON automation_episodes(episode_key) WHERE state <> 'closed';
CREATE INDEX IF NOT EXISTS automation_episodes_closed_age
  ON automation_episodes(updated_ms) WHERE state = 'closed';
CREATE TABLE IF NOT EXISTS automation_action_claims (
  claim_id TEXT PRIMARY KEY,
  episode_key TEXT NOT NULL UNIQUE,
  rule_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  invocation_started INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_birth TEXT,
  claimed_ms INTEGER NOT NULL
);
`;

/** Bounded, payload-free view of one delivery. */
export type AutomationDeliveryRecord = Readonly<{
  /** sha256 of the source id and transport id; never the GUID itself. */
  deliveryKey: string;
  sourceId: string;
  semanticKey: string;
  eventType: string;
  receivedAt: string;
  updatedAt: string;
  outcome: AutomationDeliveryOutcome;
  reason?: AutomationRefusalReason | AutomationSuppressionReason;
  ruleId?: string;
  episodeId?: string;
  taskId?: string;
  sessionId?: string;
}>;

export type AutomationEpisodeRecord = Readonly<{
  ruleId: string;
  episodeId: string;
  episodeKey: string;
  state: AutomationEpisodeState;
  attemptCount: number;
  maxAttempts: number;
  openedAt: string;
  updatedAt: string;
}>;

export type RecordDeliveryInput = Readonly<{
  sourceId: string;
  /** `X-GitHub-Delivery` for a push; the semantic key for a polled event. */
  transportId: string;
  semanticKey: string;
  eventType: string;
  receivedAt: number;
  outcome: AutomationDeliveryOutcome;
  reason?: AutomationRefusalReason | AutomationSuppressionReason;
  ruleId?: string;
}>;

export type RecordDeliveryOutcome =
  | Readonly<{ kind: 'recorded'; deliveryKey: string }>
  | Readonly<{
      kind: 'duplicate';
      layer: 'transport' | 'semantic';
      deliveryKey: string;
    }>;

export type DeliveryUpdate = Readonly<{
  outcome: AutomationDeliveryOutcome;
  reason?: AutomationRefusalReason | AutomationSuppressionReason;
  ruleId?: string;
  episodeId?: string;
  taskId?: string;
  sessionId?: string;
}>;

export type OpenEpisodeOutcome = Readonly<{
  kind: 'opened' | 'existing';
  episode: AutomationEpisodeRecord;
}>;

export type ActionSettlement = Readonly<{
  state: 'completed' | 'failed' | 'indeterminate';
  now: number;
  taskId?: string;
  sessionId?: string;
}>;

export type ReceiptTransition = 'applied' | 'stale';

/** The capability to act for one episode. Only its holder may settle it. */
export interface AutomationActionReceipt {
  readonly claimId: string;
  readonly ruleId: string;
  readonly episodeId: string;
  readonly episodeKey: string;
  readonly deliveryKey: string;
  /** 1-based attempt this claim would consume. */
  readonly attempt: number;
  /** Persists that the effect may now happen; consumes the attempt. */
  beginInvocation(now: number): ReceiptTransition;
  /** Gives up a claim before invocation; consumes nothing. */
  release(): ReceiptTransition;
  settle(settlement: ActionSettlement): ReceiptTransition;
}

export type ClaimActionOutcome =
  | Readonly<{ kind: 'claimed'; receipt: AutomationActionReceipt }>
  | Readonly<{ kind: 'not-found' }>
  | Readonly<{ kind: 'busy' }>
  | Readonly<{ kind: 'exhausted' }>
  | Readonly<{ kind: 'indeterminate' }>;

export interface AutomationLedger {
  recordDelivery(input: RecordDeliveryInput): RecordDeliveryOutcome;
  updateDelivery(deliveryKey: string, update: DeliveryUpdate): boolean;
  listDeliveries(limit?: number): AutomationDeliveryRecord[];
  openEpisode(input: OpenEpisodeInput): OpenEpisodeOutcome;
  closeEpisode(input: {
    episodeKey: string;
    now: number;
  }): AutomationEpisodeRecord | undefined;
  /** The current unclosed episode for a key. */
  episode(episodeKey: string): AutomationEpisodeRecord | undefined;
  /** Newest first, at most `limit` (default 100, ceiling 1,000). */
  listEpisodes(limit?: number): AutomationEpisodeRecord[];
  claimAction(input: {
    episodeKey: string;
    deliveryKey: string;
    now: number;
  }): ClaimActionOutcome;
  close(): void;
}

export type OpenEpisodeInput = Readonly<{
  ruleId: string;
  episodeKey: string;
  episodeId: string;
  maxAttempts: number;
  now: number;
  /**
   * For a rule without an episode policy: the episode exists only to fence
   * one delivery's action, so it closes as soon as that action settles.
   * A keyed episode stays open or exhausted until its `closeOn` event, so a
   * recurring failure keeps suppressing new starts (design section 5).
   */
  perDelivery?: boolean;
}>;

/** Rows each retention pass may delete, so one write never does unbounded work. */
const PRUNE_BATCH = 64;

const SEMANTIC_OUTCOMES_SQL = AUTOMATION_SEMANTIC_DEDUPE_OUTCOMES.map(
  (outcome) => `'${outcome}'`,
).join(', ');

/** Creates the file 0600 before SQLite does, so it is never briefly wider. */
function createPrivateFile(path: string): void {
  if (existsSync(path)) return;
  closeSync(
    openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    ),
  );
}

function tightenIfPresent(path: string): void {
  if (existsSync(path)) chmodSync(path, 0o600);
}

type ProcessIdentity = {
  exact(pid: number): { start: string } | null;
  probe(
    pid: number,
  ):
    | { state: 'dead' }
    | { state: 'unavailable' }
    | { state: 'exact'; identity: { pid: number; start: string } };
};

export interface AutomationLedgerOptions {
  /** Defaults to `<STATION_HOME>/automation`. */
  directory?: string;
  busyTimeoutMs?: number;
  /** Test seam for foreign-process liveness. */
  processIdentity?: ProcessIdentity;
  /** Test seam; production uses `AUTOMATION_EXECUTION_LIMITS`. */
  maxRetainedDeliveries?: number;
}

interface ClaimRow {
  claim_id: string;
  episode_key: string;
  rule_id: string;
  episode_id: string;
  delivery_key: string;
  attempt: number;
  invocation_started: number;
  owner_id: string;
  owner_pid: number;
  owner_birth: string | null;
}

interface EpisodeRow {
  rule_id: string;
  episode_id: string;
  episode_key: string;
  state: AutomationEpisodeState;
  attempt_count: number;
  max_attempts: number;
  opened_ms: number;
  updated_ms: number;
}

interface DeliveryRow {
  dedupe_key: string;
  source_id: string;
  semantic_key: string;
  event_type: string;
  received_ms: number;
  updated_ms: number;
  outcome: AutomationDeliveryOutcome;
  reason: string | null;
  rule_id: string | null;
  episode_id: string | null;
  task_id: string | null;
  session_id: string | null;
}

/** sha256 over an unambiguous encoding of the source and transport ids. */
export function automationDeliveryKey(
  sourceId: string,
  transportId: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([sourceId, transportId]))
    .digest('hex');
}

export function createAutomationLedger(
  options: AutomationLedgerOptions = {},
): AutomationLedger {
  return new SqliteAutomationLedger(options);
}

const iso = (ms: number) => new Date(ms).toISOString();

function episodeFromRow(row: EpisodeRow): AutomationEpisodeRecord {
  return {
    ruleId: row.rule_id,
    episodeId: row.episode_id,
    episodeKey: row.episode_key,
    state: row.state,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    openedAt: iso(row.opened_ms),
    updatedAt: iso(row.updated_ms),
  };
}

function deliveryFromRow(row: DeliveryRow): AutomationDeliveryRecord {
  return {
    deliveryKey: row.dedupe_key,
    sourceId: row.source_id,
    semanticKey: row.semantic_key,
    eventType: row.event_type,
    receivedAt: iso(row.received_ms),
    updatedAt: iso(row.updated_ms),
    outcome: row.outcome,
    ...(row.reason
      ? {
          reason: row.reason as
            | AutomationRefusalReason
            | AutomationSuppressionReason,
        }
      : {}),
    ...(row.rule_id ? { ruleId: row.rule_id } : {}),
    ...(row.episode_id ? { episodeId: row.episode_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
  };
}

/** Settled action state -> the delivery outcome that caused it. */
const SETTLED_DELIVERY_OUTCOME = {
  completed: 'started',
  failed: 'failed',
  indeterminate: 'indeterminate',
} as const satisfies Record<
  ActionSettlement['state'],
  AutomationDeliveryOutcome
>;

class SqliteAutomationLedger implements AutomationLedger {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly owner: { id: string; pid: number; birth?: string };
  private readonly identity: ProcessIdentity;
  private readonly maxRetainedDeliveries: number;

  constructor(options: AutomationLedgerOptions) {
    const directory = options.directory ?? join(resolveHomeDir(), 'automation');
    this.identity = options.processIdentity ?? {
      exact: exactProcessIdentity,
      probe: probeExactProcessIdentity,
    };
    const cap =
      options.maxRetainedDeliveries ??
      AUTOMATION_EXECUTION_LIMITS.maxRetainedDeliveries;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new RangeError('maxRetainedDeliveries must be a positive integer');
    }
    this.maxRetainedDeliveries = cap;
    const exact = this.identity.exact(process.pid);
    this.owner = {
      id: randomUUID(),
      pid: process.pid,
      ...(exact ? { birth: exact.start } : {}),
    };
    const databasePath = join(directory, 'automation.sqlite');
    try {
      if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('automation ledger directory must be a real directory');
      }
      if (
        existsSync(databasePath) &&
        lstatSync(databasePath).isSymbolicLink()
      ) {
        throw new Error('automation ledger database must not be a symlink');
      }
      createPrivateFile(databasePath);
      tightenIfPresent(databasePath);
    } catch (error) {
      throw new AutomationPolicyUnavailableError('ledger path unsafe', {
        cause: error,
      });
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;
    let db: InstanceType<typeof DatabaseSync>;
    try {
      db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
    } catch (error) {
      throw new AutomationPolicyUnavailableError('ledger unopenable', {
        cause: error,
      });
    }
    this.db = db;
    try {
      const integrity = checkSqliteIntegrity(db);
      if (integrity.kind !== 'ok') {
        throw new Error(`ledger integrity ${integrity.kind}`);
      }
      db.exec(
        `PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`,
      );
      applyWalJournalMode(db, {
        store: 'automation ledger',
        onUnavailable: 'throw',
      });
      db.exec(SCHEMA);
      // SQLite creates -wal/-shm with the database's mode; tighten anyway in
      // case they predate it.
      tightenIfPresent(`${databasePath}-wal`);
      tightenIfPresent(`${databasePath}-shm`);
    } catch (error) {
      try {
        db.close();
      } catch {
        // The initialization failure remains authoritative.
      }
      throw new AutomationPolicyUnavailableError('ledger unavailable', {
        cause: error,
      });
    }
    LIVE_OWNER_IDS.add(this.owner.id);
  }

  close(): void {
    LIVE_OWNER_IDS.delete(this.owner.id);
    this.db.close();
  }

  recordDelivery(input: RecordDeliveryInput): RecordDeliveryOutcome {
    // A refusal is unauthenticated or untrusted: it must not occupy the
    // transport key a genuine delivery will use, so it gets a key of its own.
    const deliveryKey =
      input.outcome === 'refused'
        ? `${automationDeliveryKey(input.sourceId, input.transportId)}:refused:${randomUUID()}`
        : automationDeliveryKey(input.sourceId, input.transportId);
    return this.transaction(() => {
      this.pruneBounded(input.receivedAt);
      if (input.outcome === 'refused') {
        this.insertDelivery(deliveryKey, input, input.outcome, input.reason);
        return { kind: 'recorded', deliveryKey };
      }
      if (
        this.db
          .prepare('SELECT 1 FROM automation_deliveries WHERE dedupe_key = ?')
          .get(deliveryKey)
      ) {
        return { kind: 'duplicate', layer: 'transport', deliveryKey };
      }
      // Only authenticated, accepted deliveries count: a refused or merely
      // received row never makes a later genuine delivery a duplicate.
      const semanticSeen = Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM automation_deliveries
              WHERE source_id = ? AND semantic_key = ?
                AND outcome IN (${SEMANTIC_OUTCOMES_SQL})
              LIMIT 1`,
          )
          .get(input.sourceId, input.semanticKey),
      );
      if (semanticSeen) {
        this.insertDelivery(deliveryKey, input, 'duplicate', undefined);
      } else {
        this.insertDelivery(deliveryKey, input, input.outcome, input.reason);
      }
      return semanticSeen
        ? { kind: 'duplicate', layer: 'semantic', deliveryKey }
        : { kind: 'recorded', deliveryKey };
    });
  }

  private insertDelivery(
    deliveryKey: string,
    input: RecordDeliveryInput,
    outcome: AutomationDeliveryOutcome,
    reason: RecordDeliveryInput['reason'],
  ): void {
    this.db
      .prepare(
        `INSERT INTO automation_deliveries
           (dedupe_key, source_id, semantic_key, event_type, received_ms,
            updated_ms, outcome, reason, rule_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deliveryKey,
        input.sourceId,
        input.semanticKey,
        input.eventType,
        input.receivedAt,
        input.receivedAt,
        outcome,
        reason ?? null,
        input.ruleId ?? null,
      );
  }

  /**
   * Retention, run inside each delivery write and bounded to
   * {@link PRUNE_BATCH} rows per table: deliveries past the retention
   * window, non-dedupe deliveries beyond the row ceiling (oldest first;
   * accepted rows are never row-capped), and closed
   * episodes past their retention. Open, exhausted and indeterminate
   * episodes are kept: they still decide whether work may start.
   */
  private pruneBounded(now: number): void {
    const limits = AUTOMATION_EXECUTION_LIMITS;
    this.db
      .prepare(
        `DELETE FROM automation_deliveries WHERE rowid IN (
           SELECT rowid FROM automation_deliveries
            WHERE received_ms < ? ORDER BY received_ms LIMIT ?)`,
      )
      .run(now - limits.deliveryRetentionMs, PRUNE_BATCH);
    this.db
      .prepare(
        `DELETE FROM automation_deliveries WHERE rowid IN (
           SELECT rowid FROM automation_deliveries
            WHERE outcome NOT IN (${SEMANTIC_OUTCOMES_SQL})
            ORDER BY received_ms DESC, rowid DESC LIMIT ? OFFSET ?)`,
      )
      .run(PRUNE_BATCH, this.maxRetainedDeliveries - 1);
    this.db
      .prepare(
        `DELETE FROM automation_episodes WHERE rowid IN (
           SELECT rowid FROM automation_episodes
            WHERE state = 'closed' AND updated_ms < ? LIMIT ?)`,
      )
      .run(now - limits.closedEpisodeRetentionMs, PRUNE_BATCH);
  }

  updateDelivery(deliveryKey: string, update: DeliveryUpdate): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE automation_deliveries
              SET outcome = ?, reason = ?,
                  rule_id = COALESCE(?, rule_id),
                  episode_id = COALESCE(?, episode_id),
                  task_id = COALESCE(?, task_id),
                  session_id = COALESCE(?, session_id),
                  updated_ms = ?
            WHERE dedupe_key = ?`,
        )
        .run(
          update.outcome,
          update.reason ?? null,
          update.ruleId ?? null,
          update.episodeId ?? null,
          update.taskId ?? null,
          update.sessionId ?? null,
          Date.now(),
          deliveryKey,
        );
      return Number(result.changes ?? 0) === 1;
    });
  }

  listDeliveries(limit = 100): AutomationDeliveryRecord[] {
    return this.read(() =>
      (
        this.db
          .prepare(
            'SELECT * FROM automation_deliveries ORDER BY received_ms DESC, rowid DESC LIMIT ?',
          )
          .all(Math.max(1, Math.min(1_000, Math.floor(limit)))) as DeliveryRow[]
      ).map(deliveryFromRow),
    );
  }

  openEpisode(input: OpenEpisodeInput): OpenEpisodeOutcome {
    if (
      !Number.isInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > AUTOMATION_EXECUTION_LIMITS.maxEpisodeAttempts
    ) {
      throw new RangeError('maxAttempts out of range');
    }
    return this.transaction(() => {
      const existing = this.unclosedEpisode(input.episodeKey);
      if (existing)
        return { kind: 'existing', episode: episodeFromRow(existing) };
      this.db
        .prepare(
          `INSERT INTO automation_episodes
             (rule_id, episode_id, episode_key, state, attempt_count,
              max_attempts, closes_on_settle, opened_ms, updated_ms)
           VALUES (?, ?, ?, 'open', 0, ?, ?, ?, ?)`,
        )
        .run(
          input.ruleId,
          input.episodeId,
          input.episodeKey,
          input.maxAttempts,
          input.perDelivery ? 1 : 0,
          input.now,
          input.now,
        );
      const opened = this.unclosedEpisode(input.episodeKey);
      if (!opened) throw new Error('episode insert not visible');
      return { kind: 'opened', episode: episodeFromRow(opened) };
    });
  }

  closeEpisode(input: {
    episodeKey: string;
    now: number;
  }): AutomationEpisodeRecord | undefined {
    return this.transaction(() => {
      const row = this.unclosedEpisode(input.episodeKey);
      if (!row) return undefined;
      this.db
        .prepare(
          `UPDATE automation_episodes SET state = 'closed', updated_ms = ?
            WHERE rule_id = ? AND episode_id = ?`,
        )
        .run(input.now, row.rule_id, row.episode_id);
      return episodeFromRow({ ...row, state: 'closed', updated_ms: input.now });
    });
  }

  episode(episodeKey: string): AutomationEpisodeRecord | undefined {
    return this.read(() => {
      const row = this.unclosedEpisode(episodeKey);
      return row ? episodeFromRow(row) : undefined;
    });
  }

  listEpisodes(limit = 100): AutomationEpisodeRecord[] {
    return this.read(() =>
      (
        this.db
          .prepare(
            'SELECT * FROM automation_episodes ORDER BY opened_ms DESC, rowid DESC LIMIT ?',
          )
          .all(Math.max(1, Math.min(1_000, Math.floor(limit)))) as EpisodeRow[]
      ).map(episodeFromRow),
    );
  }

  claimAction(input: {
    episodeKey: string;
    deliveryKey: string;
    now: number;
  }): ClaimActionOutcome {
    return this.transaction(() => {
      this.reconcileDeadClaims(input.now);
      const episode = this.unclosedEpisode(input.episodeKey);
      if (!episode) return { kind: 'not-found' };
      if (episode.state === 'indeterminate') return { kind: 'indeterminate' };
      if (
        episode.state === 'exhausted' ||
        episode.attempt_count >= episode.max_attempts
      ) {
        return { kind: 'exhausted' };
      }
      if (
        this.db
          .prepare(
            'SELECT 1 FROM automation_action_claims WHERE episode_key = ?',
          )
          .get(input.episodeKey)
      ) {
        return { kind: 'busy' };
      }
      const claimId = randomUUID();
      const attempt = episode.attempt_count + 1;
      this.db
        .prepare(
          `INSERT INTO automation_action_claims
             (claim_id, episode_key, rule_id, episode_id, delivery_key, attempt,
              invocation_started, owner_id, owner_pid, owner_birth, claimed_ms)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          claimId,
          input.episodeKey,
          episode.rule_id,
          episode.episode_id,
          input.deliveryKey,
          attempt,
          this.owner.id,
          this.owner.pid,
          this.owner.birth ?? null,
          input.now,
        );
      return {
        kind: 'claimed',
        receipt: this.receipt({
          claim_id: claimId,
          episode_key: input.episodeKey,
          rule_id: episode.rule_id,
          episode_id: episode.episode_id,
          delivery_key: input.deliveryKey,
          attempt,
        }),
      };
    });
  }

  private receipt(
    claim: Pick<
      ClaimRow,
      | 'claim_id'
      | 'episode_key'
      | 'rule_id'
      | 'episode_id'
      | 'delivery_key'
      | 'attempt'
    >,
  ): AutomationActionReceipt {
    const ownedClaim = (invoked: 0 | 1) =>
      this.db
        .prepare(
          `SELECT * FROM automation_action_claims
            WHERE claim_id = ? AND owner_id = ? AND invocation_started = ?`,
        )
        .get(claim.claim_id, this.owner.id, invoked) as ClaimRow | undefined;
    return {
      claimId: claim.claim_id,
      ruleId: claim.rule_id,
      episodeId: claim.episode_id,
      episodeKey: claim.episode_key,
      deliveryKey: claim.delivery_key,
      attempt: claim.attempt,
      beginInvocation: (now) =>
        this.transaction(() => {
          if (!ownedClaim(0)) return 'stale';
          this.db
            .prepare(
              'UPDATE automation_action_claims SET invocation_started = 1 WHERE claim_id = ?',
            )
            .run(claim.claim_id);
          // The attempt is consumed the moment an effect may happen, so a
          // crash after this point can never earn a free retry.
          this.db
            .prepare(
              `UPDATE automation_episodes
                  SET attempt_count = attempt_count + 1, updated_ms = ?
                WHERE rule_id = ? AND episode_id = ?`,
            )
            .run(now, claim.rule_id, claim.episode_id);
          return 'applied';
        }),
      release: () =>
        this.transaction(() => {
          if (!ownedClaim(0)) return 'stale';
          this.db
            .prepare('DELETE FROM automation_action_claims WHERE claim_id = ?')
            .run(claim.claim_id);
          return 'applied';
        }),
      settle: (settlement) =>
        this.transaction(() => {
          if (!ownedClaim(1)) return 'stale';
          this.finishInvokedClaim(
            claim,
            settlement.state,
            settlement.now,
            settlement,
          );
          return 'applied';
        }),
    };
  }

  /** Deletes an invoked claim and folds its result into episode and delivery. */
  private finishInvokedClaim(
    claim: Pick<
      ClaimRow,
      'claim_id' | 'rule_id' | 'episode_id' | 'delivery_key'
    >,
    state: ActionSettlement['state'],
    now: number,
    refs: { taskId?: string; sessionId?: string } = {},
  ): void {
    this.db
      .prepare('DELETE FROM automation_action_claims WHERE claim_id = ?')
      .run(claim.claim_id);
    // A closed or per-delivery episode ends here; otherwise an unknown
    // result fences the episode and a known one leaves it open until
    // attempts run out.
    this.db
      .prepare(
        `UPDATE automation_episodes
            SET state = CASE
                  WHEN state = 'closed' THEN 'closed'
                  WHEN closes_on_settle = 1 THEN 'closed'
                  WHEN ? = 'indeterminate' THEN 'indeterminate'
                  WHEN state = 'indeterminate' THEN 'indeterminate'
                  WHEN attempt_count >= max_attempts THEN 'exhausted'
                  ELSE 'open'
                END,
                updated_ms = ?
          WHERE rule_id = ? AND episode_id = ?`,
      )
      .run(state, now, claim.rule_id, claim.episode_id);
    this.db
      .prepare(
        `UPDATE automation_deliveries
            SET outcome = ?, reason = NULL,
                rule_id = ?, episode_id = ?,
                task_id = COALESCE(?, task_id),
                session_id = COALESCE(?, session_id),
                updated_ms = ?
          WHERE dedupe_key = ?`,
      )
      .run(
        SETTLED_DELIVERY_OUTCOME[state],
        claim.rule_id,
        claim.episode_id,
        refs.taskId ?? null,
        refs.sessionId ?? null,
        now,
        claim.delivery_key,
      );
  }

  /**
   * A dead owner's claim is released when it never began invocation, and
   * recorded as `indeterminate` (never replayed) when it may have.
   */
  private reconcileDeadClaims(now: number): void {
    for (const claim of this.db
      .prepare('SELECT * FROM automation_action_claims')
      .all() as ClaimRow[]) {
      if (this.claimIsLive(claim)) continue;
      if (!claim.invocation_started) {
        this.db
          .prepare('DELETE FROM automation_action_claims WHERE claim_id = ?')
          .run(claim.claim_id);
        continue;
      }
      this.finishInvokedClaim(claim, 'indeterminate', now);
    }
  }

  private claimIsLive(claim: ClaimRow): boolean {
    // Same pid: the in-process registry is exact (see SchedulerLedger).
    if (claim.owner_pid === process.pid) {
      return LIVE_OWNER_IDS.has(claim.owner_id);
    }
    // A different pid with no recorded birth is undecidable: keep the fence.
    if (!claim.owner_birth) return true;
    const probe = this.identity.probe(claim.owner_pid);
    return (
      probe.state === 'unavailable' ||
      (probe.state === 'exact' &&
        probe.identity.start === claim.owner_birth &&
        probe.identity.pid === claim.owner_pid)
    );
  }

  private unclosedEpisode(episodeKey: string): EpisodeRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM automation_episodes WHERE episode_key = ? AND state <> 'closed'",
      )
      .get(episodeKey) as EpisodeRow | undefined;
  }

  private read<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      throw new AutomationPolicyUnavailableError('ledger read failed', {
        cause: error,
      });
    }
  }

  private transaction<T>(work: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw new AutomationPolicyUnavailableError('ledger busy or unavailable', {
        cause: error,
      });
    }
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original failure remains actionable.
      }
      if (error instanceof RangeError) throw error;
      throw new AutomationPolicyUnavailableError('ledger write failed', {
        cause: error,
      });
    }
  }
}
