/**
 * Durable state for pull request agent feedback: who owns each pull
 * request's feedback (claims), what the forge last showed (observations),
 * what Station decided to tell the agent (deliveries, unique per pull
 * request, category and signature, so the same feedback is never sent
 * twice), the inbox messages that carried them (batches), how many
 * rounds each head has had, and Station's own review of each head
 * (head reviews, one row per pull request and head).
 *
 * One SQLite file in the Station home, opened only once something writes to
 * it, like the Task follow-up store.
 */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  type PullRequestFeedbackCategory,
  type PullRequestFeedbackCategoryCount,
  type PullRequestFeedbackObservation,
  type PullRequestFeedbackSettings,
  type PullRequestFeedbackUnavailableCause,
  parsePullRequestFeedbackSettings,
} from '@kontourai/station-contracts/pull-request-feedback';

/** Deliveries kept per pull request; the oldest settled go past it. */
const MAX_DELIVERIES_PER_PULL_REQUEST = 200;
/** Head reviews kept per pull request; a delta review reads back this far. */
const MAX_HEAD_REVIEWS_PER_PULL_REQUEST = 50;
/** A closed pull request's claim and history are kept this long. */
const CLOSED_CLAIM_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export function pullRequestFeedbackStorePath(homeDir: string): string {
  return join(homeDir, 'pull-request-feedback', 'pull-request-feedback.sqlite');
}

/** A stored claim's standing condition, apart from its switches. */
export type StoredClaimCondition =
  | {
      state: 'paused';
      reason: 'round-limit' | 'repeated-failure';
      /** round-limit: rounds on one head, or messages in 24 hours. */
      cap?: 'head' | 'day';
      headSha: string;
      /**
       * The failing check names: the ones that kept failing
       * (repeated-failure), or the ones waiting when it paused (round-limit).
       */
      failing?: string[];
      /** The same names as a person reads them: required checks first. */
      shown?: string[];
      /** cap head: the rounds that head had when it paused. */
      rounds?: number;
      /** When it paused; absent on a pause recorded before it was kept. */
      at?: string;
    }
  | { state: 'unavailable'; cause: PullRequestFeedbackUnavailableCause }
  | { state: 'closed'; at: string };

export interface PullRequestFeedbackClaim {
  prKey: string;
  identity: PullRequestLinkIdentity;
  conversationId: string;
  settings: PullRequestFeedbackSettings;
  enabledBy: string;
  enabledAt: string;
  generation: number;
  condition?: StoredClaimCondition;
  /** repeated-failure was overridden for this head by Send again. */
  overrideHead?: string;
}

export type StoredDeliveryState =
  | 'pending'
  | 'submitting'
  | 'queued'
  | 'sent'
  | 'superseded'
  | 'dismissed';

export interface StoredDelivery {
  id: string;
  prKey: string;
  conversationId: string;
  headSha: string;
  category: PullRequestFeedbackCategory;
  signature: string;
  state: StoredDeliveryState;
  attempt: number;
  batchKey?: string;
  /** What the message says about it: counts and the items' own lines. */
  summary: DeliverySummary;
  createdAt: string;
  settledAt?: string;
}

export interface DeliverySummary {
  count: number;
  /** failing-checks: the sorted failing check names. */
  failing?: string[];
  /** review-threads: the thread and review items it carried. */
  items?: string[];
}

export type StoredBatchState =
  | 'submitting'
  | 'queued'
  | 'sent'
  | 'refused'
  | 'cancelled';

export interface StoredBatch {
  key: string;
  conversationId: string;
  generation: number;
  state: StoredBatchState;
  message: string;
  actor: { userId: string };
  reasonCode?: string;
  createdAt: string;
  settledAt?: string;
  /** Per pull request: its head and what was sent about it. */
  summary: Array<{
    prKey: string;
    headSha: string;
    /** The claim's generation when composed; a move refuses it. */
    generation: number;
    categories: PullRequestFeedbackCategoryCount[];
  }>;
}

export interface StoredObservation {
  observation: PullRequestFeedbackObservation;
  observedAt: string;
  /** When what the forge showed last changed. */
  unchangedSince: string;
  digest: string;
  /** Per check name, when it was first seen incomplete on this head. */
  incompleteSince?: Record<string, string>;
  /** When this head was first observed; absent on a row written before. */
  headFirstSeenAt?: string;
}

/**
 * Where Station's review of one head stands. `head-not-local` and
 * `no-reviewer` (and a `not-verified` that never reached the review
 * module, so has no `requestId`) are tried again on a later observation;
 * the rest are final for that head until a person asks for Review again.
 */
export type StoredHeadReviewState =
  | 'running'
  | 'reviewed'
  | 'not-verified'
  | 'unknown'
  | 'head-not-local'
  | 'no-reviewer';

export interface StoredHeadReviewFinding {
  id: string;
  file: string;
  line: number;
  severity: string;
  confidence: string;
  basis: string;
  summary: string;
  stateOrInput: string;
  wrongOutcome: string;
  /** Goes to the agent (see `requiredHeadReviewFindings`). */
  required: boolean;
  /** A prior head's finding the reviewer found still present or regressed. */
  carried?: true;
}

export interface StoredHeadReview {
  prKey: string;
  headSha: string;
  state: StoredHeadReviewState;
  /** The review module's request; absent until one was submitted. */
  requestId?: string;
  projectSlug?: string;
  mode?: 'initial' | 'delta';
  priorReceiptId?: string;
  baseSha?: string;
  receiptId?: string;
  /** Required first, then the rest. */
  findings: StoredHeadReviewFinding[];
  requiredIds: string[];
  /** Findings shown only in Station. */
  others: number;
  failureReason?: string;
  startedAt: string;
  settledAt?: string;
  /** Review again count on this head. */
  rerun: number;
  /** A person asked for the required findings to go to the agent. */
  sendRequestedAt?: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS claims (
    pr_key TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    settings TEXT NOT NULL,
    enabled_by TEXT NOT NULL,
    enabled_at TEXT NOT NULL,
    generation INTEGER NOT NULL,
    condition TEXT,
    override_head TEXT,
    next_due_at INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS claims_by_conversation ON claims (conversation_id)`,
  `CREATE TABLE IF NOT EXISTS observations (
    pr_key TEXT PRIMARY KEY,
    observation TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    unchanged_since TEXT NOT NULL,
    digest TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    pr_key TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    category TEXT NOT NULL,
    signature TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    batch_key TEXT,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    UNIQUE (pr_key, category, signature)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS deliveries_by_conversation ON deliveries (conversation_id, state)`,
  `CREATE TABLE IF NOT EXISTS batches (
    key TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    state TEXT NOT NULL,
    message TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason_code TEXT,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    settled_at TEXT
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS batches_by_conversation ON batches (conversation_id, state)`,
  `CREATE TABLE IF NOT EXISTS head_reviews (
    pr_key TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    request_id TEXT,
    project_slug TEXT,
    mode TEXT,
    prior_receipt_id TEXT,
    base_sha TEXT,
    state TEXT NOT NULL,
    receipt_id TEXT,
    findings TEXT NOT NULL,
    required_ids TEXT NOT NULL,
    others INTEGER NOT NULL,
    failure_reason TEXT,
    started_at TEXT NOT NULL,
    settled_at TEXT,
    rerun INTEGER NOT NULL,
    send_requested_at TEXT,
    PRIMARY KEY (pr_key, head_sha)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS head_reviews_by_project ON head_reviews (project_slug, started_at)`,
  // Every review request submitted, reruns included, kept for the daily
  // limit; a head review row is replaced by its rerun, this is not.
  `CREATE TABLE IF NOT EXISTS head_review_requests (
    request_id TEXT PRIMARY KEY,
    project_slug TEXT NOT NULL,
    pr_key TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    submitted_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS head_review_requests_by_project ON head_review_requests (project_slug, submitted_at)`,
  `CREATE TABLE IF NOT EXISTS rounds (
    pr_key TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    count INTEGER NOT NULL,
    extra INTEGER NOT NULL,
    PRIMARY KEY (pr_key, head_sha)
  ) STRICT`,
];

const str = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string')
    throw new Error(`Pull request feedback row has no ${key}.`);
  return value;
};
const optStr = (row: Record<string, unknown>, key: string) => {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
};
const int = (row: Record<string, unknown>, key: string): number => {
  const value = row[key];
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw new Error(`Pull request feedback row has no ${key}.`);
  return Number(value);
};

function readClaim(row: Record<string, unknown>): PullRequestFeedbackClaim {
  const settings = parsePullRequestFeedbackSettings(
    JSON.parse(str(row, 'settings')),
  );
  if (!settings) throw new Error('Pull request feedback settings unreadable.');
  const condition = optStr(row, 'condition');
  const overrideHead = optStr(row, 'override_head');
  return {
    prKey: str(row, 'pr_key'),
    identity: JSON.parse(str(row, 'identity')),
    conversationId: str(row, 'conversation_id'),
    settings,
    enabledBy: str(row, 'enabled_by'),
    enabledAt: str(row, 'enabled_at'),
    generation: int(row, 'generation'),
    ...(condition ? { condition: JSON.parse(condition) } : {}),
    ...(overrideHead ? { overrideHead } : {}),
  };
}

function readDelivery(row: Record<string, unknown>): StoredDelivery {
  const batchKey = optStr(row, 'batch_key');
  const settledAt = optStr(row, 'settled_at');
  return {
    id: str(row, 'id'),
    prKey: str(row, 'pr_key'),
    conversationId: str(row, 'conversation_id'),
    headSha: str(row, 'head_sha'),
    category: str(row, 'category') as PullRequestFeedbackCategory,
    signature: str(row, 'signature'),
    state: str(row, 'state') as StoredDeliveryState,
    attempt: int(row, 'attempt'),
    ...(batchKey ? { batchKey } : {}),
    summary: JSON.parse(str(row, 'summary')),
    createdAt: str(row, 'created_at'),
    ...(settledAt ? { settledAt } : {}),
  };
}

function readHeadReview(row: Record<string, unknown>): StoredHeadReview {
  const optional = {
    requestId: optStr(row, 'request_id'),
    projectSlug: optStr(row, 'project_slug'),
    mode: optStr(row, 'mode') as StoredHeadReview['mode'],
    priorReceiptId: optStr(row, 'prior_receipt_id'),
    baseSha: optStr(row, 'base_sha'),
    receiptId: optStr(row, 'receipt_id'),
    failureReason: optStr(row, 'failure_reason'),
    settledAt: optStr(row, 'settled_at'),
    sendRequestedAt: optStr(row, 'send_requested_at'),
  };
  return {
    prKey: str(row, 'pr_key'),
    headSha: str(row, 'head_sha'),
    state: str(row, 'state') as StoredHeadReviewState,
    findings: JSON.parse(str(row, 'findings')),
    requiredIds: JSON.parse(str(row, 'required_ids')),
    others: int(row, 'others'),
    startedAt: str(row, 'started_at'),
    rerun: int(row, 'rerun'),
    ...Object.fromEntries(
      Object.entries(optional).filter(([, value]) => value !== undefined),
    ),
  };
}

function readBatch(row: Record<string, unknown>): StoredBatch {
  const reasonCode = optStr(row, 'reason_code');
  const settledAt = optStr(row, 'settled_at');
  return {
    key: str(row, 'key'),
    conversationId: str(row, 'conversation_id'),
    generation: int(row, 'generation'),
    state: str(row, 'state') as StoredBatchState,
    message: str(row, 'message'),
    actor: JSON.parse(str(row, 'actor')),
    ...(reasonCode ? { reasonCode } : {}),
    summary: JSON.parse(str(row, 'summary')),
    createdAt: str(row, 'created_at'),
    ...(settledAt ? { settledAt } : {}),
  };
}

export class PullRequestFeedbackStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    // Private: forge text, conversation ids and who turned feedback on.
    if (!existsSync(dbPath))
      closeSync(
        openSync(
          dbPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        ),
      );
    else if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      for (const statement of SCHEMA) db.exec(statement);
      const columns = db
        .prepare('PRAGMA table_info(observations)')
        .all()
        .map((row) => row.name);
      if (!columns.includes('incomplete_since'))
        db.exec('ALTER TABLE observations ADD COLUMN incomplete_since TEXT');
      if (!columns.includes('head_first_seen_at'))
        db.exec('ALTER TABLE observations ADD COLUMN head_first_seen_at TEXT');
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Claims ------------------------------------------------------------------

  claim(prKey: string): PullRequestFeedbackClaim | undefined {
    const row = this.db
      .prepare('SELECT * FROM claims WHERE pr_key = ?')
      .get(prKey);
    return row ? readClaim(row) : undefined;
  }

  claimsForConversation(conversationId: string): PullRequestFeedbackClaim[] {
    return this.db
      .prepare('SELECT * FROM claims WHERE conversation_id = ?')
      .all(conversationId)
      .map(readClaim);
  }

  allClaims(): PullRequestFeedbackClaim[] {
    return this.db.prepare('SELECT * FROM claims').all().map(readClaim);
  }

  /**
   * Write a claim's switches. A new claim starts at generation 1; an
   * existing one keeps its generation unless `move` names a new owner,
   * which bumps it so a message queued for the old owner is refused.
   */
  writeClaim(input: {
    prKey: string;
    identity: PullRequestLinkIdentity;
    conversationId: string;
    settings: PullRequestFeedbackSettings;
    enabledBy: string;
    now: string;
  }): PullRequestFeedbackClaim {
    return this.transaction(() => {
      const prior = this.claim(input.prKey);
      const moved = prior && prior.conversationId !== input.conversationId;
      const generation = prior ? prior.generation + (moved ? 1 : 0) : 1;
      this.db
        .prepare(
          `INSERT INTO claims (pr_key, identity, conversation_id, settings, enabled_by, enabled_at, generation, condition, override_head)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT (pr_key) DO UPDATE SET identity = excluded.identity,
             conversation_id = excluded.conversation_id, settings = excluded.settings,
             enabled_by = excluded.enabled_by, enabled_at = excluded.enabled_at,
             generation = excluded.generation, next_due_at = 0,
             condition = CASE WHEN claims.conversation_id = excluded.conversation_id THEN claims.condition ELSE NULL END,
             override_head = CASE WHEN claims.conversation_id = excluded.conversation_id THEN claims.override_head ELSE NULL END`,
        )
        .run(
          input.prKey,
          JSON.stringify(input.identity),
          input.conversationId,
          JSON.stringify(input.settings),
          input.enabledBy,
          input.now,
          generation,
        );
      if (moved) {
        // What waited for the old owner is not the new owner's.
        this.db
          .prepare(
            "UPDATE deliveries SET state = 'superseded', settled_at = ? WHERE pr_key = ? AND state = 'pending'",
          )
          .run(input.now, input.prKey);
        // Nor are its head reviews: the new owner's chat reviews afresh.
        this.db
          .prepare('DELETE FROM head_reviews WHERE pr_key = ?')
          .run(input.prKey);
      }
      return this.claim(input.prKey)!;
    });
  }

  /** Remove a claim; its history goes with it. */
  deleteClaim(prKey: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM claims WHERE pr_key = ?').run(prKey);
      this.db.prepare('DELETE FROM observations WHERE pr_key = ?').run(prKey);
      this.db.prepare('DELETE FROM deliveries WHERE pr_key = ?').run(prKey);
      this.db.prepare('DELETE FROM rounds WHERE pr_key = ?').run(prKey);
      this.db.prepare('DELETE FROM head_reviews WHERE pr_key = ?').run(prKey);
    });
  }

  /**
   * Stop a claim without forgetting it: every switch off, its waiting
   * feedback superseded, history kept (pruned with off claims later).
   */
  releaseClaim(prKey: string, now: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          'UPDATE claims SET settings = ?, enabled_at = ?, condition = NULL WHERE pr_key = ?',
        )
        .run(
          JSON.stringify({
            fixFailingChecks: false,
            addressReviewComments: false,
            reviewEachHead: false,
          }),
          now,
          prKey,
        );
      this.db
        .prepare(
          "UPDATE deliveries SET state = 'superseded', settled_at = ? WHERE pr_key = ? AND state = 'pending'",
        )
        .run(now, prKey);
      // A released claim's head reviews were for the chat that let it go.
      this.db.prepare('DELETE FROM head_reviews WHERE pr_key = ?').run(prKey);
    });
  }

  setCondition(prKey: string, condition: StoredClaimCondition | null): void {
    this.db
      .prepare('UPDATE claims SET condition = ? WHERE pr_key = ?')
      .run(condition ? JSON.stringify(condition) : null, prKey);
  }

  setOverrideHead(prKey: string, headSha: string | null): void {
    this.db
      .prepare('UPDATE claims SET override_head = ? WHERE pr_key = ?')
      .run(headSha, prKey);
  }

  // Observations -------------------------------------------------------------

  observation(prKey: string): StoredObservation | undefined {
    const row = this.db
      .prepare('SELECT * FROM observations WHERE pr_key = ?')
      .get(prKey);
    if (!row) return undefined;
    return {
      observation: JSON.parse(str(row, 'observation')),
      observedAt: str(row, 'observed_at'),
      unchangedSince: str(row, 'unchanged_since'),
      digest: str(row, 'digest'),
      ...(optStr(row, 'incomplete_since')
        ? { incompleteSince: JSON.parse(optStr(row, 'incomplete_since')!) }
        : {}),
      ...(optStr(row, 'head_first_seen_at')
        ? { headFirstSeenAt: optStr(row, 'head_first_seen_at')! }
        : {}),
    };
  }

  writeObservation(prKey: string, value: StoredObservation): void {
    this.db
      .prepare(
        `INSERT INTO observations (pr_key, observation, observed_at, unchanged_since, digest, incomplete_since, head_first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pr_key) DO UPDATE SET observation = excluded.observation,
           observed_at = excluded.observed_at,
           unchanged_since = excluded.unchanged_since, digest = excluded.digest,
           incomplete_since = excluded.incomplete_since,
           head_first_seen_at = excluded.head_first_seen_at`,
      )
      .run(
        prKey,
        JSON.stringify(value.observation),
        value.observedAt,
        value.unchangedSince,
        value.digest,
        value.incompleteSince ? JSON.stringify(value.incompleteSince) : null,
        value.headFirstSeenAt ?? null,
      );
  }

  /** When the next read is due; a claim never read is due now. */
  nextDueAt(prKey: string): number {
    const row = this.db
      .prepare('SELECT next_due_at FROM claims WHERE pr_key = ?')
      .get(prKey);
    return row ? int(row, 'next_due_at') : 0;
  }

  setNextDueAt(prKey: string, at: number): void {
    this.db
      .prepare('UPDATE claims SET next_due_at = ? WHERE pr_key = ?')
      .run(at, prKey);
  }

  // Deliveries ---------------------------------------------------------------

  /**
   * The delivery for this pull request, category and signature: the one
   * already recorded, or a new pending one. The UNIQUE key makes the same
   * feedback one row forever.
   */
  recordDelivery(input: {
    id: string;
    prKey: string;
    conversationId: string;
    headSha: string;
    category: PullRequestFeedbackCategory;
    signature: string;
    summary: DeliverySummary;
    now: string;
  }): StoredDelivery {
    this.db
      .prepare(
        `INSERT INTO deliveries (id, pr_key, conversation_id, head_sha, category, signature, state, attempt, batch_key, summary, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?, NULL)
         ON CONFLICT (pr_key, category, signature) DO NOTHING`,
      )
      .run(
        input.id,
        input.prKey,
        input.conversationId,
        input.headSha,
        input.category,
        input.signature,
        JSON.stringify(input.summary),
        input.now,
      );
    // Feedback that stopped showing and came back is pending again (a
    // check re-run that failed the same way), and feedback still pending
    // for a previous owner (its message was refused after a move) is now
    // the current owner's.
    this.db
      .prepare(
        `UPDATE deliveries SET state = 'pending', settled_at = NULL, conversation_id = ?
         WHERE pr_key = ? AND category = ? AND signature = ?
           AND (state = 'superseded' OR (state = 'pending' AND conversation_id != ?))`,
      )
      .run(
        input.conversationId,
        input.prKey,
        input.category,
        input.signature,
        input.conversationId,
      );
    return readDelivery(
      this.db
        .prepare(
          'SELECT * FROM deliveries WHERE pr_key = ? AND category = ? AND signature = ?',
        )
        .get(input.prKey, input.category, input.signature)!,
    );
  }

  /** Pending feedback for this category that the forge no longer shows. */
  supersede(
    prKey: string,
    category: PullRequestFeedbackCategory,
    current: string | undefined,
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE deliveries SET state = 'superseded', settled_at = ?
         WHERE pr_key = ? AND category = ? AND state = 'pending' AND signature IS NOT ?`,
      )
      .run(now, prKey, category, current ?? null);
  }

  pendingDeliveries(conversationId: string): StoredDelivery[] {
    return this.db
      .prepare(
        "SELECT * FROM deliveries WHERE conversation_id = ? AND state = 'pending' ORDER BY created_at, id",
      )
      .all(conversationId)
      .map(readDelivery);
  }

  deliveriesForPullRequest(prKey: string, limit: number): StoredDelivery[] {
    return this.db
      .prepare(
        'SELECT * FROM deliveries WHERE pr_key = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(prKey, limit)
      .map(readDelivery);
  }

  /** The newest sent failing-check deliveries, newest first. */
  recentSentFailures(prKey: string, limit: number): StoredDelivery[] {
    return this.db
      .prepare(
        `SELECT * FROM deliveries WHERE pr_key = ? AND category = 'failing-checks' AND state = 'sent'
         ORDER BY settled_at DESC, id DESC LIMIT ?`,
      )
      .all(prKey, limit)
      .map(readDelivery);
  }

  // Batches ------------------------------------------------------------------

  /** Messages not yet settled by the inbox that carry this pull request. */
  openBatchKeysFor(prKey: string): string[] {
    return this.db
      .prepare(
        `SELECT DISTINCT batch_key FROM deliveries
         WHERE pr_key = ? AND state IN ('submitting', 'queued') AND batch_key IS NOT NULL`,
      )
      .all(prKey)
      .map((row) => str(row, 'batch_key'));
  }

  /** The conversation's message not yet settled by the inbox, if any. */
  openBatch(conversationId: string): StoredBatch | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM batches WHERE conversation_id = ? AND state IN ('submitting', 'queued') ORDER BY created_at LIMIT 1",
      )
      .get(conversationId);
    return row ? readBatch(row) : undefined;
  }

  batch(key: string): StoredBatch | undefined {
    const row = this.db.prepare('SELECT * FROM batches WHERE key = ?').get(key);
    return row ? readBatch(row) : undefined;
  }

  batchesForConversation(conversationId: string, limit: number): StoredBatch[] {
    return this.db
      .prepare(
        'SELECT * FROM batches WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(conversationId, limit)
      .map(readBatch);
  }

  /** Write the message and claim its deliveries before it is submitted. */
  beginBatch(batch: StoredBatch, deliveryIds: readonly string[]): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO batches (key, conversation_id, generation, state, message, actor, reason_code, summary, created_at, settled_at)
           VALUES (?, ?, ?, 'submitting', ?, ?, NULL, ?, ?, NULL)`,
        )
        .run(
          batch.key,
          batch.conversationId,
          batch.generation,
          batch.message,
          JSON.stringify(batch.actor),
          JSON.stringify(batch.summary),
          batch.createdAt,
        );
      const claim = this.db.prepare(
        "UPDATE deliveries SET state = 'submitting', batch_key = ? WHERE id = ? AND state = 'pending'",
      );
      for (const id of deliveryIds) claim.run(batch.key, id);
    });
  }

  markBatchQueued(key: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE batches SET state = 'queued' WHERE key = ? AND state = 'submitting'",
        )
        .run(key);
      this.db
        .prepare(
          "UPDATE deliveries SET state = 'queued' WHERE batch_key = ? AND state = 'submitting'",
        )
        .run(key);
    });
  }

  /**
   * The inbox settled the message. `sent` counts a round for each pull
   * request's head; `refused` returns its deliveries to pending, to be
   * composed again under a new key; `cancelled` (a person withdrew it)
   * dismisses them.
   */
  settleBatch(
    key: string,
    state: 'sent' | 'refused' | 'cancelled',
    now: string,
    reasonCode?: string,
  ): void {
    this.transaction(() => {
      const batch = this.batch(key);
      if (!batch || (batch.state !== 'submitting' && batch.state !== 'queued'))
        return;
      this.db
        .prepare(
          'UPDATE batches SET state = ?, reason_code = ?, settled_at = ? WHERE key = ?',
        )
        .run(state, reasonCode ?? null, now, key);
      if (state === 'sent') {
        this.db
          .prepare(
            "UPDATE deliveries SET state = 'sent', settled_at = ? WHERE batch_key = ?",
          )
          .run(now, key);
        const round = this.db.prepare(
          `INSERT INTO rounds (pr_key, head_sha, count, extra) VALUES (?, ?, 1, 0)
           ON CONFLICT (pr_key, head_sha) DO UPDATE SET count = count + 1`,
        );
        for (const entry of batch.summary)
          round.run(entry.prKey, entry.headSha);
      } else if (state === 'refused') {
        this.db
          .prepare(
            "UPDATE deliveries SET state = 'pending', batch_key = NULL, attempt = attempt + 1 WHERE batch_key = ?",
          )
          .run(key);
      } else {
        this.db
          .prepare(
            "UPDATE deliveries SET state = 'dismissed', settled_at = ? WHERE batch_key = ?",
          )
          .run(now, key);
      }
    });
  }

  // Rounds -------------------------------------------------------------------

  rounds(prKey: string, headSha: string): { count: number; extra: number } {
    const row = this.db
      .prepare(
        'SELECT count, extra FROM rounds WHERE pr_key = ? AND head_sha = ?',
      )
      .get(prKey, headSha);
    return row
      ? { count: int(row, 'count'), extra: int(row, 'extra') }
      : { count: 0, extra: 0 };
  }

  /** Send again: one more round on this head. */
  grantRound(prKey: string, headSha: string): void {
    this.db
      .prepare(
        `INSERT INTO rounds (pr_key, head_sha, count, extra) VALUES (?, ?, 0, 1)
         ON CONFLICT (pr_key, head_sha) DO UPDATE SET extra = extra + 1`,
      )
      .run(prKey, headSha);
  }

  /** Messages placed for this pull request since `since`. */
  sentSince(prKey: string, since: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT batch_key) AS sent FROM deliveries
         WHERE pr_key = ? AND state = 'sent' AND settled_at >= ?`,
      )
      .get(prKey, since);
    return row ? int(row, 'sent') : 0;
  }

  // Head reviews -------------------------------------------------------------

  headReview(prKey: string, headSha: string): StoredHeadReview | undefined {
    const row = this.db
      .prepare('SELECT * FROM head_reviews WHERE pr_key = ? AND head_sha = ?')
      .get(prKey, headSha);
    return row ? readHeadReview(row) : undefined;
  }

  /** This pull request's head reviews, newest first. */
  headReviews(prKey: string): StoredHeadReview[] {
    return this.db
      .prepare(
        'SELECT * FROM head_reviews WHERE pr_key = ? ORDER BY started_at DESC, rowid DESC',
      )
      .all(prKey)
      .map(readHeadReview);
  }

  /** Reviews left running: after a restart nobody is waiting on them. */
  runningHeadReviews(): StoredHeadReview[] {
    return this.db
      .prepare("SELECT * FROM head_reviews WHERE state = 'running'")
      .all()
      .map(readHeadReview);
  }

  writeHeadReview(review: StoredHeadReview): void {
    this.db
      .prepare(
        `INSERT INTO head_reviews (pr_key, head_sha, request_id, project_slug, mode, prior_receipt_id, base_sha, state, receipt_id, findings, required_ids, others, failure_reason, started_at, settled_at, rerun, send_requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pr_key, head_sha) DO UPDATE SET request_id = excluded.request_id,
           project_slug = excluded.project_slug, mode = excluded.mode,
           prior_receipt_id = excluded.prior_receipt_id, base_sha = excluded.base_sha,
           state = excluded.state, receipt_id = excluded.receipt_id,
           findings = excluded.findings, required_ids = excluded.required_ids,
           others = excluded.others, failure_reason = excluded.failure_reason,
           started_at = excluded.started_at, settled_at = excluded.settled_at,
           rerun = excluded.rerun, send_requested_at = excluded.send_requested_at`,
      )
      .run(
        review.prKey,
        review.headSha,
        review.requestId ?? null,
        review.projectSlug ?? null,
        review.mode ?? null,
        review.priorReceiptId ?? null,
        review.baseSha ?? null,
        review.state,
        review.receiptId ?? null,
        JSON.stringify(review.findings),
        JSON.stringify(review.requiredIds),
        review.others,
        review.failureReason ?? null,
        review.startedAt,
        review.settledAt ?? null,
        review.rerun,
        review.sendRequestedAt ?? null,
      );
  }

  /** Record one submitted review request, a rerun included. */
  recordHeadReviewRequest(input: {
    requestId: string;
    projectSlug: string;
    prKey: string;
    headSha: string;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO head_review_requests (request_id, project_slug, pr_key, head_sha, submitted_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (request_id) DO NOTHING`,
      )
      .run(
        input.requestId,
        input.projectSlug,
        input.prKey,
        input.headSha,
        input.at,
      );
  }

  /** Review requests this Project submitted since `since` (the daily cap). */
  headReviewsStartedSince(projectSlug: string, since: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS started FROM head_review_requests
         WHERE project_slug = ? AND submitted_at >= ?`,
      )
      .get(projectSlug, since);
    return row ? int(row, 'started') : 0;
  }

  // Retention ----------------------------------------------------------------

  /** Drop history past its bounds and claims closed long enough ago. */
  prune(now: number): void {
    this.transaction(() => {
      for (const claim of this.allClaims()) {
        const off =
          !claim.settings.fixFailingChecks &&
          !claim.settings.addressReviewComments &&
          !claim.settings.reviewEachHead;
        if (
          (claim.condition?.state === 'closed' &&
            now - Date.parse(claim.condition.at) > CLOSED_CLAIM_RETENTION_MS) ||
          (off && now - Date.parse(claim.enabledAt) > CLOSED_CLAIM_RETENTION_MS)
        ) {
          for (const table of [
            'claims',
            'observations',
            'deliveries',
            'rounds',
            'head_reviews',
          ])
            this.db
              .prepare(`DELETE FROM ${table} WHERE pr_key = ?`)
              .run(claim.prKey);
          continue;
        }
        this.db
          .prepare(
            `DELETE FROM deliveries WHERE pr_key = ? AND state NOT IN ('pending', 'submitting', 'queued')
             AND id NOT IN (SELECT id FROM deliveries WHERE pr_key = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
          )
          .run(claim.prKey, claim.prKey, MAX_DELIVERIES_PER_PULL_REQUEST);
        this.db
          .prepare(
            `DELETE FROM head_reviews WHERE pr_key = ? AND state != 'running'
             AND rowid NOT IN (SELECT rowid FROM head_reviews WHERE pr_key = ? ORDER BY started_at DESC LIMIT ?)`,
          )
          .run(claim.prKey, claim.prKey, MAX_HEAD_REVIEWS_PER_PULL_REQUEST);
      }
      // Two days: the daily limit reads back one.
      this.db
        .prepare('DELETE FROM head_review_requests WHERE submitted_at < ?')
        .run(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString());
      this.db
        .prepare(
          `DELETE FROM batches WHERE state NOT IN ('submitting', 'queued')
           AND key NOT IN (SELECT DISTINCT batch_key FROM deliveries WHERE batch_key IS NOT NULL)`,
        )
        .run();
    });
  }
}

/** Opens the store on first write; a read before then finds nothing. */
export class PullRequestFeedbackStoreHolder {
  private store: PullRequestFeedbackStore | undefined;
  private closed = false;

  constructor(private readonly path: () => string) {}

  forWrite(): PullRequestFeedbackStore | undefined {
    if (this.closed) return undefined;
    this.store ??= new PullRequestFeedbackStore(this.path());
    return this.store;
  }

  forRead(): PullRequestFeedbackStore | undefined {
    if (this.closed) return undefined;
    if (!this.store && !existsSync(this.path())) return undefined;
    return this.forWrite();
  }

  close(): void {
    this.closed = true;
    this.store?.close();
    this.store = undefined;
  }
}
