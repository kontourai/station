/**
 * Canonical RunService fetchers (#167 Wave 1) — `GET /api/runs` and
 * `GET /api/runs/:id`. This is the third, unrelated "runs" concept named in
 * the audit (distinct from orchestration "runs" and Flow runs). No
 * station-control leg exists today per the audit, so this is a 2-way
 * CLI+SDK dedupe.
 */

import { apiErrorMessage } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';

interface RunsEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * #167 iteration-2 fix (H1): the original version of this function checked
 * `response.ok` *before* parsing the body, discarding a `{success:false,
 * error}` body's `error` text in favor of a generic `Runs API error:
 * <status>` message whenever the status was non-2xx — the exact defect
 * Wave 3 fixed in `client/scheduler.ts`'s `unwrapSchedulerResponse` (see its
 * docblock) but did not sweep to this sibling fetcher. Parsing the body
 * first and preferring its `error` field brings this in line with every
 * other fetcher in `client/**` (`http.ts`'s `readEnvelopeOrThrow`,
 * `projects.ts`'s `unwrapOrThrow`, `scheduler.ts`'s
 * `unwrapSchedulerResponse`), all of which parse-then-check rather than
 * check-then-parse.
 */
async function unwrapRunsResponse<T>(response: Response): Promise<T> {
  let result: RunsEnvelope<T> | null = null;
  try {
    result = (await response.json()) as RunsEnvelope<T>;
  } catch {
    throw new Error(`Runs API error: ${response.status}`);
  }
  if (!response.ok || !result.success) {
    throw new Error(
      apiErrorMessage(result, `Runs API error: ${response.status}`),
    );
  }
  return result.data as T;
}

/** `GET /api/runs` — list runs. */
export async function listRuns<T = unknown[]>(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<T> {
  const response = await getJson(`${apiBase}/api/runs`, opts);
  return unwrapRunsResponse<T>(response);
}

/** `GET /api/runs/:runId` — get one run. */
export async function getRun<T = unknown>(
  apiBase: string,
  runId: string,
  opts?: ClientRequestOptions,
): Promise<T> {
  const response = await getJson(
    `${apiBase}/api/runs/${encodeURIComponent(runId)}`,
    opts,
  );
  return unwrapRunsResponse<T>(response);
}
