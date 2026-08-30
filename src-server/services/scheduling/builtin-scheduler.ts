import {
  nextOccurrences,
  type Schedule,
  validateSchedule,
} from '@kontourai/ephemeris';
import {
  SCHEDULER_EXECUTION_LIMITS,
  type SchedulerManualRunReceipt,
} from '@kontourai/station-contracts/scheduler';
import { SCHEDULED_CHECK_STARTER_DEFINITION_VERSION } from '@kontourai/station-contracts/starter-work';
import type {
  AddJobOpts,
  SchedulerCapability,
  SchedulerJob,
  SchedulerLogEntry,
  SchedulerProviderStats,
  SchedulerProviderStatus,
} from '../../providers/provider-contracts.js';
import type { ISchedulerProvider } from '../../providers/provider-interfaces.js';
import {
  schedulerConcurrencyDeferrals,
  schedulerHealthy,
} from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import { schedulerJobCorrelationBindings } from '../../utils/logger-correlation.js';
import { SSEBroadcaster } from '../infra/sse-broadcaster.js';
import type { NotificationService } from '../notifications/notification-service.js';
import { createScheduleRunId } from '../orchestration/run-projection.js';
import type { IntegrationSecretResolver } from '../secrets/secret-binding-administration.js';
import {
  announceSchedulerJobFailure,
  executeSchedulerJobAttempt,
  type SchedulerExecutionResult,
} from './builtin-scheduler-execution.js';
import {
  decideExternalMonitor,
  parseGitHubPullRequestTarget,
  probeGitHubPullRequest,
} from './external-monitor.js';
import {
  type AttachedMonitorTrigger,
  createSchedulerLedger,
  type MonitorProbeTerminalAnnouncement,
  type MonitorProbeTerminalAnnouncementOutbox,
  type MonitorTerminal,
  type MonitorTerminalAnnouncementOutbox,
  normalizeMonitorBudget,
  SCHEDULER_STARTER_CHECK_EVERY_MS,
  SCHEDULER_STARTER_CHECK_JOB_NAME,
  SCHEDULER_STARTER_CHECK_PROMPT,
  type SchedulerAnnouncementClaim,
  type SchedulerAnnouncementOutbox,
  type SchedulerDispatchReceipt,
  type SchedulerLedger,
  type SchedulerReadOutcome,
  type SchedulerStarterReleaseOutcome,
  SchedulerStorageCorruptError,
  SchedulerStorageUnavailableError,
  type SchedulerUnavailable,
  type StoredSchedulerJob,
} from './scheduler-ledger.js';

/**
 * "Locked, ask again" and "these bytes are damaged" are different facts and
 * deserve different errors.
 *
 * Before archive#3220 both arrived as `SchedulerStorageUnavailableError`,
 * which the routes map to 503 — an answer that tells an operator to retry a
 * store that retrying cannot fix, and tells the UI the scheduler is merely
 * busy. A corrupt ledger now raises the error that names the damage and the
 * restore command, and falls to 500 because it is not a "come back later".
 */
function storageError(outcome: SchedulerUnavailable): Error {
  return outcome.reason === 'corrupt'
    ? new SchedulerStorageCorruptError()
    : new SchedulerStorageUnavailableError();
}

export class SchedulerJobConflictError extends Error {
  constructor(name: string) {
    super(`Job '${name}' already exists`);
    this.name = 'SchedulerJobConflictError';
  }
}

/** A monitor dispatches a Task through its declared Station authority only. */
function assertMonitorAuthority(
  input: Pick<AddJobOpts, 'monitor' | 'retryCount' | 'trustAllTools'>,
): void {
  if (!input.monitor?.projectId?.trim())
    throw new Error('External monitor requires a project');
  if (!input.monitor.agentId.trim())
    throw new Error('External monitor requires a Task Agent');
  if (input.trustAllTools)
    throw new Error('External monitor cannot enable generic tool trust');
  if ((input.retryCount ?? 0) !== 0)
    throw new Error(
      'External monitor owns deterministic adoption and cannot use generic retries',
    );
}

/** One terminal fact has one NotificationService identity across every retry. */
function monitorTerminalDedupeTag(id: string): string {
  return `external-monitor:terminal:${id}`;
}

/** Configuration equality is semantic: object key order cannot reset a monitor. */
function canonicalMonitorConfig(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalMonitorConfig).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalMonitorConfig(record[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Only a source/authority identity starts a new monitor ledger generation. */
function monitorIdentity(value: unknown): string {
  const monitor = value as Record<string, unknown> | null | undefined;
  return canonicalMonitorConfig(
    monitor
      ? {
          target: monitor.target,
          objective: monitor.objective,
          projectId: monitor.projectId,
          agentId: monitor.agentId,
        }
      : null,
  );
}

function monitorBusyMessage(target: string): string {
  return `Job '${target}' has a monitor task whose outcome is still authoritative; observe or resolve it before changing, restarting, or removing the monitor`;
}

/** Health window: a tick older than this marks the scheduler unhealthy. */
const HEALTH_WINDOW_MS = 120_000;

/** Spread for the re-sweep, so two Stations do not wake on the same tick. */
const OWED_ANNOUNCEMENT_RETRY_JITTER_MS = 500;

// ── Provider ──

/**
 * The scheduler's execution seam.  A receipt exists before this Adapter is
 * invoked, so scheduled work is attributable without pretending it is an
 * interactive `/chat` request.  Unattended tool calls retain the runtime's
 * fail-closed no-approval-channel policy.
 */
export type ScheduledTurnOutcome =
  | { kind: 'completed'; output: string }
  | { kind: 'definitely-not-invoked'; error: string }
  | { kind: 'indeterminate'; error: string };

export interface ScheduledTurnAdapter {
  invoke(input: {
    agentSlug: string;
    prompt: string;
    receipt: Pick<
      SchedulerDispatchReceipt,
      'id' | 'jobId' | 'job' | 'startedAt' | 'manual' | 'missedCount'
    >;
    approval: 'unattended-deny';
    principal: Readonly<{
      kind: 'scheduled-job';
      jobId: string;
      runId: string;
    }>;
    signal: AbortSignal;
  }): Promise<ScheduledTurnOutcome>;
}

export interface BuiltinSchedulerOptions {
  logger?: Logger;
  ledger?: SchedulerLedger;
  turnAdapter: ScheduledTurnAdapter;
  notificationService?: NotificationService | null;
  integrationSecretResolver?: IntegrationSecretResolver;
  onActionableMonitor?: (input: {
    jobName: string;
    jobId: string;
    fingerprint: string;
    triggerId: string;
    projectId: string;
    agentId: string;
    prompt: string;
    principal: { kind: 'scheduled-job'; jobId: string; runId: string };
    /** Private execution authority, always fully materialized by the scheduler. */
    monitor: Readonly<{
      signal: AbortSignal;
      deadlineAt: number;
      maxCompletedTurns: number;
      maxTokens: number;
      onInitialTurnStarted: (task: {
        taskId: string;
        sessionId: string;
        turnId: string;
      }) => void;
    }>;
  }) => Promise<{
    task: { taskId: string; sessionId?: string; turnId?: string };
    outcome:
      | 'definitely-not-started'
      | 'started'
      | 'adopted'
      | 'terminal'
      | 'contended'
      /** A provider request may have crossed the remote boundary. Keep the reservation. */
      | 'possible-start';
  }>;
  /** Supplies authoritative Task terminal receipts on boot and each tick. */
  readMonitorTerminals?: (
    triggers: readonly AttachedMonitorTrigger[],
  ) => Promise<readonly MonitorTerminal[]>;
  /** Stops a live Task once its exact observed usage reaches its reservation. */
  enforceMonitorLimits?: (
    triggers: readonly AttachedMonitorTrigger[],
  ) => Promise<readonly MonitorTerminal[]>;
  /** Re-arms the monitor-only turn observer for persisted running Tasks. */
  adoptMonitorTasks?: (input: {
    triggers: readonly AttachedMonitorTrigger[];
    signal: AbortSignal;
    onInitialTurnStarted: (
      triggerId: string,
      task: { taskId: string; sessionId: string; turnId: string },
    ) => void;
  }) => void;
  onMonitorTerminal?: (triggerId: string) => void;
  /** Releases server-only monitor observers when the scheduler is disposed. */
  disposeMonitorTasks?: () => void;
}

export const STARTER_SCHEDULED_CHECK_DEFINITION_VERSION =
  SCHEDULED_CHECK_STARTER_DEFINITION_VERSION;
export const STARTER_SCHEDULED_CHECK_JOB_NAME =
  SCHEDULER_STARTER_CHECK_JOB_NAME;

export interface PreparedStarterScheduledRun {
  readonly replayed: boolean;
  readonly completion: 'running' | 'completed' | 'failed' | 'indeterminate';
  readonly reference: {
    readonly kind: 'receipt';
    readonly owner: 'scheduler-run';
    readonly id: string;
  };
  readonly receipt: SchedulerManualRunReceipt;
  readonly activate?: () => Promise<SchedulerManualRunReceipt>;
  readonly releaseUnstarted?: () => SchedulerStarterReleaseOutcome;
}

export type StarterScheduledCheckPrepareCode =
  | 'busy'
  | 'capacity'
  | 'collision'
  | 'corrupt'
  | 'invalid'
  | 'unavailable';

export class StarterScheduledCheckPrepareError extends Error {
  constructor(
    readonly code: StarterScheduledCheckPrepareCode,
    readonly retrySafe: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'StarterScheduledCheckPrepareError';
  }
}

export class BuiltinScheduler implements ISchedulerProvider {
  readonly id = 'built-in';
  readonly displayName = 'Built-in Scheduler';
  readonly capabilities: SchedulerCapability[] = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private runningJobs = new Map<string, Promise<void>>();
  /** Invocation permits, intentionally narrower than whole retry lifecycles. */
  private activeInvocations = new Set<string>();
  private invocationCapacityWaiters = new Set<() => void>();
  private sse = new SSEBroadcaster();
  private readonly notificationService: NotificationService | null;
  private readonly ledger: SchedulerLedger;
  private readonly announcementOutbox: SchedulerAnnouncementOutbox;
  private readonly monitorTerminalOutbox: MonitorTerminalAnnouncementOutbox;
  private readonly monitorProbeTerminalOutbox: MonitorProbeTerminalAnnouncementOutbox;
  /** In-flight announcements, so `stop()` cannot outrun the bell. */
  private pendingAnnouncements = new Set<Promise<void>>();
  /** At most one armed re-sweep for a run another claimant still holds. */
  private owedAnnouncementRetry: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt = 0;
  private stopping = false;
  private closed = false;
  private readonly stopController = new AbortController();
  private monitorDeadlineTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private reconcilingMonitorTerminals = false;

  constructor(private readonly options: BuiltinSchedulerOptions) {
    this.notificationService = options.notificationService ?? null;
    this.ledger =
      options.ledger ??
      createSchedulerLedger({
        // A run this process abandoned by dying is still a failed run on the
        // Schedule page. Nothing is executing when reconciliation writes it,
        // so the ledger reports it here and it takes the same route to the
        // user as an invocation failure.
        onAbandonedRun: (entry) => this.announceFailedRun(entry),
      });
    this.announcementOutbox = this.ledger.announcementOutbox();
    this.monitorTerminalOutbox =
      this.ledger.monitorTerminalAnnouncementOutbox();
    this.monitorProbeTerminalOutbox =
      this.ledger.monitorProbeTerminalAnnouncementOutbox();
  }

  start() {
    if (this.stopping || this.closed) {
      throw new Error('Scheduler has been stopped and cannot be restarted');
    }
    if (this.timer) return;
    void this.reconcileExternalMonitorTerminals();
    this.sweepOwedMonitorTerminalAnnouncements();
    this.sweepOwedMonitorProbeTerminalAnnouncements();
    // Before anything else this boot does: say what the last one could not.
    // A failure is written durably and announced afterwards, so a process
    // that dies in between leaves a Failed row nobody was ever told about —
    // and the in-memory buffer that carried it is gone with the process.
    this.sweepOwedFailureAnnouncements();
    this.timer = setInterval(() => this.tick(), 60_000);
    this.watchdog = setInterval(() => this.checkHealth(), HEALTH_WINDOW_MS);
    schedulerHealthy.addCallback((obs) => {
      const age = this.lastTickAt ? Date.now() - this.lastTickAt : null;
      obs.observe(
        this.timer !== null && (age === null || age < HEALTH_WINDOW_MS) ? 1 : 0,
      );
    });
    this.tick();
  }

  async stop() {
    this.stopping = true;
    this.stopController.abort(new Error('Scheduler is stopping'));
    for (const timer of this.monitorDeadlineTimers.values())
      clearTimeout(timer);
    this.monitorDeadlineTimers.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.owedAnnouncementRetry) {
      clearTimeout(this.owedAnnouncementRetry);
      this.owedAnnouncementRetry = null;
    }
    await Promise.all(this.runningJobs.values());
    await Promise.all(this.pendingAnnouncements);
    if (!this.closed) {
      this.closed = true;
      this.ledger.close();
    }
    this.options.disposeMonitorTasks?.();
  }

  /**
   * The one call this class makes to announce a run the ledger recorded as
   * failed — the dead-owner listener and the boot sweep both go through it,
   * so the event, the notification and the durable stamp cannot drift apart
   * between them.
   */
  private announceFailedRun(entry: SchedulerLogEntry): Promise<void> {
    return this.trackAnnouncement(
      announceSchedulerJobFailure({
        job: entry.job,
        id: entry.id,
        error: entry.error ?? 'Failed without a recorded reason',
        broadcast: (event) => this.broadcast(event),
        notificationService: this.notificationService,
        outbox: this.announcementOutbox,
      }),
    );
  }

  /**
   * An announcement now completes only when a notification for it is durable,
   * and two of its callers cannot await it: the ledger's dead-owner listener
   * is synchronous, and `start()` is not async. Tracking them here is what
   * keeps `stop()` honest — a scheduler that stopped while an announcement
   * was still deciding would report shutdown before the bell had the failure.
   */
  private trackAnnouncement(announcement: Promise<void>): Promise<void> {
    const settled = announcement.catch(() => undefined);
    this.pendingAnnouncements.add(settled);
    void settled.finally(() => this.pendingAnnouncements.delete(settled));
    return settled;
  }

  /**
   * Drain the durable outbox. Everything it returns is a failure that is
   * durable and unannounced; announcing stamps it, so a later sweep over the
   * same store announces nothing again. Runs older than the ledger's
   * retention window are stamped as skipped rather than delivered, so a
   * Station that was off for a long time does not open with a wall of stale
   * notifications.
   *
   * Sweeping ONCE at start is not enough. The ordinary crash-recovery path is
   * a Station that died mid-announcement and came back seconds later — well
   * inside the dead claimant's 60s lease — where every owed row reads as
   * leased-elsewhere and this sweep announces nothing. Without a second look
   * that failure stays silent for the whole life of the restarted process.
   * So when the ledger reports a live lease, arm exactly ONE follow-up sweep
   * for just after it expires; that sweep arms another only if leases are
   * still held. It is a bounded chain, not a poll: a store with nothing
   * leased schedules nothing at all.
   */
  private sweepOwedFailureAnnouncements(): void {
    if (this.stopping || this.closed) return;
    const owed = this.ledger.owedFailureAnnouncements(Date.now());
    if (owed.kind === 'unavailable') {
      // Nothing is lost: the rows stay owed and the next sweep tries again.
      this.options.logger?.warn(
        'Scheduler could not read unannounced job failures at startup',
        { reason: owed.reason },
      );
      return;
    }
    for (const entry of owed.value.entries) {
      this.observe(() => void this.announceFailedRun(entry));
    }
    if (owed.value.retryAtMs !== undefined) {
      this.scheduleOwedAnnouncementRetry(owed.value.retryAtMs);
    }
  }

  /**
   * One pending re-sweep at a time, just past the earliest lease expiry.
   *
   * The jitter matters when two Stations share a home: without it both wake
   * at the same millisecond, race for the same claim, and the loser arms
   * another timer for the same instant. A small spread makes one of them win
   * outright.
   */
  private scheduleOwedAnnouncementRetry(retryAtMs: number): void {
    if (this.stopping || this.closed || this.owedAnnouncementRetry) return;
    const delayMs =
      Math.max(0, retryAtMs - Date.now()) +
      1 +
      Math.floor(Math.random() * OWED_ANNOUNCEMENT_RETRY_JITTER_MS);
    this.owedAnnouncementRetry = setTimeout(() => {
      this.owedAnnouncementRetry = null;
      this.observe(() => this.sweepOwedFailureAnnouncements());
    }, delayMs);
    // A pending retry must not be a reason for the process to stay alive.
    this.owedAnnouncementRetry.unref?.();
  }

  private trackJob(runId: string): () => void {
    let resolve: () => void;
    const p = new Promise<void>((r) => {
      resolve = r;
    });
    this.runningJobs.set(runId, p);
    return () => {
      this.runningJobs.delete(runId);
      resolve!();
    };
  }

  private trackInvocation(invocationId: string): () => void {
    this.activeInvocations.add(invocationId);
    return () => {
      this.activeInvocations.delete(invocationId);
      for (const wake of this.invocationCapacityWaiters) wake();
    };
  }

  /**
   * Retried/recovered receipts retain durable ownership while waiting. They
   * must not be deleted and reclaimed as attempt 1, so they wait for a permit
   * in memory and wake on either a release or scheduler shutdown.
   */
  private async waitForInvocationCapacity(): Promise<boolean> {
    while (
      !this.stopping &&
      this.activeInvocations.size >=
        SCHEDULER_EXECUTION_LIMITS.maxConcurrentJobs
    ) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.invocationCapacityWaiters.delete(wake);
          this.stopController.signal.removeEventListener('abort', wake);
          resolve();
        };
        this.invocationCapacityWaiters.add(wake);
        this.stopController.signal.addEventListener('abort', wake, {
          once: true,
        });
      });
    }
    return !this.stopping;
  }

  /** Replays terminal Task bells left owed by a crash or a refused queue. */
  private sweepOwedMonitorTerminalAnnouncements(): void {
    if (this.stopping || this.closed) return;
    const owed = this.ledger.owedMonitorTerminalAnnouncements();
    if (owed.kind !== 'available') return;
    const views = this.ledger.listViews();
    if (views.kind !== 'available') return;
    for (const terminal of owed.value) {
      const job = views.value.find(
        (view) => view.unattendedPrincipal?.jobId === terminal.monitorId,
      );
      if (job) this.announceMonitorTerminal(job, terminal.triggerId);
    }
  }

  private sweepOwedMonitorProbeTerminalAnnouncements(): void {
    if (this.stopping || this.closed) return;
    const owed = this.ledger.owedMonitorProbeTerminalAnnouncements();
    if (owed.kind !== 'available') return;
    for (const announcement of owed.value)
      this.announceMonitorProbeTerminal(announcement);
  }

  private announceMonitorTerminal(job: SchedulerJob, triggerId: string): void {
    this.announceMonitorTerminalNotification({
      id: triggerId,
      jobName: job.name,
      title: 'Monitor terminal result',
      body: 'Monitor task reached a terminal result; restart to resume.',
      outbox: this.monitorTerminalOutbox,
    });
  }

  private announceMonitorProbeTerminal(
    announcement: MonitorProbeTerminalAnnouncement,
  ): void {
    const title =
      announcement.outcome === 'unauthorized'
        ? 'Monitor authorization required'
        : announcement.outcome === 'budget-exhausted'
          ? 'Monitor budget exhausted'
          : 'Monitor complete';
    this.announceMonitorTerminalNotification({
      id: announcement.id,
      jobName: announcement.jobName,
      title,
      body: announcement.detail,
      outbox: this.monitorProbeTerminalOutbox,
    });
  }

  /**
   * Both Task and probe terminal outcomes use the same delivery protocol.
   * The ledger claim protects concurrent schedulers; NotificationService's
   * stable tag protects the crash-after-write-before-mark window.
   */
  private announceMonitorTerminalNotification(input: {
    id: string;
    jobName: string;
    title: string;
    body: string;
    outbox: {
      claim(id: string): SchedulerAnnouncementClaim;
      release(id: string, token: string): void;
      markDelivered(id: string, token: string): void;
    };
  }): void {
    const claim = input.outbox.claim(input.id);
    // Unknown storage is not a delivery lease. Announcing on it would create
    // an unbounded duplicate bell on every cadence; leave the durable row
    // owed for a later successful claim instead.
    if (claim.kind !== 'claimed') return;
    const token = claim.token;
    const delivered = new Promise<boolean>((resolve) => {
      if (!this.notificationService) return resolve(false);
      const admitted = this.notificationService.dispatch(
        'external-monitor-terminal',
        async () => {
          try {
            await this.notificationService!.schedule('scheduler', {
              category: 'external-monitor',
              title: input.title,
              body: input.body,
              priority: 'high',
              // Exactly one terminal outcome has exactly one bell identity.
              dedupeTag: monitorTerminalDedupeTag(input.id),
              actions: [{ id: 'view-scheduler', label: 'View Schedule' }],
              metadata: {
                jobName: input.jobName,
                link: `/schedule?job=${encodeURIComponent(input.jobName)}`,
              },
            });
            resolve(true);
          } catch (error) {
            resolve(false);
            throw error;
          }
        },
      );
      if (!admitted) resolve(false);
    });
    void this.trackAnnouncement(
      delivered.then((persisted) => {
        if (persisted) input.outbox.markDelivered(input.id, token);
        else input.outbox.release(input.id, token);
      }),
    );
  }

  private tick() {
    if (this.stopping || this.closed) return;
    void this.reconcileExternalMonitorTerminals();
    this.sweepOwedMonitorTerminalAnnouncements();
    this.sweepOwedMonitorProbeTerminalAnnouncements();
    let receipts: SchedulerDispatchReceipt[];
    try {
      receipts = this.requireRead(this.ledger.claimDue(Date.now()));
    } catch (error) {
      // Damage and contention used to produce the identical line, once a
      // minute, forever. The first is an incident — nothing this scheduler is
      // configured to run will run again until the store is restored — and
      // the log has to say so rather than reporting it as a busy moment.
      if (error instanceof SchedulerStorageCorruptError) {
        this.options.logger?.error(
          'Scheduler storage is corrupt; no scheduled job will run until it is restored',
          { error: error.message },
        );
      } else {
        this.options.logger?.warn('Scheduler storage unavailable during tick', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    this.lastTickAt = Date.now();
    for (const receipt of receipts) {
      void this.executeJob(receipt).catch((error) =>
        this.observe(() =>
          this.options.logger?.warn('Scheduler execution lifecycle failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }
  }

  /**
   * Task terminal truth may arrive while this process is alive or be waiting
   * in the Task graph when it boots again. Both paths use one receipt fold;
   * an unreadable/missing usage receipt remains unknown and is fenced by the
   * ledger rather than becoming a free retry.
   */
  private async reconcileExternalMonitorTerminals(): Promise<void> {
    if (this.reconcilingMonitorTerminals || !this.options.readMonitorTerminals)
      return;
    this.reconcilingMonitorTerminals = true;
    try {
      const active = this.ledger.activeMonitorTriggers();
      if (active.kind !== 'available' || active.value.length === 0) return;
      this.options.adoptMonitorTasks?.({
        triggers: active.value,
        signal: this.stopController.signal,
        onInitialTurnStarted: (triggerId, task) => {
          const attached = this.ledger.attachMonitorTask({ triggerId, task });
          if (attached.kind !== 'applied')
            this.ledger.settleMonitorTrigger({
              triggerId,
              terminal: 'indeterminate',
            });
        },
      });
      // Durable Task terminal truth wins over a sampled live limit. A task
      // that completed its allowed final turn between samples is success,
      // never an indeterminate limit fence (the default one-turn monitor
      // depends on this ordering).
      const terminalReceipts = await this.options.readMonitorTerminals(
        active.value,
      );
      const terminalIds = new Set(
        terminalReceipts.map((terminal) => terminal.triggerId),
      );
      const fenced = this.options.enforceMonitorLimits
        ? await this.options.enforceMonitorLimits(
            active.value.filter((entry) => !terminalIds.has(entry.triggerId)),
          )
        : [];
      const terminals = [...terminalReceipts, ...fenced];
      const settled = this.ledger.reconcileMonitorTerminals({ terminals });
      if (settled.kind === 'unavailable')
        this.options.logger?.warn(
          'Monitor terminal accounting is unavailable',
          {
            reason: settled.reason,
          },
        );
      if (settled.kind !== 'available') return;
      const byTrigger = new Map(
        active.value.map((entry) => [entry.triggerId, entry]),
      );
      const views = this.ledger.listViews();
      if (views.kind !== 'available') return;
      for (const terminal of terminals) {
        this.clearMonitorDeadline(terminal.triggerId);
        this.options.onMonitorTerminal?.(terminal.triggerId);
        const trigger = byTrigger.get(terminal.triggerId);
        if (!trigger) continue;
        // `attachMonitorTask` commits before the UI projection. A crash in
        // that gap must still fold the exact terminal receipt into the owning
        // job immediately; task-id lookup only worked after another probe.
        const job = views.value.find(
          (entry) => entry.unattendedPrincipal?.jobId === trigger.monitorId,
        );
        if (!job) continue;
        if (job.monitorState?.lastOutcome !== 'terminal') {
          const update = this.ledger.update(job.name, {
            monitorState: {
              ...job.monitorState,
              lastOutcome: 'terminal',
              nextAction:
                'Monitor task reached a terminal result; restart to resume.',
              usageKnown: terminal.usage !== undefined,
            },
          });
          if (update.kind !== 'updated') continue;
          this.broadcast({
            event: 'monitor.terminal',
            job: job.name,
            provider: this.id,
            id: terminal.triggerId,
            monitorOutcome: 'terminal',
          });
        }
        this.announceMonitorTerminal(job, terminal.triggerId);
      }
    } catch (error) {
      this.options.logger?.warn('Monitor terminal reconciliation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.reconcilingMonitorTerminals = false;
    }
  }

  private async executeJob(initialReceipt: SchedulerDispatchReceipt) {
    const { job } = initialReceipt;
    const done = this.trackJob(initialReceipt.id);
    let receipt = initialReceipt;
    let releaseInvocation: (() => void) | undefined;
    // archive#1897 logging slice 3: bound ONCE per execution attempt, so
    // this run's own start/success/failure log lines all carry the SAME
    // `jobName`/`jobRunId` a `read_logs?q=<id>` query can key off — there
    // was no Logger-seam logging anywhere on this path before (only the
    // `broadcast()` SSE events below, which this does not replace).
    try {
      for (;;) {
        if (this.stopping) {
          return {
            logId: `${receipt.id}-${receipt.attempt}`,
            outcome: 'indeterminate' as const,
            success: false,
            error: 'Scheduler stopped before the next retry invocation',
            durationSecs: 0,
          };
        }
        if (
          !receipt.manual &&
          this.activeInvocations.size >=
            SCHEDULER_EXECUTION_LIMITS.maxConcurrentJobs
        ) {
          if (receipt.attempt > 1) {
            if (!(await this.waitForInvocationCapacity())) {
              return {
                logId: `${receipt.id}-${receipt.attempt}`,
                outcome: 'indeterminate' as const,
                success: false,
                error: 'Scheduler stopped before the next retry invocation',
                durationSecs: 0,
              };
            }
          } else {
            const released = receipt.releaseDeferred();
            const reason = SCHEDULER_EXECUTION_LIMITS.concurrencyDeferralReason;
            if (released.kind === 'applied') {
              this.observe(() =>
                this.options.logger?.warn(
                  'Scheduler occurrence deferred by concurrency limit',
                  {
                    job: job.name,
                    reason,
                    maxConcurrentJobs:
                      SCHEDULER_EXECUTION_LIMITS.maxConcurrentJobs,
                  },
                ),
              );
              this.observe(() =>
                schedulerConcurrencyDeferrals.add(1, { reason }),
              );
              this.observe(() =>
                this.broadcast({
                  event: 'job.deferred',
                  job: job.name,
                  provider: this.id,
                  reason,
                }),
              );
              return {
                logId: `${receipt.id}-${receipt.attempt}`,
                outcome: 'deferred' as const,
                success: false,
                error: `Scheduler job deferred: ${reason} (${SCHEDULER_EXECUTION_LIMITS.maxConcurrentJobs} concurrent jobs)`,
                durationSecs: 0,
              };
            }
            return {
              logId: `${receipt.id}-${receipt.attempt}`,
              outcome: 'indeterminate' as const,
              success: false,
              error: `Scheduler concurrency deferral receipt is ${released.kind}`,
              durationSecs: 0,
            };
          }
        }
        const attempt = receipt.attempt;
        const maxAttempts = receipt.maxAttempts;
        const id = `${receipt.id}-${attempt}`;
        releaseInvocation = this.trackInvocation(id);
        let jobLogger: Logger | undefined;
        try {
          jobLogger = this.options.logger?.child(
            schedulerJobCorrelationBindings({
              jobName: job.name,
              jobRunId: id,
            }),
          );
        } catch {
          // Logging is observer-only and cannot prevent durable invocation.
        }
        this.observe(() =>
          jobLogger?.info('Scheduler job started', {
            manual: receipt.manual,
            attempt,
            maxAttempts,
          }),
        );
        this.observe(() =>
          this.broadcast({
            event: 'job.started',
            job: job.name,
            provider: this.id,
            id,
          }),
        );
        const monitorResult = await this.executeExternalMonitor(receipt);
        const result =
          monitorResult ??
          (await executeSchedulerJobAttempt({
            job,
            id,
            manual: receipt.manual,
            attempt,
            maxAttempts,
            startedAt: receipt.startedAt,
            receipt,
            turnAdapter: this.options.turnAdapter,
            notificationService: this.notificationService,
            broadcast: (event) => this.broadcast(event),
            announcementOutbox: this.announcementOutbox,
            logger: jobLogger,
            signal: this.stopController.signal,
          }));
        // The provider/monitor attempt has settled. Durable retry handling,
        // notifications, and configured backoff remain part of this job
        // lifecycle, but none is an active invocation and none holds a slot.
        releaseInvocation();
        releaseInvocation = undefined;
        if (result.pendingNotInvoked) {
          const pending = result.pendingNotInvoked;
          const recovered = await this.retryNotInvokedTransition(pending);
          if (!recovered) return result;
          // `stale` is the one recovery that wrote nothing: no failed row
          // exists for this attempt, so there is nothing to announce.
          if (recovered.kind === 'stale') return result;
          // `terminal` and `claimed` both mean the retained transition landed
          // and THIS attempt is now a durable failed run. The execution path
          // could not announce it — its own transition came back unavailable,
          // which is why the capability was retained — so this is the only
          // place that can. The reason announced is the one the ledger stored
          // (`pending.input.error`), not `result.error`, which carries a
          // storage-unavailable parenthetical the run row never shows.
          await this.trackAnnouncement(
            announceSchedulerJobFailure({
              job: job.name,
              id: result.logId,
              error: pending.input.error,
              broadcast: (event) => this.broadcast(event),
              notificationService: this.notificationService,
              outbox: this.announcementOutbox,
            }),
          );
          if (recovered.kind === 'terminal') {
            return {
              ...result,
              outcome: 'not-invoked',
              pendingNotInvoked: undefined,
            };
          }
          // `recordNotInvoked` has now durably advanced the exact receipt to
          // its next pre-invocation attempt.  It is just as retryable as the
          // ordinary `retryReceipt` path below, so do not let a transient
          // storage ambiguity bypass the job's configured backoff.
          if (!(await this.waitForConfiguredRetry(job))) {
            return this.stoppedRetryResult(result, recovered.receipt);
          }
          receipt = recovered.receipt;
          continue;
        }
        if (!result.retryReceipt) return result;
        if (!(await this.waitForConfiguredRetry(job))) {
          return this.stoppedRetryResult(result, result.retryReceipt);
        }
        receipt = result.retryReceipt;
      }
    } finally {
      releaseInvocation?.();
      done();
    }
  }

  /**
   * A monitor consumes the scheduler's already-atomic occurrence claim, then
   * settles a zero-turn outcome before an adapter can run. The same claim is
   * therefore the concurrency/restart fence for baseline and unchanged
   * observations as well as ordinary scheduled work.
   */
  private async executeExternalMonitor(
    receipt: SchedulerDispatchReceipt,
  ): Promise<SchedulerExecutionResult | undefined> {
    const config = receipt.job.monitor;
    if (!config) return undefined;
    const started = Date.now();
    const probed = await probeGitHubPullRequest(
      config,
      fetch,
      this.options.integrationSecretResolver,
    );
    let decision = decideExternalMonitor({
      state: receipt.job.monitorState,
      observation: probed.observation,
      actionable: probed.actionable,
      budget: config.budget,
    });
    this.broadcast({
      event: 'monitor.observed',
      job: receipt.job.name,
      provider: this.id,
      id: receipt.id,
      monitorOutcome: decision.outcome,
    });
    const prior = receipt.job.monitorState ?? {};
    let triggeredTaskId: string | undefined;
    let taskStartedOrAdopted = false;
    // A legacy/malformed monitor must not fall through to the generic model
    // adapter. Monitor dispatch is Task-only and has no trust/retry fallback.
    if (
      decision.shouldDispatch &&
      (!config.projectId ||
        !config.agentId ||
        !this.options.onActionableMonitor)
    ) {
      decision = {
        outcome: 'unavailable',
        fingerprint: decision.fingerprint,
        shouldDispatch: false,
        nextAction:
          'Monitor authority is incomplete; configure a project and Agent.',
      };
    }
    if (
      decision.shouldDispatch &&
      config.projectId &&
      decision.fingerprint &&
      this.options.onActionableMonitor
    ) {
      const reservation = this.ledger.reserveMonitorTrigger({
        monitorId: receipt.jobId,
        ownerId: 'personal',
        fingerprint: decision.fingerprint,
        budget: config.budget,
      });
      if (reservation.kind === 'blocked') {
        decision = {
          outcome: 'budget-exhausted',
          fingerprint: decision.fingerprint,
          shouldDispatch: false,
          nextAction:
            reservation.reason === 'unknown-usage'
              ? 'Completed-turn usage is unknown; resolve the prior task before restarting.'
              : 'Monitor budget is exhausted.',
        };
      } else if (reservation.kind === 'unavailable') {
        decision = {
          outcome: 'unavailable',
          shouldDispatch: false,
          nextAction: 'Monitor accounting storage is unavailable.',
        };
      } else if (reservation.kind === 'terminal') {
        decision = {
          outcome: 'terminal',
          fingerprint: decision.fingerprint,
          shouldDispatch: false,
          nextAction:
            'This revision already reached a terminal monitor outcome.',
        };
      } else if (reservation.kind === 'adopt' && reservation.task) {
        // Crash after attaching the Task but before projecting monitorState:
        // retain the exact Task/session receipt and never dispatch again.
        triggeredTaskId = reservation.task.taskId;
        taskStartedOrAdopted = true;
      } else if (reservation.kind === 'adopt') {
        // A crashed process has an admitted revision but no durable Task
        // receipt. Starting another Task would be an unauthorized duplicate.
        this.ledger.settleMonitorTrigger({
          triggerId: reservation.triggerId,
          terminal: 'indeterminate',
        });
        return {
          logId: `${receipt.id}-${receipt.attempt}`,
          outcome: 'indeterminate',
          success: false,
          error: 'Monitor dispatch was adopted without a Task receipt.',
          durationSecs: (Date.now() - started) / 1000,
        };
      } else {
        const controller = new AbortController();
        const deadlineAt = Date.parse(reservation.deadlineAt);
        const timer = Number.isFinite(deadlineAt)
          ? setTimeout(
              () => {
                this.monitorDeadlineTimers.delete(reservation.triggerId);
                controller.abort(new Error('monitor runtime budget exceeded'));
              },
              Math.max(0, deadlineAt - Date.now()),
            )
          : undefined;
        if (timer) this.monitorDeadlineTimers.set(reservation.triggerId, timer);
        const signal = AbortSignal.any([
          this.stopController.signal,
          controller.signal,
        ]);
        let dispatched: Awaited<
          ReturnType<NonNullable<typeof this.options.onActionableMonitor>>
        >;
        try {
          dispatched = await this.options.onActionableMonitor({
            jobName: receipt.job.name,
            jobId: receipt.jobId,
            fingerprint: decision.fingerprint,
            triggerId: reservation.triggerId,
            projectId: config.projectId!,
            agentId: config.agentId,
            prompt: receipt.job.prompt,
            principal: {
              kind: 'scheduled-job',
              jobId: receipt.jobId,
              runId: receipt.id,
            },
            monitor: {
              signal,
              deadlineAt,
              maxCompletedTurns: reservation.limits.maxTurns,
              maxTokens: reservation.limits.maxTokens,
              onInitialTurnStarted: (task) => {
                const attached = this.ledger.attachMonitorTask({
                  triggerId: reservation.triggerId,
                  task,
                });
                if (attached.kind !== 'applied') {
                  // The provider has started a real Task turn but the exact
                  // durable receipt could not be retained. Fence it rather
                  // than allowing a later monitor revision to spend around
                  // an un-attributable turn.
                  this.ledger.settleMonitorTrigger({
                    triggerId: reservation.triggerId,
                    terminal: 'indeterminate',
                  });
                }
              },
            },
          });
        } catch {
          this.clearMonitorDeadline(reservation.triggerId);
          this.ledger.settleMonitorTrigger({
            triggerId: reservation.triggerId,
            terminal: 'indeterminate',
          });
          return {
            logId: `${receipt.id}-${receipt.attempt}`,
            outcome: 'indeterminate',
            success: false,
            error: 'Monitor dispatch exceeded its execution bound.',
            durationSecs: (Date.now() - started) / 1000,
          };
        }
        triggeredTaskId = dispatched.task.taskId;
        if (
          this.ledger.attachMonitorTask({
            triggerId: reservation.triggerId,
            task: dispatched.task,
          }).kind !== 'applied'
        ) {
          this.clearMonitorDeadline(reservation.triggerId);
          return {
            logId: `${receipt.id}-${receipt.attempt}`,
            outcome: 'indeterminate',
            success: false,
            error: 'Monitor task receipt could not be persisted.',
            durationSecs: (Date.now() - started) / 1000,
          };
        }
        taskStartedOrAdopted =
          dispatched.outcome === 'started' || dispatched.outcome === 'adopted';
        if (dispatched.outcome === 'possible-start') {
          // A remote start may exist.  Do not settle, release, or account
          // zero usage: the durable reservation is the capacity fence until
          // exact Task/session reconciliation proves otherwise.
          return {
            logId: `${receipt.id}-${receipt.attempt}`,
            outcome: 'indeterminate',
            success: false,
            error:
              'Monitor task dispatch may have started; awaiting reconciliation.',
            durationSecs: (Date.now() - started) / 1000,
          };
        }
        if (!taskStartedOrAdopted) {
          this.clearMonitorDeadline(reservation.triggerId);
          this.ledger.settleMonitorTrigger({
            triggerId: reservation.triggerId,
            terminal:
              dispatched.outcome === 'definitely-not-started'
                ? 'failed'
                : 'indeterminate',
            ...(dispatched.outcome === 'definitely-not-started'
              ? { usage: { turns: 0, tokens: 0, runtimeMs: 0 } }
              : {}),
          });
          return {
            logId: `${receipt.id}-${receipt.attempt}`,
            outcome:
              dispatched.outcome === 'definitely-not-started'
                ? 'failed'
                : 'indeterminate',
            success: false,
            error: `Monitor task dispatch ${dispatched.outcome}.`,
            durationSecs: (Date.now() - started) / 1000,
          };
        }
      }
    }
    const monitorState = {
      ...prior,
      lastObservedAt: probed.observation.observedAt,
      lastOutcome: decision.outcome,
      nextAction: decision.nextAction,
      ...(decision.outcome === 'baseline' && decision.fingerprint
        ? { lastSuccessfulFingerprint: decision.fingerprint }
        : {}),
      ...(decision.outcome === 'actionable' &&
      decision.fingerprint &&
      taskStartedOrAdopted
        ? { lastTriggeredFingerprint: decision.fingerprint }
        : {}),
      ...(triggeredTaskId ? { triggeredTaskId } : {}),
    };
    if (decision.outcome === 'actionable')
      this.broadcast({
        event: 'monitor.actionable',
        job: receipt.job.name,
        provider: this.id,
        id: receipt.id,
        monitorOutcome: 'actionable',
      });
    if (
      decision.outcome === 'budget-exhausted' ||
      decision.outcome === 'unavailable'
    )
      this.broadcast({
        event: 'monitor.blocked',
        job: receipt.job.name,
        provider: this.id,
        id: receipt.id,
        monitorOutcome: decision.outcome,
        error: decision.nextAction,
      });
    const probeTerminalOutcome =
      decision.outcome === 'terminal' ||
      decision.outcome === 'unauthorized' ||
      decision.outcome === 'budget-exhausted';
    if (probeTerminalOutcome) {
      const recorded = this.ledger.recordMonitorProbeTerminal({
        name: receipt.job.name,
        monitorId: receipt.jobId,
        outcome:
          decision.outcome as MonitorProbeTerminalAnnouncement['outcome'],
        monitorState,
      });
      if (recorded.kind === 'unavailable') {
        return {
          logId: `${receipt.id}-${receipt.attempt}`,
          outcome: 'indeterminate',
          success: false,
          error: 'Monitor terminal outcome could not be persisted.',
          durationSecs: (Date.now() - started) / 1000,
        };
      }
      if (recorded.kind === 'not-found') {
        return {
          logId: `${receipt.id}-${receipt.attempt}`,
          outcome: 'indeterminate',
          success: false,
          error:
            'Monitor changed before its terminal outcome could be recorded.',
          durationSecs: (Date.now() - started) / 1000,
        };
      }
      if (recorded.kind === 'recorded') {
        this.broadcast({
          event: 'monitor.terminal',
          job: receipt.job.name,
          provider: this.id,
          id: recorded.announcement.id,
          monitorOutcome: 'terminal',
        });
        this.announceMonitorProbeTerminal(recorded.announcement);
      }
    } else {
      const stored = this.ledger.update(receipt.job.name, { monitorState });
      if (stored.kind !== 'updated') {
        return {
          logId: `${receipt.id}-${receipt.attempt}`,
          outcome: 'indeterminate',
          success: false,
          error: 'Monitor outcome could not be persisted.',
          durationSecs: (Date.now() - started) / 1000,
        };
      }
    }
    // A newly actionable revision continues through the existing one and only
    // scheduler turn adapter. All other monitor decisions are settled here,
    // so they cannot spend a model turn.
    if (decision.shouldDispatch) {
      if (triggeredTaskId) {
        const invoked = receipt.beginInvocation();
        if (invoked.kind === 'applied')
          receipt.settle({
            success: true,
            state: 'completed',
            completedAt: new Date().toISOString(),
            durationSecs: (Date.now() - started) / 1000,
            output: JSON.stringify({
              monitor: 'actionable',
              taskId: triggeredTaskId,
            }),
          });
        return {
          logId: `${receipt.id}-${receipt.attempt}`,
          outcome: 'completed',
          success: true,
          durationSecs: (Date.now() - started) / 1000,
        };
      }
      return undefined;
    }
    const invoked = receipt.beginInvocation();
    if (invoked.kind !== 'applied') {
      return {
        logId: `${receipt.id}-${receipt.attempt}`,
        outcome: 'indeterminate',
        success: false,
        error: 'Monitor receipt could not be authorized.',
        durationSecs: (Date.now() - started) / 1000,
      };
    }
    const output = JSON.stringify({
      monitor: decision.outcome,
      nextAction: decision.nextAction,
    });
    const settled = receipt.settle({
      success: true,
      state: 'completed',
      completedAt: new Date().toISOString(),
      durationSecs: (Date.now() - started) / 1000,
      output,
    });
    return settled.kind === 'applied'
      ? {
          logId: `${receipt.id}-${receipt.attempt}`,
          outcome: 'completed',
          success: true,
          durationSecs: (Date.now() - started) / 1000,
        }
      : {
          logId: `${receipt.id}-${receipt.attempt}`,
          outcome: 'indeterminate',
          success: false,
          error: 'Monitor outcome could not be settled.',
          durationSecs: (Date.now() - started) / 1000,
        };
  }

  private clearMonitorDeadline(triggerId: string): void {
    const timer = this.monitorDeadlineTimers.get(triggerId);
    if (timer) clearTimeout(timer);
    this.monitorDeadlineTimers.delete(triggerId);
  }

  private async waitForConfiguredRetry(
    job: Readonly<Pick<SchedulerJob, 'retryDelaySecs'>>,
  ): Promise<boolean> {
    const delayMs = Math.max(0, (job.retryDelaySecs ?? 0) * 1000);
    if (
      delayMs > 0 &&
      !(await waitForRetry(delayMs, this.stopController.signal))
    ) {
      return false;
    }
    return !this.stopping;
  }

  private stoppedRetryResult(
    result: SchedulerExecutionResult,
    retryReceipt: SchedulerDispatchReceipt,
  ) {
    return {
      logId: `${retryReceipt.id}-${retryReceipt.attempt}`,
      outcome: 'indeterminate' as const,
      success: false,
      error: 'Scheduler stopped before the next retry invocation',
      durationSecs: result.durationSecs,
    };
  }

  /**
   * A definitely-not-invoked adapter result is safe to retry only after its
   * exact durable transition advances the same receipt. Retain that closure
   * across transient SQLite ambiguity; do not claim a new run or invoke the
   * adapter until `recordNotInvoked` returns the advanced capability.
   */
  private async retryNotInvokedTransition(
    pending: NonNullable<SchedulerExecutionResult['pendingNotInvoked']>,
  ) {
    let delayMs = 25;
    while (!this.stopping) {
      if (!(await waitForRetry(delayMs, this.stopController.signal))) {
        return undefined;
      }
      const outcome = pending.receipt.recordNotInvoked(pending.input);
      if (outcome.kind !== 'unavailable') return outcome;
      // A damaged store will not become readable by asking again, and this
      // loop would otherwise hammer it every 250ms until `stop()`. Give up
      // the same way the stopping path does (archive#3220).
      //
      // The cost, stated plainly: this run's provenance DEGRADES. It was
      // proved-not-invoked — an exact fact the adapter reported — and giving
      // up abandons the one capability that could record it. The claim stays
      // durable with `invocation_started = 1`, so `reconcileDeadClaims` will
      // later write it as `indeterminate` ("may already have happened"),
      // which is weaker but not false. Spinning on SQLITE_CORRUPT to preserve
      // the stronger word is the worse trade.
      //
      // Only the corrupt case is bounded here. The transient loop is still
      // unbounded-until-stop by design: contention does resolve, and the
      // capability is worth retaining across it. That asymmetry is
      // deliberate, not an oversight.
      if (outcome.reason === 'corrupt') return undefined;
      // Bound each wait while retaining the one exact capability. `stop()`
      // aborts this wait, so there is no detached retry timer after close.
      delayMs = Math.min(delayMs * 2, 250);
    }
    return undefined;
  }

  private broadcast(event: Record<string, unknown>) {
    this.sse.broadcast(event);
  }

  private checkHealth() {
    if (!this.lastTickAt) return;
    const age = Date.now() - this.lastTickAt;
    if (age > HEALTH_WINDOW_MS) {
      this.notificationService?.dispatch('scheduler-health', () =>
        this.notificationService!.schedule('scheduler', {
          category: 'scheduler-unhealthy',
          title: 'Scheduler heartbeat stale',
          body: `Last tick was ${Math.round(age / 1000)}s ago`,
          priority: 'high',
          dedupeTag: 'scheduler:heartbeat-stale',
          actions: [{ id: 'view-scheduler', label: 'View Scheduler' }],
          metadata: {
            lastTickAt: new Date(this.lastTickAt).toISOString(),
            link: '/schedule',
          },
        }),
      );
    }
  }

  // ── ISchedulerProvider ──

  async listJobs(): Promise<SchedulerJob[]> {
    return this.requireRead(this.ledger.listViews()).map((job) => {
      if (!job.monitor || !job.unattendedPrincipal) return job;
      const accounting = this.ledger.readMonitorAccounting({
        monitorId: job.unattendedPrincipal.jobId,
        ownerId: 'personal',
      });
      if (accounting.kind !== 'available') return job;
      return {
        ...job,
        monitorState: {
          ...job.monitorState,
          ...(accounting.value.fingerprint
            ? { lastTriggeredFingerprint: accounting.value.fingerprint }
            : {}),
          ...(accounting.value.task?.taskId
            ? { triggeredTaskId: accounting.value.task.taskId }
            : {}),
          ...(accounting.value.triggerId
            ? { triggerId: accounting.value.triggerId }
            : {}),
          completedTurns: accounting.value.completedTurns,
          consumedTokens: accounting.value.consumedTokens,
          consumedRuntimeMs: accounting.value.consumedRuntimeMs,
          usageKnown: accounting.value.usageKnown,
        },
      };
    });
  }

  async addJob(opts: AddJobOpts): Promise<string> {
    if (!opts.name?.trim()) throw new Error('Job name is required');
    if (!opts.prompt?.trim()) throw new Error('Job prompt is required');
    if (opts.cron !== undefined && opts.schedule !== undefined) {
      throw new Error('Use either cron or schedule, not both');
    }
    if (opts.monitor) {
      // Validate at the durable configuration boundary, not after a timer
      // wakes. This also keeps the fixed-host/SSRF policy out of UI-only code.
      parseGitHubPullRequestTarget(opts.monitor.target);
      assertMonitorAuthority(opts);
    }
    const schedule = opts.schedule as Schedule | undefined;
    if (schedule !== undefined) {
      const err = validateSchedule(schedule);
      if (err !== null) throw new Error(`Invalid schedule: ${err}`);
    }
    const createdAt = new Date().toISOString();
    const result = this.ledger.create({
      name: opts.name,
      cron: opts.cron,
      schedule,
      prompt: opts.prompt,
      // A monitor has exactly one Task-Agent authority: monitor.agentId.
      // Never persist a second scheduler-level agent that could diverge.
      agent: opts.monitor ? undefined : opts.agent,
      notifyStart: opts.notifyStart,
      retryCount: opts.retryCount,
      retryDelaySecs: opts.retryDelaySecs,
      monitor: opts.monitor
        ? {
            ...opts.monitor,
            budget: normalizeMonitorBudget(opts.monitor.budget),
          }
        : undefined,
      enabled: true,
      createdAt,
    });
    if (result.kind === 'unavailable') throw storageError(result);
    if (result.kind === 'exists')
      throw new SchedulerJobConflictError(opts.name);
    return `Job '${opts.name}' created`;
  }

  async editJob(
    target: string,
    opts: Record<string, unknown>,
  ): Promise<string> {
    const normalized =
      typeof opts.cron === 'string'
        ? {
            ...opts,
            schedule: { kind: 'cron' as const, expr: opts.cron },
          }
        : opts;
    const schedule = normalized.schedule as Schedule | undefined;
    if (schedule !== undefined) {
      const error = validateSchedule(schedule);
      if (error !== null) throw new Error(`Invalid schedule: ${error}`);
    }
    let durableUpdate = normalized;
    if (normalized.monitor && typeof normalized.monitor === 'object') {
      // Monitor authority has no top-level Agent. Strip compatibility input
      // before either a reset transaction or an ordinary budget-only save.
      durableUpdate = { ...normalized };
      delete durableUpdate.agent;
      parseGitHubPullRequestTarget(
        (normalized.monitor as { target: string }).target,
      );
      const existing = this.ledger.list();
      if (existing.kind === 'unavailable') throw storageError(existing);
      const job = existing.value.find((candidate) => candidate.name === target);
      if (!job) throw new Error(`Job '${target}' not found`);
      assertMonitorAuthority({
        ...job,
        ...normalized,
        monitor: normalized.monitor as AddJobOpts['monitor'],
      });
      // Ignore a stale generic scheduler-agent field. Monitor ownership is
      // exclusively `monitor.agentId`; a second field cannot reset it.
      const identityChanged =
        monitorIdentity(job.monitor) !== monitorIdentity(normalized.monitor);
      if (identityChanged) {
        const view = this.requireRead(this.ledger.listViews()).find(
          (candidate) => candidate.name === target,
        );
        if (!view?.unattendedPrincipal)
          throw new Error(`Job '${target}' is unavailable for monitor reset`);
        const reset = this.ledger.resetMonitorAndUpdateJob({
          name: target,
          monitorId: view.unattendedPrincipal.jobId,
          ownerId: 'personal',
          update: {
            ...durableUpdate,
            monitor: {
              ...(normalized.monitor as NonNullable<AddJobOpts['monitor']>),
              budget: normalizeMonitorBudget(
                (normalized.monitor as NonNullable<AddJobOpts['monitor']>)
                  .budget,
              ),
            },
            monitorState: {},
          },
        });
        if (reset.kind === 'unavailable') throw storageError(reset);
        if (reset.kind === 'not-found')
          throw new Error(`Job '${target}' not found`);
        if (reset.kind === 'busy') throw new Error(monitorBusyMessage(target));
        return `Job '${target}' updated`;
      }
    }
    // A legacy client can still send `agent` while editing a monitor. It is
    // irrelevant authority and must neither change nor reset the monitor.
    if (
      normalized.monitor === undefined &&
      Object.hasOwn(normalized, 'agent')
    ) {
      const existing = this.ledger.list();
      if (existing.kind === 'unavailable') throw storageError(existing);
      const job = existing.value.find((candidate) => candidate.name === target);
      if (!job) throw new Error(`Job '${target}' not found`);
      if (job.monitor) return `Job '${target}' updated`;
    }
    if (normalized.monitor === null) {
      const existing = this.ledger.list();
      if (existing.kind === 'unavailable') throw storageError(existing);
      const job = existing.value.find((candidate) => candidate.name === target);
      if (!job) throw new Error(`Job '${target}' not found`);
      if (job.monitor) {
        const view = this.requireRead(this.ledger.listViews()).find(
          (candidate) => candidate.name === target,
        );
        if (!view?.unattendedPrincipal)
          throw new Error(`Job '${target}' is unavailable for monitor removal`);
        const cleared = {
          ...normalized,
          monitor: undefined,
          monitorState: undefined,
        };
        const reset = this.ledger.resetMonitorAndUpdateJob({
          name: target,
          monitorId: view.unattendedPrincipal.jobId,
          ownerId: 'personal',
          update: cleared,
        });
        if (reset.kind === 'unavailable') throw storageError(reset);
        if (reset.kind === 'not-found')
          throw new Error(`Job '${target}' not found`);
        if (reset.kind === 'busy') throw new Error(monitorBusyMessage(target));
        return `Job '${target}' updated`;
      }
      // Explicit removal remains an idempotent update for a job already
      // without a monitor, but do not store JSON null as a phantom config.
      const result = this.ledger.update(target, {
        ...normalized,
        monitor: undefined,
      });
      if (result.kind === 'unavailable') throw storageError(result);
      if (result.kind === 'not-found')
        throw new Error(`Job '${target}' not found`);
      if (result.kind === 'busy') throw new Error(monitorBusyMessage(target));
      return `Job '${target}' updated`;
    }
    const result = this.ledger.update(target, durableUpdate);
    if (result.kind === 'unavailable') throw storageError(result);
    if (result.kind === 'not-found')
      throw new Error(`Job '${target}' not found`);
    if (result.kind === 'busy') throw new Error(monitorBusyMessage(target));
    return `Job '${target}' updated`;
  }

  /** Explicit monitor recovery; generic edit/enable may never revive terminal state. */
  async restartMonitor(target: string): Promise<string> {
    const jobs = this.ledger.list();
    if (jobs.kind === 'unavailable') throw storageError(jobs);
    const job = jobs.value.find((candidate) => candidate.name === target);
    if (!job) throw new Error(`Job '${target}' not found`);
    if (!job.monitor) throw new Error(`Job '${target}' has no monitor`);
    const view = this.requireRead(this.ledger.listViews()).find(
      (candidate) => candidate.name === target,
    );
    if (!view?.unattendedPrincipal)
      throw new Error(`Job '${target}' is unavailable for monitor restart`);
    const updated = this.ledger.resetMonitorAndUpdateJob({
      name: target,
      monitorId: view.unattendedPrincipal.jobId,
      ownerId: 'personal',
      update: { monitorState: {} },
    });
    if (updated.kind === 'unavailable') throw storageError(updated);
    if (updated.kind === 'not-found')
      throw new Error(`Job '${target}' not found`);
    if (updated.kind === 'busy') throw new Error(monitorBusyMessage(target));
    this.broadcast({
      event: 'monitor.restarted',
      job: target,
      provider: this.id,
      monitorOutcome: 'pending',
    });
    return `Monitor '${target}' restarted`;
  }

  /**
   * An indeterminate monitor is resolved from the exact Task receipt, never
   * by guessing that its unknown use was zero. This is the explicit escape
   * hatch from an otherwise permanent accounting fence.
   */
  async resolveIndeterminateMonitor(
    target: string,
    input: { triggerId: string; action: 'resolve' },
  ): Promise<string> {
    const view = this.requireRead(this.ledger.listViews()).find(
      (candidate) => candidate.name === target,
    );
    if (!view?.monitor || !view.unattendedPrincipal)
      throw new Error(`Job '${target}' has no monitor`);
    const trigger = this.requireRead(
      this.ledger.monitorTrigger(input.triggerId),
    );
    if (!trigger || trigger.monitorId !== view.unattendedPrincipal.jobId)
      throw new Error('Monitor resolution trigger is not owned by this job');
    if (!this.options.readMonitorTerminals)
      throw new Error('Monitor Task evidence is unavailable');
    const terminal = (await this.options.readMonitorTerminals([trigger])).find(
      (candidate) => candidate.triggerId === input.triggerId,
    );
    if (
      !terminal ||
      (terminal.terminal !== 'completed' && terminal.terminal !== 'failed') ||
      !terminal.usage ||
      terminal.usage.turns === undefined ||
      terminal.usage.tokens === undefined ||
      terminal.usage.runtimeMs === undefined
    )
      throw new Error('Monitor Task has no authoritative terminal usage yet');
    const resolved = this.ledger.resolveIndeterminateMonitor({
      monitorId: view.unattendedPrincipal.jobId,
      ownerId: 'personal',
      triggerId: input.triggerId,
      task: trigger.task,
      terminal: terminal.terminal,
      usage: terminal.usage as {
        turns: number;
        tokens: number;
        runtimeMs: number;
      },
      jobName: target,
      monitorState: {
        ...view.monitorState,
        lastOutcome: 'terminal',
        usageKnown: true,
        nextAction: 'Monitor Task evidence resolved; restart to observe again.',
      },
    });
    if (resolved.kind === 'unavailable') throw storageError(resolved);
    if (resolved.kind !== 'applied')
      throw new Error(
        'Monitor resolution does not match its exact Task receipt',
      );
    this.options.onMonitorTerminal?.(input.triggerId);
    this.broadcast({
      event: 'monitor.resolved',
      job: target,
      provider: this.id,
      id: input.triggerId,
      monitorOutcome: 'terminal',
    });
    return `Monitor '${target}' resolved from Task evidence`;
  }

  async removeJob(target: string): Promise<void> {
    const result = this.ledger.remove(target);
    if (result.kind === 'unavailable') throw storageError(result);
    if (result.kind === 'not-found')
      throw new Error(`Job '${target}' not found`);
    if (result.kind === 'busy') throw new Error(monitorBusyMessage(target));
  }

  async runJob(target: string): Promise<SchedulerManualRunReceipt> {
    const claimed = this.ledger.claimManual(target, Date.now());
    if (claimed.kind === 'unavailable') throw storageError(claimed);
    if (claimed.kind === 'not-found')
      throw new Error(`Job '${target}' not found`);
    if (claimed.kind === 'busy')
      throw new Error(`Job '${target}' is already running`);
    return this.executeManualClaim(target, claimed.receipt);
  }

  prepareStarterManualIntent(operationId: string): PreparedStarterScheduledRun {
    const now = Date.now();
    const job: StoredSchedulerJob = {
      name: STARTER_SCHEDULED_CHECK_JOB_NAME,
      schedule: { kind: 'every', everyMs: SCHEDULER_STARTER_CHECK_EVERY_MS },
      prompt: SCHEDULER_STARTER_CHECK_PROMPT,
      agent: 'station',
      enabled: false,
      notifyStart: false,
      retryCount: 0,
      createdAt: new Date(now).toISOString(),
    };
    const claimed = this.ledger.claimStarterManualIntent(operationId, job, now);
    if (claimed.kind === 'unavailable')
      throw new StarterScheduledCheckPrepareError(
        claimed.reason === 'corrupt' ? 'corrupt' : 'unavailable',
        claimed.reason !== 'corrupt',
        claimed.reason === 'corrupt'
          ? 'Scheduled-check storage is corrupt.'
          : 'Scheduled-check storage is unavailable.',
      );
    if (claimed.kind === 'not-found')
      throw new StarterScheduledCheckPrepareError(
        'unavailable',
        true,
        'Scheduled-check Starter job is unavailable.',
      );
    if (claimed.kind === 'busy')
      throw new StarterScheduledCheckPrepareError(
        'busy',
        true,
        'Scheduled-check Starter job is already running.',
      );
    if (claimed.kind === 'capacity')
      throw new StarterScheduledCheckPrepareError(
        'capacity',
        false,
        'Scheduled-check Starter intent capacity is full.',
      );
    if (claimed.kind === 'conflict')
      throw new StarterScheduledCheckPrepareError(
        'collision',
        false,
        'The canonical scheduled-check job name is already in use.',
      );
    if (claimed.kind === 'invalid')
      throw new StarterScheduledCheckPrepareError(
        'invalid',
        false,
        'Scheduled-check Starter identity is invalid.',
      );
    if (claimed.kind === 'replayed')
      return {
        replayed: true,
        completion: schedulerLogCompletion(claimed.run),
        reference: {
          kind: 'receipt',
          owner: 'scheduler-run',
          id: createScheduleRunId(this.id, claimed.run.job, claimed.run.id),
        },
        receipt: this.replayedManualReceipt(claimed),
      };
    const runId = createScheduleRunId(
      this.id,
      claimed.receipt.job.name,
      `${claimed.receipt.id}-${claimed.receipt.attempt}`,
    );
    let activation: Promise<SchedulerManualRunReceipt> | undefined;
    let activationStarted = false;
    const starterReceipt = this.starterManualReceipt(
      operationId,
      claimed.receipt,
    );
    return {
      replayed: claimed.replayed,
      completion: 'running',
      reference: { kind: 'receipt', owner: 'scheduler-run', id: runId },
      receipt: {
        outcome: 'indeterminate',
        message:
          'Scheduled-check Starter is durably prepared and awaiting activation.',
        runId,
      },
      activate: () => {
        activationStarted = true;
        activation ??= this.executeManualClaim(
          STARTER_SCHEDULED_CHECK_JOB_NAME,
          starterReceipt,
          true,
        );
        return activation;
      },
      releaseUnstarted: () =>
        activationStarted
          ? { kind: 'stale' }
          : this.ledger.releaseStarterManualIntent(
              operationId,
              claimed.receipt.id,
            ),
    };
  }

  private async executeManualClaim(
    target: string,
    receipt: SchedulerDispatchReceipt,
    starter = false,
  ): Promise<SchedulerManualRunReceipt> {
    const result = await this.executeJob(receipt);
    const runId = createScheduleRunId(this.id, receipt.job.name, result.logId);
    if (result.outcome === 'completed') {
      return {
        outcome: 'completed',
        message: `Job '${target}' completed`,
        runId,
      };
    }
    return {
      outcome:
        starter && result.outcome === 'deferred'
          ? 'failed'
          : result.outcome === 'deferred'
            ? 'deferred'
            : result.outcome === 'refused'
              ? starter
                ? 'failed'
                : 'refused'
              : result.outcome === 'failed' || result.outcome === 'not-invoked'
                ? 'failed'
                : 'indeterminate',
      message: `Job '${target}' ${result.outcome}: ${result.error ?? 'scheduler receipt unavailable'}`,
      ...(result.outcome === 'deferred' ? {} : { runId }),
    };
  }

  private starterManualReceipt(
    operationId: string,
    receipt: SchedulerDispatchReceipt,
  ): SchedulerDispatchReceipt {
    return Object.freeze({
      ...receipt,
      releaseDeferred: () => {
        const outcome = this.ledger.recordStarterNotInvoked(
          operationId,
          receipt.id,
          {
            completedAt: new Date().toISOString(),
            error: 'Scheduled-check Starter was deferred before invocation.',
          },
        );
        if (outcome.kind === 'unavailable') return outcome;
        return outcome.kind === 'stale' || outcome.kind === 'invalid'
          ? ({ kind: 'stale' } as const)
          : ({ kind: 'applied' } as const);
      },
    });
  }

  private replayedManualReceipt(replayed: {
    readonly run: SchedulerLogEntry;
  }): SchedulerManualRunReceipt {
    const run = replayed.run;
    const runId = createScheduleRunId(this.id, run.job, run.id);
    if (run.state === 'running')
      return {
        outcome: 'indeterminate',
        message: `Job '${run.job}' was already admitted; observe its exact run.`,
        runId,
      };
    if (run.success)
      return {
        outcome: 'completed',
        message: `Job '${run.job}' completed`,
        runId,
      };
    return {
      outcome: run.state === 'indeterminate' ? 'indeterminate' : 'failed',
      message: `Job '${run.job}' ${run.state ?? 'failed'}: ${run.error ?? 'scheduler receipt unavailable'}`,
      runId,
    };
  }

  async enableJob(target: string): Promise<void> {
    await this.editJob(target, { enabled: true });
  }
  async disableJob(target: string): Promise<void> {
    await this.editJob(target, { enabled: false });
  }

  async getJobLogs(target: string, count = 20): Promise<SchedulerLogEntry[]> {
    const terminal = this.requireRead(this.ledger.logs(target, count));
    const active = this.requireRead(this.ledger.runningLogs(target));
    return [...terminal, ...active]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .slice(-count);
  }

  async listRunLogs(): Promise<SchedulerLogEntry[]> {
    return [
      ...this.requireRead(this.ledger.allLogs()),
      ...this.requireRead(this.ledger.runningLogs()),
    ].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async readRunFile(path: string): Promise<string> {
    return this.requireRead(this.ledger.readOutput(path));
  }

  async getStats(): Promise<SchedulerProviderStats> {
    return this.requireRead(this.ledger.stats());
  }

  async getStatus(): Promise<SchedulerProviderStatus> {
    const tickAge = this.lastTickAt ? Date.now() - this.lastTickAt : null;
    return {
      running: this.timer !== null,
      jobCount: this.requireRead(this.ledger.list()).length,
      lastTickAt: this.lastTickAt
        ? new Date(this.lastTickAt).toISOString()
        : null,
      healthy:
        this.timer !== null && (tickAge === null || tickAge < HEALTH_WINDOW_MS),
    };
  }

  async previewSchedule(cron: string, count = 5): Promise<string[]> {
    // Back-compat: the UI passes a bare cron string. Wrap as a UTC cron
    // schedule and defer to ephemeris. The caller (SchedulerService) already
    // validates the cron shape via the route schema before reaching here.
    const schedule: Schedule = { kind: 'cron', expr: cron };
    return nextOccurrences(schedule, count, Date.now()).map((ms) =>
      new Date(ms).toISOString(),
    );
  }

  subscribe(send: (data: string) => void): () => void {
    return this.sse.subscribe(send);
  }

  private requireRead<T>(outcome: SchedulerReadOutcome<T>): T {
    if (outcome.kind === 'unavailable') throw storageError(outcome);
    return outcome.value;
  }

  private observe(effect: () => void): void {
    try {
      effect();
    } catch {
      // Durable receipt transitions are authoritative over diagnostic fan-out.
    }
  }
}

function schedulerLogCompletion(
  run: SchedulerLogEntry,
): PreparedStarterScheduledRun['completion'] {
  if (run.state === 'running') return 'running';
  if (run.success) return 'completed';
  return run.state === 'indeterminate' ? 'indeterminate' : 'failed';
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (elapsed: boolean) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(elapsed);
    };
    const onAbort = () => finish(false);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(true), delayMs);
  });
}
