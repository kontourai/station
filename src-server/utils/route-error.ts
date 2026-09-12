/**
 * The one typed error a route may throw to choose its own HTTP answer.
 *
 * Station's route boundary (`configureRuntimeHttp`'s `app.onError` in
 * `runtime/bootstrap/runtime-http.ts`) already answers every unhandled throw
 * with `{ success: false, error: { code: 'internal_error', correlationId } }`
 * at 500, deliberately disclosing nothing: an untyped message is one nobody
 * reviewed for disclosure. `RouteError` is the reviewed exception. A route
 * that throws one is saying "this text is safe to show the caller, and this
 * is the status it deserves"; everything else keeps the generic envelope.
 *
 * What the boundary does with each field:
 * - `status` — the response status, taken verbatim.
 * - `clientMessage` — the response's `error` **string**, and it is still run
 *   through `sanitizeFreeText` at the boundary. That is not redundant with
 *   the reviewed-text claim above: the claim covers the literal a route
 *   writes, and a message is routinely built by interpolating a filename, a
 *   slug, or a service's own text into that literal.
 *
 *   Be exact about what that sanitizer is and is not. It removes every URL
 *   and absolute path, and the credential shapes `redactSecrets` knows: AWS
 *   access-key ids, GitHub tokens, `Bearer`/`Basic` values, `sk-` keys,
 *   `user:pass@` in a connection string, and a `key=value` / `key: value`
 *   pair whose key names a credential. It does NOT remove a high-entropy
 *   value under a key it does not recognize, and — executed — a credential
 *   pair is skipped entirely when an unrecognized `key: value` pair precedes
 *   it on the same line, because that earlier pair's value matches to the
 *   end of the line and the later one is never examined. `redactSecrets`'s
 *   own docblock says to describe it as "known credential shapes are
 *   redacted", never as "secrets are removed"; this docblock used to say the
 *   second thing.
 *
 *   So the sanitizer is a backstop, not a licence. Build `clientMessage`
 *   from literals and ids, not from caught engine or CLI text.
 * - `code` — copied to a **top-level** `code` on the envelope when present,
 *   which is where every existing reader already looks for one. Vocabulary:
 *   a code a domain class already publishes is passed through verbatim
 *   (`AGENT_ID_RESERVED`, `STATION_ENGINE_IS_APP_SETTING`); a code minted for
 *   this contract is snake_case, like the boundary's own `internal_error`
 *   and `missing_param`. Two styles are already on the wire — do not add a
 *   third.
 * - `details` — copied to a top-level `details` when present, matching the
 *   shape `validate()` already sends for field errors. The boundary runs it
 *   through `redactDeep`, but that is the same backstop with the same limits:
 *   `details` is for route-authored structure (field names, ids), never
 *   error-derived data. `scripts/route-error-egress-gate.mjs` reviews both
 *   this and `clientMessage` at every `new RouteError(...)`.
 * - `cause` — never sent. It is what the boundary hands `sanitizeError` for
 *   the server-side log on a 5xx, so the operator keeps the underlying
 *   failure while the caller gets only the reviewed text.
 *
 * The boundary adds a `correlationId` to every `RouteError` response, so the
 * client-visible text and the log line name the same request.
 */

/**
 * The statuses a route may choose. Deliberately a closed set: the boundary
 * passes this value straight to `c.json(body, status)`, and an open `number`
 * would let a typo answer 999 (or 200 — three route files answer 200 with an
 * error body today, which is exactly the defect this contract removes).
 */
export type RouteErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 405
  | 409
  | 413
  | 422
  | 429
  | 500
  | 502
  | 503;

const ROUTE_ERROR_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 405, 409, 413, 422, 429, 500, 502, 503,
]);

/**
 * The `name` the boundary matches on. See {@link isRouteError} for why the
 * name, and not `instanceof`, is the load-bearing check.
 */
export const ROUTE_ERROR_NAME = 'RouteError';

export interface RouteErrorOptions {
  /** Machine-readable refusal code, copied to the envelope's top level. */
  code?: string;
  /** Structured detail, copied to the envelope's top level. */
  details?: Record<string, unknown>;
  /** The underlying failure. Logged (sanitized) on a 5xx, never sent. */
  cause?: unknown;
}

export class RouteError extends Error {
  readonly status: RouteErrorStatus;
  readonly clientMessage: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: RouteErrorStatus,
    clientMessage: string,
    options: RouteErrorOptions = {},
  ) {
    // `cause` is installed only when the caller supplied one: `new Error(m,
    // { cause: undefined })` installs an own `cause` property set to
    // undefined, which reads as "there was a cause" to anything using `in`.
    super(clientMessage, 'cause' in options ? { cause: options.cause } : {});
    this.name = ROUTE_ERROR_NAME;
    this.status = status;
    this.clientMessage = clientMessage;
    if (options.code !== undefined) this.code = options.code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * True for a `RouteError` — including one constructed by a **different loaded
 * copy** of this module.
 *
 * `instanceof` compares constructor identity, and a server process can hold
 * more than one copy of a module: a `.ts` source graph and a `dist/` build,
 * a package resolved twice through differing dependency paths, or a test that
 * loads a route through `await import()` while the boundary came in
 * statically. Under any of those, `instanceof` is false for an error that is
 * a `RouteError` in every way that matters, and the boundary would answer the
 * generic 500 instead of the route's chosen status — a failure that shows up
 * only in whichever deployment shape duplicates the module.
 *
 * So the check is the `name` plus the fields the boundary actually reads.
 * The field checks are not decoration: an unrelated error that happens to be
 * named `RouteError` must not reach `c.json(body, status)` with a status that
 * is not a status.
 */
export function isRouteError(error: unknown): error is RouteError {
  if (error instanceof RouteError) return true;
  if (!(error instanceof Error) || error.name !== ROUTE_ERROR_NAME) {
    return false;
  }
  const candidate = error as Partial<RouteError>;
  return (
    typeof candidate.status === 'number' &&
    ROUTE_ERROR_STATUSES.has(candidate.status) &&
    typeof candidate.clientMessage === 'string'
  );
}
