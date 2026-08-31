import { writeFileSync } from 'node:fs';
import type { SchedulerEvent } from '@kontourai/station-contracts/scheduler';
import {
  schedulerJobDuration,
  schedulerJobRuns,
} from '../../telemetry/metrics.js';
import type { NotificationService } from '../notifications/notification-service.js';
import type {
  ScheduledTurnAdapter,
  ScheduledTurnOutcome,
} from './builtin-scheduler.js';
import {
  type SchedulerAnnouncementClaim,
  type SchedulerAnnouncementOutbox,
  type SchedulerDeferredOutcome,
  type SchedulerDispatchReceipt,
  type SchedulerInvocationOutcome,
  type SchedulerNotInvokedOutcome,
  type SchedulerSettlementOutcome,
  type StoredSchedulerJob,
} from './scheduler-ledger.js';

export interface SchedulerExecutionDeps {
  job: StoredSchedulerJob;
  id: string;
  manual: boolean;
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  receipt: SchedulerDispatchReceipt;
  turnAdapter: ScheduledTurnAdapter;
  notificationService: NotificationService | null;
  broadcast: (event: SchedulerEvent) => void;
  /**
   * The ledger's durable announcement record, threaded through so a failure
   * announced here is stamped on the run it belongs to. Absent only where a
   * test drives this function without a ledger, in which case announcement
   * idempotence falls back to the in-process fast path alone.
   */
  announcementOutbox?: SchedulerAnnouncementOutbox;
  /** Optional (archive#1897 logging slice 3): the caller's job-run-scoped
   * `logger.child()` (`BuiltinScheduler.executeJob`) — absent when the
   * scheduler was constructed without a logger (e.g. `new
   * BuiltinScheduler()` in `scheduler.test.ts`), in which case this stays
   * broadcast/durable-job-log-only, exactly as before this slice. */
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  /** Implementation-private deadline seam for deterministic timeout tests. */
  timeoutMs?: number;
  /** Scheduler shutdown aborts a pending retry/invocation without releasing ownership. */
  signal?: AbortSignal;
}

export interface SchedulerExecutionResult {
  /** Exact log/running projection id for this authoritative attempt. */
  logId: string;
  outcome:
    | 'completed'
    | 'failed'
    | 'indeterminate'
    | 'not-invoked'
    | 'retrying'
    | 'deferred'
    | 'refused';
  success: boolean;
  outputPath?: string;
  error?: string;
  durationSecs: number;
  retryReceipt?: SchedulerDispatchReceipt;
  /** Same capability + immutable transition intent retained after storage ambiguity. */
  pendingNotInvoked?: Readonly<{
    receipt: SchedulerDispatchReceipt;
    input: Readonly<{ completedAt: string; error: string }>;
  }>;
}

const JOB_TIMEOUT = 10 * 60_000;

/**
 * The strings below reach the durable run log and a manual run's receipt
 * message, and for an operator they are the only clue about why a run stopped.
 *
 * Before archive#3220 a damaged store and a contended one both printed
 * `unavailable`, so the advice was "wait" for a store that waiting cannot fix.
 * Both helpers take the outcome unions rather than a structural `{kind:
 * string}`, so a mistyped kind is a compile error instead of user-facing text.
 */
type ReceiptFailureOutcome =
  | Exclude<SchedulerSettlementOutcome, { kind: 'applied' }>
  | Exclude<SchedulerNotInvokedOutcome, { kind: 'claimed' }>
  | Exclude<SchedulerInvocationOutcome, { kind: 'applied' }>
  | Exclude<SchedulerDeferredOutcome, { kind: 'applied' }>;

/**
 * The bare word for an "X is <word>" frame. `transient` keeps the existing
 * `unavailable` wording exactly; only damage gets a new word.
 */
function receiptOutcomeWord(outcome: ReceiptFailureOutcome): string {
  if (outcome.kind !== 'unavailable') return outcome.kind;
  return outcome.reason === 'corrupt' ? 'corrupt' : 'unavailable';
}

/** The parenthetical form, which names the subject as well as the word. */
function receiptFailureLabel(outcome: ReceiptFailureOutcome): string {
  return outcome.kind === 'unavailable'
    ? `scheduler storage ${receiptOutcomeWord(outcome)}`
    : `scheduler receipt ${outcome.kind}`;
}

export async function executeSchedulerJobAttempt({
  job,
  id,
  attempt,
  maxAttempts,
  startedAt,
  receipt,
  turnAdapter,
  notificationService,
  broadcast,
  announcementOutbox,
  logger,
  timeoutMs = JOB_TIMEOUT,
  signal,
}: SchedulerExecutionDeps): Promise<SchedulerExecutionResult> {
  const outFile = receipt.outputPath();
  // Shutdown wins before invocation authorization.
  if (signal?.aborted) {
    return {
      logId: id,
      outcome: 'not-invoked',
      success: false,
      error: 'Scheduler is stopping',
      durationSecs: 0,
    };
  }
  const invocation = receipt.beginInvocation();
  if (invocation.kind !== 'applied') {
    return {
      logId: id,
      outcome: 'indeterminate',
      success: false,
      error: `Scheduler receipt invocation is ${receiptOutcomeWord(invocation)}`,
      durationSecs: 0,
    };
  }

  try {
    // `default` is a legacy scheduler spelling; the runtime Adapter accepts
    // only the public Station identity and maps it to its private default key.
    const agent = job.agent && job.agent !== 'default' ? job.agent : 'station';
    const controller = new AbortController();
    let shutdownResolve: (() => void) | undefined;
    const shuttingDown = new Promise<void>((resolve) => {
      shutdownResolve = resolve;
    });
    const abortForShutdown = () => {
      controller.abort(signal?.reason ?? new Error('Scheduler is stopping'));
      shutdownResolve?.();
    };
    if (signal?.aborted) abortForShutdown();
    else signal?.addEventListener('abort', abortForShutdown, { once: true });
    let timeoutResolve: (() => void) | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timeoutResolve = resolve;
    });
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Job timed out after ${timeoutMs / 60_000}m`));
      timeoutResolve?.();
    }, timeoutMs);
    let turn: ScheduledTurnOutcome;
    try {
      const invocation = turnAdapter.invoke({
        agentSlug: agent,
        prompt: job.prompt,
        receipt,
        approval: 'unattended-deny',
        principal: {
          kind: 'scheduled-job',
          jobId: receipt.jobId,
          runId: receipt.id,
        },
        signal: controller.signal,
      });
      const raced = await Promise.race([
        invocation.then((outcome) => ({ kind: 'outcome' as const, outcome })),
        timedOut.then(() => ({ kind: 'timed-out' as const })),
        shuttingDown.then(() => ({ kind: 'stopping' as const })),
      ]);
      if (raced.kind === 'timed-out' || raced.kind === 'stopping') {
        // The provider may settle after this bounded scheduler lifecycle. It
        // cannot reclassify or retry the receipt; observe only its rejection.
        void invocation.catch(() => undefined);
        throw new SchedulerIndeterminateInvocationError(
          raced.kind === 'stopping'
            ? 'Scheduler stopped after provider invocation was authorized'
            : `Scheduler invocation timed out after ${timeoutMs}ms`,
        );
      }
      turn = raced.outcome;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortForShutdown);
    }
    if (turn.kind === 'definitely-not-invoked') {
      // One ledger transition writes the proved no-effect receipt and advances
      // (or terminalizes) its attempt. A crash cannot leave a logged failure
      // paired with the old attempt number.
      //
      // The adapter's own words are the WHY; the prefix is the WHAT, and it is
      // the part a reader of the run row cannot otherwise recover — this run
      // failed without the engine ever being asked, which is a different fact
      // from an engine that ran and errored.
      const notInvokedError = `Engine never invoked: ${turn.error}`;
      const notInvoked = {
        completedAt: new Date().toISOString(),
        error: notInvokedError,
      };
      let recorded = receipt.recordNotInvoked(notInvoked);
      if (recorded.kind === 'unavailable') {
        // This is the *same* capability and exact intent. A post-commit
        // storage/readback fault may already have advanced the durable retry
        // receipt; retrying it here recognizes that exact state without
        // reacquiring or invoking attempt 1 again.
        recorded = receipt.recordNotInvoked(notInvoked);
      }
      if (recorded.kind === 'stale' || recorded.kind === 'unavailable') {
        // Nothing durable was written under this attempt, so there is no run
        // row to explain and nothing to announce.
        return {
          logId: id,
          outcome: 'indeterminate',
          success: false,
          error: `${notInvokedError} (${receiptFailureLabel(recorded)})`,
          durationSecs: 0,
          ...(recorded.kind === 'unavailable'
            ? { pendingNotInvoked: { receipt, input: notInvoked } }
            : {}),
        };
      }
      // A failed run is now durable in the ledger and will render as `Failed`.
      // It reaches the user the same way an invocation error does — the row
      // and the notification come from one call, so a failure the UI can show
      // is never one the bell silently omits.
      // Awaited: the run row is not stamped until a notification for it is
      // durable, and this attempt must not report an outcome before that
      // decision is made.
      await announceSchedulerJobFailure({
        job: job.name,
        id,
        error: notInvokedError,
        broadcast,
        notificationService,
        outbox: announcementOutbox,
      });
      observe(() =>
        logger?.warn('Scheduler job failed', {
          error: notInvokedError,
          attempt,
          maxAttempts,
        }),
      );
      return {
        logId: id,
        outcome: recorded.kind === 'claimed' ? 'retrying' : 'not-invoked',
        success: false,
        error: notInvokedError,
        durationSecs: 0,
        ...(recorded.kind === 'claimed'
          ? { retryReceipt: recorded.receipt }
          : {}),
      };
    }
    if (turn.kind === 'indeterminate') {
      throw new SchedulerIndeterminateInvocationError(turn.error);
    }
    const output = turn.output;

    try {
      writeFileSync(outFile, output, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw new SchedulerIndeterminateInvocationError(
        `Scheduler output could not be persisted: ${messageOf(error)}`,
      );
    }
    const completedAt = new Date().toISOString();
    const durationSecs =
      (Date.parse(completedAt) - Date.parse(startedAt)) / 1000;

    const settlement = receipt.settle({
      success: true,
      state: 'completed',
      completedAt,
      durationSecs,
      output: outFile,
      terminal: true,
    });
    if (settlement.kind !== 'applied') {
      return {
        logId: id,
        outcome: 'indeterminate',
        success: false,
        outputPath: outFile,
        error: `Scheduler receipt settlement is ${receiptOutcomeWord(settlement)}`,
        durationSecs,
      };
    }
    observe(() =>
      schedulerJobRuns.add(1, { job: job.name, status: 'success' }),
    );
    observe(() =>
      schedulerJobDuration.record(durationSecs * 1000, { job: job.name }),
    );
    observe(() =>
      broadcast({
        event: 'job.completed',
        job: job.name,
        provider: 'built-in',
        id,
        success: true,
        duration_secs: durationSecs,
      }),
    );
    observe(() =>
      logger?.info('Scheduler job completed', {
        durationSecs,
        attempt,
        maxAttempts,
      }),
    );

    return {
      logId: id,
      outcome: 'completed',
      success: true,
      outputPath: outFile,
      durationSecs,
    };
  } catch (error: any) {
    const errorMessage = messageOf(error);
    try {
      writeFileSync(outFile, errorMessage, { flag: 'wx', mode: 0o600 });
    } catch {
      // The invocation may have happened; the durable receipt is more
      // important than a best-effort error artifact.
    }
    const completedAt = new Date().toISOString();
    const durationSecs =
      (Date.parse(completedAt) - Date.parse(startedAt)) / 1000;

    const settlement = receipt.settle({
      success: false,
      state: 'indeterminate',
      completedAt,
      durationSecs,
      output: outFile,
      error: errorMessage,
      terminal: true,
    });
    if (settlement.kind !== 'applied') {
      return {
        logId: id,
        success: false,
        outputPath: outFile,
        outcome: 'indeterminate',
        error: `${errorMessage} (${receiptFailureLabel(settlement)})`,
        durationSecs,
      };
    }
    observe(() => schedulerJobRuns.add(1, { job: job.name, status: 'error' }));
    observe(() =>
      schedulerJobDuration.record(durationSecs * 1000, { job: job.name }),
    );
    await announceSchedulerJobFailure({
      job: job.name,
      id,
      error: errorMessage,
      broadcast,
      notificationService,
      outbox: announcementOutbox,
    });
    observe(() =>
      logger?.warn('Scheduler job failed', {
        error: errorMessage,
        attempt,
        maxAttempts,
      }),
    );

    return {
      logId: id,
      outcome: 'indeterminate',
      success: false,
      outputPath: outFile,
      error: errorMessage,
      durationSecs,
    };
  }
}

/**
 * The one route a recorded scheduler failure takes to a user.
 *
 * Three code paths can leave a `failed` run in the ledger — an invocation that
 * threw, an adapter result proving the engine was never invoked, and dead-owner
 * reconciliation after this process died mid-run. Before station's schedule
 * honesty pass only the first announced itself, so the other two produced a run
 * row nobody was told about. They all call this now; there is no second copy of
 * the event shape or the notification to drift.
 */
export async function announceSchedulerJobFailure({
  job,
  id,
  error,
  broadcast,
  notificationService,
  outbox,
}: {
  /** Job NAME, as it appears on the Schedule page. */
  job: string;
  /** The run/log id this failure belongs to. Announced at most once. */
  id: string;
  /** Why it failed. Never empty — every caller derives a specific reason. */
  error: string;
  broadcast: (event: SchedulerEvent) => void;
  notificationService: NotificationService | null;
  /**
   * The durable record of which runs have been announced. Optional so a test
   * can drive this without a ledger; every production caller supplies it,
   * because without it "already announced" is only true for this process.
   */
  outbox?: SchedulerAnnouncementOutbox;
}): Promise<void> {
  // At most once per run, no matter how many callers discover the same
  // failure. A retained not-invoked capability is the case that makes this
  // load-bearing: the immediate path announces when its transition lands, and
  // the scheduler's recovery loop announces when a retained one lands later —
  // neither can see what the other did, and the user must not be told twice
  // about one run. Dedupe belongs here rather than in each caller because
  // "announced" is a property of the run, not of the code path that noticed.
  //
  // The Set is a fast path in front of the run's own row and nothing more.
  // It cannot be the source of truth: it is cleared by the restart that is
  // precisely when a crashed process's failures get discovered, it is
  // bounded, so a busy scheduler forgets, and it is invisible to a second
  // Station over the same home. The row is asked whenever it has not already
  // answered.
  if (announcedRunIds.has(id)) return;
  const claim: SchedulerAnnouncementClaim = outbox?.claimAnnouncement(id) ?? {
    kind: 'unknown',
  };
  if (claim.kind === 'already-announced') {
    rememberAnnouncedRunId(id);
    return;
  }
  // Someone else holds this run's lease right now. Deliberately NOT
  // remembered: if that claimant dies without stamping, the lease expires and
  // this process may legitimately announce the run later.
  if (claim.kind === 'leased-elsewhere') return;
  const token = claim.kind === 'claimed' ? claim.token : undefined;
  rememberAnnouncedRunId(id);
  observe(() =>
    broadcast({
      event: 'job.failed',
      job,
      provider: 'built-in',
      id,
      error,
    }),
  );
  const delivered = await persistFailureNotification({
    job,
    id,
    error,
    notificationService,
  });
  if (!delivered) {
    // The broadcast went out, but an SSE event is not the bell: it is
    // ephemeral and may have had no subscriber at all. Nothing durable exists
    // for this run, so it stays owed — release the claim so the next boot (or
    // the other Station) can retry immediately instead of waiting out a lease,
    // and forget it in-process so the fast path keeps meaning "announced".
    if (token !== undefined) outbox?.releaseAnnouncement(id, token);
    forgetAnnouncedRunId(id);
    return;
  }
  // Stamped only after the notification write resolved, deliberately. A crash
  // in this window leaves the run owed and the next boot announces it a
  // second time; the reverse order would let a crash — or a refused dispatch —
  // mark a run told that nobody was told about. A duplicate notification is a
  // nuisance, a silent failure is the defect this outbox exists to remove.
  if (token !== undefined) outbox?.markAnnounced(id, token);
}

/**
 * Resolves true only once a notification for this failure is durable.
 *
 * `dispatch` answers whether the task was ADMITTED to the queue, which is not
 * the same question: it returns false during shutdown, and a task it accepted
 * can still reject inside `schedule`. Both of those used to read as delivery.
 * The service persists inside `schedule` (its store write happens under the
 * mutation lock, and the store fsyncs and atomically renames, before the
 * promise resolves), so awaiting the task is what makes "the bell has this"
 * true.
 *
 * The dedupe tag is per RUN, and that is load-bearing rather than cosmetic.
 * Under the old job-scoped tag, `schedule` resolved successfully WITHOUT
 * writing anything whenever it found a dismissed (or action-leased)
 * notification for that job — so dismissing one failure silently suppressed
 * every later failure of the same job, while each of those later runs was
 * stamped announced. Per-run tags make the only possible dedupe hit a second
 * announcement of the SAME run, where an existing notification — dismissed or
 * not — does mean the user was told about this run. The cost is that a job
 * failing repeatedly now produces one bell entry per failed run instead of
 * one updated entry; `metadata.jobName` still identifies the job for any
 * grouping the bell wants to do.
 */
function persistFailureNotification({
  job,
  id,
  error,
  notificationService,
}: {
  job: string;
  id: string;
  error: string;
  notificationService: NotificationService | null;
}): Promise<boolean> {
  // No notification service means no durable channel exists at all, so
  // nothing here can be recorded as delivered.
  if (!notificationService) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const admitted = notificationService.dispatch(
      'scheduler-job-failure',
      async () => {
        try {
          await notificationService.schedule('scheduler', {
            category: 'job-failure',
            title: `Job "${job}" failed`,
            body: error,
            priority: 'high',
            dedupeTag: `scheduler:fail:${job}:${id}`,
            actions: [{ id: 'view-logs', label: 'View Logs' }],
            metadata: { jobName: job, link: `/schedule?job=${job}` },
          });
        } catch (failure) {
          resolve(false);
          // Rethrown so the service's own async-error observer still sees it.
          throw failure;
        }
        resolve(true);
      },
    );
    if (!admitted) resolve(false);
  });
}

/**
 * Run ids already announced by this process. Bounded: run ids are
 * `<uuid>-<attempt>`, so only a recent one can still attract a second
 * announcement, and a scheduler process outlives any number of runs. A
 * restart clears it, which is correct — after a restart the durable outbox
 * above is what answers, and the runs it still shows as owed are exactly the
 * ones nobody has been told about yet.
 */
const announcedRunIds = new Set<string>();
const ANNOUNCED_RUN_ID_LIMIT = 1024;

function rememberAnnouncedRunId(id: string): void {
  announcedRunIds.add(id);
  while (announcedRunIds.size > ANNOUNCED_RUN_ID_LIMIT) {
    const oldest = announcedRunIds.values().next();
    if (oldest.done) break;
    announcedRunIds.delete(oldest.value);
  }
}

function forgetAnnouncedRunId(id: string): void {
  announcedRunIds.delete(id);
}

/** Test-only: run ids are unique in production, reused across test cases. */
export function resetAnnouncedSchedulerFailuresForTests(): void {
  announcedRunIds.clear();
}

class SchedulerIndeterminateInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerIndeterminateInvocationError';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observe(effect: () => void): void {
  try {
    effect();
  } catch {
    // Receipt state is authoritative; observers must not reclassify it.
  }
}
