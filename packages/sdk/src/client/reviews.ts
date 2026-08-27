import {
  type IndependentReviewReceipt,
  type IndependentReviewRequest,
  type IndependentReviewRequestStatus,
  type IndependentReviewRunResult,
  parseIndependentReviewReceipt,
  parseIndependentReviewRequestStatus,
  parseReviewEvidenceAggregate,
  type ReviewEvidenceAggregate,
} from '@kontourai/station-contracts/review-evidence';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from './http';

function projectReviewsPath(projectSlug: string): string {
  return `/api/projects/${encodeURIComponent(projectSlug)}/reviews`;
}

/** Execute one exact independent review request. */
export async function runIndependentReview(
  apiBase: string,
  request: IndependentReviewRequest,
  opts?: ClientRequestOptions,
): Promise<IndependentReviewRunResult> {
  // The POST is an idempotent submission/join operation. A bounded transport
  // wait avoids coupling callers to the reviewer runtime; status polling uses
  // the caller-owned requestId to recover response loss without reinvocation.
  const requestOptions: ClientRequestOptions = {
    ...(opts ?? {}),
    timeoutMs: opts?.timeoutMs ?? 30_000,
  };
  let status: IndependentReviewRequestStatus | undefined;
  try {
    const response = await mutateJson(
      `${apiBase}${projectReviewsPath(request.target.projectSlug)}`,
      'POST',
      requestOptions,
      request,
    );
    status = parseIndependentReviewRequestStatus(
      await readEnvelopeOrThrow<unknown>(response),
    );
  } catch {
    // The exact request may have crossed the server boundary. Read before any
    // safe idempotent retry; if it was definitely absent, retry the same key.
    try {
      status = await getReviewRequestStatus(
        apiBase,
        request.target.projectSlug,
        request.requestId,
        requestOptions,
      );
    } catch {
      const response = await mutateJson(
        `${apiBase}${projectReviewsPath(request.target.projectSlug)}`,
        'POST',
        requestOptions,
        request,
      );
      status = parseIndependentReviewRequestStatus(
        await readEnvelopeOrThrow<unknown>(response),
      );
    }
  }
  while (status.state === 'running') {
    await delay(500, requestOptions.signal);
    status = await getReviewRequestStatus(
      apiBase,
      request.target.projectSlug,
      request.requestId,
      requestOptions,
    );
  }
  if (status.state === 'completed' && status.result) return status.result;
  if (status.state === 'indeterminate') {
    throw new ReviewEvidenceIndeterminateError(status);
  }
  throw new ReviewEvidenceRejectedError(status);
}

export class ReviewEvidenceRejectedError extends Error {
  constructor(readonly status: IndependentReviewRequestStatus) {
    super(
      status.failureReason ?? 'The independent review request was rejected.',
    );
    this.name = 'ReviewEvidenceRejectedError';
  }
}

export class ReviewEvidenceIndeterminateError extends Error {
  readonly retryable = false;

  constructor(readonly status: IndependentReviewRequestStatus) {
    super(
      status.failureReason ??
        'The independent review outcome is uncertain and must not be retried automatically.',
    );
    this.name = 'ReviewEvidenceIndeterminateError';
  }
}

/** Recover one exact idempotent review submission after transport loss. */
export async function getReviewRequestStatus(
  apiBase: string,
  projectSlug: string,
  requestId: string,
  opts?: ClientRequestOptions,
): Promise<IndependentReviewRequestStatus> {
  const response = await getJson(
    `${apiBase}${projectReviewsPath(projectSlug)}/requests/${encodeURIComponent(requestId)}`,
    opts,
  );
  return parseIndependentReviewRequestStatus(
    await readEnvelopeOrThrow<unknown>(response),
  );
}

/** List durable receipts for one Project, newest first. */
export async function listReviewReceipts(
  apiBase: string,
  projectSlug: string,
  opts?: ClientRequestOptions,
): Promise<IndependentReviewReceipt[]> {
  const response = await getJson(
    `${apiBase}${projectReviewsPath(projectSlug)}`,
    opts,
  );
  const value = await readEnvelopeOrThrow<unknown>(response);
  if (!Array.isArray(value)) throw new Error('Review receipt list is invalid');
  return value.map(parseIndependentReviewReceipt);
}

/**
 * Cross-Project read projection for Station's Review Queue. Total over the
 * project inventory: unreadable projects arrive as `unavailableProjects`
 * entries beside the readable receipts, never as a transport failure.
 */
export async function listAllReviewReceipts(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<ReviewEvidenceAggregate> {
  const response = await getJson(`${apiBase}/api/review-evidence`, opts);
  const value = await readEnvelopeOrThrow<unknown>(response);
  return parseReviewEvidenceAggregate(value);
}

/** Read one exact Project-bound review receipt. */
export async function getReviewReceipt(
  apiBase: string,
  projectSlug: string,
  receiptId: string,
  opts?: ClientRequestOptions,
): Promise<IndependentReviewReceipt> {
  const response = await getJson(
    `${apiBase}${projectReviewsPath(projectSlug)}/${encodeURIComponent(receiptId)}`,
    opts,
  );
  return parseIndependentReviewReceipt(
    await readEnvelopeOrThrow<unknown>(response),
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Request aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Request aborted'));
      },
      { once: true },
    );
  });
}
