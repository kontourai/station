import { APICallError } from 'ai';

/**
 * Outward-safe wording for a model provider's refusal, composed from its HTTP
 * status alone. Nothing the provider said (its error text, response body or
 * URL) is ever part of the result, so the sentence may cross to a client, be
 * persisted in a transcript, or be republished as a `runtime.error` message.
 *
 * Shared by the `/chat` route's failure paths (`stream-orchestrator.ts`) and
 * the station-agent relay (`station-agent-adapter.ts`) so a failed turn reads
 * the same live, after a reload, and in Activity.
 */

/**
 * A credential refusal Station INFERRED from an error's wording (no HTTP
 * response supplied a status), so it names no status code.
 */
export const MODEL_PROVIDER_CREDENTIALS_REJECTED =
  'The model provider rejected the credentials.';

/** A 4xx/5xx integer, else undefined. */
export function modelProviderHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 400 &&
    value <= 599
    ? value
    : undefined;
}

/**
 * The HTTP status of a MODEL PROVIDER's refusal: only an ai-sdk
 * `APICallError` (the error every provider SDK call raises for an HTTP
 * refusal) qualifies. Any other error that happens to carry `status` or
 * `statusCode` (a Hono `HTTPException`, a catalog or route error) is not the
 * model provider's answer and must not be worded as one.
 */
export function modelProviderErrorStatus(error: unknown): number | undefined {
  return APICallError.isInstance(error)
    ? modelProviderHttpStatus(error.statusCode)
    : undefined;
}

/**
 * Wording avoids the words `classifyAgentRunFailure`
 * (orchestration-session-state.ts) reads from a `runtime.error` message —
 * "timeout", "offline", "recover", "cancel" — so the sentence cannot change
 * how a delegated run's failure is classified or whether it is retried.
 */
export function modelProviderFailureMessage(httpStatus: number): string {
  const suffix = `(HTTP ${httpStatus}).`;
  if (httpStatus === 401 || httpStatus === 403) {
    return `The model provider rejected the credentials ${suffix}`;
  }
  if (httpStatus === 404) {
    return `The model provider could not find the model ${suffix}`;
  }
  if (httpStatus === 408 || httpStatus === 504) {
    return `The model provider timed out ${suffix}`;
  }
  if (httpStatus === 429) {
    return `The model provider rate-limited the request ${suffix}`;
  }
  if (httpStatus >= 500) {
    return `The model provider returned an error ${suffix}`;
  }
  return `The model provider refused the request ${suffix}`;
}
