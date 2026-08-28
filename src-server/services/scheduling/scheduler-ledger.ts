/**
 * SchedulerLedger is the sole owner of built-in scheduler state.
 *
 * Its Interface is intentionally made of scheduler operations, not a generic
 * transaction callback: create, edit, remove, claim and settlement are the
 * transitions whose ordering matters.  SQLite keeps the implementation
 * private while a claim capability prevents a timer from reconstructing an
 * old completion after an operator changes or removes its job.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import {
  isOverdue,
  missedCount,
  nextOccurrence,
  type Schedule,
  type ScheduledJob,
} from '@kontourai/ephemeris';
import type {
  ExternalMonitorConfig,
  ExternalMonitorState,
} from '@kontourai/station-contracts/external-monitor';
import type {
  SchedulerJob,
  SchedulerLogEntry,
  SchedulerProviderStats,
} from '@kontourai/station-contracts/scheduler';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import {
  corruptionMarkerFromError,
  recordCorruptionObserved,
} from '@kontourai/station-shared/sqlite-corruption-marker';
import { watchForSqliteCorruption } from '@kontourai/station-shared/sqlite-corruption-watch';
import {
  checkSqliteIntegrity,
  explicitCorruption,
} from '@kontourai/station-shared/sqlite-integrity';
import { resolveHomeDir } from '../../utils/paths.js';
import { applyWalJournalMode } from '../../utils/sqlite-wal.js';
import { JsonFileStore } from '../infra/json-store.js';

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
      run: (...args: unknown[]) => unknown;
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
    close(): void;
  };
};

export interface StoredSchedulerJob {
  name: string;
  cron?: string;
  schedule?: Schedule;
  prompt: string;
  agent?: string;
  enabled: boolean;
  notifyStart?: boolean;
  retryCount?: number;
  retryDelaySecs?: number;
  lastRunMs?: number;
  monitor?: ExternalMonitorConfig;
  monitorState?: ExternalMonitorState;
  createdAt: string;
}

export interface SchedulerDispatchReceipt {
  readonly id: string;
  /** Opaque server-issued identity; display names never authorize a job. */
  readonly jobId: string;
  readonly job: Readonly<StoredSchedulerJob>;
  readonly startedAt: string;
  /** The exact recurring occurrence this receipt consumes; manual runs omit it. */
  readonly scheduledForMs?: number;
  readonly manual: boolean;
  readonly missedCount: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  outputPath(): string;
  /** Releases a pre-invocation claim without consuming an attempt or a run. */
  releaseDeferred(): SchedulerDeferredOutcome;
  beginInvocation(): SchedulerInvocationOutcome;
  /** Atomically records a proved pre-effect failure and advances its attempt. */
  recordNotInvoked(input: {
    completedAt: string;
    error: string;
  }): SchedulerNotInvokedOutcome;
  settle(outcome: SchedulerDispatchSettlement): SchedulerSettlementOutcome;
}

export type SchedulerDispatchSettlement = Readonly<{
  success: boolean;
  state: 'completed' | 'failed' | 'indeterminate';
  completedAt: string;
  durationSecs: number;
  output?: string;
  error?: string;
  /** Legacy callers may pass `true`; all generic settlements are terminal. */
  terminal?: true;
}>;

/**
 * Why the ledger could not answer.
 *
 * `corrupt` is the positive claim: SQLite reported SQLITE_CORRUPT or
 * SQLITE_NOTADB, so the bytes are damaged and no amount of asking again will
 * repair them. `transient` is the ABSENCE of that claim — everything else.
 *
 * That asymmetry is deliberate, and the wording matters because the obvious
 * gloss ("transient means asking again is the right move") is false for at
 * least one member of the set: `readOutput` rejects a path outside the logs
 * directory through the same seam, and retrying a traversal attempt is never
 * right. Calling the residual bucket "not classified as damage" is the most
 * this actually derives. The pre-existing `SchedulerStorageUnavailableError`
 * still says "temporarily unavailable" for that case, which was true before
 * this change and is disclosed rather than widened here (archive#3220).
 *
 * Both stay under one `kind` deliberately. Every existing caller already
 * treats `unavailable` as a failure, so widening the discriminant instead
 * would let a corrupt store fall through an `if (kind === 'unavailable')`
 * chain into a success return. The reason is REQUIRED so that the producer —
 * the only place that holds the SQLite error — has to decide, while consumers
 * that do not care are unaffected.
 */
export type SchedulerUnavailableReason = 'transient' | 'corrupt';

export interface SchedulerUnavailable {
  readonly kind: 'unavailable';
  readonly reason: SchedulerUnavailableReason;
}

/** The one place a raw SQLite failure becomes a scheduler-shaped verdict. */
function unavailableFrom(error: unknown): SchedulerUnavailable {
  return {
    kind: 'unavailable',
    reason: explicitCorruption(error) ? 'corrupt' : 'transient',
  };
}

export type SchedulerSettlementOutcome =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | { kind: 'invalid' }
  | SchedulerUnavailable;

export type SchedulerInvocationOutcome =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | SchedulerUnavailable;

export type SchedulerDeferredOutcome =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | SchedulerUnavailable;

export type SchedulerStarterReleaseOutcome =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | SchedulerUnavailable;

export type SchedulerNotInvokedOutcome =
  | { kind: 'claimed'; receipt: SchedulerDispatchReceipt }
  | { kind: 'terminal' }
  | { kind: 'stale' }
  | SchedulerUnavailable;

export type SchedulerClaimOutcome =
  | { kind: 'claimed'; receipt: SchedulerDispatchReceipt }
  | { kind: 'not-found' }
  | { kind: 'busy' }
  | SchedulerUnavailable;

export const SCHEDULER_STARTER_MANUAL_INTENT_CAPACITY = 100;
export const SCHEDULER_STARTER_CHECK_JOB_NAME = 'station-starter-check';
export const SCHEDULER_STARTER_CHECK_EVERY_MS = 86_400_000;
export const SCHEDULER_STARTER_CHECK_PROMPT =
  'Check this Station’s current readiness and summarize any action required. Do not change configuration or Work.';

export type SchedulerStarterManualClaimOutcome =
  | {
      kind: 'claimed';
      receipt: SchedulerDispatchReceipt;
      replayed: boolean;
    }
  | { kind: 'replayed'; run: SchedulerLogEntry }
  | { kind: 'not-found' }
  | { kind: 'busy' }
  | { kind: 'conflict' }
  | { kind: 'capacity' }
  | { kind: 'invalid' }
  | SchedulerUnavailable;

export type SchedulerCreateOutcome =
  | { kind: 'created' }
  | { kind: 'exists' }
  | SchedulerUnavailable;

export type SchedulerUpdateOutcome =
  | { kind: 'updated' }
  | { kind: 'not-found' }
  | { kind: 'busy' }
  | SchedulerUnavailable;

export type SchedulerRemoveOutcome =
  | { kind: 'removed' }
  | { kind: 'not-found' }
  | { kind: 'busy' }
  | SchedulerUnavailable;

export class SchedulerStorageUnavailableError extends Error {
  readonly code = 'SCHEDULER_STORAGE_UNAVAILABLE';

  constructor() {
    super('Scheduler storage is temporarily unavailable');
    this.name = 'SchedulerStorageUnavailableError';
  }
}

export class SchedulerStorageCorruptError extends Error {
  readonly code = 'SCHEDULER_STORAGE_CORRUPT';

  constructor() {
    // Mechanism-neutral on purpose: SQLite now reports this either from the
    // boot check or from an ordinary statement hitting a damaged page, and the
    // operator's next move is the same in both cases (archive#3220).
    super(
      'Scheduler storage is corrupt. Stop every Station using this home, then restore a validated backup with `station home restore --from=<backup-dir> --confirm`.',
    );
    this.name = 'SchedulerStorageCorruptError';
  }
}

export type SchedulerReadOutcome<T> =
  | { kind: 'available'; value: T }
  | SchedulerUnavailable;

/** Monitor accounting is part of the scheduler authority, never a second DB. */
export const EXTERNAL_MONITOR_LEDGER_RETENTION_DAYS = 31;
export const EXTERNAL_MONITOR_LEDGER_MAX_OUTCOMES = 512;
export const EXTERNAL_MONITOR_DEFAULT_BUDGET = Object.freeze({
  maxTurns: 4,
  maxTokens: 100_000,
  maxRuntimeMs: 15 * 60_000,
  maxWallRuntimeMs: 20 * 60_000,
  maxActive: 1,
  maxConcurrency: 1,
});
export const EXTERNAL_MONITOR_MAX_BUDGET = Object.freeze({
  maxTurns: 20,
  maxTokens: 1_000_000,
  maxRuntimeMs: 2 * 60 * 60_000,
  maxWallRuntimeMs: 2 * 60 * 60_000,
  maxActive: 4,
  maxConcurrency: 4,
});

export type MonitorUsage = Readonly<{
  turns?: number;
  tokens?: number;
  runtimeMs?: number;
}>;
export type MonitorBudget = Readonly<{
  maxTurns?: number;
  maxTokens?: number;
  maxRuntimeMs?: number;
  maxWallRuntimeMs?: number;
  maxActive?: number;
  maxConcurrency?: number;
}>;
export type MonitorTriggerPhase = 'reserved' | 'task-attached' | 'terminal';
export type MonitorTaskTurnReceipt = Readonly<{
  taskId: string;
  sessionId?: string;
  turnId?: string;
}>;
export type MonitorReservation =
  | {
      kind: 'dispatch';
      triggerId: string;
      phase: 'reserved';
      /** Durable wall fence minted in the admission transaction. */
      deadlineAt: string;
      /** The atomically reserved remainder; never recompute it after admission. */
      limits: Required<
        Pick<
          MonitorBudget,
          'maxTurns' | 'maxTokens' | 'maxRuntimeMs' | 'maxWallRuntimeMs'
        >
      >;
    }
  | {
      kind: 'adopt';
      triggerId: string;
      phase: 'reserved' | 'task-attached';
      task?: MonitorTaskTurnReceipt;
    }
  | { kind: 'terminal'; triggerId: string }
  | { kind: 'blocked'; reason: 'budget' | 'unknown-usage' | 'active' }
  | SchedulerUnavailable;
export type MonitorSettlement =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | { kind: 'unknown-usage' }
  | SchedulerUnavailable;
export type MonitorTerminal = Readonly<{
  triggerId: string;
  terminal: 'completed' | 'failed' | 'indeterminate';
  usage?: MonitorUsage;
}>;
export type MonitorAccounting = Readonly<{
  triggerId?: string;
  task?: MonitorTaskTurnReceipt;
  fingerprint?: string;
  phase?: MonitorTriggerPhase;
  completedTurns: number;
  consumedTokens: number;
  consumedRuntimeMs: number;
  usageKnown: boolean;
}>;
export type AttachedMonitorTrigger = Readonly<{
  triggerId: string;
  monitorId: string;
  task: MonitorTaskTurnReceipt;
  startedAt: string;
  deadlineAt: string;
  limits: Readonly<{ maxTurns: number; maxTokens: number }>;
}>;

/**
 * How far back the boot sweep will announce a failure nobody was told about.
 *
 * The outbox exists because a failed run must reach the bell even if the
 * process that recorded it died before saying so — but a Station that was off
 * for a month must not open with a month of notifications, which is a flood
 * nobody reads and which buries the failure that happened this morning. Runs
 * older than this are still visible on the Schedule page (the row is durable
 * and unchanged); only the announcement is dropped, and the row records that
 * it was dropped rather than pretending it was delivered.
 */
export const FAILURE_ANNOUNCEMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Why a stamped row was never announced. NULL skip reason = announced. */
export const ANNOUNCEMENT_SKIPPED_OLDER_THAN_RETENTION =
  'announcement skipped: older than retention';

/**
 * Rows that already existed when this ledger gained the outbox. They were
 * recorded under the old in-process rule, so whether they were announced is
 * not a fact this store holds — and re-announcing an unknown backlog on the
 * first boot after an upgrade is the flood the retention window exists to
 * prevent.
 */
export const ANNOUNCEMENT_SKIPPED_BEFORE_OUTBOX =
  'announcement skipped: recorded before the announcement outbox existed';

/**
 * How long one claimant owns a run's announcement.
 *
 * Two Stations over one home (a desktop app and a CLI, say) each run their
 * own scheduler and each boot sweeps the same table. Without a claim both
 * read the same owed row, both announce it, and the user is told twice about
 * one failure — an ordinary-concurrency duplicate, not the ambiguous-crash
 * duplicate this design accepts. The lease expires so a claimant that dies
 * mid-announcement cannot hold the row shut forever; that recovery is the
 * at-least-once path, and it is why the window is short.
 */
export const ANNOUNCEMENT_LEASE_MS = 60_000;

/** Records that the pre-outbox backfill has run to completion, exactly once. */
export const ANNOUNCEMENT_OUTBOX_MIGRATION_KEY = 'announcement-outbox-migrated';

/**
 * What a caller may do about one run's announcement.
 *
 * A claim carries a TOKEN, and release/mark are conditional on it. Without
 * one the lease is only a timestamp, so a slow claimant whose lease expired
 * can still clear or stamp over the lease its successor now holds — its
 * announcement is in flight, and neither the dispatch queue nor the
 * notification mutation lock promises to finish inside 60 seconds. The token
 * makes a stale claimant's writes no-ops instead of interference.
 *
 * `unknown` is the honest residual: no such row, or a store that could not
 * answer. It reads as "announce it" — being told twice is recoverable, being
 * told nothing is the defect this outbox exists to remove. It carries no
 * token, so a caller holding one cannot stamp anything on that path.
 */
export type SchedulerAnnouncementClaim =
  | { kind: 'claimed'; token: string }
  | { kind: 'already-announced' }
  | { kind: 'leased-elsewhere' }
  | { kind: 'unknown' };

/**
 * The durable side of "this failure was announced".
 *
 * Announcement idempotence used to be an in-process Set, which a restart
 * cleared and which therefore could not answer the only question that
 * matters after a crash: has the user been told about THIS run? The answer
 * lives in the run's own row now, and the Set is kept only as a fast path in
 * front of it.
 *
 * The sequence a caller owes this Interface is claim → announce → mark (or
 * release). Stamping happens only after a notification write is durable, so
 * a claimant that dies between the two leaves the run owed and the next boot
 * announces it once more. That duplicate is the designed at-least-once
 * behaviour; a stamp written before the notification would instead be a
 * delivery this store recorded and nobody received.
 *
 * Every operation is best-effort against storage and fails in the direction
 * of telling the user.
 */
export interface SchedulerAnnouncementOutbox {
  /** Reserves this run's announcement for `ANNOUNCEMENT_LEASE_MS`. */
  claimAnnouncement(id: string, now?: number): SchedulerAnnouncementClaim;
  /** Gives a claim back unused, so another caller need not wait it out. */
  releaseAnnouncement(id: string, token: string): void;
  /** Records that a durable notification for this run now exists. */
  markAnnounced(id: string, token: string): void;
}

/** Durable terminal-task notification state, keyed by the exact trigger. */
export interface MonitorTerminalAnnouncementOutbox {
  claim(triggerId: string, now?: number): SchedulerAnnouncementClaim;
  release(triggerId: string, token: string): void;
  markDelivered(triggerId: string, token: string): void;
}

/**
 * A probe can reach a final answer without ever creating a Task trigger.
 * Keep that bell in the scheduler ledger too: a direct NotificationService
 * call cannot survive the gap between changing monitor state and delivery.
 */
export type MonitorProbeTerminalOutcome =
  | 'terminal'
  | 'unauthorized'
  | 'budget-exhausted';

export type MonitorProbeTerminalAnnouncement = Readonly<{
  id: string;
  monitorId: string;
  jobName: string;
  outcome: MonitorProbeTerminalOutcome;
  detail: string;
}>;

export interface MonitorProbeTerminalAnnouncementOutbox {
  claim(id: string, now?: number): SchedulerAnnouncementClaim;
  release(id: string, token: string): void;
  markDelivered(id: string, token: string): void;
}

/**
 * What one sweep of the outbox found.
 *
 * `retryAtMs` is the earliest moment a row somebody else is announcing RIGHT
 * NOW stops being theirs. A sweeper that just returns when it meets a live
 * lease is correct only if something looks again: the common recovery is a
 * process that crashed mid-announcement and restarted seconds later, well
 * inside the 60s lease, and without this hint that restart would sweep once,
 * find the row leased by its own dead predecessor, and stay silent for its
 * whole lifetime.
 */
export interface SchedulerOwedAnnouncements {
  readonly entries: SchedulerLogEntry[];
  readonly retryAtMs?: number;
}

export interface SchedulerLedger {
  create(job: StoredSchedulerJob): SchedulerCreateOutcome;
  update(name: string, update: Record<string, unknown>): SchedulerUpdateOutcome;
  remove(name: string): SchedulerRemoveOutcome;
  list(): SchedulerReadOutcome<StoredSchedulerJob[]>;
  listViews(now?: number): SchedulerReadOutcome<SchedulerJob[]>;
  claimDue(now: number): SchedulerReadOutcome<SchedulerDispatchReceipt[]>;
  claimManual(name: string, now: number): SchedulerClaimOutcome;
  claimStarterManualIntent(
    operationId: string,
    job: StoredSchedulerJob,
    now: number,
  ): SchedulerStarterManualClaimOutcome;
  releaseStarterManualIntent(
    operationId: string,
    runId: string,
  ): SchedulerStarterReleaseOutcome;
  recordStarterNotInvoked(
    operationId: string,
    runId: string,
    input: { completedAt: string; error: string },
  ): SchedulerSettlementOutcome;
  logs(name: string, count?: number): SchedulerReadOutcome<SchedulerLogEntry[]>;
  allLogs(): SchedulerReadOutcome<SchedulerLogEntry[]>;
  runningLogs(name?: string): SchedulerReadOutcome<SchedulerLogEntry[]>;
  stats(): SchedulerReadOutcome<SchedulerProviderStats>;
  readOutput(path: string): SchedulerReadOutcome<string>;
  /** Atomically admits one monitor revision under per-monitor and account fences. */
  reserveMonitorTrigger(input: {
    monitorId: string;
    ownerId: string;
    fingerprint: string;
    budget?: MonitorBudget;
    now?: Date;
  }): MonitorReservation;
  /** Associates the exact Task/session/turn that owns an admitted revision. */
  attachMonitorTask(input: {
    triggerId: string;
    task: MonitorTaskTurnReceipt;
  }): { kind: 'applied' } | { kind: 'stale' } | SchedulerUnavailable;
  /** Appends accounting at most once and permanently fences unknown usage. */
  settleMonitorTrigger(
    input: MonitorTerminal & { now?: Date },
  ): MonitorSettlement;
  /** Replays authoritative Task terminal receipts after a live event or boot. */
  reconcileMonitorTerminals(input: {
    terminals: readonly MonitorTerminal[];
    now?: Date;
  }): SchedulerReadOutcome<number>;
  /** Resolves an indeterminate Task only against its exact adopted receipt. */
  resolveIndeterminateMonitor(input: {
    monitorId: string;
    ownerId: string;
    triggerId: string;
    task: MonitorTaskTurnReceipt;
    terminal: 'completed' | 'failed';
    usage: Required<MonitorUsage>;
    jobName?: string;
    monitorState?: Record<string, unknown>;
  }): MonitorSettlement;
  readMonitorAccounting(input: {
    monitorId: string;
    ownerId: string;
  }): SchedulerReadOutcome<MonitorAccounting>;
  /** A changed source target is a new monitor identity, not a retry. */
  resetMonitorAccounting(input: {
    monitorId: string;
    ownerId: string;
  }): { kind: 'applied' } | { kind: 'busy' } | SchedulerUnavailable;
  /** One transaction for monitor identity reset and its scheduler definition. */
  resetMonitorAndUpdateJob(input: {
    name: string;
    monitorId: string;
    ownerId: string;
    update: Record<string, unknown>;
  }): SchedulerUpdateOutcome;
  /** Attached Tasks still needing authoritative terminal reconciliation. */
  activeMonitorTriggers(): SchedulerReadOutcome<
    readonly AttachedMonitorTrigger[]
  >;
  monitorTrigger(
    triggerId: string,
  ): SchedulerReadOutcome<AttachedMonitorTrigger | undefined>;
  /**
   * Failed runs this ledger recorded that nobody has announced yet, oldest
   * first. Rows past `FAILURE_ANNOUNCEMENT_RETENTION_MS` are stamped skipped
   * inside this call and never returned, so a long downtime cannot flood the
   * bell and cannot leave the sweep re-reading the same backlog forever.
   */
  owedFailureAnnouncements(
    now?: number,
  ): SchedulerReadOutcome<SchedulerOwedAnnouncements>;
  /** The durable announcement record for the runs this ledger stores. */
  announcementOutbox(): SchedulerAnnouncementOutbox;
  /** Terminal monitor tasks are owed independently from scheduler run failures. */
  owedMonitorTerminalAnnouncements(): SchedulerReadOutcome<
    readonly { triggerId: string; monitorId: string }[]
  >;
  monitorTerminalAnnouncementOutbox(): MonitorTerminalAnnouncementOutbox;
  /**
   * Atomically makes a probe-only outcome terminal and records its owed bell.
   * A terminal state written before an earlier Task terminal is left alone so
   * probe cadence can never manufacture a second generic notification.
   */
  recordMonitorProbeTerminal(input: {
    name: string;
    monitorId: string;
    outcome: MonitorProbeTerminalOutcome;
    monitorState: ExternalMonitorState;
  }):
    | { kind: 'recorded'; announcement: MonitorProbeTerminalAnnouncement }
    | { kind: 'already-terminal' }
    | { kind: 'not-found' }
    | SchedulerUnavailable;
  owedMonitorProbeTerminalAnnouncements(): SchedulerReadOutcome<
    readonly MonitorProbeTerminalAnnouncement[]
  >;
  monitorProbeTerminalAnnouncementOutbox(): MonitorProbeTerminalAnnouncementOutbox;
  close(): void;
}

interface ProcessOwner {
  id: string;
  pid: number;
  birth?: string;
}

interface ClaimRow {
  job_id: string;
  job_name: string;
  revision: number;
  run_id: string;
  started_at: string;
  started_ms: number;
  job_data: string | null;
  scheduled_for_ms: number | null;
  manual: number;
  missed_count: number;
  attempt: number;
  max_attempts: number;
  invocation_started: number;
  owner_id: string;
  owner_pid: number;
  owner_birth: string | null;
}

interface SchedulerLedgerOptions {
  /** Implementation-private construction seam for real temporary SQLite tests. */
  directory?: string;
  /** Test-only bounded busy timeout; production uses the conservative default. */
  busyTimeoutMs?: number;
  processIdentity?: {
    exact(pid: number): { start: string } | null;
    probe(
      pid: number,
    ):
      | { state: 'dead' }
      | { state: 'unavailable' }
      | { state: 'exact'; identity: { pid: number; start: string } };
  };
  /** Implementation-private fault seam for exact durable-settlement readback. */
  afterSettlementCommit?: () => void;
  /** Implementation-private fault seam for proved-not-invoked readback. */
  afterNotInvokedCommit?: () => void;
  /** Implementation-private fault seam for a transient post-write readback. */
  beforeNotInvokedReadback?: () => void;
  /** Test-only fault after the Starter intent+claim transaction commits. */
  afterStarterIntentCommit?: () => void;
  /** Test-only observation seam for real SQLite unavailable transitions. */
  onNotInvokedUnavailable?: () => void;
  /** Test-only startup integrity classification seam. */
  integrityCheck?: typeof checkSqliteIntegrity;
  /**
   * Called once for each run this ledger writes as failed on behalf of an
   * owner that died mid-run. Reconciliation happens inside a claim read, far
   * from the executing code that normally announces a failure, so the ledger
   * has to say that it wrote one — otherwise the run row appears with nobody
   * told. Best-effort and observer-only: a throwing listener cannot change
   * what was already made durable.
   */
  onAbandonedRun?: (entry: SchedulerLogEntry) => void;
}

/**
 * Compose one ledger per scheduler home.  The returned Interface is the only
 * mutable state surface used by BuiltinScheduler; SQLite connections may vary
 * across Station processes without varying the scheduler protocol.
 */
export function createSchedulerLedger(
  options: SchedulerLedgerOptions = {},
): SchedulerLedger {
  return new SqliteSchedulerLedger(options);
}

class SqliteSchedulerLedger implements SchedulerLedger {
  private readonly directory: string;
  private readonly logsDirectory: string;
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly owner: ProcessOwner;
  private readonly identity: Required<SchedulerLedgerOptions>['processIdentity'];
  private readonly afterSettlementCommit?: () => void;
  private readonly afterNotInvokedCommit?: () => void;
  private readonly beforeNotInvokedReadback?: () => void;
  private readonly afterStarterIntentCommit?: () => void;
  private readonly onNotInvokedUnavailable?: () => void;
  private abandonedRunListener?: (entry: SchedulerLogEntry) => void;
  /**
   * Reconciliation runs inside the claim transaction; a listener must not see
   * a run the transaction is still free to roll back, and must not be able to
   * roll one back by throwing. Entries buffer here and flush after commit.
   */
  private pendingAbandonedRuns: SchedulerLogEntry[] = [];
  /** One outbox per ledger; its state is the table, not this object. */
  private outbox?: SchedulerAnnouncementOutbox;
  private monitorTerminalOutbox?: MonitorTerminalAnnouncementOutbox;
  private monitorProbeTerminalOutbox?: MonitorProbeTerminalAnnouncementOutbox;
  /** Set by the watch on the first SQLITE_CORRUPT/NOTADB this handle sees. */
  private corruptionObserved = false;

  constructor(options: SchedulerLedgerOptions) {
    this.directory = options.directory ?? join(resolveHomeDir(), 'scheduler');
    this.logsDirectory = join(this.directory, 'logs');
    this.identity = options.processIdentity ?? {
      exact: exactProcessIdentity,
      probe: probeExactProcessIdentity,
    };
    this.afterSettlementCommit = options.afterSettlementCommit;
    this.afterNotInvokedCommit = options.afterNotInvokedCommit;
    this.beforeNotInvokedReadback = options.beforeNotInvokedReadback;
    this.afterStarterIntentCommit = options.afterStarterIntentCommit;
    this.onNotInvokedUnavailable = options.onNotInvokedUnavailable;
    this.abandonedRunListener = options.onAbandonedRun;
    const exact = this.identity.exact(process.pid);
    this.owner = {
      id: randomUUID(),
      pid: process.pid,
      ...(exact ? { birth: exact.start } : {}),
    };
    LIVE_OWNER_IDS.add(this.owner.id);
    ensureRealDirectory(this.directory, 'Scheduler ledger directory');
    ensureRealDirectory(this.logsDirectory, 'Scheduler ledger logs directory');
    const databasePath = join(this.directory, 'scheduler.sqlite');
    if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) {
      throw new Error('Scheduler ledger database must not be a symbolic link');
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;
    // Two jobs, deliberately split.
    //
    // RECORDING is the connection's job: corruption can surface from any
    // statement — including the schema upgrade below and the private helpers
    // inside `reconcileDeadClaims`, neither of which has a catch site of its
    // own — so the marker is written once, wherever it first appears. This
    // ledger has far fewer statements than the EventStore's ~180, but "few
    // enough to remember" is exactly the reasoning that leaves the next
    // statement unobserved. Nothing READS that marker yet (archive#3217 is
    // building the first consumer); today it is operator diagnostics plus the
    // in-process latch below, which is the part that changes behaviour.
    //
    // CLASSIFYING is each catch site's job (see `unavailableFrom`): the watch
    // rethrows unchanged, so it cannot tell a caller what happened. That
    // stays with the code that owns the outcome type (archive#3220).
    this.db = watchForSqliteCorruption(
      new DatabaseSync(databasePath, { timeout: busyTimeoutMs }),
      {
        onCorruptionObserved: (error) => {
          this.corruptionObserved = true;
          recordCorruptionObserved(
            corruptionMarkerFromError(databasePath, error),
          );
        },
      },
    );
    try {
      const integrity = (options.integrityCheck ?? checkSqliteIntegrity)(
        this.db,
      );
      if (integrity.kind === 'corrupt') {
        // A `quick_check` that returns a non-`ok` row rather than throwing
        // never reaches the watch, so record the same observation here. It is
        // idempotent, and the throwing path's richer marker already won.
        recordCorruptionObserved({
          databasePath,
          observedAt: new Date().toISOString(),
          detail: 'PRAGMA quick_check reported a damaged scheduler ledger',
        });
        throw new SchedulerStorageCorruptError();
      }
      if (integrity.kind === 'unavailable')
        throw new SchedulerStorageUnavailableError();
      // Node's SQLite constructor timeout does not consistently govern explicit
      // `BEGIN IMMEDIATE` statements across supported builds. Set the SQLite
      // pragma too, so the production bound and real-lock tests mean the same.
      this.db.exec(
        `PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`,
      );
      // archive#3661: a mode CONVERSION on a never-WAL database needs an
      // exclusive lock that `busy_timeout` does not govern, so two instances
      // first-opening a brand-new home raced here and one died on
      // `database is locked` before the ledger existed. The retry is bounded
      // and the pragma is advisory — see `enableWalJournalMode`.
      // archive#3661 review MEDIUM-1: contention must not kill startup (that
      // is the whole defect), but this store fails CLOSED on anything else —
      // an I/O error or a read-only home — exactly as it did before archive#3661,
      // rather than coming up quietly in rollback-journal mode.
      applyWalJournalMode(this.db, {
        store: 'scheduler ledger',
        onUnavailable: 'throw',
      });
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec(SCHEDULER_LEDGER_SCHEMA);
      this.ensureSchedulerLedgerColumns();
      this.transaction(() => this.ensureExternalMonitorColumns());
      this.importLegacyJsonOnce();
    } catch (error) {
      LIVE_OWNER_IDS.delete(this.owner.id);
      try {
        this.db.close();
      } catch {
        // The initialization failure remains authoritative.
      }
      throw error;
    }
  }

  close(): void {
    LIVE_OWNER_IDS.delete(this.owner.id);
    this.db.close();
  }

  /**
   * Refuses to promise durability that this handle has already proved the
   * bytes cannot keep.
   *
   * Classifying an error stays per-error — a SQLITE_BUSY after a corruption
   * observation is still a BUSY, and latching that would be a lie about which
   * failure happened. But whether to keep SERVING NEW WRITES is a different
   * question, and the answer changes the moment SQLite says the file is
   * damaged. Without this, a store this process has already recorded a
   * corruption marker for still answered `created`, and the operator was told
   * a job exists that the next boot's `quick_check` refuses to even open. That
   * is a durability claim nothing computed, made by a process simultaneously
   * holding the observation that falsifies it (archive#3220 review).
   *
   * Scope is exactly the operations that promise something about the FUTURE:
   * creating, editing or removing a job, claiming a new run, and
   * `beginInvocation` — which reads as a state change but is the fence that
   * authorizes an adapter call, so it is the most literal future-promise in
   * this file.
   *
   * `settle` and `recordNotInvoked` deliberately keep trying, because they
   * record something that has ALREADY happened and their post-commit
   * readbacks are the mechanism for not losing it. `releaseDeferred` only
   * REDUCES commitment, so refusing it could strand a claim that giving up
   * would have released.
   *
   * Latching is safe to derive from because it arms only on
   * `explicitCorruption`, which is SQLITE_CORRUPT/SQLITE_NOTADB by result
   * code OR by SQLite's own two fixed phrases for them — never a contention
   * code, and pinned by a real-lock negative control rather than by this
   * sentence. It is also not a trap door: a restart clears the flag and then
   * meets the boot check, which fails closed on the same bytes.
   */
  private refuseIfCorrupt(): SchedulerUnavailable | undefined {
    return this.corruptionObserved
      ? { kind: 'unavailable', reason: 'corrupt' }
      : undefined;
  }

  create(job: StoredSchedulerJob): SchedulerCreateOutcome {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    try {
      return this.transaction(() => {
        const existing = this.rowForJob(job.name);
        if (existing) return { kind: 'exists' };
        this.db
          .prepare(
            `INSERT INTO scheduler_jobs(name, job_id, revision, data, created_at, last_run_ms)
           VALUES (?, ?, 1, ?, ?, ?)`,
          )
          .run(
            job.name,
            randomUUID(),
            JSON.stringify(job),
            job.createdAt,
            job.lastRunMs ?? null,
          );
        return { kind: 'created' };
      });
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  recordStarterNotInvoked(
    operationId: string,
    runId: string,
    input: { completedAt: string; error: string },
  ): SchedulerSettlementOutcome {
    let intended: SchedulerLogEntry | undefined;
    try {
      return this.transaction(() => {
        const intent = this.db
          .prepare(
            'SELECT job_id FROM scheduler_starter_manual_intents WHERE operation_id = ? AND run_id = ?',
          )
          .get(operationId, runId) as { job_id: string } | undefined;
        const claim = this.db
          .prepare('SELECT * FROM scheduler_claims WHERE run_id = ?')
          .get(runId) as ClaimRow | undefined;
        if (
          !intent ||
          !claim ||
          claim.job_id !== intent.job_id ||
          claim.owner_id !== this.owner.id ||
          claim.attempt !== 1 ||
          claim.invocation_started !== 0
        )
          return { kind: 'stale' } as const;
        intended = {
          id: `${claim.run_id}-1`,
          job: claim.job_name,
          jobId: claim.job_id,
          startedAt: claim.started_at,
          firedAt: claim.started_at,
          completedAt: input.completedAt,
          success: false,
          durationSecs: 0,
          manual: true,
          missedCount: 0,
          error: input.error,
          attempt: 1,
          maxAttempts: 1,
          state: 'failed',
        };
        this.insertRunLog(intended, claim.job_id);
        this.db
          .prepare(
            `DELETE FROM scheduler_claims
              WHERE run_id = ? AND owner_id = ? AND attempt = 1
                AND invocation_started = 0`,
          )
          .run(runId, this.owner.id);
        return { kind: 'applied' } as const;
      });
    } catch (error) {
      try {
        const row = this.db
          .prepare('SELECT data FROM scheduler_logs WHERE id = ?')
          .get(`${runId}-1`) as { data: string } | undefined;
        if (row && intended && row.data === JSON.stringify(intended))
          return { kind: 'applied' };
      } catch {
        // Exact readback uncertainty leaves the intent as a no-replay fence.
      }
      return unavailableFrom(error);
    }
  }

  update(
    name: string,
    update: Record<string, unknown>,
  ): SchedulerUpdateOutcome {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    try {
      return this.transaction(() => {
        const current = this.rowForJob(name);
        if (!current) return { kind: 'not-found' };
        // Monitor configuration is an authority boundary. A late task must
        // never settle into accounting a save has just erased or re-identified.
        // Generic enable/disable omits this key and cannot revive terminal state.
        if (
          Object.hasOwn(update, 'monitor') &&
          this.monitorMutationBlocked(current.job_id, 'personal')
        )
          return { kind: 'busy' } as const;
        const job = parseStoredJob(current.data);
        for (const [key, value] of Object.entries(update)) {
          if (key === 'name' || key === 'createdAt') continue;
          (job as unknown as Record<string, unknown>)[key] = value;
        }
        this.db
          .prepare(
            `UPDATE scheduler_jobs
           SET revision = revision + 1, data = ?, last_run_ms = ?
           WHERE name = ?`,
          )
          .run(JSON.stringify(job), job.lastRunMs ?? null, name);
        return { kind: 'updated' };
      });
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  remove(name: string): SchedulerRemoveOutcome {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    try {
      return this.transaction(() => {
        const current = this.rowForJob(name);
        if (!current) return { kind: 'not-found' } as const;
        const job = parseStoredJob(current.data);
        if (
          job.monitor &&
          this.monitorMutationBlocked(current.job_id, 'personal')
        )
          return { kind: 'busy' } as const;
        if (job.monitor) {
          // The trigger row is the terminal-notification outbox too. Delete
          // every monitor-owned record with its job, in this transaction.
          this.db
            .prepare(
              'DELETE FROM external_monitor_outcomes WHERE monitor_id=? AND owner_id=?',
            )
            .run(current.job_id, 'personal');
          this.db
            .prepare(
              'DELETE FROM external_monitor_triggers WHERE monitor_id=? AND owner_id=?',
            )
            .run(current.job_id, 'personal');
          this.db
            .prepare(
              'DELETE FROM external_monitor_probe_announcements WHERE monitor_id=?',
            )
            .run(current.job_id);
          this.db
            .prepare(
              'DELETE FROM external_monitor_state WHERE monitor_id=? AND owner_id=?',
            )
            .run(current.job_id, 'personal');
        }
        const changed = this.db
          .prepare('DELETE FROM scheduler_jobs WHERE name = ?')
          .run(name) as { changes?: number };
        return changed.changes === 1
          ? { kind: 'removed' }
          : { kind: 'not-found' };
      });
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  list(): SchedulerReadOutcome<StoredSchedulerJob[]> {
    return this.read(() => this.listUnsafe());
  }

  private listUnsafe(): StoredSchedulerJob[] {
    return this.db
      .prepare('SELECT data FROM scheduler_jobs ORDER BY created_at ASC')
      .all()
      .map((row) => freezeJob(parseStoredJob((row as { data: string }).data)));
  }

  listViews(now = Date.now()): SchedulerReadOutcome<SchedulerJob[]> {
    return this.read(() =>
      (
        this.db
          .prepare(
            'SELECT job_id, data FROM scheduler_jobs ORDER BY created_at ASC',
          )
          .all() as Array<{ job_id: string; data: string }>
      ).map((row) => {
        const job = freezeJob(parseStoredJob(row.data));
        const last = this.logsUnsafe(job.name, 1).at(-1);
        const scheduled = job.enabled ? toScheduledJob(job) : null;
        const next = scheduled ? nextOccurrence(scheduled.schedule, now) : null;
        return {
          ...job,
          provider: 'built-in',
          unattendedPrincipal: {
            kind: 'scheduled-job' as const,
            jobId: row.job_id,
          },
          lastRun: last?.startedAt,
          nextRun: next === null ? undefined : new Date(next).toISOString(),
        };
      }),
    );
  }

  claimDue(now: number): SchedulerReadOutcome<SchedulerDispatchReceipt[]> {
    // A claim authorizes a real agent invocation whose receipt this store
    // then has to settle. Handing one out over damaged bytes buys an
    // unattended run nothing can record the outcome of.
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    const outcome = this.read(() =>
      this.transaction(() => {
        // Recovery changes ownership only when this caller will receive and
        // execute the capability.  In particular, a timer must never make a
        // dead manual retry look live merely by reassigning its owner.
        const receipts = this.reconcileDeadClaims(
          now,
          (claim) => !claim.manual,
        );
        for (const row of this.db
          .prepare(
            'SELECT name, job_id, revision, data FROM scheduler_jobs ORDER BY created_at ASC',
          )
          .all() as Array<{
          name: string;
          job_id: string;
          revision: number;
          data: string;
        }>) {
          const job = parseStoredJob(row.data);
          const scheduled = job.enabled ? toScheduledJob(job) : null;
          if (!scheduled || !isOverdue(scheduled, now)) continue;
          if (this.claimRow(row.job_id)) continue;
          const scheduledForMs = this.nextDueOccurrence(scheduled, now);
          if (scheduledForMs === undefined) continue;
          receipts.push(
            this.insertClaim(job, row.revision, now, false, scheduledForMs),
          );
        }
        return receipts;
      }),
    );
    this.flushAbandonedRuns(outcome.kind === 'available');
    return outcome;
  }

  claimManual(name: string, now: number): SchedulerClaimOutcome {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    try {
      const outcome = this.transaction<SchedulerClaimOutcome>(() => {
        const row = this.rowForJob(name);
        if (!row) return { kind: 'not-found' };
        // A manual request can recover exactly its own advanced manual retry;
        // it leaves every other dead claim untouched for its executor.
        const reclaimed = this.reconcileDeadClaims(
          now,
          (claim) => Boolean(claim.manual) && claim.job_id === row.job_id,
        );
        const recovered = reclaimed.find(
          (receipt) => receipt.jobId === row.job_id && receipt.manual,
        );
        if (recovered) return { kind: 'claimed', receipt: recovered };
        if (this.claimRow(row.job_id)) return { kind: 'busy' };
        return {
          kind: 'claimed',
          receipt: this.insertClaim(
            parseStoredJob(row.data),
            row.revision,
            now,
            true,
          ),
        };
      });
      this.flushAbandonedRuns(true);
      return outcome;
    } catch (error) {
      this.flushAbandonedRuns(false);
      return unavailableFrom(error);
    }
  }

  claimStarterManualIntent(
    operationId: string,
    job: StoredSchedulerJob,
    now: number,
  ): SchedulerStarterManualClaimOutcome {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    if (
      !boundedIdentity(operationId) ||
      operationId.length > 160 ||
      !validStarterManualJob(job) ||
      !Number.isFinite(now)
    )
      return { kind: 'invalid' };
    try {
      return this.transaction<SchedulerStarterManualClaimOutcome>(() => {
        const prior = this.db
          .prepare(
            `SELECT operation_id, job_id, run_id, created_at
               FROM scheduler_starter_manual_intents
              WHERE operation_id = ?`,
          )
          .get(operationId) as
          | {
              operation_id: string;
              job_id: string;
              run_id: string;
              created_at: string;
            }
          | undefined;
        if (prior) {
          const active = this.db
            .prepare('SELECT * FROM scheduler_claims WHERE run_id = ?')
            .get(prior.run_id) as ClaimRow | undefined;
          if (active && !this.claimIsLive(active)) {
            if (!active.invocation_started && active.attempt === 1) {
              const changed = this.db
                .prepare(
                  `UPDATE scheduler_claims
                      SET owner_id = ?, owner_pid = ?, owner_birth = ?
                    WHERE run_id = ? AND owner_id = ? AND attempt = 1
                      AND invocation_started = 0`,
                )
                .run(
                  this.owner.id,
                  this.owner.pid,
                  this.owner.birth ?? null,
                  active.run_id,
                  active.owner_id,
                ) as { changes?: number };
              if (changed.changes === 1) {
                const reclaimed = this.db
                  .prepare('SELECT * FROM scheduler_claims WHERE run_id = ?')
                  .get(active.run_id) as ClaimRow | undefined;
                if (reclaimed?.job_data)
                  return {
                    kind: 'claimed',
                    replayed: true,
                    receipt: this.receiptFor(
                      reclaimed,
                      parseStoredJob(reclaimed.job_data),
                    ),
                  };
              }
            } else {
              this.reconcileDeadClaims(now, () => false);
            }
          }
          const run = this.starterIntentRun(prior.run_id);
          if (!run)
            return { kind: 'unavailable', reason: 'transient' } as const;
          if (run.job !== job.name || run.jobId !== prior.job_id)
            return { kind: 'conflict' } as const;
          return { kind: 'replayed', run } as const;
        }
        const count = (
          this.db
            .prepare(
              'SELECT COUNT(*) AS count FROM scheduler_starter_manual_intents',
            )
            .get() as { count: number }
        ).count;
        if (count >= SCHEDULER_STARTER_MANUAL_INTENT_CAPACITY)
          return { kind: 'capacity' };
        let row = this.rowForJob(job.name);
        if (row) {
          const owned = this.db
            .prepare(
              'SELECT 1 AS owned FROM scheduler_starter_manual_intents WHERE job_id = ? LIMIT 1',
            )
            .get(row.job_id);
          if (
            !owned ||
            !starterJobDefinitionMatches(parseStoredJob(row.data), job)
          )
            return { kind: 'conflict' };
        } else {
          this.db
            .prepare(
              `INSERT INTO scheduler_jobs(name, job_id, revision, data, created_at, last_run_ms)
               VALUES (?, ?, 1, ?, ?, NULL)`,
            )
            .run(job.name, randomUUID(), JSON.stringify(job), job.createdAt);
          row = this.rowForJob(job.name);
          if (!row)
            return { kind: 'unavailable', reason: 'transient' } as const;
        }
        if (this.claimRow(row.job_id)) return { kind: 'busy' };
        const receipt = this.insertClaim(
          parseStoredJob(row.data),
          row.revision,
          now,
          true,
        );
        this.db
          .prepare(
            `INSERT INTO scheduler_starter_manual_intents(
               operation_id, job_id, run_id, created_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            operationId,
            row.job_id,
            receipt.id,
            new Date(now).toISOString(),
          );
        return { kind: 'claimed', receipt, replayed: false };
      }, this.afterStarterIntentCommit);
    } catch (error) {
      try {
        const prior = this.db
          .prepare(
            'SELECT job_id, run_id FROM scheduler_starter_manual_intents WHERE operation_id = ?',
          )
          .get(operationId) as { job_id: string; run_id: string } | undefined;
        if (prior) {
          const claim = this.db
            .prepare('SELECT * FROM scheduler_claims WHERE run_id = ?')
            .get(prior.run_id) as ClaimRow | undefined;
          if (
            claim?.job_data &&
            claim.job_id === prior.job_id &&
            claim.owner_id === this.owner.id &&
            claim.invocation_started === 0 &&
            starterJobDefinitionMatches(parseStoredJob(claim.job_data), job)
          )
            return {
              kind: 'claimed',
              replayed: true,
              receipt: this.receiptFor(claim, parseStoredJob(claim.job_data)),
            };
          const run = this.starterIntentRun(prior.run_id);
          if (run && run.job === job.name && run.jobId === prior.job_id)
            return { kind: 'replayed', run };
        }
      } catch {
        // Exact readback uncertainty retains the durable intent as a fence.
      }
      return unavailableFrom(error);
    }
  }

  releaseStarterManualIntent(
    operationId: string,
    runId: string,
  ): SchedulerStarterReleaseOutcome {
    try {
      return this.transaction(() => {
        const intent = this.db
          .prepare(
            `SELECT job_id, run_id
               FROM scheduler_starter_manual_intents
              WHERE operation_id = ? AND run_id = ?`,
          )
          .get(operationId, runId) as
          | { job_id: string; run_id: string }
          | undefined;
        if (!intent) return { kind: 'stale' } as const;
        const claim = this.db
          .prepare('SELECT * FROM scheduler_claims WHERE run_id = ?')
          .get(runId) as ClaimRow | undefined;
        if (
          !claim ||
          claim.job_id !== intent.job_id ||
          claim.owner_id !== this.owner.id ||
          claim.attempt !== 1 ||
          claim.invocation_started !== 0
        )
          return { kind: 'stale' } as const;
        this.db
          .prepare(
            `DELETE FROM scheduler_claims
              WHERE run_id = ? AND owner_id = ? AND attempt = 1
                AND invocation_started = 0`,
          )
          .run(runId, this.owner.id);
        this.db
          .prepare(
            `DELETE FROM scheduler_starter_manual_intents
              WHERE operation_id = ? AND run_id = ?`,
          )
          .run(operationId, runId);
        const remaining = this.db
          .prepare(
            'SELECT 1 AS retained FROM scheduler_starter_manual_intents WHERE job_id = ? LIMIT 1',
          )
          .get(intent.job_id);
        if (!remaining) {
          this.db
            .prepare(
              `DELETE FROM scheduler_jobs
                WHERE job_id = ? AND revision = 1 AND data = ?`,
            )
            .run(intent.job_id, claim.job_data);
        }
        return { kind: 'applied' } as const;
      });
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  logs(
    name: string,
    count?: number,
  ): SchedulerReadOutcome<SchedulerLogEntry[]> {
    return this.read(() => this.logsUnsafe(name, count));
  }

  allLogs(): SchedulerReadOutcome<SchedulerLogEntry[]> {
    return this.read(() =>
      (
        this.db
          .prepare(
            'SELECT job_id, data FROM scheduler_logs ORDER BY sequence ASC',
          )
          .all() as Array<{ job_id: string | null; data: string }>
      ).map((row) => this.logFromRow(row)),
    );
  }

  private logsUnsafe(name: string, count?: number): SchedulerLogEntry[] {
    const job = this.rowForJob(name);
    if (!job) return [];
    const limit = typeof count === 'number' ? Math.max(0, count) : undefined;
    const rows = this.db
      .prepare(
        `SELECT job_id, data FROM (
           SELECT job_id, data, sequence FROM scheduler_logs WHERE job_id = ?
           ORDER BY sequence DESC${limit === undefined ? '' : ' LIMIT ?'}
         ) ORDER BY sequence ASC`,
      )
      .all(...(limit === undefined ? [job.job_id] : [job.job_id, limit]));
    return rows.map((row) =>
      this.logFromRow(row as { job_id?: string | null; data: string }),
    );
  }

  /** The table's opaque identity backfills legacy JSON receipts on read. */
  private logFromRow(row: {
    job_id?: string | null;
    data: string;
  }): SchedulerLogEntry {
    const entry = JSON.parse(row.data) as SchedulerLogEntry;
    return Object.freeze(
      entry.jobId || !row.job_id ? entry : { ...entry, jobId: row.job_id },
    );
  }

  runningLogs(name?: string): SchedulerReadOutcome<SchedulerLogEntry[]> {
    return this.read(() => this.runningLogsUnsafe(name));
  }

  private runningLogsUnsafe(name?: string): SchedulerLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduler_claims${name === undefined ? '' : ' WHERE job_name = ?'}
         ORDER BY started_ms ASC`,
      )
      .all(...(name === undefined ? [] : [name])) as ClaimRow[];
    return rows.map((claim) =>
      Object.freeze({
        id: `${claim.run_id}-${claim.attempt}`,
        job: claim.job_name,
        jobId: claim.job_id,
        startedAt: claim.started_at,
        ...(claim.scheduled_for_ms === null
          ? {}
          : { scheduledFor: new Date(claim.scheduled_for_ms).toISOString() }),
        firedAt: claim.started_at,
        success: false,
        manual: Boolean(claim.manual),
        missedCount: claim.missed_count,
        attempt: claim.attempt,
        maxAttempts: claim.max_attempts,
        state: 'running' as const,
      }),
    );
  }

  private starterIntentRun(runId: string): SchedulerLogEntry | undefined {
    const active = this.db
      .prepare('SELECT * FROM scheduler_claims WHERE run_id = ?')
      .get(runId) as ClaimRow | undefined;
    if (active)
      return Object.freeze({
        id: `${active.run_id}-${active.attempt}`,
        job: active.job_name,
        jobId: active.job_id,
        startedAt: active.started_at,
        ...(active.scheduled_for_ms === null
          ? {}
          : { scheduledFor: new Date(active.scheduled_for_ms).toISOString() }),
        firedAt: active.started_at,
        success: false,
        manual: Boolean(active.manual),
        missedCount: active.missed_count,
        attempt: active.attempt,
        maxAttempts: active.max_attempts,
        state: 'running' as const,
      });
    const terminal = this.db
      .prepare(
        `SELECT job_id, data
           FROM scheduler_logs
          WHERE id GLOB ?
          ORDER BY sequence DESC
          LIMIT 1`,
      )
      .get(`${runId}-*`) as { job_id: string | null; data: string } | undefined;
    return terminal ? this.logFromRow(terminal) : undefined;
  }

  stats(): SchedulerReadOutcome<SchedulerProviderStats> {
    return this.read(() => ({
      jobs: this.listUnsafe().map((job) => {
        const logs = this.logsUnsafe(job.name);
        const successes = logs.filter((entry) => entry.success).length;
        return {
          name: job.name,
          total: logs.length,
          successes,
          failures: logs.length - successes,
          success_rate: logs.length
            ? Math.round((successes / logs.length) * 100)
            : 0,
        };
      }),
    }));
  }

  readOutput(path: string): SchedulerReadOutcome<string> {
    return this.read(() => this.readOutputUnsafe(path));
  }

  reserveMonitorTrigger(input: {
    monitorId: string;
    ownerId: string;
    fingerprint: string;
    budget?: MonitorBudget;
    now?: Date;
  }): MonitorReservation {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    const now = input.now ?? new Date();
    try {
      return this.transaction(() => {
        this.expireMonitorTriggers(now);
        const state = this.db
          .prepare(
            'SELECT usage_known FROM external_monitor_state WHERE monitor_id=? AND owner_id=?',
          )
          .get(input.monitorId, input.ownerId) as
          | { usage_known: number }
          | undefined;
        if (state && state.usage_known !== 1)
          return { kind: 'blocked', reason: 'unknown-usage' } as const;
        const existing = this.db
          .prepare(
            'SELECT trigger_id, phase, state, task_id, session_id, turn_id FROM external_monitor_triggers WHERE monitor_id=? AND owner_id=? AND fingerprint=?',
          )
          .get(input.monitorId, input.ownerId, input.fingerprint) as
          | {
              trigger_id: string;
              phase: MonitorTriggerPhase;
              state: string;
              task_id?: string;
              session_id?: string | null;
              turn_id?: string | null;
            }
          | undefined;
        if (existing?.state !== 'running' && existing)
          return { kind: 'terminal', triggerId: existing.trigger_id } as const;
        if (existing)
          return {
            kind: 'adopt',
            triggerId: existing.trigger_id,
            phase: existing.phase as 'reserved' | 'task-attached',
            ...(existing.task_id
              ? {
                  task: {
                    taskId: existing.task_id,
                    ...(existing.session_id
                      ? { sessionId: existing.session_id }
                      : {}),
                    ...(existing.turn_id ? { turnId: existing.turn_id } : {}),
                  },
                }
              : {}),
          } as const;
        const budget = normalizeMonitorBudget(input.budget);
        const active = Number(
          (
            this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM external_monitor_triggers WHERE owner_id=? AND state='running' AND deadline_at > ?",
              )
              .get(input.ownerId, now.toISOString()) as { count: number }
          ).count,
        );
        const monitorActive = Number(
          (
            this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM external_monitor_triggers WHERE monitor_id=? AND owner_id=? AND state='running' AND deadline_at > ?",
              )
              .get(input.monitorId, input.ownerId, now.toISOString()) as {
              count: number;
            }
          ).count,
        );
        if (
          active >= budget.maxConcurrency ||
          monitorActive >= budget.maxActive
        )
          return { kind: 'blocked', reason: 'active' } as const;
        const totals = this.db
          .prepare(
            'SELECT COALESCE(SUM(turns),0) AS turns, COALESCE(SUM(tokens),0) AS tokens, COALESCE(SUM(runtime_ms),0) AS runtime FROM external_monitor_outcomes WHERE owner_id=? AND day=?',
          )
          .get(input.ownerId, monitorDay(now)) as {
          turns: number;
          tokens: number;
          runtime: number;
        };
        // Reserve the remaining envelope in the same transaction that admits
        // the trigger.  A second concurrent monitor cannot observe the same
        // remaining tokens/turns and both spend them after their Tasks start.
        const reserved = this.db
          .prepare(
            "SELECT COALESCE(SUM(reserved_turns),0) AS turns, COALESCE(SUM(reserved_tokens),0) AS tokens, COALESCE(SUM(reserved_runtime_ms),0) AS runtime FROM external_monitor_triggers WHERE owner_id=? AND state='running' AND deadline_at > ?",
          )
          .get(input.ownerId, now.toISOString()) as {
          turns: number;
          tokens: number;
          runtime: number;
        };
        const limits = {
          maxTurns:
            budget.maxTurns - Number(totals.turns) - Number(reserved.turns),
          maxTokens:
            budget.maxTokens - Number(totals.tokens) - Number(reserved.tokens),
          maxRuntimeMs:
            budget.maxRuntimeMs -
            Number(totals.runtime) -
            Number(reserved.runtime),
          maxWallRuntimeMs: budget.maxWallRuntimeMs,
        };
        if (
          limits.maxTurns < 1 ||
          limits.maxTokens < 1 ||
          limits.maxRuntimeMs < 1
        )
          return { kind: 'blocked', reason: 'budget' } as const;
        const triggerId = randomUUID();
        const deadline = new Date(
          now.getTime() + budget.maxWallRuntimeMs,
        ).toISOString();
        this.db
          .prepare(
            'INSERT INTO external_monitor_state(monitor_id,owner_id,usage_known,updated_at) VALUES(?,?,1,?) ON CONFLICT(monitor_id,owner_id) DO UPDATE SET updated_at=excluded.updated_at',
          )
          .run(input.monitorId, input.ownerId, now.toISOString());
        this.db
          .prepare(
            "INSERT INTO external_monitor_triggers(trigger_id,monitor_id,owner_id,fingerprint,phase,state,created_at,deadline_at,reserved_turns,reserved_tokens,reserved_runtime_ms) VALUES(?,?,?,?, 'reserved', 'running', ?,?,?,?,?)",
          )
          .run(
            triggerId,
            input.monitorId,
            input.ownerId,
            input.fingerprint,
            now.toISOString(),
            deadline,
            limits.maxTurns,
            limits.maxTokens,
            limits.maxRuntimeMs,
          );
        this.pruneMonitorAccounting(now);
        return {
          kind: 'dispatch',
          triggerId,
          phase: 'reserved',
          deadlineAt: deadline,
          limits,
        } as const;
      });
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  attachMonitorTask(input: {
    triggerId: string;
    task: MonitorTaskTurnReceipt;
  }): { kind: 'applied' } | { kind: 'stale' } | SchedulerUnavailable {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    try {
      return this.transaction(() => {
        const changed = this.db
          .prepare(
            "UPDATE external_monitor_triggers SET task_id=?, session_id=?, turn_id=?, phase='task-attached' WHERE trigger_id=? AND state='running' AND phase='reserved'",
          )
          .run(
            input.task.taskId,
            input.task.sessionId ?? null,
            input.task.turnId ?? null,
            input.triggerId,
          ) as { changes?: number };
        if (changed.changes === 1) return { kind: 'applied' } as const;
        const current = this.db
          .prepare(
            'SELECT task_id, session_id, turn_id, state FROM external_monitor_triggers WHERE trigger_id=?',
          )
          .get(input.triggerId) as
          | {
              task_id?: string;
              session_id?: string | null;
              turn_id?: string | null;
              state?: string;
            }
          | undefined;
        // The Task/session association is durable before an external engine
        // necessarily publishes its first turn.  Fill that one blank slot
        // when the authoritative `turn.started` arrives; never replace an
        // already observed turn id.
        if (
          current?.state === 'running' &&
          current.task_id === input.task.taskId &&
          (current.session_id ?? undefined) === input.task.sessionId &&
          current.turn_id === null &&
          input.task.turnId
        ) {
          const filled = this.db
            .prepare(
              "UPDATE external_monitor_triggers SET turn_id=? WHERE trigger_id=? AND state='running' AND phase='task-attached' AND task_id=? AND session_id IS ? AND turn_id IS NULL",
            )
            .run(
              input.task.turnId,
              input.triggerId,
              input.task.taskId,
              input.task.sessionId ?? null,
            ) as { changes?: number };
          if (filled.changes === 1) return { kind: 'applied' } as const;
        }
        // A post-commit retry is safe only for the exact receipt. A different
        // Task/session/turn is a stale writer, never an overwrite.
        if (
          current?.state === 'running' &&
          current.task_id === input.task.taskId &&
          (current.session_id ?? undefined) === input.task.sessionId &&
          ((current.turn_id ?? undefined) === input.task.turnId ||
            (input.task.turnId === undefined && current.turn_id !== null))
        )
          return { kind: 'applied' } as const;
        return { kind: 'stale' } as const;
      });
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  settleMonitorTrigger(
    input: MonitorTerminal & { now?: Date },
  ): MonitorSettlement {
    const now = input.now ?? new Date();
    try {
      return this.transaction(() =>
        this.settleMonitorTriggerUnsafe(input, now),
      );
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  reconcileMonitorTerminals(input: {
    terminals: readonly MonitorTerminal[];
    now?: Date;
  }): SchedulerReadOutcome<number> {
    return this.read(() =>
      this.transaction(() => {
        let reconciled = 0;
        const now = input.now ?? new Date();
        for (const terminal of input.terminals) {
          const result = this.settleMonitorTriggerUnsafe(terminal, now);
          if (result.kind !== 'stale') reconciled += 1;
        }
        return reconciled;
      }),
    );
  }

  resolveIndeterminateMonitor(input: {
    monitorId: string;
    ownerId: string;
    triggerId: string;
    task: MonitorTaskTurnReceipt;
    terminal: 'completed' | 'failed';
    usage: Required<MonitorUsage>;
    jobName?: string;
    monitorState?: Record<string, unknown>;
  }): MonitorSettlement {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    try {
      return this.transaction(() => {
        const row = this.db
          .prepare(
            `SELECT task_id, session_id, turn_id, state FROM external_monitor_triggers
              WHERE trigger_id=? AND monitor_id=? AND owner_id=?`,
          )
          .get(input.triggerId, input.monitorId, input.ownerId) as
          | {
              task_id: string | null;
              session_id: string | null;
              turn_id: string | null;
              state: string;
            }
          | undefined;
        if (
          !row ||
          !['indeterminate', 'completed', 'failed'].includes(row.state) ||
          row.task_id !== input.task.taskId ||
          (row.session_id ?? undefined) !== input.task.sessionId ||
          (row.turn_id ?? undefined) !== input.task.turnId
        )
          return { kind: 'stale' } as const;
        this.db
          .prepare(
            "UPDATE external_monitor_triggers SET state=?, phase='terminal', settled_at=? WHERE trigger_id=? AND state IN ('indeterminate','completed','failed')",
          )
          .run(input.terminal, new Date().toISOString(), input.triggerId);
        this.db
          .prepare(
            'UPDATE external_monitor_outcomes SET turns=?, tokens=?, runtime_ms=?, usage_known=1 WHERE trigger_id=?',
          )
          .run(
            input.usage.turns,
            input.usage.tokens,
            input.usage.runtimeMs,
            input.triggerId,
          );
        const unknown = this.db
          .prepare(
            'SELECT 1 FROM external_monitor_outcomes WHERE monitor_id=? AND owner_id=? AND usage_known=0 LIMIT 1',
          )
          .get(input.monitorId, input.ownerId);
        this.db
          .prepare(
            'UPDATE external_monitor_state SET usage_known=?, updated_at=? WHERE monitor_id=? AND owner_id=?',
          )
          .run(
            unknown ? 0 : 1,
            new Date().toISOString(),
            input.monitorId,
            input.ownerId,
          );
        if (input.jobName && input.monitorState) {
          const jobRow = this.rowForJob(input.jobName);
          if (!jobRow) return { kind: 'stale' } as const;
          const job = parseStoredJob(jobRow.data);
          job.monitorState =
            input.monitorState as StoredSchedulerJob['monitorState'];
          this.db
            .prepare(
              'UPDATE scheduler_jobs SET revision=revision+1, data=?, last_run_ms=? WHERE name=?',
            )
            .run(JSON.stringify(job), job.lastRunMs ?? null, input.jobName);
        }
        return { kind: 'applied' } as const;
      });
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  readMonitorAccounting(input: {
    monitorId: string;
    ownerId: string;
  }): SchedulerReadOutcome<MonitorAccounting> {
    return this.read(() => {
      const current = this.db
        .prepare(
          'SELECT trigger_id, task_id, session_id, turn_id, fingerprint, phase FROM external_monitor_triggers WHERE monitor_id=? AND owner_id=? ORDER BY created_at DESC LIMIT 1',
        )
        .get(input.monitorId, input.ownerId) as
        | {
            task_id?: string;
            trigger_id?: string;
            session_id?: string | null;
            turn_id?: string | null;
            fingerprint?: string;
            phase?: MonitorTriggerPhase;
          }
        | undefined;
      const totals = this.db
        .prepare(
          'SELECT COALESCE(SUM(turns),0) AS turns, COALESCE(SUM(tokens),0) AS tokens, COALESCE(SUM(runtime_ms),0) AS runtime FROM external_monitor_outcomes WHERE monitor_id=? AND owner_id=?',
        )
        .get(input.monitorId, input.ownerId) as {
        turns: number;
        tokens: number;
        runtime: number;
      };
      const state = this.db
        .prepare(
          'SELECT usage_known FROM external_monitor_state WHERE monitor_id=? AND owner_id=?',
        )
        .get(input.monitorId, input.ownerId) as
        | { usage_known?: number }
        | undefined;
      return {
        ...(current?.trigger_id ? { triggerId: current.trigger_id } : {}),
        ...(current?.task_id
          ? {
              task: {
                taskId: current.task_id,
                ...(current.session_id
                  ? { sessionId: current.session_id }
                  : {}),
                ...(current.turn_id ? { turnId: current.turn_id } : {}),
              },
            }
          : {}),
        ...(current?.fingerprint ? { fingerprint: current.fingerprint } : {}),
        ...(current?.phase ? { phase: current.phase } : {}),
        completedTurns: Number(totals.turns ?? 0),
        consumedTokens: Number(totals.tokens ?? 0),
        consumedRuntimeMs: Number(totals.runtime ?? 0),
        usageKnown: state?.usage_known !== 0,
      };
    });
  }

  resetMonitorAccounting(input: {
    monitorId: string;
    ownerId: string;
  }): { kind: 'applied' } | { kind: 'busy' } | SchedulerUnavailable {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    try {
      return this.transaction(() => {
        if (this.monitorMutationBlocked(input.monitorId, input.ownerId))
          return { kind: 'busy' } as const;
        this.db
          .prepare(
            'DELETE FROM external_monitor_outcomes WHERE monitor_id=? AND owner_id=?',
          )
          .run(input.monitorId, input.ownerId);
        this.db
          .prepare(
            'DELETE FROM external_monitor_triggers WHERE monitor_id=? AND owner_id=?',
          )
          .run(input.monitorId, input.ownerId);
        this.db
          .prepare(
            'DELETE FROM external_monitor_probe_announcements WHERE monitor_id=?',
          )
          .run(input.monitorId);
        this.db
          .prepare(
            'DELETE FROM external_monitor_state WHERE monitor_id=? AND owner_id=?',
          )
          .run(input.monitorId, input.ownerId);
        return { kind: 'applied' } as const;
      });
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  resetMonitorAndUpdateJob(input: {
    name: string;
    monitorId: string;
    ownerId: string;
    update: Record<string, unknown>;
  }): SchedulerUpdateOutcome {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    try {
      return this.transaction(() => {
        const current = this.rowForJob(input.name);
        if (!current) return { kind: 'not-found' } as const;
        if (this.monitorMutationBlocked(input.monitorId, input.ownerId))
          return { kind: 'busy' } as const;
        this.db
          .prepare(
            'DELETE FROM external_monitor_outcomes WHERE monitor_id=? AND owner_id=?',
          )
          .run(input.monitorId, input.ownerId);
        this.db
          .prepare(
            'DELETE FROM external_monitor_triggers WHERE monitor_id=? AND owner_id=?',
          )
          .run(input.monitorId, input.ownerId);
        this.db
          .prepare(
            'DELETE FROM external_monitor_probe_announcements WHERE monitor_id=?',
          )
          .run(input.monitorId);
        this.db
          .prepare(
            'DELETE FROM external_monitor_state WHERE monitor_id=? AND owner_id=?',
          )
          .run(input.monitorId, input.ownerId);
        const job = parseStoredJob(current.data);
        for (const [key, value] of Object.entries(input.update)) {
          if (key !== 'name' && key !== 'createdAt')
            (job as unknown as Record<string, unknown>)[key] = value;
        }
        this.db
          .prepare(
            'UPDATE scheduler_jobs SET revision=revision+1, data=?, last_run_ms=? WHERE name=?',
          )
          .run(JSON.stringify(job), job.lastRunMs ?? null, input.name);
        return { kind: 'updated' } as const;
      });
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  activeMonitorTriggers(): SchedulerReadOutcome<
    readonly AttachedMonitorTrigger[]
  > {
    return this.read(() =>
      (
        this.db
          .prepare(
            "SELECT trigger_id, monitor_id, task_id, session_id, turn_id, created_at, deadline_at, reserved_turns, reserved_tokens FROM external_monitor_triggers WHERE state='running' AND phase='task-attached' ORDER BY created_at ASC",
          )
          .all() as Array<{
          trigger_id: string;
          monitor_id: string;
          task_id: string;
          session_id: string | null;
          turn_id: string | null;
          created_at: string;
          deadline_at: string;
          reserved_turns: number;
          reserved_tokens: number;
        }>
      ).map((row) =>
        Object.freeze({
          triggerId: row.trigger_id,
          monitorId: row.monitor_id,
          task: {
            taskId: row.task_id,
            ...(row.session_id ? { sessionId: row.session_id } : {}),
            ...(row.turn_id ? { turnId: row.turn_id } : {}),
          },
          startedAt: row.created_at,
          deadlineAt: row.deadline_at,
          limits: {
            maxTurns: row.reserved_turns,
            maxTokens: row.reserved_tokens,
          },
        }),
      ),
    );
  }

  monitorTrigger(
    triggerId: string,
  ): SchedulerReadOutcome<AttachedMonitorTrigger | undefined> {
    return this.read(() => {
      const row = this.db
        .prepare(
          `SELECT trigger_id, monitor_id, task_id, session_id, turn_id, created_at, deadline_at,
                  reserved_turns, reserved_tokens
             FROM external_monitor_triggers
            WHERE trigger_id=? AND phase='task-attached'`,
        )
        .get(triggerId) as
        | {
            trigger_id: string;
            monitor_id: string;
            task_id: string;
            session_id: string | null;
            turn_id: string | null;
            created_at: string;
            deadline_at: string;
            reserved_turns: number;
            reserved_tokens: number;
          }
        | undefined;
      return row
        ? Object.freeze({
            triggerId: row.trigger_id,
            monitorId: row.monitor_id,
            task: {
              taskId: row.task_id,
              ...(row.session_id ? { sessionId: row.session_id } : {}),
              ...(row.turn_id ? { turnId: row.turn_id } : {}),
            },
            startedAt: row.created_at,
            deadlineAt: row.deadline_at,
            limits: {
              maxTurns: row.reserved_turns,
              maxTokens: row.reserved_tokens,
            },
          })
        : undefined;
    });
  }

  /**
   * A monitor can be reset or removed only once every authority it created is
   * terminal. `indeterminate` is intentionally not terminal for mutation:
   * it represents unknown consumption and must remain inspectable instead of
   * being deleted into a fresh budget. A scheduler claim closes the same race
   * while the probe is still deciding whether it will reserve a Task.
   */
  private monitorMutationBlocked(monitorId: string, ownerId: string): boolean {
    const trigger = this.db
      .prepare(
        `SELECT 1 FROM external_monitor_triggers
          WHERE monitor_id=? AND owner_id=?
            AND state IN ('running', 'indeterminate') LIMIT 1`,
      )
      .get(monitorId, ownerId);
    if (trigger) return true;
    const unknownUsage = this.db
      .prepare(
        'SELECT 1 FROM external_monitor_state WHERE monitor_id=? AND owner_id=? AND usage_known=0 LIMIT 1',
      )
      .get(monitorId, ownerId);
    if (unknownUsage) return true;
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM scheduler_claims WHERE job_id=? LIMIT 1')
        .get(monitorId),
    );
  }

  private settleMonitorTriggerUnsafe(
    input: MonitorTerminal,
    now: Date,
  ): Exclude<MonitorSettlement, SchedulerUnavailable> {
    const trigger = this.db
      .prepare(
        'SELECT monitor_id, owner_id, state FROM external_monitor_triggers WHERE trigger_id=?',
      )
      .get(input.triggerId) as
      | { monitor_id: string; owner_id: string; state: string }
      | undefined;
    if (trigger?.state !== 'running') return { kind: 'stale' };
    const known =
      input.usage?.turns !== undefined &&
      input.usage?.tokens !== undefined &&
      input.usage?.runtimeMs !== undefined;
    this.db
      .prepare(
        "UPDATE external_monitor_triggers SET state=?, phase='terminal', settled_at=? WHERE trigger_id=? AND state='running'",
      )
      .run(input.terminal, now.toISOString(), input.triggerId);
    // `trigger_id` is the primary key. A retry after the commit therefore
    // cannot double-spend tokens or manufacture another completed turn.
    this.db
      .prepare(
        'INSERT INTO external_monitor_outcomes(trigger_id,monitor_id,owner_id,day,turns,tokens,runtime_ms,usage_known,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        input.triggerId,
        trigger.monitor_id,
        trigger.owner_id,
        monitorDay(now),
        input.usage?.turns ?? null,
        input.usage?.tokens ?? null,
        input.usage?.runtimeMs ?? null,
        known ? 1 : 0,
        now.toISOString(),
      );
    if (!known)
      this.db
        .prepare(
          'UPDATE external_monitor_state SET usage_known=0, updated_at=? WHERE monitor_id=? AND owner_id=?',
        )
        .run(now.toISOString(), trigger.monitor_id, trigger.owner_id);
    return known ? { kind: 'applied' } : { kind: 'unknown-usage' };
  }

  /** A stopped process cannot leave a model-capacity reservation forever. */
  private expireMonitorTriggers(now: Date): void {
    const rows = this.db
      .prepare(
        "SELECT trigger_id FROM external_monitor_triggers WHERE state='running' AND deadline_at <= ?",
      )
      .all(now.toISOString()) as Array<{ trigger_id: string }>;
    for (const row of rows)
      this.settleMonitorTriggerUnsafe(
        { triggerId: row.trigger_id, terminal: 'indeterminate' },
        now,
      );
  }

  private pruneMonitorAccounting(now: Date): void {
    const cutoff = new Date(
      now.getTime() - EXTERNAL_MONITOR_LEDGER_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    this.db
      .prepare('DELETE FROM external_monitor_outcomes WHERE created_at < ?')
      .run(cutoff);
    this.db
      .prepare(
        'DELETE FROM external_monitor_triggers WHERE settled_at IS NOT NULL AND settled_at < ?',
      )
      .run(cutoff);
    // The count cap remains even on a clock that never advances (tests and
    // restored homes both exercise that case).
    this.db
      .prepare(`DELETE FROM external_monitor_outcomes WHERE trigger_id IN (
      SELECT trigger_id FROM external_monitor_outcomes ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )`)
      .run(EXTERNAL_MONITOR_LEDGER_MAX_OUTCOMES);
  }

  owedFailureAnnouncements(
    now = Date.now(),
  ): SchedulerReadOutcome<SchedulerOwedAnnouncements> {
    return this.read(() =>
      this.transaction(() => {
        const entries: SchedulerLogEntry[] = [];
        let retryAtMs: number | undefined;
        for (const row of this.db
          .prepare(
            `SELECT id, job_id, data, announce_lease_until_ms FROM scheduler_logs
             WHERE announced_at IS NULL AND json_extract(data, '$.success') = 0
             ORDER BY sequence ASC`,
          )
          .all() as Array<{
          id: string;
          job_id: string | null;
          data: string;
          announce_lease_until_ms: number | null;
        }>) {
          const entry = this.logFromRow(row);
          // The moment the failure became durable is what ages out, not the
          // moment somebody noticed it. A row whose timestamps are unreadable
          // is announced rather than dropped: the retention rule exists to
          // bound a flood, and it must not become a way for a malformed row
          // to silence itself.
          const recordedMs = Date.parse(entry.completedAt ?? entry.startedAt);
          if (
            Number.isFinite(recordedMs) &&
            now - recordedMs > FAILURE_ANNOUNCEMENT_RETENTION_MS
          ) {
            this.stampAnnouncement(
              row.id,
              now,
              ANNOUNCEMENT_SKIPPED_OLDER_THAN_RETENTION,
            );
            continue;
          }
          // Rows under a live lease are still returned: the claim decides who
          // announces, not this read. What the caller cannot work out for
          // itself is WHEN to look again, so report the earliest expiry.
          const leaseUntil = row.announce_lease_until_ms;
          if (typeof leaseUntil === 'number' && leaseUntil > now) {
            retryAtMs =
              retryAtMs === undefined
                ? leaseUntil
                : Math.min(retryAtMs, leaseUntil);
          }
          entries.push(entry);
        }
        return retryAtMs === undefined ? { entries } : { entries, retryAtMs };
      }),
    );
  }

  announcementOutbox(): SchedulerAnnouncementOutbox {
    this.outbox ??= {
      claimAnnouncement: (id, now = Date.now()) => {
        const token = randomUUID();
        try {
          return this.transaction<SchedulerAnnouncementClaim>(() => {
            // One statement decides it. A read followed by a write would be
            // the same check-then-act race across processes that the lease
            // exists to close, and SQLite's own row-level result is the only
            // arbiter both processes share.
            const changed = this.db
              .prepare(
                `UPDATE scheduler_logs
                   SET announce_lease_until_ms = ?, announce_lease_token = ?
                 WHERE id = ? AND announced_at IS NULL
                   AND (announce_lease_until_ms IS NULL OR announce_lease_until_ms < ?)`,
              )
              .run(now + ANNOUNCEMENT_LEASE_MS, token, id, now) as {
              changes?: number;
            };
            if (changed.changes === 1) return { kind: 'claimed', token };
            const row = this.db
              .prepare('SELECT announced_at FROM scheduler_logs WHERE id = ?')
              .get(id) as { announced_at: string | null } | undefined;
            if (!row) return { kind: 'unknown' };
            return row.announced_at === null
              ? { kind: 'leased-elsewhere' }
              : { kind: 'already-announced' };
          });
        } catch {
          // A store that cannot answer must not be read as "already told".
          return { kind: 'unknown' };
        }
      },
      releaseAnnouncement: (id, token) => {
        try {
          this.transaction(() => {
            this.db
              .prepare(
                `UPDATE scheduler_logs
                   SET announce_lease_until_ms = NULL, announce_lease_token = NULL
                 WHERE id = ? AND announced_at IS NULL AND announce_lease_token = ?`,
              )
              .run(id, token);
          });
        } catch {
          // The lease expires on its own; releasing early is only courtesy.
        }
      },
      markAnnounced: (id, token) => {
        try {
          this.transaction(() => {
            this.stampAnnouncement(id, Date.now(), null, token);
          });
        } catch {
          // At-least-once by design: an announced-but-unstamped run stays
          // owed, so the next boot sweep announces it one more time.
        }
      },
    };
    return this.outbox;
  }

  owedMonitorTerminalAnnouncements(): SchedulerReadOutcome<
    readonly { triggerId: string; monitorId: string }[]
  > {
    return this.read(() =>
      (
        this.db
          .prepare(
            `SELECT trigger_id, monitor_id FROM external_monitor_triggers
            WHERE state IN ('completed','failed','indeterminate')
              AND terminal_announced_at IS NULL
            ORDER BY settled_at ASC`,
          )
          .all() as Array<{ trigger_id: string; monitor_id: string }>
      ).map((row) => ({
        triggerId: row.trigger_id,
        monitorId: row.monitor_id,
      })),
    );
  }

  monitorTerminalAnnouncementOutbox(): MonitorTerminalAnnouncementOutbox {
    this.monitorTerminalOutbox ??= {
      claim: (triggerId, now = Date.now()) => {
        const token = randomUUID();
        try {
          return this.transaction<SchedulerAnnouncementClaim>(() => {
            const changed = this.db
              .prepare(
                `UPDATE external_monitor_triggers
                    SET terminal_announce_lease_until_ms=?, terminal_announce_lease_token=?
                  WHERE trigger_id=? AND terminal_announced_at IS NULL
                    AND (terminal_announce_lease_until_ms IS NULL OR terminal_announce_lease_until_ms < ?)`,
              )
              .run(now + ANNOUNCEMENT_LEASE_MS, token, triggerId, now) as {
              changes?: number;
            };
            if (changed.changes === 1) return { kind: 'claimed', token };
            const row = this.db
              .prepare(
                'SELECT terminal_announced_at FROM external_monitor_triggers WHERE trigger_id=?',
              )
              .get(triggerId) as
              | { terminal_announced_at: string | null }
              | undefined;
            if (!row) return { kind: 'unknown' };
            return row.terminal_announced_at === null
              ? { kind: 'leased-elsewhere' }
              : { kind: 'already-announced' };
          });
        } catch {
          return { kind: 'unknown' };
        }
      },
      release: (triggerId, token) => {
        try {
          this.transaction(() => {
            this.db
              .prepare(
                `UPDATE external_monitor_triggers
                    SET terminal_announce_lease_until_ms=NULL, terminal_announce_lease_token=NULL
                  WHERE trigger_id=? AND terminal_announced_at IS NULL
                    AND terminal_announce_lease_token=?`,
              )
              .run(triggerId, token);
          });
        } catch {}
      },
      markDelivered: (triggerId, token) => {
        try {
          this.transaction(() => {
            this.db
              .prepare(
                `UPDATE external_monitor_triggers
                    SET terminal_announced_at=?, terminal_announce_lease_until_ms=NULL,
                        terminal_announce_lease_token=NULL
                  WHERE trigger_id=? AND terminal_announced_at IS NULL
                    AND terminal_announce_lease_token=?`,
              )
              .run(new Date().toISOString(), triggerId, token);
          });
        } catch {}
      },
    };
    return this.monitorTerminalOutbox;
  }

  recordMonitorProbeTerminal(input: {
    name: string;
    monitorId: string;
    outcome: MonitorProbeTerminalOutcome;
    monitorState: ExternalMonitorState;
  }):
    | { kind: 'recorded'; announcement: MonitorProbeTerminalAnnouncement }
    | { kind: 'already-terminal' }
    | { kind: 'not-found' }
    | SchedulerUnavailable {
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    try {
      return this.transaction(() => {
        const current = this.rowForJob(input.name);
        if (!current || current.job_id !== input.monitorId)
          return { kind: 'not-found' } as const;
        const job = parseStoredJob(current.data);
        if (!job.monitor) return { kind: 'not-found' } as const;
        // A Task terminal marker is distinct from a probe result. In
        // particular, an authorization failure is recoverable on the next
        // healthy probe and must never be rewritten into sticky `terminal`.
        if (job.monitorState?.lastOutcome === 'terminal')
          return { kind: 'already-terminal' } as const;
        // Deduplicate only a repeated observation of the CURRENT outcome.
        // A healthy/pending observation starts a new episode, so a later
        // authorization, budget, or source-terminal result earns its own
        // durable bell even if an older row has the same monitor identity.
        if (job.monitorState?.lastOutcome === input.outcome) {
          const existingAnnouncement = this.db
            .prepare(
              'SELECT id FROM external_monitor_probe_announcements WHERE monitor_id=? AND outcome=? LIMIT 1',
            )
            .get(input.monitorId, input.outcome);
          if (existingAnnouncement)
            return { kind: 'already-terminal' } as const;
        }
        const id = randomUUID();
        const monitorState: ExternalMonitorState = input.monitorState;
        this.db
          .prepare(
            'UPDATE scheduler_jobs SET revision=revision+1, data=?, last_run_ms=? WHERE name=? AND job_id=?',
          )
          .run(
            JSON.stringify({ ...job, monitorState }),
            job.lastRunMs ?? null,
            input.name,
            input.monitorId,
          );
        this.db
          .prepare(
            `INSERT INTO external_monitor_probe_announcements
              (id,monitor_id,job_name,outcome,detail,created_at)
             VALUES(?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.monitorId,
            input.name,
            input.outcome,
            input.monitorState.nextAction ??
              'Monitor reached a terminal result.',
            new Date().toISOString(),
          );
        return {
          kind: 'recorded',
          announcement: {
            id,
            monitorId: input.monitorId,
            jobName: input.name,
            outcome: input.outcome,
            detail:
              input.monitorState.nextAction ??
              'Monitor reached a terminal result.',
          },
        } as const;
      });
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  owedMonitorProbeTerminalAnnouncements(): SchedulerReadOutcome<
    readonly MonitorProbeTerminalAnnouncement[]
  > {
    return this.read(() =>
      (
        this.db
          .prepare(
            `SELECT id, monitor_id, job_name, outcome, detail
               FROM external_monitor_probe_announcements
              WHERE delivered_at IS NULL
              ORDER BY created_at ASC`,
          )
          .all() as Array<{
          id: string;
          monitor_id: string;
          job_name: string;
          outcome: MonitorProbeTerminalOutcome;
          detail: string;
        }>
      ).map((row) =>
        Object.freeze({
          id: row.id,
          monitorId: row.monitor_id,
          jobName: row.job_name,
          outcome: row.outcome,
          detail: row.detail,
        }),
      ),
    );
  }

  monitorProbeTerminalAnnouncementOutbox(): MonitorProbeTerminalAnnouncementOutbox {
    this.monitorProbeTerminalOutbox ??= {
      claim: (id, now = Date.now()) => {
        const token = randomUUID();
        try {
          return this.transaction<SchedulerAnnouncementClaim>(() => {
            const changed = this.db
              .prepare(
                `UPDATE external_monitor_probe_announcements
                    SET lease_until_ms=?, lease_token=?
                  WHERE id=? AND delivered_at IS NULL
                    AND (lease_until_ms IS NULL OR lease_until_ms < ?)`,
              )
              .run(now + ANNOUNCEMENT_LEASE_MS, token, id, now) as {
              changes?: number;
            };
            if (changed.changes === 1) return { kind: 'claimed', token };
            const row = this.db
              .prepare(
                'SELECT delivered_at FROM external_monitor_probe_announcements WHERE id=?',
              )
              .get(id) as { delivered_at: string | null } | undefined;
            if (!row) return { kind: 'unknown' };
            return row.delivered_at === null
              ? { kind: 'leased-elsewhere' }
              : { kind: 'already-announced' };
          });
        } catch {
          return { kind: 'unknown' };
        }
      },
      release: (id, token) => {
        try {
          this.transaction(() => {
            this.db
              .prepare(
                `UPDATE external_monitor_probe_announcements
                    SET lease_until_ms=NULL, lease_token=NULL
                  WHERE id=? AND delivered_at IS NULL AND lease_token=?`,
              )
              .run(id, token);
          });
        } catch {
          // An abandoned lease becomes claimable after its bounded expiry.
        }
      },
      markDelivered: (id, token) => {
        try {
          this.transaction(() => {
            this.db
              .prepare(
                `UPDATE external_monitor_probe_announcements
                    SET delivered_at=?, lease_until_ms=NULL, lease_token=NULL
                  WHERE id=? AND delivered_at IS NULL AND lease_token=?`,
              )
              .run(new Date().toISOString(), id, token);
          });
        } catch {
          // Delivery happened but the stamp did not: retry under the same
          // NotificationService dedupe identity after restart.
        }
      },
    };
    return this.monitorProbeTerminalOutbox;
  }

  /**
   * Closes a run's announcement, whether it was delivered (`skipReason` null)
   * or deliberately dropped. `announced_at IS NULL` is the only thing the
   * sweep reads, so a stamped row is never announced again by this Station.
   */
  private stampAnnouncement(
    id: string,
    now: number,
    skipReason: string | null,
    token?: string,
  ): void {
    // A token narrows the stamp to the claimant that still holds the lease,
    // so a slow predecessor cannot close a run its successor is mid-way
    // through announcing. The retention skip passes none: that decision
    // belongs to the sweep itself and takes no claim.
    this.db
      .prepare(
        `UPDATE scheduler_logs
           SET announced_at = ?, announcement_skip_reason = ?,
               announce_lease_until_ms = NULL, announce_lease_token = NULL
         WHERE id = ? AND announced_at IS NULL
           AND (? IS NULL OR announce_lease_token = ?)`,
      )
      .run(
        new Date(now).toISOString(),
        skipReason,
        id,
        token ?? null,
        token ?? null,
      );
  }

  private readOutputUnsafe(path: string): string {
    const real = realpathSync(path);
    const logsReal = realpathSync(this.logsDirectory);
    const relativePath = relative(logsReal, real);
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`)
    ) {
      throw new Error('Invalid path');
    }
    return readFileSync(real, 'utf-8');
  }

  private insertClaim(
    job: StoredSchedulerJob,
    revision: number,
    now: number,
    manual: boolean,
    scheduledForMs?: number,
  ): SchedulerDispatchReceipt {
    const id = randomUUID();
    const maxAttempts = (job.retryCount ?? 0) + 1;
    const missed = manual
      ? 0
      : missedCount(
          toScheduledJob(job)!.schedule,
          toScheduledJob(job)!.lastRunMs ?? toScheduledJob(job)!.createdMs,
          now,
        );
    this.db
      .prepare(
        `INSERT INTO scheduler_claims(
          job_name, job_id, revision, run_id, started_at, started_ms, job_data, scheduled_for_ms, manual,
          missed_count, attempt, max_attempts, invocation_started, owner_id, owner_pid, owner_birth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`,
      )
      .run(
        job.name,
        this.rowForJob(job.name)!.job_id,
        revision,
        id,
        new Date(now).toISOString(),
        now,
        JSON.stringify(job),
        scheduledForMs ?? null,
        manual ? 1 : 0,
        missed,
        maxAttempts,
        this.owner.id,
        this.owner.pid,
        this.owner.birth ?? null,
      );
    const row = this.claimRow(this.rowForJob(job.name)!.job_id)!;
    return this.receiptFor(row, job);
  }

  private receiptFor(
    row: ClaimRow,
    stored: StoredSchedulerJob,
    attempt = row.attempt,
  ): SchedulerDispatchReceipt {
    const job = freezeJob(stored);
    let outcome: SchedulerSettlementOutcome | undefined;
    let settlementIntent: string | undefined;
    let notInvokedIntent: string | undefined;
    let notInvokedOutcome: SchedulerNotInvokedOutcome | undefined;
    const settle = (
      settlement: SchedulerDispatchSettlement,
    ): SchedulerSettlementOutcome => {
      if (notInvokedIntent !== undefined) return { kind: 'stale' };
      const intent = JSON.stringify(settlement);
      if (settlementIntent !== undefined && settlementIntent !== intent) {
        return { kind: 'invalid' };
      }
      settlementIntent = intent;
      if (outcome && outcome.kind !== 'unavailable') return outcome;
      outcome = this.settle(row, job, attempt, settlement);
      return outcome;
    };
    return Object.freeze({
      id: row.run_id,
      jobId: row.job_id,
      job,
      startedAt: row.started_at,
      ...(row.scheduled_for_ms === null
        ? {}
        : { scheduledForMs: row.scheduled_for_ms }),
      manual: Boolean(row.manual),
      missedCount: row.missed_count,
      attempt,
      maxAttempts: row.max_attempts,
      outputPath: () => this.outputPath(row.run_id, attempt),
      releaseDeferred: () => this.releaseDeferred(row, attempt),
      beginInvocation: () => this.beginInvocation(row, attempt),
      recordNotInvoked: (input: {
        completedAt: string;
        error: string;
      }): SchedulerNotInvokedOutcome => {
        if (settlementIntent !== undefined) return { kind: 'stale' };
        const intent = JSON.stringify(input);
        if (notInvokedIntent !== undefined && notInvokedIntent !== intent) {
          return { kind: 'stale' };
        }
        notInvokedIntent = intent;
        if (notInvokedOutcome && notInvokedOutcome.kind !== 'unavailable') {
          return notInvokedOutcome;
        }
        notInvokedOutcome = this.recordNotInvoked(row, job, attempt, input);
        return notInvokedOutcome;
      },
      settle,
    }) as SchedulerDispatchReceipt;
  }

  private settle(
    claim: ClaimRow,
    job: StoredSchedulerJob,
    attempt: number,
    settlement: SchedulerDispatchSettlement,
  ): SchedulerSettlementOutcome {
    if (
      (settlement.success && settlement.state !== 'completed') ||
      (!settlement.success && settlement.state === 'completed')
    ) {
      return { kind: 'invalid' };
    }
    if (
      !Number.isInteger(attempt) ||
      attempt < 1 ||
      attempt > claim.max_attempts
    ) {
      return { kind: 'invalid' };
    }
    try {
      return this.transaction(() => {
        const active = this.claimRow(claim.job_id);
        if (
          !active ||
          active.run_id !== claim.run_id ||
          active.owner_id !== this.owner.id ||
          active.attempt !== attempt ||
          active.invocation_started !== 1
        ) {
          return { kind: 'stale' };
        }
        const entry: SchedulerLogEntry = {
          id: `${claim.run_id}-${attempt}`,
          job: job.name,
          jobId: claim.job_id,
          startedAt: claim.started_at,
          ...(claim.scheduled_for_ms === null
            ? {}
            : { scheduledFor: new Date(claim.scheduled_for_ms).toISOString() }),
          firedAt: claim.started_at,
          completedAt: settlement.completedAt,
          success: settlement.success,
          durationSecs: settlement.durationSecs,
          missedCount: claim.missed_count,
          manual: Boolean(claim.manual),
          output: settlement.output,
          error: settlement.error,
          attempt,
          maxAttempts: claim.max_attempts,
          state: settlement.state,
        };
        this.insertRunLog(entry, claim.job_id);

        if (!claim.manual && claim.scheduled_for_ms !== null) {
          this.db
            .prepare(
              `UPDATE scheduler_jobs
               SET last_run_ms = MAX(COALESCE(last_run_ms, 0), ?),
                   data = json_set(data, '$.lastRunMs', MAX(COALESCE(last_run_ms, 0), ?))
               WHERE job_id = ?`,
            )
            .run(claim.scheduled_for_ms, claim.scheduled_for_ms, claim.job_id);
        }
        if (settlement.success && !claim.manual) {
          const current = this.rowForJob(job.name);
          if (current?.revision === claim.revision) {
            const currentJob = current
              ? parseStoredJob(current.data)
              : undefined;
            const schedule = currentJob
              ? toScheduledJob(currentJob)?.schedule
              : undefined;
            if (schedule?.kind === 'at' && schedule.deleteAfterRun) {
              this.db
                .prepare(
                  `UPDATE scheduler_jobs
                 SET revision = revision + 1,
                     data = json_set(data, '$.enabled', json('false'))
                 WHERE name = ? AND revision = ?`,
                )
                .run(job.name, claim.revision);
            }
          }
        }
        this.db
          .prepare(
            `DELETE FROM scheduler_claims
             WHERE job_id = ? AND run_id = ? AND owner_id = ?
               AND attempt = ? AND invocation_started = 1`,
          )
          .run(claim.job_id, claim.run_id, this.owner.id, attempt);
        return { kind: 'applied' };
      }, this.afterSettlementCommit);
    } catch (error) {
      // A write may have committed before a native SQLite exception. Read the
      // exact receipt back: only the same durable transition is idempotently
      // applied; every other ambiguity remains unavailable for the owner.
      try {
        const log = this.db
          .prepare('SELECT data FROM scheduler_logs WHERE id = ?')
          .get(`${claim.run_id}-${attempt}`) as { data: string } | undefined;
        if (log) {
          const intended: SchedulerLogEntry = {
            id: `${claim.run_id}-${attempt}`,
            job: job.name,
            jobId: claim.job_id,
            startedAt: claim.started_at,
            ...(claim.scheduled_for_ms === null
              ? {}
              : {
                  scheduledFor: new Date(claim.scheduled_for_ms).toISOString(),
                }),
            firedAt: claim.started_at,
            completedAt: settlement.completedAt,
            success: settlement.success,
            durationSecs: settlement.durationSecs,
            missedCount: claim.missed_count,
            manual: Boolean(claim.manual),
            output: settlement.output,
            error: settlement.error,
            attempt,
            maxAttempts: claim.max_attempts,
            state: settlement.state,
          };
          if (log.data === JSON.stringify(intended)) {
            return { kind: 'applied' };
          }
        }
      } catch {
        // A failed readback must not pretend an external run is settled.
      }
      return unavailableFrom(error);
    }
  }

  private beginInvocation(
    claim: ClaimRow,
    attempt: number,
  ): SchedulerInvocationOutcome {
    // The pre-invocation FENCE, not a record of anything. `applied` here is
    // what authorizes `executeSchedulerJobAttempt` to call the adapter, and
    // the `invocation_started = 1` it writes is the durable mark that stops
    // the run being replayed. A receipt claimed while the store was healthy
    // reaches this line after corruption has already armed the latch — and
    // without this guard SQLite can serve the fence write from cached pages,
    // so Station invokes a real unattended agent behind a fence living in
    // bytes that will not survive the next boot (archive#3220 delta review).
    const refused = this.refuseIfCorrupt();
    if (refused) return refused;
    try {
      const result = this.transaction(() => {
        const current = this.claimRow(claim.job_id);
        if (
          current?.run_id === claim.run_id &&
          current.owner_id === this.owner.id &&
          current.attempt === attempt &&
          current.invocation_started === 1
        ) {
          return { kind: 'applied' } as const;
        }
        const changed = this.db
          .prepare(
            `UPDATE scheduler_claims SET invocation_started = 1
             WHERE job_id = ? AND run_id = ? AND owner_id = ? AND attempt = ? AND invocation_started = 0`,
          )
          .run(claim.job_id, claim.run_id, this.owner.id, attempt) as {
          changes?: number;
        };
        return changed.changes === 1
          ? ({ kind: 'applied' } as const)
          : ({ kind: 'stale' } as const);
      });
      return result;
    } catch (error) {
      try {
        const current = this.claimRow(claim.job_id);
        if (
          current?.run_id === claim.run_id &&
          current.owner_id === this.owner.id &&
          current.attempt === attempt &&
          current.invocation_started === 1
        ) {
          return { kind: 'applied' };
        }
      } catch {
        // Preserve the durable pre-invocation fence on readback uncertainty.
      }
      return unavailableFrom(error);
    }
  }

  /**
   * A posture deferral happens before any Adapter authorization. Releasing the
   * claim preserves the original occurrence for a later scheduler tick without
   * recording a false failure or spending its retry budget.
   */
  private releaseDeferred(
    claim: ClaimRow,
    attempt: number,
  ): SchedulerDeferredOutcome {
    try {
      const result = this.transaction(() => {
        const changed = this.db
          .prepare(
            `DELETE FROM scheduler_claims
             WHERE job_id = ? AND run_id = ? AND owner_id = ?
               AND attempt = ? AND invocation_started = 0`,
          )
          .run(claim.job_id, claim.run_id, this.owner.id, attempt) as {
          changes?: number;
        };
        return changed.changes === 1
          ? ({ kind: 'applied' } as const)
          : ({ kind: 'stale' } as const);
      });
      return result;
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  private recordNotInvoked(
    claim: ClaimRow,
    job: StoredSchedulerJob,
    attempt: number,
    input: { completedAt: string; error: string },
  ): SchedulerNotInvokedOutcome {
    const terminal = attempt >= claim.max_attempts;
    const entry: SchedulerLogEntry = {
      id: `${claim.run_id}-${attempt}`,
      job: job.name,
      jobId: claim.job_id,
      startedAt: claim.started_at,
      ...(claim.scheduled_for_ms === null
        ? {}
        : { scheduledFor: new Date(claim.scheduled_for_ms).toISOString() }),
      firedAt: claim.started_at,
      completedAt: input.completedAt,
      success: false,
      durationSecs: 0,
      missedCount: claim.missed_count,
      manual: Boolean(claim.manual),
      error: input.error,
      attempt,
      maxAttempts: claim.max_attempts,
      state: 'failed',
    };
    // A caller may retry this exact capability after a post-commit native
    // exception or transient readback fault. Recognize only the same durable
    // record+advance; a changed intent remains stale rather than re-running
    // an already advanced attempt.
    const alreadyRecorded = this.readNotInvokedResult(
      claim,
      job,
      attempt,
      entry,
      terminal,
    );
    if (alreadyRecorded) return alreadyRecorded;
    try {
      const result = this.transaction(() => {
        const active = this.claimRow(claim.job_id);
        if (
          !active ||
          active.run_id !== claim.run_id ||
          active.owner_id !== this.owner.id ||
          active.attempt !== attempt ||
          active.invocation_started !== 1
        ) {
          return { kind: 'stale' } as const;
        }
        this.insertRunLog(entry, claim.job_id);
        if (terminal) {
          if (!claim.manual && claim.scheduled_for_ms !== null) {
            this.db
              .prepare(
                `UPDATE scheduler_jobs
                 SET last_run_ms = MAX(COALESCE(last_run_ms, 0), ?),
                     data = json_set(data, '$.lastRunMs', MAX(COALESCE(last_run_ms, 0), ?))
                 WHERE job_id = ?`,
              )
              .run(
                claim.scheduled_for_ms,
                claim.scheduled_for_ms,
                claim.job_id,
              );
          }
          this.db
            .prepare(
              'DELETE FROM scheduler_claims WHERE job_id = ? AND run_id = ? AND owner_id = ?',
            )
            .run(claim.job_id, claim.run_id, this.owner.id);
          return { kind: 'terminal' } as const;
        }
        const changed = this.db
          .prepare(
            `UPDATE scheduler_claims SET attempt = ?, invocation_started = 0
             WHERE job_id = ? AND run_id = ? AND owner_id = ? AND attempt = ?`,
          )
          .run(
            attempt + 1,
            claim.job_id,
            claim.run_id,
            this.owner.id,
            attempt,
          ) as { changes?: number };
        if (changed.changes !== 1) return { kind: 'stale' } as const;
        return { kind: 'advanced' } as const;
      }, this.afterNotInvokedCommit);
      if (result.kind === 'terminal') return result;
      // A stale CAS can mean another call of this same capability committed
      // immediately before us. Read the exact intended record before calling
      // it stale, so same-handle recovery remains total after ambiguity.
      const durable = this.readNotInvokedResult(
        claim,
        job,
        attempt,
        entry,
        terminal,
      );
      return durable ?? (result.kind === 'stale' ? result : { kind: 'stale' });
    } catch (error) {
      // The transaction may have committed before native SQLite surfaced its
      // error. Read only the exact durable result: a retry retains its same
      // run/attempt capability; an exhausted proved-no-effect receipt is
      // terminal. Anything else remains honestly unavailable.
      const recovered = this.readNotInvokedResult(
        claim,
        job,
        attempt,
        entry,
        terminal,
        true,
      );
      if (recovered) return recovered;
      this.onNotInvokedUnavailable?.();
      return unavailableFrom(error);
    }
  }

  private readNotInvokedResult(
    claim: ClaimRow,
    job: StoredSchedulerJob,
    attempt: number,
    entry: SchedulerLogEntry,
    terminal: boolean,
    injectFault = false,
  ): SchedulerNotInvokedOutcome | undefined {
    try {
      if (injectFault) this.beforeNotInvokedReadback?.();
      const log = this.db
        .prepare('SELECT data FROM scheduler_logs WHERE id = ?')
        .get(entry.id) as { data: string } | undefined;
      if (log?.data !== JSON.stringify(entry)) return undefined;
      const current = this.claimRow(claim.job_id);
      if (terminal && (!current || current.run_id !== claim.run_id)) {
        return { kind: 'terminal' };
      }
      if (
        !terminal &&
        current?.run_id === claim.run_id &&
        current.owner_id === this.owner.id &&
        current.attempt === attempt + 1 &&
        current.invocation_started === 0
      ) {
        return { kind: 'claimed', receipt: this.receiptFor(current, job) };
      }
    } catch {
      // The exact durable state is still unknown to this caller.
    }
    return undefined;
  }

  private reconcileDeadClaims(
    now: number,
    shouldRecover: (claim: ClaimRow) => boolean,
  ): SchedulerDispatchReceipt[] {
    const reclaimed: SchedulerDispatchReceipt[] = [];
    for (const claim of this.db
      .prepare('SELECT * FROM scheduler_claims')
      .all() as ClaimRow[]) {
      if (this.claimIsLive(claim)) continue;
      if (!claim.invocation_started) {
        // Starter attempt 1 has a durable operation owner outside this scan.
        // Generic due/manual reconciliation must not delete it: only the same
        // operation may reclaim the exact run or release it after a binding
        // conflict.
        if (
          claim.attempt === 1 &&
          this.db
            .prepare(
              'SELECT 1 AS owned FROM scheduler_starter_manual_intents WHERE run_id = ? LIMIT 1',
            )
            .get(claim.run_id)
        )
          continue;
        // An initial pre-invocation claim has no durable retry lineage and may
        // be released. A later attempt was atomically recorded as definitely
        // not invoked, however: deleting it would reset its max-attempts
        // budget and create a fresh attempt 1 for the same occurrence.
        if (claim.attempt > 1) {
          const current = this.rowForJobId(claim.job_id);
          if (!current) {
            // The operator deleted the job after this attempt was atomically
            // proved not invoked. Its existing failed log preserves history;
            // releasing the no-effect retry is safe and avoids a dead running
            // claim that no caller can ever execute.
            this.db
              .prepare(
                'DELETE FROM scheduler_claims WHERE job_id = ? AND run_id = ? AND attempt = ? AND invocation_started = 0',
              )
              .run(claim.job_id, claim.run_id, claim.attempt);
            continue;
          }
          if (shouldRecover(claim) && claim.job_data) {
            const changed = this.db
              .prepare(
                `UPDATE scheduler_claims
                   SET owner_id = ?, owner_pid = ?, owner_birth = ?
                 WHERE job_id = ? AND run_id = ? AND owner_id = ?
                   AND attempt = ? AND invocation_started = 0`,
              )
              .run(
                this.owner.id,
                this.owner.pid,
                this.owner.birth ?? null,
                claim.job_id,
                claim.run_id,
                claim.owner_id,
                claim.attempt,
              ) as { changes?: number };
            if (changed.changes === 1) {
              const reclaimedClaim = this.claimRow(claim.job_id);
              if (reclaimedClaim) {
                reclaimed.push(
                  this.receiptFor(
                    reclaimedClaim,
                    parseStoredJob(claim.job_data),
                  ),
                );
                continue;
              }
            }
            // A concurrent owner transition is no longer ours to recover.
            continue;
          }
          // This exact retry belongs to a different executor (for example a
          // manual job during a timer tick). Leave its dead owner unchanged
          // until that executor asks to reclaim it; otherwise it would become
          // live without anybody receiving the capability.
          continue;
        }
        // The receipt was only initially claimed before any Adapter call was
        // authorized, so releasing it is safe.
        this.db
          .prepare(
            'DELETE FROM scheduler_claims WHERE job_id = ? AND run_id = ?',
          )
          .run(claim.job_id, claim.run_id);
        continue;
      }
      // The external agent invocation may already have happened.  Never replay
      // it automatically: make the uncertainty durable, advance the catch-up
      // origin, and release the job for the next independent occurrence.
      const completedAt = new Date(now).toISOString();
      const entry: SchedulerLogEntry = {
        id: `${claim.run_id}-${claim.attempt}`,
        job: claim.job_name,
        jobId: claim.job_id,
        startedAt: claim.started_at,
        ...(claim.scheduled_for_ms === null
          ? {}
          : { scheduledFor: new Date(claim.scheduled_for_ms).toISOString() }),
        firedAt: claim.started_at,
        completedAt,
        success: false,
        durationSecs: Math.max(0, (now - claim.started_ms) / 1000),
        manual: Boolean(claim.manual),
        missedCount: claim.missed_count,
        error:
          'Scheduler process stopped after this run was claimed; invocation was not replayed automatically.',
        attempt: claim.attempt,
        maxAttempts: claim.max_attempts,
        state: 'indeterminate',
      };
      this.insertRunLog(entry, claim.job_id);
      // A run the user will see as Failed, written by nobody's executing code.
      // Announced after commit so it reaches the same broadcast + notification
      // an ordinary invocation failure does.
      this.pendingAbandonedRuns.push(entry);
      const consumedForMs =
        claim.scheduled_for_ms ?? (claim.manual ? null : now);
      if (!claim.manual && consumedForMs !== null) {
        this.db
          .prepare(
            `UPDATE scheduler_jobs
             SET last_run_ms = MAX(COALESCE(last_run_ms, 0), ?),
                 data = json_set(data, '$.lastRunMs', MAX(COALESCE(last_run_ms, 0), ?))
             WHERE job_id = ?`,
          )
          .run(consumedForMs, consumedForMs, claim.job_id);
      }
      this.db
        .prepare('DELETE FROM scheduler_claims WHERE job_id = ? AND run_id = ?')
        .run(claim.job_id, claim.run_id);
    }
    return reclaimed;
  }

  /**
   * The private cursor is `last_run_ms`, keyed by opaque jobId. Terminal due
   * outcomes advance it to their captured occurrence; manual runs and
   * pre-invocation releases do not. Delete/recreate starts a new cursor.
   */
  private nextDueOccurrence(
    scheduled: ScheduledJob,
    now: number,
  ): number | undefined {
    return latestOccurrenceAtOrBefore(scheduled, now);
  }

  /**
   * Drain the buffer. `committed` false means the surrounding transaction did
   * not land, so those runs do not exist and nothing is announced.
   */
  private flushAbandonedRuns(committed: boolean): void {
    const entries = this.pendingAbandonedRuns;
    this.pendingAbandonedRuns = [];
    if (!committed || !this.abandonedRunListener) return;
    for (const entry of entries) {
      try {
        this.abandonedRunListener(entry);
      } catch {
        // Observer-only: the run is already durable either way.
      }
    }
  }

  private claimIsLive(claim: ClaimRow): boolean {
    // A claim naming THIS pid is decided by the in-process owner registry and
    // by nothing else. That registry is exact: every live owner adds its
    // opaque id on construction and removes it on close, so it answers
    // without a birth fingerprint. Reaching for one here is what stranded a
    // crashed occurrence whenever a contended `ps` could not supply it
    // (archive#3188) — a NULL `owner_birth` read as "live forever", and an
    // owner whose own probe failed could not reclaim even its own prior
    // claim. A foreign owner that died and had its pid recycled to us never
    // has its id in this registry, so the same answer is correct for reuse.
    if (claim.owner_pid === process.pid) {
      return LIVE_OWNER_IDS.has(claim.owner_id);
    }
    // A DIFFERENT pid with no recorded birth is genuinely undecidable: keep
    // the fence rather than risk double-running a live owner's occurrence.
    if (!claim.owner_birth) return true;
    const probe = this.identity.probe(claim.owner_pid);
    return (
      probe.state === 'unavailable' ||
      (probe.state === 'exact' &&
        probe.identity.start === claim.owner_birth &&
        probe.identity.pid === claim.owner_pid)
    );
  }

  private outputPath(runId: string, attempt: number): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        runId,
      )
    ) {
      throw new Error('Invalid scheduler receipt');
    }
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error('Invalid scheduler attempt');
    }
    ensureRealDirectory(this.logsDirectory, 'Scheduler ledger logs directory');
    const output = join(this.logsDirectory, `${runId}-${attempt}.log`);
    if (existsSync(output)) {
      const stat = lstatSync(output);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('Scheduler output target is not a regular file');
      }
      throw new Error('Scheduler output target already exists');
    }
    return output;
  }

  private rowForJob(
    name: string,
  ):
    | { name: string; job_id: string; revision: number; data: string }
    | undefined {
    return this.db
      .prepare(
        'SELECT name, job_id, revision, data FROM scheduler_jobs WHERE name = ?',
      )
      .get(name) as
      | { name: string; job_id: string; revision: number; data: string }
      | undefined;
  }

  private rowForJobId(
    jobId: string,
  ):
    | { name: string; job_id: string; revision: number; data: string }
    | undefined {
    return this.db
      .prepare(
        'SELECT name, job_id, revision, data FROM scheduler_jobs WHERE job_id = ?',
      )
      .get(jobId) as
      | { name: string; job_id: string; revision: number; data: string }
      | undefined;
  }

  /**
   * The one place a terminal run row is written, so every path that records a
   * run enters the announcement outbox the same way: `announced_at` NULL, in
   * the same transaction as the row itself. A failure is owed to the user
   * from the instant it becomes durable — including the paths where nothing
   * is executing to notice it — and stays owed until an announcement stamps
   * it. A successful run also enters NULL and is simply never announceable;
   * the sweep selects on the entry's own `success` field rather than on a
   * second, drift-prone copy of that fact in a column.
   */
  private insertRunLog(entry: SchedulerLogEntry, jobId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO scheduler_logs(
           id, job_name, job_id, data,
           announced_at, announcement_skip_reason, announce_lease_until_ms, announce_lease_token
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(entry.id, entry.job, jobId, JSON.stringify(entry));
  }

  private claimRow(jobId: string): ClaimRow | undefined {
    return this.db
      .prepare('SELECT * FROM scheduler_claims WHERE job_id = ?')
      .get(jobId) as ClaimRow | undefined;
  }

  private read<T>(work: () => T): SchedulerReadOutcome<T> {
    try {
      return { kind: 'available', value: work() };
    } catch (error) {
      return unavailableFrom(error);
    }
  }

  private transaction<T>(work: () => T, afterCommit?: () => void): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      afterCommit?.();
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original storage failure remains actionable.
      }
      throw error;
    }
  }

  private importLegacyJsonOnce(): void {
    this.transaction(() => {
      const imported = this.db
        .prepare(
          "SELECT value FROM scheduler_ledger_meta WHERE key = 'legacy-json-imported'",
        )
        .get();
      if (imported) return;
      const jobsPath = join(this.directory, 'jobs.json');
      if (existsSync(jobsPath)) {
        const jobs = new JsonFileStore<StoredSchedulerJob[]>(jobsPath, [], {
          onCorruption: 'throw',
        }).read();
        for (const job of jobs) {
          assertCanonicalLegacyJobName(job.name);
          this.db
            .prepare(
              `INSERT OR IGNORE INTO scheduler_jobs(name, job_id, revision, data, created_at, last_run_ms)
               VALUES (?, ?, 1, ?, ?, ?)`,
            )
            .run(
              job.name,
              randomUUID(),
              JSON.stringify(job),
              job.createdAt,
              job.lastRunMs ?? null,
            );
          const legacyLogPath = join(this.logsDirectory, `${job.name}.json`);
          if (!existsSync(legacyLogPath)) continue;
          const logs = new JsonFileStore<SchedulerLogEntry[]>(
            legacyLogPath,
            [],
            {
              onCorruption: 'throw',
            },
          ).read();
          for (const log of logs) {
            // Imported history predates the outbox exactly the way an
            // upgraded table's rows do: nothing here records whether the user
            // was told, and announcing a whole legacy log on first boot would
            // be a flood, not a recovery.
            this.db
              .prepare(
                `INSERT OR IGNORE INTO scheduler_logs(id, job_name, job_id, data, announced_at, announcement_skip_reason)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(
                log.id,
                job.name,
                this.rowForJob(job.name)!.job_id,
                JSON.stringify({
                  ...log,
                  jobId: this.rowForJob(job.name)!.job_id,
                }),
                new Date().toISOString(),
                ANNOUNCEMENT_SKIPPED_BEFORE_OUTBOX,
              );
          }
        }
      }
      this.db
        .prepare('INSERT INTO scheduler_ledger_meta(key, value) VALUES (?, ?)')
        .run('legacy-json-imported', new Date().toISOString());
    });
  }

  private ensureSchedulerLedgerColumns(): void {
    // A prior development build may have created the first scheduler-ledger
    // tables without opaque identities/invocation state.  Upgrade them before
    // accepting a claim; old jobs get fresh server-only identities.
    try {
      this.db.exec('ALTER TABLE scheduler_jobs ADD COLUMN job_id TEXT');
    } catch {
      // New schema or an already-upgraded ledger.
    }
    this.db.exec(
      "UPDATE scheduler_jobs SET job_id = lower(hex(randomblob(16))) WHERE job_id IS NULL OR job_id = ''",
    );
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS scheduler_jobs_job_id ON scheduler_jobs(job_id)',
    );
    try {
      this.db.exec('ALTER TABLE scheduler_claims ADD COLUMN job_id TEXT');
    } catch {
      // New schema or an already-upgraded ledger.
    }
    try {
      this.db.exec(
        'ALTER TABLE scheduler_claims ADD COLUMN invocation_started INTEGER NOT NULL DEFAULT 0',
      );
    } catch {
      // New schema or an already-upgraded ledger.
    }
    try {
      this.db.exec(
        'ALTER TABLE scheduler_claims ADD COLUMN scheduled_for_ms INTEGER',
      );
    } catch {
      // New schema or an already-upgraded ledger.
    }
    try {
      this.db.exec('ALTER TABLE scheduler_claims ADD COLUMN job_data TEXT');
    } catch {
      // New schema or an already-upgraded ledger.
    }
    this.db.exec(
      `UPDATE scheduler_claims
       SET job_id = (SELECT job_id FROM scheduler_jobs WHERE scheduler_jobs.name = scheduler_claims.job_name)
       WHERE job_id IS NULL OR job_id = ''`,
    );
    // Claims created before the immutable snapshot column can only be
    // resumed from the job definition that existed at this one-time upgrade;
    // all newly claimed/retried work persists its own snapshot at claim time.
    this.db.exec(
      `UPDATE scheduler_claims
       SET job_data = (SELECT data FROM scheduler_jobs WHERE scheduler_jobs.job_id = scheduler_claims.job_id)
       WHERE job_data IS NULL`,
    );
    try {
      this.db.exec('ALTER TABLE scheduler_logs ADD COLUMN job_id TEXT');
    } catch {
      // New schema or an already-upgraded ledger.
    }
    this.db.exec(
      `UPDATE scheduler_logs
       SET job_id = (SELECT job_id FROM scheduler_jobs WHERE scheduler_jobs.name = scheduler_logs.job_name)
       WHERE job_id IS NULL OR job_id = ''`,
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS scheduler_logs_job_id_sequence ON scheduler_logs(job_id, sequence)',
    );
    this.ensureAnnouncementOutboxColumns();
  }

  /**
   * Development builds before the accounting migration created these monitor
   * tables through a second SQLite handle. They already used this file path,
   * so the migration is only additive: retain every trigger and add the
   * receipt/phase/deadline facts that make post-crash reconciliation honest.
   */
  private ensureExternalMonitorColumns(): void {
    const add = (sql: string) => {
      try {
        this.db.exec(sql);
      } catch {
        // Existing migrated schema.
      }
    };
    add('ALTER TABLE external_monitor_triggers ADD COLUMN task_id TEXT');
    add('ALTER TABLE external_monitor_triggers ADD COLUMN session_id TEXT');
    add('ALTER TABLE external_monitor_triggers ADD COLUMN turn_id TEXT');
    add(
      "ALTER TABLE external_monitor_triggers ADD COLUMN phase TEXT NOT NULL DEFAULT 'reserved'",
    );
    add('ALTER TABLE external_monitor_triggers ADD COLUMN deadline_at TEXT');
    add(
      'ALTER TABLE external_monitor_triggers ADD COLUMN reserved_turns INTEGER NOT NULL DEFAULT 0',
    );
    add(
      'ALTER TABLE external_monitor_triggers ADD COLUMN reserved_tokens INTEGER NOT NULL DEFAULT 0',
    );
    add(
      'ALTER TABLE external_monitor_triggers ADD COLUMN reserved_runtime_ms INTEGER NOT NULL DEFAULT 0',
    );
    add(
      'ALTER TABLE external_monitor_triggers ADD COLUMN terminal_announced_at TEXT',
    );
    add(
      'ALTER TABLE external_monitor_triggers ADD COLUMN terminal_announce_lease_until_ms INTEGER',
    );
    add(
      'ALTER TABLE external_monitor_triggers ADD COLUMN terminal_announce_lease_token TEXT',
    );
    this.db.exec(
      "UPDATE external_monitor_triggers SET phase = CASE WHEN state = 'running' AND task_id IS NOT NULL THEN 'task-attached' WHEN state = 'running' THEN 'reserved' ELSE 'terminal' END WHERE phase IS NULL OR phase = ''",
    );
    this.db.exec(
      "UPDATE external_monitor_triggers SET deadline_at = created_at WHERE deadline_at IS NULL OR deadline_at = ''",
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS external_monitor_owner_active ON external_monitor_triggers(owner_id, state, deadline_at)',
    );
  }

  /**
   * A ledger written before the announcement outbox has failed runs whose
   * announcement state nothing recorded. Adding the columns would make every
   * one of them read as owed, so the first boot after an upgrade would
   * announce the entire history. Close them instead, with the reason, and let
   * the outbox govern only the runs recorded from here on.
   *
   * WHICH history gets closed is decided by the COLUMNS, not by the marker,
   * and the difference matters because two very different databases can
   * arrive here without a marker:
   *
   *  - No columns: a genuine pre-outbox ledger. Every existing row predates
   *    the mechanism, so the backfill stamps them all as history.
   *  - Columns but no marker: a ledger that already ran an EARLIER build of
   *    this upgrade — one that added the columns and stamped its own history
   *    before the marker existed. It has been recording owed rows ever since.
   *    Backfilling here would close genuinely owed failures nobody has been
   *    told about, which is the exact loss this outbox exists to prevent, and
   *    it would do it silently. So: write the marker, stamp nothing. Any NULL
   *    left in such a database is owed, and the retention window bounds how
   *    far back the sweep will act on it.
   *
   * The whole decision is remade INSIDE the transaction. Two Stations can
   * boot over one new home simultaneously, and a list of missing columns read
   * before the write lock is stale the moment the other instance commits its
   * ALTERs — the second would then re-add a column that now exists and fail
   * initialization outright. `BEGIN IMMEDIATE` serialises them; re-reading
   * under it is what makes the loser a no-op instead of a crash.
   *
   * DDL, backfill and marker share that one transaction (SQLite's DDL is
   * transactional), so a crash anywhere in here rolls back to the shape it
   * started from and the next boot repeats the whole thing. A fresh database,
   * whose columns arrive with the CREATE TABLE, still writes the marker —
   * over an empty table — so it starts life already migrated.
   */
  private ensureAnnouncementOutboxColumns(): void {
    const missing = (column: string): boolean =>
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS present FROM pragma_table_info('scheduler_logs') WHERE name = ?",
          )
          .get(column) as { present: number }
      ).present === 0;
    const outboxColumns: Array<[string, string]> = [
      ['announced_at', 'TEXT'],
      ['announcement_skip_reason', 'TEXT'],
      ['announce_lease_until_ms', 'INTEGER'],
      ['announce_lease_token', 'TEXT'],
    ];
    const alreadyMigrated = (): boolean =>
      this.db
        .prepare('SELECT value FROM scheduler_ledger_meta WHERE key = ?')
        .get(ANNOUNCEMENT_OUTBOX_MIGRATION_KEY) !== undefined;
    if (!outboxColumns.some(([column]) => missing(column)) && alreadyMigrated())
      return;
    this.transaction(() => {
      if (alreadyMigrated()) {
        // Another instance won the race and finished the whole upgrade while
        // this one waited for the write lock.
        for (const [column, type] of outboxColumns) {
          if (missing(column)) {
            this.db.exec(
              `ALTER TABLE scheduler_logs ADD COLUMN ${column} ${type}`,
            );
          }
        }
        return;
      }
      const preOutbox = missing('announced_at');
      for (const [column, type] of outboxColumns) {
        if (missing(column)) {
          this.db.exec(
            `ALTER TABLE scheduler_logs ADD COLUMN ${column} ${type}`,
          );
        }
      }
      if (preOutbox) {
        // No announcement column existed a moment ago, so no row here can be
        // an owed run: they all predate the mechanism.
        this.db
          .prepare(
            'UPDATE scheduler_logs SET announced_at = ?, announcement_skip_reason = ? WHERE announced_at IS NULL',
          )
          .run(new Date().toISOString(), ANNOUNCEMENT_SKIPPED_BEFORE_OUTBOX);
      }
      this.db
        .prepare(
          'INSERT OR REPLACE INTO scheduler_ledger_meta(key, value) VALUES (?, ?)',
        )
        .run(ANNOUNCEMENT_OUTBOX_MIGRATION_KEY, new Date().toISOString());
    });
  }
}

export function toScheduledJob(
  stored: StoredSchedulerJob,
): ScheduledJob | null {
  const schedule = stored.schedule
    ? stored.schedule
    : stored.cron
      ? { kind: 'cron' as const, expr: stored.cron }
      : null;
  if (!schedule) return null;
  const createdMs = Date.parse(stored.createdAt);
  return {
    schedule,
    lastRunMs: stored.lastRunMs,
    createdMs: Number.isNaN(createdMs) ? 0 : createdMs,
    enabled: stored.enabled,
  };
}

function parseStoredJob(value: string): StoredSchedulerJob {
  try {
    const parsed = JSON.parse(value) as StoredSchedulerJob;
    if (
      !parsed ||
      typeof parsed.name !== 'string' ||
      typeof parsed.prompt !== 'string'
    ) {
      throw new Error('invalid scheduler job record');
    }
    return parsed;
  } catch (error) {
    throw new Error('Scheduler ledger contains corrupt job state', {
      cause: error,
    });
  }
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function validStarterManualJob(job: StoredSchedulerJob): boolean {
  return (
    job.name === SCHEDULER_STARTER_CHECK_JOB_NAME &&
    job.prompt === SCHEDULER_STARTER_CHECK_PROMPT &&
    job.agent === 'station' &&
    job.enabled === false &&
    job.notifyStart === false &&
    job.retryCount === 0 &&
    job.cron === undefined &&
    job.lastRunMs === undefined &&
    job.schedule?.kind === 'every' &&
    Number.isInteger(job.schedule.everyMs) &&
    job.schedule.everyMs === SCHEDULER_STARTER_CHECK_EVERY_MS &&
    typeof job.createdAt === 'string' &&
    !Number.isNaN(Date.parse(job.createdAt)) &&
    new Date(job.createdAt).toISOString() === job.createdAt
  );
}

function starterJobDefinitionMatches(
  stored: StoredSchedulerJob,
  requested: StoredSchedulerJob,
): boolean {
  const definition = (job: StoredSchedulerJob) => ({
    name: job.name,
    prompt: job.prompt,
    agent: job.agent,
    notifyStart: job.notifyStart,
    retryCount: job.retryCount,
    retryDelaySecs: job.retryDelaySecs,
    cron: job.cron,
    schedule: job.schedule,
  });
  return (
    JSON.stringify(definition(stored)) === JSON.stringify(definition(requested))
  );
}

function freezeJob(job: StoredSchedulerJob): StoredSchedulerJob {
  return Object.freeze(structuredClone(job));
}

function assertCanonicalLegacyJobName(name: string): void {
  const candidate = resolve(join('/scheduler-legacy-name', `${name}.json`));
  if (!candidate.startsWith(`${resolve('/scheduler-legacy-name')}${sep}`)) {
    throw new Error('Legacy scheduler job identity is not path-safe');
  }
}

function ensureRealDirectory(path: string, label: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

/**
 * Ephemeris owns schedule math.  For the ledger's "fire newest once" catch-up
 * policy, derive the latest due occurrence in bounded work: closed-form for
 * interval/one-shot schedules and a millisecond binary search over Ephemeris'
 * strict-next operation for cron.  This avoids walking a decades-old
 * minute-cron one occurrence at a time.
 */
function latestOccurrenceAtOrBefore(
  scheduled: ScheduledJob,
  now: number,
): number | undefined {
  const schedule = scheduled.schedule;
  if (schedule.kind === 'at') {
    return scheduled.lastRunMs === undefined && schedule.timeMs <= now
      ? schedule.timeMs
      : undefined;
  }
  const origin = scheduled.lastRunMs ?? scheduled.createdMs;
  if (schedule.kind === 'every') {
    if (now <= origin) return undefined;
    const steps = Math.floor((now - origin) / schedule.everyMs);
    return steps > 0 ? origin + steps * schedule.everyMs : undefined;
  }
  const first = nextOccurrence(schedule, origin);
  if (first === null || first > now) return undefined;
  let low = origin;
  let high = now;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    const next = nextOccurrence(schedule, middle);
    if (next !== null && next <= now) low = middle;
    else high = middle - 1;
  }
  const latest = nextOccurrence(schedule, low);
  return latest !== null && latest <= now ? latest : first;
}

function monitorDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Canonical defaults are materialized before monitor execution is admitted. */
export function normalizeMonitorBudget(
  input?: MonitorBudget,
): Required<MonitorBudget> {
  const value = { ...EXTERNAL_MONITOR_DEFAULT_BUDGET, ...input };
  for (const [key, maximum] of Object.entries(EXTERNAL_MONITOR_MAX_BUDGET)) {
    const current = value[key as keyof MonitorBudget];
    if (!Number.isFinite(current) || current === undefined || current <= 0)
      throw new Error(`Invalid external monitor ${key}`);
    if (current > maximum)
      throw new Error(`External monitor ${key} exceeds the fixed maximum`);
  }
  return value as Required<MonitorBudget>;
}

const SCHEDULER_LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scheduler_ledger_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scheduler_jobs (
    name TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_run_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS scheduler_claims (
    run_id TEXT PRIMARY KEY,
    job_name TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    started_ms INTEGER NOT NULL,
    job_data TEXT NOT NULL,
    scheduled_for_ms INTEGER,
    manual INTEGER NOT NULL,
    missed_count INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    invocation_started INTEGER NOT NULL DEFAULT 0,
    owner_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    owner_birth TEXT
  );
  CREATE TABLE IF NOT EXISTS scheduler_starter_manual_intents (
    operation_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scheduler_logs (
    id TEXT NOT NULL UNIQUE,
    job_name TEXT NOT NULL,
    job_id TEXT,
    data TEXT NOT NULL,
    -- The announcement outbox. NULL means this run's failure is still owed
    -- to the user; a timestamp means the decision is durable, and
    -- announcement_skip_reason says whether it was told or dropped.
    announced_at TEXT,
    announcement_skip_reason TEXT,
    -- Set while one process is announcing this run; expires so a claimant
    -- that died cannot hold the row shut.
    announce_lease_until_ms INTEGER,
    -- Identifies the claimant, so an expired one cannot write over its
    -- successor's lease.
    announce_lease_token TEXT,
    sequence INTEGER PRIMARY KEY AUTOINCREMENT
  );
  CREATE INDEX IF NOT EXISTS scheduler_logs_job_sequence
    ON scheduler_logs(job_name, sequence);
  -- These rows intentionally share scheduler.sqlite and its write
  -- transactions. A monitor trigger is a scheduler admission, not a second
  -- independently durable workflow.
  CREATE TABLE IF NOT EXISTS external_monitor_state (
    monitor_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    usage_known INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (monitor_id, owner_id)
  );
  CREATE TABLE IF NOT EXISTS external_monitor_triggers (
    trigger_id TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    task_id TEXT,
    session_id TEXT,
    turn_id TEXT,
    phase TEXT NOT NULL DEFAULT 'reserved'
      CHECK(phase IN ('reserved','task-attached','terminal')),
    state TEXT NOT NULL CHECK(state IN ('running','completed','failed','indeterminate')),
    created_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    reserved_turns INTEGER NOT NULL DEFAULT 0,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_runtime_ms INTEGER NOT NULL DEFAULT 0,
    settled_at TEXT,
    -- A terminal Task can be written before the process reaches the bell.
    -- These durable fields make that notification retryable after a crash.
    terminal_announced_at TEXT,
    terminal_announce_lease_until_ms INTEGER,
    terminal_announce_lease_token TEXT,
    UNIQUE(monitor_id, owner_id, fingerprint)
  );
  -- Probe-only terminal outcomes never create a Task trigger, but their
  -- state transition and notification must still survive a process crash.
  CREATE TABLE IF NOT EXISTS external_monitor_probe_announcements (
    id TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL,
    job_name TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('terminal','unauthorized','budget-exhausted')),
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    lease_until_ms INTEGER,
    lease_token TEXT
  );
  CREATE INDEX IF NOT EXISTS external_monitor_probe_announcements_owed
    ON external_monitor_probe_announcements(delivered_at, created_at);
  CREATE TABLE IF NOT EXISTS external_monitor_outcomes (
    trigger_id TEXT PRIMARY KEY REFERENCES external_monitor_triggers(trigger_id),
    monitor_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    day TEXT NOT NULL,
    turns INTEGER,
    tokens INTEGER,
    runtime_ms INTEGER,
    usage_known INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS external_monitor_outcomes_budget
    ON external_monitor_outcomes(monitor_id, owner_id, day);
  CREATE INDEX IF NOT EXISTS external_monitor_owner_active
    ON external_monitor_triggers(owner_id, state, deadline_at);
`;
