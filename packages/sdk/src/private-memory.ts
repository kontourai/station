import type {
  MemoryBrief,
  MemoryDecisionRequest,
  MemoryDecisionResult,
  MemoryMeasurement,
  MemoryQueue,
  MemoryRecall,
} from '@kontourai/station-contracts/knowledge-memory';
import { hasCapability } from './capability.js';
import { getJson, mutateJson } from './client/http.js';
import { fetchPublicStationCapabilities } from './client/publicStationCapabilities.js';
import { rethrowDeadline } from './client/request-deadline.js';
import type { ApiRequestScope } from './query-core';

/**
 * Review, recall and brief a person's private memory
 * (`/api/knowledge/memory/*`, behind the `private-memory` preview).
 *
 * This is the public client: it speaks the HTTP routes and nothing else, and
 * never reaches the host's memory-root manager. The host decides who is
 * reviewing; a decision request carries no reviewer and no reviewer kind.
 */
export type PrivateMemoryHostSupport = 'supported' | 'unsupported' | 'unknown';

/**
 * - `supported`: the host advertises review.
 * - `unsupported`: it answered without the flag. It predates review or is a
 *   deployment that never serves it, so a call would 404 like a refusal.
 * - `unknown`: the handshake could not be read; a call reports for itself.
 */
export async function privateMemoryHostSupport(
  apiBase: string,
): Promise<PrivateMemoryHostSupport> {
  const handshake = await fetchPublicStationCapabilities(apiBase);
  if (!handshake) return 'unknown';
  return hasCapability(handshake, 'privateMemoryReview')
    ? 'supported'
    : 'unsupported';
}

export type PrivateMemoryFailure =
  /** The preview is off, there is no memory yet, or you may not read it. */
  | 'not-available'
  /** The request itself was refused as malformed. */
  | 'invalid'
  | 'unavailable';

export class PrivateMemoryRequestError extends Error {
  constructor(
    readonly failure: PrivateMemoryFailure,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PrivateMemoryRequestError';
  }
}

interface ClientOptions {
  apiBase: string;
  requestScope?: ApiRequestScope;
}

async function read<T>(response: Response): Promise<T> {
  if (response.ok) {
    const body = (await response.json()) as { data: T };
    return body.data;
  }
  let message = 'Private memory is unavailable.';
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') message = body.error;
  } catch (error) {
    // A deadline is not "no message"; anything else keeps the generic one.
    rethrowDeadline(error);
  }
  throw new PrivateMemoryRequestError(
    response.status === 400 || response.status === 413
      ? 'invalid'
      : response.status === 403 || response.status === 404
        ? 'not-available'
        : 'unavailable',
    response.status,
    message,
  );
}

export function createPrivateMemoryClient(options: ClientOptions) {
  const base = `${options.apiBase}/api/knowledge/memory`;
  const request = (signal?: AbortSignal) => ({
    ...(options.requestScope ? { requestScope: options.requestScope } : {}),
    ...(signal ? { signal } : {}),
  });
  return {
    /** Routed changes waiting for a person, and decided ones, with their evidence. */
    queue: async (signal?: AbortSignal) =>
      read<MemoryQueue>(await getJson(`${base}/queue`, request(signal))),
    /** Marks that you opened an item, so its review time is measured. */
    open: async (itemId: string, signal?: AbortSignal) =>
      read<{ itemId: string }>(
        await mutateJson(
          `${base}/queue/${encodeURIComponent(itemId)}/open`,
          'POST',
          request(signal),
          {},
        ),
      ),
    decide: async (
      itemId: string,
      decision: MemoryDecisionRequest & { requestKey?: string },
      signal?: AbortSignal,
    ) =>
      read<MemoryDecisionResult>(
        await mutateJson(
          `${base}/queue/${encodeURIComponent(itemId)}/decision`,
          'POST',
          request(signal),
          decision,
        ),
      ),
    recall: async (query: string, limit?: number, signal?: AbortSignal) => {
      const params = new URLSearchParams({ q: query });
      if (limit) params.set('limit', String(limit));
      return read<MemoryRecall>(
        await getJson(`${base}/recall?${params}`, request(signal)),
      );
    },
    brief: async (signal?: AbortSignal) =>
      read<MemoryBrief>(await getJson(`${base}/brief`, request(signal))),
    /** The per-run record the evals lane scores. */
    measurement: async (signal?: AbortSignal) =>
      read<MemoryMeasurement>(
        await getJson(`${base}/measurement`, request(signal)),
      ),
  };
}

export type PrivateMemoryClient = ReturnType<typeof createPrivateMemoryClient>;
