/**
 * `station delegate wait` observation engine (#2264) — the bounded,
 * observation-only wait loop behind `station delegate wait`, split out of
 * `delegate.ts` so the polling/classification machinery owns one file and the
 * command seam (arg parsing, SIGINT wiring, printing) stays in `delegate.ts`.
 *
 * Honesty contract (the reason this command exists):
 *
 * - TERMINAL provider outcomes come from the server's own status field.
 *   `completed` → exit 0; `failed`/`canceled` → exit 3.
 * - NEEDS USER ACTION (`pendingRequest` present, or status `needs_input`/
 *   `review_pending`/`blocked`) → exit 4 — the same exit `--on-request=fail`
 *   uses for "a request is pending, the task is alive and waiting on you".
 * - The caller's WAIT BUDGET expiring while the task was last observed
 *   active → exit 5. This is NOT task completion or failure: waiting never
 *   stops the task, and the output reports the LAST observed status.
 * - The server reporting `unknown` (or a future status value this CLI cannot
 *   classify) → exit 6. Observation ambiguity is never laundered into
 *   completion or failure.
 * - OBSERVATION LOSS (a status read failed — transport error, HTTP failure,
 *   or a read bounded out by the remaining wait budget) → exit 2, the same
 *   transport-failure exit every other delegate verb uses. The last good
 *   observation is reported and explicitly NOT classified as a task failure;
 *   after the loss the task's outcome is simply not known from here.
 * - Ctrl-C → exit 130, cooperative and immediate: the abort signal is passed
 *   INTO the in-flight status read (SDK `ClientRequestOptions.signal`), so a
 *   hung read cannot keep Ctrl-C blocked. An abort wins over any snapshot
 *   that races it — an interrupted result never claims completion; re-running
 *   `wait` or `status` observes the truth.
 *
 * The engine's execution budget (`supervision`, #2269) is server state this
 * loop only displays — waiting longer than it, or shorter than it, never
 * dispatches, interrupts, or extends anything. There is deliberately no
 * progress-based kill policy and no heartbeat-driven wait extension: the
 * budget the operator passed is the budget that applies.
 */

import {
  type DelegatedTaskPendingRequest,
  type DelegatedTaskReason,
  type DelegatedTaskSnapshot,
  DelegationApiError,
  observeDelegatedTask,
  StationHttpError,
  StationRequestTimeoutError,
} from '@kontourai/station-sdk/client';
import type { ParsedCoreArgs } from './core-api.js';
import { optionalValueFlag } from './core-api.js';

export const WAIT_DEFAULT_TIMEOUT_SECONDS = 3600;
export const WAIT_MAX_TIMEOUT_SECONDS = 86400;
export const WAIT_DEFAULT_INTERVAL_SECONDS = 5;
export const WAIT_MAX_INTERVAL_SECONDS = 3600;

export type DelegateWaitOutcome =
  | 'completed'
  | 'failed'
  | 'needs-action'
  | 'wait-timeout'
  | 'observation-lost'
  | 'unknown'
  | 'interrupted';

/** Documented `delegate wait` exit codes (delegate-scoped, like AC9's). */
export const WAIT_EXIT_CODES: Record<DelegateWaitOutcome, number> = {
  completed: 0,
  'observation-lost': 2,
  failed: 3,
  'needs-action': 4,
  'wait-timeout': 5,
  unknown: 6,
  interrupted: 130,
};

export interface DelegateWaitResult {
  outcome: DelegateWaitOutcome;
  exitCode: number;
  taskId: string;
  /** Observed identifiers — the actual conversation/child Session at the last observation. */
  conversationId?: string;
  currentSessionId?: string;
  /** The canonical status as last observed, when any observation succeeded. */
  status?: DelegatedTaskSnapshot['status'];
  pendingRequest?: DelegatedTaskPendingRequest;
  reason?: DelegatedTaskReason;
  transitionReason?: string;
  /** The current child Session changed under us (a continuation replaced it); the wait continued. */
  sessionChanged: boolean;
  previousSessionId?: string;
  pollCount: number;
  elapsedMs: number;
  timeoutMs: number;
  intervalMs: number;
  /**
   * Set for `observation-lost`: a SAFE fixed error category (HTTP status,
   * timeout, refusal code) — never a raw error message, URL, or response
   * body, which can carry peer-controlled content.
   */
  lastError?: string;
  /** The last successful status snapshot, when one exists, for human rendering. */
  lastSnapshot?: DelegatedTaskSnapshot;
}

export interface DelegateWaitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The single observation seam. Defaults to `observeDelegatedTask` bounded
   * by the caller-supplied budget (`timeoutMs: remaining`) AND carrying the
   * wait's AbortSignal, so both the deadline and Ctrl-C can cut a hung read.
   * Tests inject a fake here — which also proves the wait loop touches
   * nothing else on the delegation API.
   */
  observe?: (budgetMs: number) => Promise<DelegatedTaskSnapshot>;
  /** Cooperative abort (Ctrl-C): checked before each poll, during sleeps, and around every observation. */
  signal?: AbortSignal;
  onPoll?: (snapshot: DelegatedTaskSnapshot, elapsedMs: number) => void;
}

/**
 * One honest classification of a status snapshot. Unknown/unrecognized
 * statuses (including a future server value this CLI has never heard of)
 * return `unknown` rather than being folded into success or failure.
 */
function classifySnapshot(
  snapshot: DelegatedTaskSnapshot,
): DelegateWaitOutcome | 'active' {
  switch (snapshot.status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'canceled':
      return 'failed';
    case 'unknown':
      return 'unknown';
    default:
      break;
  }
  if (snapshot.pendingRequest) return 'needs-action';
  if (
    snapshot.status === 'needs_input' ||
    snapshot.status === 'review_pending' ||
    snapshot.status === 'blocked'
  ) {
    return 'needs-action';
  }
  if (snapshot.status === 'queued' || snapshot.status === 'running') {
    return 'active';
  }
  // A status value this CLI version does not know is honest unknown, not a guess.
  return 'unknown';
}

/**
 * A safe, fixed projection of WHY an observation failed — transport reach,
 * HTTP status, refusal code, or timeout — with no peer-controlled content.
 * Raw `Error.message` values from the SDK's HTTP layer can embed response
 * bodies/URLs; none of that reaches output through this seam.
 */
export function describeObservationError(error: unknown): string {
  if (error instanceof StationRequestTimeoutError) {
    return `status read timed out after ${error.timeoutMs}ms`;
  }
  if (error instanceof StationHttpError) {
    return `status read failed with HTTP ${error.status}`;
  }
  if (error instanceof DelegationApiError) {
    // The SDK carries response.code without validating its vocabulary.
    return 'status read refused by the Station';
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'status read aborted';
  }
  if (error instanceof TypeError) {
    return 'the Station could not be reached';
  }
  return 'status read failed';
}

export async function waitOnDelegatedTask(input: {
  /** Required only when the default `observe` is used; injected observers ignore it. */
  apiBase?: string;
  taskId: string;
  environmentId?: string;
  timeoutMs: number;
  intervalMs: number;
  /** Cooperative abort, carried into every in-flight status read (Ctrl-C). */
  signal?: AbortSignal;
  deps?: DelegateWaitDeps;
}): Promise<DelegateWaitResult> {
  const deps = input.deps ?? {};
  const now = deps.now ?? Date.now;
  const signal = input.signal ?? deps.signal;
  const aborted = () => signal?.aborted === true;
  const observe =
    deps.observe ??
    ((budgetMs: number) => {
      if (!input.apiBase) {
        throw new Error(
          'apiBase is required when no observe override is injected.',
        );
      }
      return observeDelegatedTask(
        input.apiBase,
        input.taskId,
        input.environmentId
          ? { environmentId: input.environmentId }
          : undefined,
        {
          // Bound each HTTP observation by the remaining wait budget so a
          // hung read cannot silently outwait the deadline, AND carry the
          // caller's abort signal so Ctrl-C cuts the read immediately
          // (the SDK combines both: AbortSignal.any([signal, deadline])).
          timeoutMs: budgetMs,
          ...(signal ? { signal } : {}),
        },
      );
    });
  const sleep =
    deps.sleep ??
    ((ms: number) => {
      if (aborted()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          cleanup();
          resolve();
        };
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort);
      });
    });

  const start = now();
  const deadline = start + input.timeoutMs;
  const base: Omit<DelegateWaitResult, 'outcome' | 'exitCode'> = {
    taskId: input.taskId,
    sessionChanged: false,
    previousSessionId: undefined,
    pollCount: 0,
    elapsedMs: 0,
    timeoutMs: input.timeoutMs,
    intervalMs: input.intervalMs,
  };
  let lastSnapshot: DelegatedTaskSnapshot | undefined;
  let lastError: string | undefined;

  const finish = (
    outcome: DelegateWaitOutcome,
    extra?: Partial<DelegateWaitResult>,
  ): DelegateWaitResult => ({
    ...base,
    outcome,
    exitCode: WAIT_EXIT_CODES[outcome],
    ...(lastSnapshot
      ? {
          conversationId: lastSnapshot.conversationId,
          currentSessionId: lastSnapshot.currentSessionId,
          status: lastSnapshot.status,
          pendingRequest: lastSnapshot.pendingRequest,
          reason: lastSnapshot.reason,
          transitionReason: lastSnapshot.transitionReason,
          lastSnapshot,
        }
      : {}),
    elapsedMs: now() - start,
    lastError,
    ...extra,
  });

  while (true) {
    if (aborted()) return finish('interrupted');
    const remaining = deadline - now();
    if (remaining <= 0) {
      // Last successful observation was active (or there was none): the wait
      // budget expired. If the very first read already failed, that is an
      // observation loss, not a running task we outlasted.
      return lastSnapshot ? finish('wait-timeout') : finish('observation-lost');
    }
    try {
      const snapshot = await observe(remaining);
      // An abort wins over any snapshot that races it: Ctrl-C must report
      // `interrupted` — which claims nothing about the task — even when a
      // terminal snapshot slipped in during the abort window. Re-running
      // wait/status observes the truth.
      if (aborted()) return finish('interrupted');
      const previous = lastSnapshot;
      lastSnapshot = snapshot;
      base.pollCount += 1;
      if (previous && previous.currentSessionId !== snapshot.currentSessionId) {
        // A continuation replaced the child Session. Observation only: keep
        // waiting, and report the actual observed identifiers at the end.
        base.sessionChanged = true;
        base.previousSessionId = previous.currentSessionId;
      }
      deps.onPoll?.(snapshot, now() - start);
      const classified = classifySnapshot(snapshot);
      if (classified !== 'active') return finish(classified);
    } catch (error) {
      if (aborted()) return finish('interrupted');
      // A polling failure is an observation loss, never a task failure — and
      // never a reason to redispatch anything. Report a safe category, keep
      // the last good observation, and stop.
      lastError = describeObservationError(error);
      return finish('observation-lost');
    }
    const sleepMs = Math.min(input.intervalMs, deadline - now());
    if (sleepMs > 0) await sleep(sleepMs);
  }
}

/**
 * Strict positive whole seconds, mirroring `environment access request`'s
 * `--timeout` convention. `/^\d+$/` deliberately rejects `1.5`, `1e3`,
 * `-1`, `NaN`, `Infinity`, and empty strings — malformed, nonfinite, and
 * out-of-range values are usage errors before any request.
 */
export function parseWaitSeconds(
  parsed: ParsedCoreArgs,
  name: 'timeout' | 'interval',
  fallback: number,
  max: number,
): number {
  const raw = optionalValueFlag(parsed, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `--${name} must be a positive whole number of seconds (1–${max}).`,
    );
  }
  const value = Number(raw);
  if (value < 1 || value > max) {
    throw new Error(`--${name} must be between 1 and ${max} seconds.`);
  }
  return value;
}

export function formatWaitOutcomeLine(result: DelegateWaitResult): string {
  const ids = lastObservedIds(result);
  switch (result.outcome) {
    case 'completed':
      return `Task ${result.taskId} completed after ${formatDurationMs(result.elapsedMs)}${ids}.`;
    case 'failed':
      return `Task ${result.taskId} reached a terminal failure (status: ${result.status})${ids}.`;
    case 'needs-action':
      return `Task ${result.taskId} needs your action before it can continue${ids}.`;
    case 'wait-timeout':
      return `Wait deadline reached after ${formatDurationMs(result.timeoutMs)}; task ${result.taskId}'s last observed status is '${result.status}'${ids}. Waiting is observation only and never stops the task — re-run 'station delegate status ${result.taskId}' to see where it is now.`;
    case 'observation-lost':
      return `Observation stopped while waiting on task ${result.taskId}: ${result.lastError}. Observation did not cancel the task, and its outcome is not known from here.${result.status ? ` Last observed status: '${result.status}'${ids}.` : ' No status was ever observed.'} An observation failure is not a task failure.`;
    case 'unknown':
      return `Task ${result.taskId} reported status '${result.status ?? 'unknown'}', which this CLI cannot classify${ids}.`;
    case 'interrupted':
      return `Interrupted while waiting on task ${result.taskId}; observation stopped without cancelling the task.${result.status ? ` Last observed status: '${result.status}'.` : ''} The task's current state is not known from here — re-run 'station delegate status ${result.taskId}'.`;
  }
}

function lastObservedIds(result: DelegateWaitResult): string {
  if (!result.conversationId) return '';
  return ` — conversation ${result.conversationId}, current Session ${result.currentSessionId}`;
}

/** Compact `90s` / `30m` / `2h` rendering for elapsed/wait durations. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}
