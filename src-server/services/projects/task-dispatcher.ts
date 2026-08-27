import type {
  TaskAssignmentClaimSummary,
  TaskDispatchInput,
  TaskDispatchRecord,
  TaskDispatchResult,
  TaskRecord,
} from '@kontourai/station-contracts';
import type {
  ProviderKind,
  ProviderSession,
} from '@kontourai/station-contracts/provider';

/**
 * The sole public intent for the remote task-dispatch vertical. Cancellation
 * is admitted at this Interface rather than leaked through every Adapter.
 * Once a provider start is requested, an abort or deadline produces an
 * indeterminate outcome: Station cannot honestly promise that a remote
 * session was not created.
 */
/**
 * Server-only execution envelope for a Task admitted by an external monitor.
 * It deliberately does not live in TaskDispatchInput: browser/API callers
 * cannot grant an unattended task more authority by naming monitor limits.
 */
export type MonitorTaskDispatchIntent = Readonly<{
  /** The monitor's configured Task Agent; it must equal TaskDispatchInput.agentId. */
  agentId: string;
  /** Scheduler stop and the monitor wall deadline, already combined by its owner. */
  signal: AbortSignal;
  /** Absolute wall clock fence retained for diagnostics and late-start checks. */
  deadlineAt: number;
  maxCompletedTurns: number;
  maxTokens: number;
  /** Arms the private monitor observer before an engine can start this Task. */
  onSessionReserved?: (input: { taskId: string; sessionId: string }) => void;
  /** Removes an observer whose Task dispatch never acquired a session. */
  onSessionAbandoned?: (sessionId: string) => void;
}>;

export type DispatchIntent = TaskDispatchInput & {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly monitor?: MonitorTaskDispatchIntent;
};

/** A total outcome; legacy callers map non-dispatched outcomes at their boundary. */
export type DispatchOutcome =
  | { kind: 'dispatched'; result: TaskDispatchResult }
  | { kind: 'not-found' | 'contended' | 'terminal'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'indeterminate'; reason: string; sessionId?: string }
  | { kind: 'aborted'; reason: string; retryable: true }
  | { kind: 'unavailable'; reason: string; retryable: boolean };

/**
 * The Interface serializes one dispatch transaction. An unavailable remote
 * Adapter is discovered before claim acquisition and is retryable without a
 * durable reservation or external claim. A possible remote start is instead
 * terminally indeterminate until graph reconciliation confirms it.
 */
export interface TaskDispatcher {
  dispatch(taskId: string, intent: DispatchIntent): Promise<DispatchOutcome>;
}

/** Opaque durable reservation passed only among Dispatcher collaborators. */
export interface TaskDispatchReservation {
  readonly task: TaskRecord;
  readonly sessionId: string;
  readonly provider: ProviderKind;
  readonly sourceSurface: string;
  readonly modelId: string | undefined;
}

export interface TaskDispatchAssociation {
  readonly session: ProviderSession;
  readonly outcome: TaskDispatchRecord['outcome'];
  readonly claim: TaskAssignmentClaimSummary | undefined;
}

/**
 * Private behavioral Adapter. It owns graph authority and atomic transitions;
 * it does not expose a raw store or arbitrary mutation callbacks.
 */
export interface TaskDispatchGraphState {
  // Every member returns a Promise since #2646: the graph's durable
  // transitions take a cross-process file lock, and that acquisition is now
  // awaited rather than busy-waited so a contended dispatch yields the event
  // loop instead of freezing the listener. Sibling seams (`TaskDispatchClaims`,
  // `TaskDispatchRemoteSessions`) were already Promise-based; every consumer
  // reaches these through the already-async `dispatch`.
  reserve(
    taskId: string,
    intent: DispatchIntent,
  ): Promise<
    | { kind: 'reserved'; reservation: TaskDispatchReservation }
    | { kind: 'not-found' | 'contended' | 'terminal'; reason: string }
  >;
  markProviderStarting(reservation: TaskDispatchReservation): Promise<void>;
  associate(
    reservation: TaskDispatchReservation,
    intent: DispatchIntent,
    association: TaskDispatchAssociation,
  ): Promise<TaskDispatchResult>;
  markIndeterminate(reservation: TaskDispatchReservation): Promise<void>;
  /** Restoring retryability is itself durable truth, never best effort. */
  releaseReservation(
    reservation: TaskDispatchReservation,
  ): Promise<{ kind: 'released' } | { kind: 'indeterminate'; reason: string }>;
}

/** Assignment-provider ownership and its compensating release are one seam. */
export interface TaskDispatchClaims {
  /**
   * The claim Adapter must observe `signal` before beginning external work.
   * If cancellation wins after a claim has begun, its late settlement is
   * ownership-unknown; the Dispatcher records an indeterminate reservation
   * instead of returning a retryable outcome.
   */
  claim(
    reservation: TaskDispatchReservation,
    signal: AbortSignal | undefined,
  ): Promise<TaskAssignmentClaimSummary | undefined>;
  compensate(
    reservation: TaskDispatchReservation,
    cause: unknown,
  ): Promise<{ kind: 'released' } | { kind: 'indeterminate'; reason: string }>;
}

/** Provider selection, task-slug policy and session creation form one seam. */
export interface TaskDispatchRemoteSessions {
  /** Readiness is an Adapter fact, not a caller-visible bootstrap ordering rule. */
  readiness(
    reservation: TaskDispatchReservation,
  ):
    | { kind: 'ready' }
    | { kind: 'unavailable'; reason: string; retryable: boolean };
  /** Whether a thrown start can have created an unobservable remote session. */
  mayHaveStarted(reservation: TaskDispatchReservation): boolean;
  startOrSeed(
    reservation: TaskDispatchReservation,
    intent: DispatchIntent,
  ): Promise<{
    session: ProviderSession;
    outcome: TaskDispatchRecord['outcome'];
  }>;
}

export interface TaskDispatchTelemetry {
  succeeded(
    reservation: TaskDispatchReservation,
    result: TaskDispatchResult,
    startedAt: number,
  ): void;
  failed(
    reservation: TaskDispatchReservation,
    startedAt: number,
    blocked: boolean,
  ): void;
}

/**
 * Server-internal publication after the graph has durably associated the
 * exact Task and provider Session. It is observational: publication can never
 * change the already-successful dispatch result.
 */
export interface TaskDispatchLiveWorkPublisher {
  /** Durable outbox checkpoint before publication is observed as attempted. */
  prepareAgentStarted?(result: TaskDispatchResult): Promise<void> | void;
  publishAgentStarted(result: TaskDispatchResult): Promise<void> | void;
}

class TaskDispatcherImplementation implements TaskDispatcher {
  constructor(
    private readonly graph: TaskDispatchGraphState,
    private readonly claims: TaskDispatchClaims,
    private readonly remoteSessions: TaskDispatchRemoteSessions,
    private readonly telemetry: TaskDispatchTelemetry,
    private readonly liveWorkPublisher?: TaskDispatchLiveWorkPublisher,
  ) {}

  async dispatch(
    taskId: string,
    intent: DispatchIntent,
  ): Promise<DispatchOutcome> {
    const startedAt = performance.now();
    if (
      intent.monitor &&
      (!intent.agentId || intent.agentId !== intent.monitor.agentId)
    ) {
      return {
        kind: 'failed',
        reason:
          'Monitor Task Agent must exactly match the dispatched Task Agent',
      };
    }
    const signal = dispatchSignal(intent);
    const cancelled = dispatchCancelledReason(signal, intent.timeoutMs);
    if (cancelled)
      return { kind: 'aborted', reason: cancelled, retryable: true };
    let admission: Awaited<ReturnType<TaskDispatchGraphState['reserve']>>;
    try {
      admission = await this.graph.reserve(taskId, intent);
    } catch (error) {
      return { kind: 'failed', reason: errorMessage(error) };
    }
    if (admission.kind !== 'reserved') return admission;

    const { reservation } = admission;
    try {
      intent.monitor?.onSessionReserved?.({
        taskId: reservation.task.id,
        sessionId: reservation.sessionId,
      });
    } catch (error) {
      const cleanup = await this.releaseReservation(reservation);
      this.reportFailure(reservation, startedAt, false);
      return cleanup.kind === 'indeterminate'
        ? cleanup
        : { kind: 'failed', reason: errorMessage(error) };
    }
    const claimRequiresExternal = reservation.task.workItemRef?.includes(':');
    let claimResult: TaskAssignmentClaimSummary | undefined;
    let claimAttempted = false;
    let blocked = false;
    let providerStartAttempted = false;
    try {
      const readiness = this.remoteSessions.readiness(reservation);
      if (readiness.kind === 'unavailable') {
        const cleanup = await this.releaseReservation(reservation);
        this.reportFailure(reservation, startedAt, false);
        if (cleanup.kind === 'indeterminate') {
          return cleanup;
        }
        return readiness;
      }
      const cancelled = dispatchCancelledReason(signal, intent.timeoutMs);
      if (cancelled) {
        const cleanup = await this.releaseReservation(reservation);
        this.reportFailure(reservation, startedAt, false);
        return cleanup.kind === 'indeterminate'
          ? cleanup
          : { kind: 'aborted', reason: cancelled, retryable: true };
      }
      await this.graph.markProviderStarting(reservation);
      claimAttempted = true;
      claimResult = await awaitDispatchPhase(
        this.claims.claim(reservation, signal),
        signal,
        intent.timeoutMs,
      );
      if (claimResult?.outcome === 'blocked') {
        blocked = true;
        throw new Error(
          claimResult.kind === 'conflict'
            ? `Task is claimed by another actor: ${claimResult.reason}`
            : `Task dispatch blocked: assignment claim status is indeterminate (${claimResult.reason})`,
        );
      }
      const afterClaimCancellation = dispatchCancelledReason(
        signal,
        intent.timeoutMs,
      );
      if (afterClaimCancellation) {
        throw new DispatchInterruptedError(afterClaimCancellation);
      }
      providerStartAttempted = this.remoteSessions.mayHaveStarted(reservation);
      const remote = await awaitDispatchPhase(
        this.remoteSessions.startOrSeed(reservation, intent),
        signal,
        intent.timeoutMs,
      );
      const result = await this.graph.associate(reservation, intent, {
        session: remote.session,
        outcome: remote.outcome,
        claim: claimResult,
      });
      try {
        await this.liveWorkPublisher?.prepareAgentStarted?.(result);
        await this.liveWorkPublisher?.publishAgentStarted(result);
      } catch {
        // The remote session and graph association are durable already.
      }
      this.reportSuccess(reservation, result, startedAt);
      return { kind: 'dispatched', result };
    } catch (error) {
      const interrupted = error instanceof DispatchInterruptedError;
      const indeterminate =
        providerStartAttempted ||
        (claimRequiresExternal && claimAttempted && !claimResult);
      // Once provider start was attempted, the monitor must retain its
      // observer: the remote session can still publish the Task's canonical
      // first turn after this local caller returns indeterminate.
      if (!indeterminate)
        intent.monitor?.onSessionAbandoned?.(reservation.sessionId);
      if (indeterminate) {
        await this.markIndeterminate(reservation);
      } else if (claimResult?.outcome === 'claimed') {
        const compensation = await this.claims.compensate(reservation, error);
        if (compensation.kind === 'indeterminate') {
          await this.markIndeterminate(reservation);
          this.reportFailure(reservation, startedAt, blocked);
          return {
            kind: 'indeterminate',
            reason: compensation.reason,
          };
        }
      }
      const cleanup = indeterminate
        ? undefined
        : await this.releaseReservation(reservation);
      this.reportFailure(reservation, startedAt, blocked);
      if (cleanup?.kind === 'indeterminate') return cleanup;
      if (indeterminate) {
        return {
          kind: 'indeterminate',
          reason: errorMessage(error),
          ...(providerStartAttempted
            ? { sessionId: reservation.sessionId }
            : {}),
        };
      }
      if (interrupted) {
        return {
          kind: 'aborted',
          reason: errorMessage(error),
          retryable: true,
        };
      }
      return {
        kind: blocked ? 'contended' : 'failed',
        reason: errorMessage(error),
      };
    }
  }

  /** Telemetry is observational; an observer cannot alter a durable outcome. */
  private reportSuccess(
    reservation: TaskDispatchReservation,
    result: TaskDispatchResult,
    startedAt: number,
  ): void {
    try {
      this.telemetry.succeeded(reservation, result, startedAt);
    } catch {
      // The durable association already succeeded.
    }
  }

  private reportFailure(
    reservation: TaskDispatchReservation,
    startedAt: number,
    blocked: boolean,
  ): void {
    try {
      this.telemetry.failed(reservation, startedAt, blocked);
    } catch {
      // The caller receives the total outcome even when observation fails.
    }
  }

  // `await` sits INSIDE the try on purpose: the graph transition is a promise
  // since #2646, and returning it unawaited would route a rejection past this
  // catch and out as an unhandled rejection instead of the indeterminate
  // outcome the caller is entitled to.
  private async markIndeterminate(
    reservation: TaskDispatchReservation,
  ): Promise<void> {
    try {
      await this.graph.markIndeterminate(reservation);
    } catch {
      // A graph storage failure is already indeterminate; never misreport it.
    }
  }

  private async releaseReservation(
    reservation: TaskDispatchReservation,
  ): Promise<{ kind: 'released' } | { kind: 'indeterminate'; reason: string }> {
    try {
      // Awaited inside the try for the same reason as markIndeterminate: a
      // rejected restoration must surface as 'indeterminate', not escape.
      return await this.graph.releaseReservation(reservation);
    } catch (error) {
      // A failed restoration is indeterminate from the caller's perspective.
      await this.markIndeterminate(reservation);
      return { kind: 'indeterminate', reason: errorMessage(error) };
    }
  }
}

class DispatchInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchInterruptedError';
  }
}

function dispatchSignal(intent: DispatchIntent): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (intent.signal) signals.push(intent.signal);
  if (intent.monitor) {
    signals.push(intent.monitor.signal);
    const remaining = intent.monitor.deadlineAt - Date.now();
    signals.push(
      remaining <= 0
        ? AbortSignal.abort(
            new DOMException('Monitor task deadline exceeded', 'TimeoutError'),
          )
        : AbortSignal.timeout(remaining),
    );
  }
  if (intent.timeoutMs === undefined)
    return signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);
  if (!Number.isFinite(intent.timeoutMs) || intent.timeoutMs <= 0) {
    return AbortSignal.abort(
      new DOMException('Task dispatch timed out', 'TimeoutError'),
    );
  }
  signals.push(AbortSignal.timeout(intent.timeoutMs));
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function dispatchCancelledReason(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): string | undefined {
  if (!signal?.aborted) return undefined;
  const reason = signal.reason;
  if (
    timeoutMs !== undefined &&
    reason instanceof Error &&
    reason.name === 'TimeoutError'
  ) {
    return 'Task dispatch timed out';
  }
  if (reason instanceof Error && reason.name === 'AbortError') {
    return 'Task dispatch aborted';
  }
  return reason instanceof Error && reason.message
    ? `Task dispatch aborted: ${reason.message}`
    : 'Task dispatch aborted';
}

async function awaitDispatchPhase<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<T> {
  const interrupted = dispatchCancelledReason(signal, timeoutMs);
  if (interrupted) throw new DispatchInterruptedError(interrupted);
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        new DispatchInterruptedError(
          dispatchCancelledReason(signal, timeoutMs) ?? 'Task dispatch aborted',
        ),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTaskDispatcher(
  graph: TaskDispatchGraphState,
  claims: TaskDispatchClaims,
  remoteSessions: TaskDispatchRemoteSessions,
  telemetry: TaskDispatchTelemetry,
  liveWorkPublisher?: TaskDispatchLiveWorkPublisher,
): TaskDispatcher {
  return new TaskDispatcherImplementation(
    graph,
    claims,
    remoteSessions,
    telemetry,
    liveWorkPublisher,
  );
}
