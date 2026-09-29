/**
 * The request-deadline error and the guard every SDK body-read catch uses.
 *
 * Kept apart from `http.ts` so a module that reads a body can import the
 * guard even where a test replaces `http.ts` with a mock; `http.ts`
 * re-exports all three, so the public surface is unchanged.
 */

/**
 * The HTTP methods that cannot change server state. Mirrors the runtime's own
 * `SAFE_HTTP_METHODS` (`src-server/runtime/bootstrap/runtime-http.ts`) — the
 * two are the same concept read from opposite ends of the same request, and
 * both mean "this method is not, by itself, a mutation".
 *
 * What it deliberately does NOT mean is "every other method IS a mutation".
 * Station uses POST for several genuine reads that need a request body
 * (`POST /api/knowledge/index/search`, `POST /api/connections/:id/test`,
 * `POST /api/runs/output`), and no property of the request distinguishes
 * those from a write. That distinction belongs to the operation, which
 * declares it with `ClientRequestOptions['readOnly']`.
 */
export const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A Station request that exceeded its deadline rather than failing outright. */
export class StationRequestTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  /**
   * The HTTP method the aborted request used, uppercased — an observed fact,
   * `undefined` when the constructing call site did not supply one. It is
   * deliberately not defaulted: this class is exported from the published SDK,
   * so a default would stamp an external two-argument construction with a
   * method nobody observed.
   */
  readonly method?: string;
  /**
   * Whether the aborted request could have changed server state. `true` makes
   * the deadline miss *indeterminate* — the server may have applied the write
   * after the client stopped waiting, so the outcome is unknown rather than
   * failed. `false` means it genuinely failed and may be retried freely.
   * `undefined` means nothing derived it (no method was supplied) and no
   * caller may claim either.
   *
   * Derived here rather than by each reporter, from the two things that can
   * answer the question: the method, and the operation's own `readOnly`
   * declaration for the write-shaped methods Station uses for reads.
   */
  readonly mutation?: boolean;

  constructor(
    url: string,
    timeoutMs: number,
    request?: { method?: string; readOnly?: boolean },
  ) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'StationRequestTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
    const method = request?.method?.toUpperCase();
    if (method !== undefined) this.method = method;
    if (request?.readOnly === true) this.mutation = false;
    else if (method !== undefined)
      this.mutation = !SAFE_HTTP_METHODS.has(method);
  }
}

/**
 * The first statement of every SDK catch around a response-body read
 * (`response.json()` and the other body readers) that does not also cover the
 * request itself. A request deadline that fires while the body is read raises
 * `StationRequestTimeoutError` (`fetchWithDeadline`); this passes it on
 * unchanged, with its `mutation` fact, instead of letting the catch report it
 * as an unreadable or non-JSON body. Anything else is left to the catch.
 * `src/__tests__/body-read-deadline.scan.test.ts` holds every such catch
 * to it.
 */
export function rethrowDeadline(error: unknown): void {
  if (error instanceof StationRequestTimeoutError) throw error;
}

/**
 * The promise form of `rethrowDeadline`, for a body reader chained with
 * `.catch`: `.catch(unlessDeadline(() => fallback))`
 * answers the fallback for an unreadable body but passes a request deadline
 * that fired mid-body on as the `StationRequestTimeoutError` it is.
 */
export function unlessDeadline<T>(fallback: () => T): (error: unknown) => T {
  return (error) => {
    rethrowDeadline(error);
    return fallback();
  };
}
