import { APICallError, RetryError } from 'ai';
import { outwardTransportError } from '../utils/outward-error.js';

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

/** A model provider request that failed without an HTTP status. */
const MODEL_PROVIDER_REQUEST_FAILED = 'The model provider request failed.';

const PROVIDER_ERROR_SEARCH_DEPTH = 4;
const PROVIDER_ERROR_SEARCH_BREADTH = 8;

/**
 * The model provider's error (an ai-sdk `APICallError`) at or inside
 * `error`: through a `RetryError`'s `lastError`/`errors` ("Failed after N
 * attempts. Last error: <provider text>"), an `AggregateError`'s `errors`,
 * and `cause` chains. Bounded in depth and breadth, and cycle-safe.
 *
 * `inconclusive` means the walk stopped before seeing everything (a chain
 * deeper than the bound, more nested errors than the breadth, or a cycle),
 * so a provider error may still be hiding inside: a caller must not trust
 * the wrapper's own message then.
 */
function searchModelProviderError(error: unknown): {
  found?: APICallError;
  inconclusive: boolean;
} {
  let inconclusive = false;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): APICallError | undefined => {
    if (APICallError.isInstance(value)) return value;
    if (!value || typeof value !== 'object') return undefined;
    if (seen.has(value)) {
      inconclusive = true;
      return undefined;
    }
    seen.add(value);
    const nested: unknown[] = [];
    let listed: unknown[] = [];
    if (RetryError.isInstance(value)) {
      nested.push(value.lastError);
      listed = value.errors;
    } else if (value instanceof AggregateError) {
      listed = value.errors;
    }
    if (listed.length > PROVIDER_ERROR_SEARCH_BREADTH) inconclusive = true;
    nested.push(...listed.slice(-PROVIDER_ERROR_SEARCH_BREADTH));
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined) nested.push(cause);
    const children = nested.filter(
      (child) => child !== undefined && child !== null,
    );
    if (children.length === 0) return undefined;
    if (depth >= PROVIDER_ERROR_SEARCH_DEPTH) {
      inconclusive = true;
      return undefined;
    }
    for (const child of children) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  const found = visit(error, 0);
  return found ? { found, inconclusive: false } : { inconclusive };
}

/** {@link searchModelProviderError}'s provider error, if it found one. */
export function findModelProviderError(
  error: unknown,
): APICallError | undefined {
  return searchModelProviderError(error).found;
}

/** A credential refusal named in an error's own wording (no status). */
export function isCredentialShapedMessage(text: string): boolean {
  return (
    text.includes('credential') ||
    text.includes('accessKeyId') ||
    text.includes('secretAccessKey')
  );
}

/**
 * Outward wording for an error that is, or wraps, a model provider's error.
 * `credentialsInferred` is true only when the provider supplied no status
 * and the wording names credentials, the one case a caller may still answer
 * as a 401. When the search was inconclusive it is the fixed outward
 * text; undefined only for an error fully searched with no provider error.
 */
export function outwardModelProviderError(
  error: unknown,
): { text: string; credentialsInferred: boolean } | undefined {
  const { found: providerError, inconclusive } =
    searchModelProviderError(error);
  if (!providerError) {
    // A wrapper whose chain could not be fully searched may still embed
    // provider text in its own message: answer with the fixed outward text.
    return inconclusive
      ? {
          text: outwardTransportError('runtimeHttp'),
          credentialsInferred: false,
        }
      : undefined;
  }
  const status = modelProviderErrorStatus(providerError);
  if (status !== undefined) {
    return {
      text: modelProviderFailureMessage(status),
      credentialsInferred: false,
    };
  }
  const wording = error instanceof Error ? error.message : '';
  return isCredentialShapedMessage(wording) ||
    isCredentialShapedMessage(providerError.message)
    ? { text: MODEL_PROVIDER_CREDENTIALS_REJECTED, credentialsInferred: true }
    : { text: MODEL_PROVIDER_REQUEST_FAILED, credentialsInferred: false };
}

/** {@link outwardModelProviderError}'s text alone. */
export function outwardModelProviderErrorText(
  error: unknown,
): string | undefined {
  return outwardModelProviderError(error)?.text;
}
