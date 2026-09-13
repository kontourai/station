/** Canonical React-free client for every operator scheduler operation. */

import type {
  AddJobOpts,
  SchedulerJob,
  SchedulerLogEntry,
  SchedulerManualRunReceipt,
  SchedulerMutationResponse,
  SchedulerProviderInfo,
  SchedulerStats,
  SchedulerStatus,
  UpdateJobOpts,
} from '@kontourai/station-contracts/scheduler';

export type {
  ExternalMonitorConfig,
  ExternalMonitorDecision,
  ExternalMonitorObservation,
  ExternalMonitorState,
} from '@kontourai/station-contracts/external-monitor';

import { apiErrorMessage } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  StationHttpError,
} from './http';

interface SchedulerEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  outcome?: unknown;
}

function isSchedulerManualRunReceipt(
  value: unknown,
): value is SchedulerManualRunReceipt {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string' &&
    typeof (value as { runId?: unknown }).runId === 'string' &&
    (value as { runId: string }).runId.trim().length > 0 &&
    ['completed', 'failed', 'indeterminate', 'refused'].includes(
      (value as { outcome?: unknown }).outcome as string,
    )
  );
}

function manualRunPayload(value: unknown): {
  output: string | undefined;
  receipt: SchedulerManualRunReceipt | undefined;
} {
  if (typeof value !== 'object' || value === null) {
    return { output: undefined, receipt: undefined };
  }
  const data = value as { output?: unknown; receipt?: unknown };
  return {
    output: typeof data.output === 'string' ? data.output : undefined,
    // Also accept the short-lived receipt-only response emitted by Station
    // versions between the legacy and additive shapes.
    receipt: isSchedulerManualRunReceipt(data.receipt)
      ? data.receipt
      : isSchedulerManualRunReceipt(value)
        ? value
        : undefined,
  };
}

export type SchedulerManualRunObservation =
  | Readonly<{ kind: 'run'; receipt: SchedulerManualRunReceipt }>
  | Readonly<{
      kind: 'unavailable';
      reason: 'missing_or_invalid_run_receipt';
    }>;

export type SchedulerManualRunReceiptResult =
  | Readonly<{
      kind: 'received';
      output: string;
      receipt: SchedulerManualRunReceipt;
    }>
  | Readonly<{
      kind: 'observation-unavailable';
      output: string;
      reason: 'missing_or_invalid_run_receipt';
    }>;

/** A manual scheduler run may have invoked its provider; never retry it automatically. */
export class SchedulerRunIndeterminateError extends Error {
  readonly code = 'scheduler_run_indeterminate';
  readonly outcome = 'indeterminate' as const;
  readonly retryable = false as const;

  constructor(
    message: string,
    readonly observation: SchedulerManualRunObservation,
  ) {
    super(message);
    this.name = 'SchedulerRunIndeterminateError';
  }

  /** Present only when the server supplied a valid, exact run identity. */
  get receipt(): SchedulerManualRunReceipt | undefined {
    return this.observation.kind === 'run'
      ? this.observation.receipt
      : undefined;
  }
}

/** A manual scheduler run failed definitely; its exact run remains observable. */
export class SchedulerRunFailedError extends Error {
  readonly code = 'scheduler_run_failed';
  readonly outcome = 'failed' as const;

  constructor(
    message: string,
    readonly receipt: SchedulerManualRunReceipt & { outcome: 'failed' },
  ) {
    super(message);
    this.name = 'SchedulerRunFailedError';
  }
}

/**
 * The scheduler service **answered**, and the answer was a failure.
 *
 * The point of this class is the distinction a caller cannot otherwise draw.
 * `unwrapSchedulerResponse` is the only thing in this client that constructs
 * one, and it does so only while holding a `Response`, so a
 * `SchedulerResponseError` arriving from a scheduler fetcher means a response
 * was observed. Anything else it can throw (a `TypeError: Failed to fetch`, a
 * `StationRequestTimeoutError`) means no response was observed. Callers
 * therefore derive "the server is unreachable" rather than assuming it — see
 * `src-ui/src/views/schedule/utils.ts`'s `describeSchedulerFailure`, which
 * exists because `ScheduleView` used to print "check that the server is
 * running" over a fully-answered HTTP 500 (station#3252).
 *
 * `detail` is the body's own `error` text, and is `undefined` precisely when
 * the body carried no explanation. That is a computed distinction, not a
 * string match against this file's fallback copy: a consumer can say what the
 * server said without having to recognise the message we invented when it
 * said nothing.
 *
 * `status` is the observed response status verbatim, which may legitimately be
 * 200: the scheduler routes can answer `{success:false, error}` with a 2xx, and
 * that is still an answer. Do not read `status` as "non-2xx".
 */
export class SchedulerResponseError extends StationHttpError {
  constructor(
    status: number,
    message: string,
    readonly detail: string | undefined,
  ) {
    super(status, message);
    this.name = 'SchedulerResponseError';
  }
}

/** A manual run was intentionally refused before provider invocation. */
export class SchedulerRunRefusedError extends Error {
  readonly code = 'scheduler_run_refused';
  readonly outcome = 'refused' as const;
  readonly retryable = true as const;

  constructor(
    message: string,
    readonly receipt: SchedulerManualRunReceipt & { outcome: 'refused' },
  ) {
    super(message);
    this.name = 'SchedulerRunRefusedError';
  }
}

/**
 * `#167 Wave 3` correction: the real scheduler routes (`src-server/routes/operations/scheduler.ts`)
 * pair every failure with both a non-2xx HTTP status *and* a
 * `{success:false, error}` body. The original version of this function
 * checked `response.ok` before parsing the body and discarded the body's
 * `error` text in favor of a generic `Scheduler API error: <status>` message
 * whenever the status was non-2xx — losing information every sibling
 * fetcher (`client/projects.ts`'s `unwrapOrThrow`, `client/http.ts`'s
 * `readEnvelopeOrThrow`) preserves. Discovered via Wave 3's
 * characterization-tests-first migration of `station-control-operations-tools.ts`'s
 * `list_jobs`/`add_job`/`run_job` (which reconstructs the original
 * `{success,error}` envelope from this function's thrown error) — parsing
 * the body first and preferring its `error` field keeps that reconstruction
 * byte-identical to the pre-migration raw-forwarding behavior. No existing
 * test pinned the old generic-message shape (verified by grep — nothing
 * outside this file called `listJobs`/`createJob`/`runJob` before Wave 3).
 */
async function unwrapSchedulerResponse<T>(response: Response): Promise<T> {
  let result: SchedulerEnvelope<T> | null = null;
  try {
    result = (await response.json()) as SchedulerEnvelope<T>;
  } catch {
    // The body was unreadable, but a response still arrived: keep the status
    // so callers can tell this apart from never having reached the server.
    throw new SchedulerResponseError(
      response.status,
      `Scheduler API error: ${response.status}`,
      undefined,
    );
  }
  if (!response.ok || !result.success) {
    if (
      result.code === 'scheduler_run_indeterminate' &&
      result.outcome === 'indeterminate'
    ) {
      const receipt = manualRunPayload(result.data).receipt;
      throw new SchedulerRunIndeterminateError(
        apiErrorMessage(result, 'Scheduler run may have started.'),
        receipt?.outcome === 'indeterminate'
          ? { kind: 'run', receipt }
          : { kind: 'unavailable', reason: 'missing_or_invalid_run_receipt' },
      );
    }
    const failedReceipt = manualRunPayload(result.data).receipt;
    if (failedReceipt?.outcome === 'refused') {
      throw new SchedulerRunRefusedError(
        apiErrorMessage(result, failedReceipt.message),
        failedReceipt as SchedulerManualRunReceipt & { outcome: 'refused' },
      );
    }
    if (failedReceipt?.outcome === 'failed') {
      throw new SchedulerRunFailedError(
        apiErrorMessage(result, failedReceipt.message),
        failedReceipt as SchedulerManualRunReceipt & { outcome: 'failed' },
      );
    }
    // `result` is an UNCHECKED cast of the parsed body, so `error` being a
    // string is declared and not computed. The runtime's own auth boundary
    // answers 401/403/429 and the containment 500 with an OBJECT there
    // (`{ code: 'insufficient_scope' }`), and interpolating that into the
    // banner renders "[object Object]" — a detail that explains nothing, in a
    // change whose whole rule is that the copy may only say what the error
    // proves (station#3252 review).
    const explanation =
      typeof result.error === 'string' && result.error.length > 0
        ? result.error
        : undefined;
    throw new SchedulerResponseError(
      response.status,
      // Message expression left byte-identical: station-control-operations-
      // tools reconstructs its envelope from it.
      apiErrorMessage(result, `Scheduler API error: ${response.status}`),
      explanation,
    );
  }
  return result.data as T;
}

/** `GET /scheduler/jobs` — list scheduled jobs. */
export async function listJobs(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<SchedulerJob[]> {
  const response = await getJson(`${apiBase}/scheduler/jobs`, opts);
  return unwrapSchedulerResponse<SchedulerJob[]>(response);
}

/** `GET /scheduler/providers` — list scheduler providers. */
export async function listSchedulerProviders(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<SchedulerProviderInfo[]> {
  return unwrapSchedulerResponse<SchedulerProviderInfo[]>(
    await getJson(`${apiBase}/scheduler/providers`, opts),
  );
}

/** `GET /scheduler/stats` — read aggregate scheduler statistics. */
export async function getSchedulerStats(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<SchedulerStats> {
  return unwrapSchedulerResponse<SchedulerStats>(
    await getJson(`${apiBase}/scheduler/stats`, opts),
  );
}

/** `GET /scheduler/status` — read provider health. */
export async function getSchedulerStatus(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<SchedulerStatus> {
  return unwrapSchedulerResponse<SchedulerStatus>(
    await getJson(`${apiBase}/scheduler/status`, opts),
  );
}

/** `GET /scheduler/jobs/preview-schedule` — preview cron occurrences. */
export async function previewSchedule(
  apiBase: string,
  cron: string,
  count?: number,
  /**
   * #1536 R2: `timezone` rides on the EXISTING options parameter rather than
   * taking a new positional slot. An earlier cut inserted it fourth, ahead of
   * `opts` — so an external `previewSchedule(base, cron, 5, { signal })` sent
   * `timezone=[object Object]` and silently lost its abort signal. This is the
   * shape the SDK already uses when one more query param joins an optioned call
   * (`getSessionInventoryGroupPage`'s `continuation`,
   * `listSessionOutputs`'s `cursor`/`limit`).
   *
   * `timezone` is the IANA zone the expression is written in. Omitted = UTC,
   * which is what the scheduler does with an unzoned schedule (#1536 D1).
   */
  options?: ClientRequestOptions & { timezone?: string },
): Promise<string[]> {
  const query = new URLSearchParams({ cron });
  if (count !== undefined) query.set('count', String(count));
  if (options?.timezone) query.set('timezone', options.timezone);
  return unwrapSchedulerResponse<string[]>(
    await getJson(
      `${apiBase}/scheduler/jobs/preview-schedule?${query.toString()}`,
      options,
    ),
  );
}

/** `GET /scheduler/jobs/:target/logs` — read exact job receipts. */
export async function getJobLogs(
  apiBase: string,
  target: string,
  options: Readonly<{ count?: number; providerId?: string }> = {},
  opts?: ClientRequestOptions,
): Promise<SchedulerLogEntry[]> {
  const query = new URLSearchParams();
  if (options.count !== undefined) query.set('count', String(options.count));
  if (options.providerId) query.set('providerId', options.providerId);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return unwrapSchedulerResponse<SchedulerLogEntry[]>(
    await getJson(
      `${apiBase}/scheduler/jobs/${encodeURIComponent(target)}/logs${suffix}`,
      opts,
    ),
  );
}

/** `POST /scheduler/jobs` — create a scheduled job. */
export async function createJob(
  apiBase: string,
  body: AddJobOpts,
  opts?: ClientRequestOptions,
): Promise<SchedulerMutationResponse> {
  const response = await mutateJson(
    `${apiBase}/scheduler/jobs`,
    'POST',
    opts,
    body,
  );
  return unwrapSchedulerResponse<SchedulerMutationResponse>(response);
}

/** `PUT /scheduler/jobs/:target` — update a scheduled job. */
export async function updateJob(
  apiBase: string,
  target: string,
  body: UpdateJobOpts,
  opts?: ClientRequestOptions,
): Promise<SchedulerMutationResponse> {
  return unwrapSchedulerResponse<SchedulerMutationResponse>(
    await mutateJson(
      `${apiBase}/scheduler/jobs/${encodeURIComponent(target)}`,
      'PUT',
      opts,
      body,
    ),
  );
}

async function mutateJobAction(
  apiBase: string,
  target: string,
  action: 'enable' | 'disable',
  opts?: ClientRequestOptions,
): Promise<unknown> {
  return unwrapSchedulerResponse<unknown>(
    await mutateJson(
      `${apiBase}/scheduler/jobs/${encodeURIComponent(target)}/${action}`,
      'PUT',
      opts,
    ),
  );
}

export function enableJob(
  apiBase: string,
  target: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  return mutateJobAction(apiBase, target, 'enable', opts);
}

export function disableJob(
  apiBase: string,
  target: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  return mutateJobAction(apiBase, target, 'disable', opts);
}

/** Explicitly clears a terminal monitor state; generic save/enable never does. */
export async function restartJobMonitor(
  apiBase: string,
  target: string,
  opts?: ClientRequestOptions,
): Promise<SchedulerMutationResponse> {
  return unwrapSchedulerResponse<SchedulerMutationResponse>(
    await mutateJson(
      `${apiBase}/scheduler/jobs/${encodeURIComponent(target)}/monitor/restart`,
      'POST',
      opts,
    ),
  );
}

export async function resolveIndeterminateJobMonitor(
  apiBase: string,
  target: string,
  evidence: {
    triggerId: string;
    action: 'resolve';
  },
  opts?: ClientRequestOptions,
): Promise<SchedulerMutationResponse> {
  return unwrapSchedulerResponse<SchedulerMutationResponse>(
    await mutateJson(
      `${apiBase}/scheduler/jobs/${encodeURIComponent(target)}/monitor/resolve`,
      'POST',
      opts,
      evidence,
    ),
  );
}

/** `DELETE /scheduler/jobs/:target` — delete a scheduled job. */
export async function deleteJob(
  apiBase: string,
  target: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  return unwrapSchedulerResponse<unknown>(
    await mutateJson(
      `${apiBase}/scheduler/jobs/${encodeURIComponent(target)}`,
      'DELETE',
      opts,
    ),
  );
}

/** `POST /scheduler/jobs/:target/run` — run a job immediately. */
export async function runJob(
  apiBase: string,
  target: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await mutateJson(
    `${apiBase}/scheduler/jobs/${encodeURIComponent(target)}/run`,
    'POST',
    opts,
  );
  return unwrapSchedulerResponse<unknown>(response);
}

/**
 * Receipt-aware manual run. This is additive to `runJob`: it accepts both
 * legacy `{output}` servers and current `{output,receipt}` servers, making
 * client/server version skew explicit instead of inventing a run identity.
 */
export async function runJobWithReceipt(
  apiBase: string,
  target: string,
  opts?: ClientRequestOptions,
): Promise<SchedulerManualRunReceiptResult> {
  const data = await runJob(apiBase, target, opts);
  const { output, receipt } = manualRunPayload(data);
  const renderedOutput = output ?? receipt?.message;
  if (renderedOutput === undefined) {
    throw new Error('Scheduler run response did not contain output');
  }
  if (receipt?.outcome === 'completed') {
    return { kind: 'received', output: renderedOutput, receipt };
  }
  return {
    kind: 'observation-unavailable',
    output: renderedOutput,
    reason: 'missing_or_invalid_run_receipt',
  };
}
