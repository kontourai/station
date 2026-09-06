/**
 * Shared, React-free HTTP request helpers for the `@kontourai/station-sdk/client`
 * entry point (#167).
 *
 * Every fetcher under `packages/sdk/src/client/**` takes `apiBase` as an
 * explicit plain-string parameter (never the module-level `_apiBase`/
 * `_setApiBase` singleton from `../api`, which assumes a mounted
 * `SDKProvider`) plus an optional `headers` bag, so the same fetcher can be
 * called from a mounted React app (via a thin SDK-hook wrapper that resolves
 * `apiBase` itself), a CLI process (`resolveApiBase(parsed)` per invocation),
 * or a long-lived `station-control` MCP server process (`resolveControlApiBase()`
 * computed once at startup) — each caller decides its own `apiBase` and
 * `headers`, but there is exactly one HTTP-call implementation per operation.
 *
 * Nothing in this file (or anywhere under `client/**`) may import `react`,
 * `react-dom`, `@tanstack/react-query`, a `.tsx` file, a `.css` file, or
 * reach back into `../hooks*`, `../providers`, `../components/*`, or
 * `../layout/*` — enforced by
 * `packages/sdk/src/__tests__/client-entry-portability.test.ts`.
 */

import {
  type ConnectionRetryClassification,
  isTerminalConnectionStatus,
} from '@kontourai/station-contracts/http';
import { withClientOriginHeaders } from './client-origin.js';

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
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ClientRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Opaque host authority snapshot for a protected request. It partitions
   * query caches and must agree with the credential resolver that dispatches
   * this one request; it never contains a credential or credential-derived
   * secret.
   */
  requestScope?: ApiRequestScope;
  /**
   * Declares that this operation does not change server state even though it
   * uses a write-shaped method — a POST that carries a query in its body
   * rather than a change. Set it on the fetcher that knows what the operation
   * is; nothing else can derive it (see `SAFE_HTTP_METHODS`).
   *
   * The one thing it currently decides is `StationRequestTimeoutError.mutation`,
   * and through it whether a reporter may tell the user their state might have
   * changed. Saying "the request was a write and may still have been applied"
   * about a search is a fabricated state change, so the claim has to be earned
   * by the operation rather than inferred from the verb.
   */
  readOnly?: boolean;
  /** Credential used only for explicit protected Station requests. */
  credential?: string;
  /** Origin the credential belongs to. Credentials are never sent elsewhere. */
  credentialOrigin?: string;
  authentication?: 'required' | 'omit';
  /** Refuse network access without a matching enrolled bearer credential. */
  requireCredential?: boolean;
  /** Identity probes must not follow a response to another listener. */
  redirect?: 'error';
  /** Optional byte ceiling for a GET response body. */
  maxResponseBytes?: number;
  /**
   * Per-call request deadline in milliseconds. `null` (or `0`) opts the call
   * out of the host-configured default — use it for streams and long polls
   * whose response body is deliberately open-ended.
   */
  timeoutMs?: number | null;
}

/** Public, non-secret identity of the host authority a request is bound to. */
export interface ApiRequestScope {
  apiBase: string;
  authorityKey: string;
}

export function isApiRequestScope(
  value: ApiRequestScope | undefined,
): value is ApiRequestScope {
  return Boolean(
    value &&
      value.apiBase.trim().length > 0 &&
      value.authorityKey.trim().length > 0,
  );
}

/**
 * The deadline a host process should configure when it wants one. Exported as
 * a constant rather than applied implicitly: this module is shared by the
 * browser UI (where an in-flight upload or a plugin install legitimately runs
 * past any fixed deadline and the user can see and cancel it) and by headless
 * callers like the CLI (where an unbounded `fetch` is an invisible hang with
 * no output at all). The default is therefore *off* until a host calls
 * `setClientRequestTimeout` — `packages/cli` does so at startup, so browser
 * request behavior is byte-for-byte unchanged by this addition.
 */
export const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 30_000;

let clientRequestTimeoutMs: number | undefined;

function normalizeTimeout(ms: number | null | undefined): number | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  return ms;
}

/**
 * Configure the default request deadline for every `client/**` fetcher in this
 * process. Pass `undefined`/`null`/`0` to disable it again (the initial state).
 */
export function setClientRequestTimeout(ms?: number | null): void {
  clientRequestTimeoutMs = normalizeTimeout(ms);
}

/** The currently configured default deadline, or `undefined` when disabled. */
export function getClientRequestTimeout(): number | undefined {
  return clientRequestTimeoutMs;
}

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
 * Resolves the deadline for one call. Precedence: an explicit `timeoutMs`
 * wins; otherwise a caller-supplied `signal` means the caller owns cancellation
 * (SSE readers, chat streams, long polls) and no deadline is imposed; otherwise
 * the host-configured default applies.
 */
function resolveTimeoutMs(opts?: ClientRequestOptions): number | undefined {
  if (opts && opts.timeoutMs !== undefined) {
    return normalizeTimeout(opts.timeoutMs);
  }
  if (opts?.signal) return undefined;
  return clientRequestTimeoutMs;
}

/**
 * Issues `fetch` with a deadline, translating the resulting abort into a
 * `StationRequestTimeoutError` so callers can tell "the server never answered"
 * apart from "the caller cancelled" and from a transport failure.
 */
async function fetchWithDeadline(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  timeoutMs: number,
  url: string,
  opts?: { request?: ClientAuthenticatedTransport; readOnly?: boolean },
): Promise<Response> {
  const request = opts?.request ?? fetch;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, deadline])
    : deadline;
  // `fetch` defaults an init without a method to GET, so reading GET here is a
  // derivation of what was actually sent, not a stand-in for an unknown.
  const method =
    init?.method ?? (input instanceof Request ? input.method : 'GET');
  try {
    return await request(input, { ...(init ?? {}), signal });
  } catch (error) {
    if (deadline.aborted) {
      throw new StationRequestTimeoutError(url, timeoutMs, {
        method,
        ...(opts?.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
      });
    }
    throw error;
  }
}

export type ClientAuthenticatedRequestInit = RequestInit & {
  /**
   * Native transports may await lazy host setup after the SDK's pre-dispatch
   * check. Call this immediately before their actual dispatch (and after any
   * host-owned body serialization) to preserve the captured authority.
   */
  authorityGuard?: () => void;
};

export type ClientAuthenticatedTransport = (
  input: Parameters<typeof fetch>[0],
  init?: ClientAuthenticatedRequestInit,
) => Promise<Response>;

export type ClientCredential = {
  credential?: string;
  origin: string;
  /**
   * Host-owned authenticated transport for native shells. The renderer gives
   * it a request but never receives or supplies the selected bearer value.
   */
  transport?: ClientAuthenticatedTransport;
  /**
   * The public identity of this resolver settlement. Scoped calls compare it
   * with their captured request scope before dispatch and after every owned
   * response-body read, so an ambient connection switch cannot rebind a
   * retained query to a different bearer on the same host.
   */
  requestAuthority?: ApiRequestScope & { isCurrent: () => boolean };
  /**
   * Optional host-owned transport binding lifetime. Unlike requestAuthority,
   * this does not couple a response to credential generation: native hosts may
   * legitimately recover that generation from the response itself.
   */
  transportBindingIsCurrent?: () => boolean;
  /**
   * Records that this Station rejected the credential. May return the state
   * transition it starts: the fetchers below AWAIT it before resolving the
   * response, so a caller that reads the store straight after a 401 sees the
   * state that 401 caused rather than the one it replaced. A host whose store
   * is synchronous returns nothing and nothing changes.
   */
  onUnauthorized?: () => void | Promise<void>;
  /**
   * Records that this Station accepted an authenticated request, and names the
   * URL it was accepted on. The URL matters to the recipient: a connection
   * keeps its identity across a rebind, so "this connection was reachable" and
   * "THIS ADDRESS accepted us" are different facts.
   */
  onAuthenticated?: (url: string) => void | Promise<void>;
  /** Fail closed for mutations while a remote environment is stale. */
  mutationAllowed?: () => boolean;
};

/** A scoped request cannot be safely attributed to the active authority. */
export class StationRequestAuthorityError extends Error {
  constructor() {
    super('The requested Station authority is no longer available');
    this.name = 'StationRequestAuthorityError';
  }
}

/**
 * A request that would be sent with one credential and reported against
 * another (#3601).
 *
 * A credential resolver is installed, so this request's credential is attached
 * by the SDK and its outcome is reported back to the connection that owns it —
 * `reportUnauthorized` deletes that credential on a 401, `reportAuthenticated`
 * retires the evidence of a rejection on a 2xx. Neither reporter can see a
 * header the caller wrote, so a raw `Authorization` would make both statements
 * about a credential that was never sent. No production caller does this; the
 * published options permitted it, and this closes them rather than picking an
 * attribution nothing derives.
 */
export class StationCredentialConflictError extends Error {
  /** The request URL that carried the conflicting header. */
  readonly url: string;

  constructor(url: string) {
    super(
      'A Station credential resolver is installed for this origin, so this ' +
        "request's credential is attached and its outcome is reported by the " +
        'SDK. Remove the `Authorization` header and pass `credential` with ' +
        '`credentialOrigin` to send a different credential, or ' +
        "`authentication: 'omit'` for a deliberately public request.",
    );
    this.name = 'StationCredentialConflictError';
    this.url = url;
  }
}

export class StationReadOnlyError extends Error {
  constructor() {
    super(
      'Station is reconnecting. Changes are disabled until the connection is verified.',
    );
    this.name = 'StationReadOnlyError';
  }
}

/** A Station HTTP response failure whose status is safe for callers to branch on. */
export class StationHttpError extends Error {
  readonly status: number;

  /**
   * The response's `Retry-After` in milliseconds, when it sent one. Station's
   * runtime sends it with every 429 (`runtime-http.ts`'s auth-failure
   * limiter), which is the server stating exactly when a client may return —
   * an instruction a reconnecting stream should follow rather than guess past.
   */
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    message?: string,
    options?: { retryAfterMs?: number },
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'StationHttpError';
    this.status = status;
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/**
 * The one place that turns a Station response envelope into the sentence a
 * user reads (station#4-HOME-006).
 *
 * Station answers a failure in two shapes, and both are load-bearing: the
 * ordinary route envelope `{success:false, error:"…"}` (a string) and the
 * runtime's own auth refusal `{"error":{"code":"authentication_required"}}`
 * (an OBJECT, with no `success` key at all). A fetcher that assumes the
 * string shape renders `new Error(json.error).message` — literally
 * `[object Object]` — for the second, which is exactly what a user saw on
 * project create when a 401 was in flight.
 *
 * The precedence below is the audit's: an explicit string wins, then the
 * object's own `message`, then its `code`. `code` is a machine token
 * (`authentication_required`) rather than prose, and it is still shown rather
 * than swapped for a friendlier invention — it is what the server actually
 * computed. `fallback` is reached only when the body carried no reason at all.
 */
export function envelopeErrorMessage(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const detail = error as { message?: unknown; code?: unknown };
    if (typeof detail.message === 'string' && detail.message.trim()) {
      return detail.message;
    }
    if (typeof detail.code === 'string' && detail.code.trim()) {
      return detail.code;
    }
  }
  return fallback;
}

/**
 * Reads a JSON body without letting a non-JSON one (a proxy's HTML error page,
 * an empty 204) turn into a parse exception that hides the status the caller
 * needs to branch on.
 */
export async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Parses an HTTP `Retry-After` header. Only the delta-seconds form is honored:
 * the HTTP-date form depends on the client's clock agreeing with the server's,
 * and a skewed clock would produce a wait this code cannot bound. An
 * unparseable or negative value yields `undefined`, which leaves the caller on
 * its ordinary backoff.
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  // Digits only, deliberately. `Number()` would accept far more than the
  // delta-seconds grammar this claims to parse — `'0x10'` as 16 seconds,
  // `'1e3'` as 1000, `' '` and `''` as 0 — turning a malformed header into a
  // confident, wrong wait instead of falling through to the ordinary ladder.
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) return undefined;
  return seconds * 1000;
}

export type ClientCredentialResolver = () =>
  | ClientCredential
  | undefined
  | Promise<ClientCredential | undefined>;

let credentialResolver: ClientCredentialResolver | undefined;

/** Configure the active Station credential without patching global fetch. */
export function setClientCredentialResolver(
  resolver?: ClientCredentialResolver,
): void {
  credentialResolver = resolver;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function urlIsWithinApiBase(url: string, apiBase: string): boolean {
  try {
    const requestUrl = new URL(url);
    const baseUrl = new URL(apiBase);
    if (requestUrl.origin !== baseUrl.origin) return false;
    const basePath = baseUrl.pathname.endsWith('/')
      ? baseUrl.pathname
      : `${baseUrl.pathname}/`;
    return (
      requestUrl.pathname === baseUrl.pathname ||
      requestUrl.pathname.startsWith(basePath)
    );
  } catch {
    return false;
  }
}

/** Snapshot mutable caller options before any credential-resolver await. */
function snapshotRequestOptions(
  opts: ClientRequestOptions | undefined,
): ClientRequestOptions | undefined {
  if (!opts?.requestScope) return opts;
  return {
    ...opts,
    requestScope: {
      apiBase: opts.requestScope.apiBase,
      authorityKey: opts.requestScope.authorityKey,
    },
  };
}

/**
 * Captures and verifies one authority settlement without re-resolving it.
 * Calling the resolver again would observe a different connection and could
 * not truthfully say which authority sent the original request.
 */
function bindRequestAuthority(
  url: string,
  opts: ClientRequestOptions | undefined,
  configured: ClientCredential | undefined,
): () => void {
  const expected = opts?.requestScope;
  const bindingIsCurrent =
    configured?.transportBindingIsCurrent && sameOrigin(url, configured.origin)
      ? configured.transportBindingIsCurrent
      : undefined;
  if (!expected && !bindingIsCurrent) return () => undefined;
  const requestAuthority = configured?.requestAuthority;
  if (expected && (!isApiRequestScope(expected) || !requestAuthority))
    throw new StationRequestAuthorityError();
  const actual =
    requestAuthority && expected
      ? {
          apiBase: requestAuthority.apiBase,
          authorityKey: requestAuthority.authorityKey,
          isCurrent: requestAuthority.isCurrent,
        }
      : undefined;
  const assertCurrent = () => {
    if (
      (actual &&
        (actual.apiBase !== expected!.apiBase ||
          actual.authorityKey !== expected!.authorityKey ||
          !urlIsWithinApiBase(url, expected!.apiBase) ||
          !actual.isCurrent())) ||
      (bindingIsCurrent && !bindingIsCurrent())
    )
      throw new StationRequestAuthorityError();
  };
  assertCurrent();
  return assertCurrent;
}

/** Guard owned body readers as well as the request/response boundary. */
function guardResponseAuthority(
  response: Response,
  assertCurrent: () => void,
): Response {
  return new Proxy(response, {
    get(target, property) {
      if (
        property === 'json' ||
        property === 'text' ||
        property === 'arrayBuffer' ||
        property === 'blob' ||
        property === 'formData'
      ) {
        return async () => {
          assertCurrent();
          const read = Reflect.get(
            target,
            property,
            target,
          ) as () => Promise<unknown>;
          const value = await read.call(target);
          assertCurrent();
          return value;
        };
      }
      if (property === 'clone') {
        return () => {
          assertCurrent();
          return guardResponseAuthority(target.clone(), assertCurrent);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Response;
}

function nativeTransportInit(
  init: RequestInit,
  opts: ClientRequestOptions | undefined,
  configured: ClientCredential | undefined,
  assertAuthority: () => void,
): ClientAuthenticatedRequestInit {
  return configured?.transport &&
    (opts?.requestScope || configured.transportBindingIsCurrent)
    ? ({
        ...init,
        authorityGuard: assertAuthority,
      } satisfies ClientAuthenticatedRequestInit)
    : init;
}

function needsAuthorityGuard(
  url: string,
  opts: ClientRequestOptions | undefined,
  configured: ClientCredential | undefined,
): boolean {
  return Boolean(
    opts?.requestScope ||
      (configured?.transportBindingIsCurrent &&
        sameOrigin(url, configured.origin)),
  );
}

/**
 * ONE credential resolution per request, taken before the request is issued.
 *
 * The resolver is a live read — `ApiBaseContext`'s implementation captures the
 * active connection, its credential generation, its credential and its address
 * each time it runs — so calling it twice for one request can attach one
 * connection's credential to another's evidence, and calling it again after
 * the response rebinds a stale result to whatever is current NOW. Every caller
 * below therefore resolves once, here, and passes the result to both the
 * header builder and the reporters.
 */
async function resolveRequestCredential(
  opts?: ClientRequestOptions,
): Promise<ClientCredential | undefined> {
  // An explicitly supplied per-call credential opts OUT of the ambient
  // resolver: it carries no transport and no callbacks, and the ambient
  // connection it does not belong to must not be told anything about it.
  if (opts?.credential && opts.credentialOrigin) return undefined;
  return credentialResolver?.();
}

function resolveRequestHeaders(
  url: string,
  configured: ClientCredential | undefined,
  opts?: ClientRequestOptions,
): Record<string, string> | undefined {
  const headers = withClientOriginHeaders(opts?.headers) ?? {};
  if (
    opts?.requireCredential &&
    (opts.authentication === 'omit' ||
      new Headers(headers).has('Authorization'))
  ) {
    throw new Error(
      'Enrolled requests require SDK-owned credential attachment',
    );
  }
  if (opts?.authentication === 'omit') {
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  const explicit =
    opts?.credential && opts.credentialOrigin
      ? { credential: opts.credential, origin: opts.credentialOrigin }
      : undefined;
  // The request would be SENT with the caller's credential and REPORTED
  // against the ambient one: `reportUnauthorized`/`reportAuthenticated` are
  // both handed `configured`, and neither can see a header. A 401 answered to
  // somebody else's bearer would then delete this connection's credential, and
  // a 2xx would retire evidence that a revoked credential is still revoked.
  // There is no correct attribution to fall back on here, so refuse.
  if (
    !explicit &&
    configured &&
    sameOrigin(url, configured.origin) &&
    new Headers(headers).has('Authorization')
  ) {
    throw new StationCredentialConflictError(url);
  }
  const source = explicit ?? configured;
  if (
    opts?.requireCredential &&
    (!source?.credential || !sameOrigin(url, source.origin))
  ) {
    throw new Error(
      'An enrolled Station credential for this target is required',
    );
  }
  if (
    source?.credential &&
    sameOrigin(url, source.origin) &&
    !new Headers(headers).has('Authorization')
  ) {
    headers.Authorization = `Bearer ${source.credential}`;
  }
  return withClientOriginHeaders(headers);
}

/**
 * Reports a rejection to the credential that was ACTUALLY sent.
 *
 * This used to re-resolve at response time, which rebound a late 401 to
 * whatever the app had become in the meantime. The damaging shape: a request
 * leaves with an old device session, pairing completes, the old request's 401
 * lands, and the freshly resolved callback reports it against the NEW
 * credential — which `markCredentialRequired` then deletes, undoing the
 * pairing. For a device session both credential values are `undefined`, so the
 * store's equality guard could not tell the two apart at all.
 *
 * `configured` is now the record captured when the request was issued, exactly
 * as on the 2xx path, and it carries the generation the store uses to drop a
 * report that has been overtaken.
 */
/**
 * How long a fetcher will wait for the state transition its report starts
 * before resolving the response anyway (delta review 2, MEDIUM).
 *
 * The transition is applied under a Web Lock, and a contended lock neither
 * rejects nor times out — so a stalled same-origin holder (another tab wedged
 * mid-callback, a lifecycle-suspended document) could delay a 401 response,
 * and the `StationHttpError` built from it, indefinitely. The request's own
 * deadline does not cover this phase because the response has already
 * arrived.
 *
 * On the deadline the fetcher proceeds and the write still lands when the lock
 * frees; what is lost is only the ORDERING guarantee, which is exactly the
 * thing worth trading for not hanging a caller forever.
 */
export const CREDENTIAL_REPORT_DEADLINE_MS = 2_000;

let credentialReportDeadlineLogged = false;

/**
 * Awaits a reporter's transition, bounded. Returns once the transition has
 * been applied or the deadline passes, whichever is first.
 */
async function awaitCredentialReport(
  transition: void | Promise<void>,
): Promise<void> {
  if (!transition || typeof transition.then !== 'function') return;
  // A transition that settles after the deadline must not surface as an
  // unhandled rejection: nothing is listening by then.
  const settled = transition.then(
    () => true,
    () => true,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), CREDENTIAL_REPORT_DEADLINE_MS);
  });
  try {
    const applied = await Promise.race([settled, deadline]);
    if (applied || credentialReportDeadlineLogged) return;
    credentialReportDeadlineLogged = true;
    try {
      console.warn(
        `[station-sdk] a credential state transition did not complete within ${CREDENTIAL_REPORT_DEADLINE_MS}ms; continuing without it. The write still lands when the store's lock frees.`,
      );
    } catch {
      // A host without a usable console must not turn this into a failure.
    }
  } finally {
    clearTimeout(timer);
  }
}

async function reportUnauthorized(
  url: string,
  response: Response,
  configured: ClientCredential | undefined,
  opts?: ClientRequestOptions,
): Promise<void> {
  if (response.status !== 401 || opts?.authentication === 'omit') return;
  if (configured && sameOrigin(url, configured.origin)) {
    // Awaited so the response boundary is ordered after the transition this
    // report causes. A store that serializes writes across documents (Web
    // Locks) applies them in a lock callback, so without this a caller that
    // awaited the request could still read the pre-report state — and the
    // user-visible contract the recovery suite pins ("the banner is gone the
    // moment the accepted response resolves") held only where the store
    // happened to be synchronous. Bounded — see `awaitCredentialReport`.
    await awaitCredentialReport(configured.onUnauthorized?.());
  }
}

/**
 * The mirror of `reportUnauthorized`, and deliberately gated on the same two
 * facts: a request that did not carry this Station's credentials says nothing
 * about them either way.
 *
 * `authentication: 'omit'` is a DELIBERATELY public request — the event-stream
 * resume probe and the session-event-window probe both use it against
 * `/.well-known/station/v1`, which answers 200 to an anonymous caller. Reading
 * that 200 as "the Station accepted our credentials" would retire the evidence
 * of a genuinely revoked session and reproduce the exact contradiction this
 * callback exists to remove (chip "Connected", banner "Request access").
 */
async function reportAuthenticated(
  url: string,
  response: Response,
  configured: ClientCredential | undefined,
  opts?: ClientRequestOptions,
): Promise<void> {
  if (!response.ok || opts?.authentication === 'omit') return;
  if (configured && sameOrigin(url, configured.origin)) {
    // Awaited, and bounded, for the same reasons as `reportUnauthorized`.
    await awaitCredentialReport(configured.onAuthenticated?.(url));
  }
}

/** Preserve the three authority boundaries around both awaited reporters. */
async function settleCredentialResponse(
  url: string,
  response: Response,
  configured: ClientCredential | undefined,
  opts: ClientRequestOptions | undefined,
  assertAuthority: () => void,
): Promise<void> {
  assertAuthority();
  await reportUnauthorized(url, response, configured, opts);
  assertAuthority();
  await reportAuthenticated(url, response, configured, opts);
  assertAuthority();
}

/**
 * `RequestInit` plus the per-call deadline override. Callers whose request is
 * legitimately long-running (a server-side gate command, a corpus rebuild)
 * pass `timeoutMs: null` to opt out of the host default.
 */
export type AuthenticatedFetchInit = RequestInit & {
  timeoutMs?: number | null;
  /** See `ClientRequestOptions['readOnly']` — the same declaration, for the
   * call sites that reach Station through `authenticatedFetch` directly. */
  readOnly?: boolean;
};

/** Fetch a protected Station resource through the configured auth boundary. */
export async function authenticatedFetch(
  input: Parameters<typeof fetch>[0],
  ...args: [init?: AuthenticatedFetchInit]
): Promise<Response> {
  const { timeoutMs: initTimeoutMs, readOnly, ...rest } = args[0] ?? {};
  const init = args[0] === undefined ? undefined : (rest as RequestInit);
  const hasInitArgument = args.length > 0;
  const url = input instanceof Request ? input.url : input.toString();
  const configured = await credentialResolver?.();
  const timeoutMs = resolveTimeoutMs({
    ...(initTimeoutMs !== undefined ? { timeoutMs: initTimeoutMs } : {}),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
  if (!configured || !sameOrigin(url, configured.origin)) {
    const originHeaders = withClientOriginHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const originInit = originHeaders
      ? { ...(init ?? {}), headers: originHeaders }
      : init;
    // Arity is preserved deliberately: several suites pin `fetch(url)` vs
    // `fetch(url, undefined)` on this path, and adding a deadline must not
    // change the call shape when no deadline is configured.
    if (timeoutMs === undefined) {
      return hasInitArgument || originInit !== undefined
        ? fetch(input, originInit)
        : fetch(input);
    }
    return fetchWithDeadline(input, originInit, timeoutMs, url, {
      ...(readOnly !== undefined ? { readOnly } : {}),
    });
  }
  const request = configured.transport ?? fetch;
  const method = (
    init?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
  // Deliberately method-only, and deliberately NOT widened by `readOnly`: this
  // is a fail-closed guard on a stale remote environment, and a declaration
  // that exists to make an error message honest is not a reason to let a
  // request through a gate it is currently held by.
  if (
    !SAFE_HTTP_METHODS.has(method) &&
    configured.mutationAllowed?.() === false
  ) {
    throw new StationReadOnlyError();
  }
  // Headers from a `Request` object count too: a caller can hide an
  // `Authorization` there and never touch `init.headers` (#3601 review,
  // MEDIUM).
  //
  // ...but `fetch(request, init)` REPLACES the request's header list when
  // `init.headers` is supplied — it does not merge it (#3601 delta review,
  // MEDIUM). Merging both falsely rejected a caller who removed an embedded
  // `Authorization` by passing replacement headers, and sent embedded headers
  // that the caller had deliberately dropped.
  const requestHeaders = input instanceof Request ? input.headers : undefined;
  const mergedHeaders = new Headers(
    init?.headers !== undefined ? init.headers : requestHeaders,
  );
  const headerRecord: Record<string, string> = {};
  mergedHeaders.forEach((value, key) => {
    headerRecord[key] = value;
  });
  if (configured.credential) {
    // The resolved credential wins, and it is the one both reporters below
    // are about, so request and report still agree. Overwriting rather than
    // refusing is deliberate and long-standing: a native host that owns the
    // bearer answers for this origin whatever a caller wrote.
    //
    // The delete is not decoration. `Headers.forEach` yields LOWERCASED names,
    // so a caller's header arrives in this record as `authorization` while
    // this line writes `Authorization` — and `fetch` then joins the two into
    // one comma-separated value, putting BOTH credentials on the wire. Found
    // by the native-transport test below, which asserted the header this path
    // claims to send.
    for (const name of Object.keys(headerRecord)) {
      if (name.toLowerCase() === 'authorization') delete headerRecord[name];
    }
    headerRecord.Authorization = `Bearer ${configured.credential}`;
  } else if (mergedHeaders.has('Authorization')) {
    // No ambient bearer to overwrite it with, so the caller's header would be
    // SENT while `reportUnauthorized`/`reportAuthenticated` below still
    // reported the outcome against the ambient credential — the device-session
    // shape, where `credential` is `undefined` but the callbacks and the
    // generation behind them are very much not. Same refusal as the
    // `getJson`/`mutateJson` path, for the same reason.
    throw new StationCredentialConflictError(url);
  }
  const requestInit = { ...(init ?? {}) };
  const originHeaders = withClientOriginHeaders(headerRecord, true);
  if (originHeaders) requestInit.headers = originHeaders;
  const assertAuthority = bindRequestAuthority(url, undefined, configured);
  assertAuthority();
  const transportInit = nativeTransportInit(
    requestInit,
    undefined,
    configured,
    assertAuthority,
  );
  const response =
    timeoutMs === undefined
      ? await request(input, transportInit)
      : await fetchWithDeadline(input, transportInit, timeoutMs, url, {
          request,
          ...(readOnly !== undefined ? { readOnly } : {}),
        });
  await settleCredentialResponse(
    url,
    response,
    configured,
    { authentication: 'required' },
    assertAuthority,
  );
  return needsAuthorityGuard(url, undefined, configured)
    ? guardResponseAuthority(response, assertAuthority)
    : response;
}

export interface JsonEnvelope<T> {
  success: boolean;
  data?: T;
  error?: unknown;
  message?: unknown;
}

function envelopeFailureMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Issues a GET request. Always calls `fetch(url, init)` with an explicit
 * `init` object (`{ method: 'GET' }`, plus `headers` when supplied) — a
 * uniform two-argument call shape matching `mutateJson` below, rather than
 * the single-argument `fetch(url)` this function used for headerless GETs
 * before #167 Wave 3.
 *
 * #167 Wave 3 correction: the original single-argument shape was carried
 * forward specifically to match a pre-existing pinned assertion in
 * `packages/sdk/src/__tests__/scheduler.test.ts` (`toHaveBeenCalledWith(url)`,
 * no second argument) — but that assertion pinned an incidental
 * implementation detail (arity), not an observable behavioral contract
 * (`fetch(url)` and `fetch(url, { method: 'GET' })` are equivalent to the
 * Fetch API). That mismatch was also the root cause of Wave 2A's `agents
 * list` CLI migration being left as a documented exception (its own pinned
 * test, `core.test.ts`, expects the *two*-argument shape). Standardizing on
 * the explicit two-argument call resolves both: `scheduler.test.ts` is
 * updated alongside this change (see its own updated assertion), and
 * `agents list` in `packages/cli/src/commands/core.ts` no longer needs the
 * exception.
 */
export async function getJson(
  url: string,
  opts?: ClientRequestOptions,
): Promise<Response> {
  const requestOptions = snapshotRequestOptions(opts);
  const maximum = requestOptions?.maxResponseBytes;
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1))
    throw new Error('Invalid response byte limit');
  const init: RequestInit = {
    method: 'GET',
    ...(requestOptions?.redirect ? { redirect: requestOptions.redirect } : {}),
  };
  if (requestOptions?.signal) init.signal = requestOptions.signal;
  const configured = await resolveRequestCredential(requestOptions);
  const assertAuthority = bindRequestAuthority(url, requestOptions, configured);
  const headers = withClientOriginHeaders(
    resolveRequestHeaders(url, configured, requestOptions),
    Boolean(
      configured &&
        sameOrigin(url, configured.origin) &&
        requestOptions?.authentication !== 'omit',
    ),
  );
  if (headers) {
    init.headers = headers;
  }
  const timeoutMs = resolveTimeoutMs(requestOptions);
  const request =
    configured?.transport && sameOrigin(url, configured.origin)
      ? configured.transport
      : fetch;
  const dispatchInit = nativeTransportInit(
    init,
    requestOptions,
    configured,
    assertAuthority,
  );
  const response =
    timeoutMs === undefined
      ? await request(url, dispatchInit)
      : await fetchWithDeadline(url, dispatchInit, timeoutMs, url, {
          request,
        });
  await settleCredentialResponse(
    url,
    response,
    configured,
    requestOptions,
    assertAuthority,
  );
  const result =
    maximum === undefined
      ? response
      : (await import('./bounded-response')).boundResponse(
          response,
          maximum,
          assertAuthority,
        );
  return needsAuthorityGuard(url, requestOptions, configured)
    ? guardResponseAuthority(result, assertAuthority)
    : result;
}

/**
 * Issues a mutating (POST/PUT/DELETE/PATCH) request. `body`, when provided,
 * is JSON-stringified and sent with a `Content-Type: application/json`
 * header; `opts.headers` are merged in on top (station-control attaches
 * `x-station-internal-token` this way, the CLI attaches nothing).
 *
 * A fetcher whose write-shaped method is carrying a query rather than a change
 * (`POST /api/knowledge/index/search`) passes `opts.readOnly` so a deadline
 * miss is not reported as a possible state change.
 */
export async function mutateJson(
  url: string,
  method: string,
  opts?: ClientRequestOptions,
  body?: unknown,
): Promise<Response> {
  const requestOptions = snapshotRequestOptions(opts);
  const hasBody = body !== undefined;
  const baseHeaders =
    hasBody || requestOptions?.headers
      ? {
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...(requestOptions?.headers || {}),
        }
      : undefined;
  const configured = await resolveRequestCredential(requestOptions);
  const assertAuthority = bindRequestAuthority(url, requestOptions, configured);
  const headers = withClientOriginHeaders(
    resolveRequestHeaders(url, configured, {
      ...requestOptions,
      headers: baseHeaders,
    }),
    Boolean(
      configured &&
        sameOrigin(url, configured.origin) &&
        requestOptions?.authentication !== 'omit',
    ),
  );
  const init: RequestInit = { method };
  if (requestOptions?.signal) init.signal = requestOptions.signal;
  if (headers) {
    init.headers = headers;
  }
  if (hasBody) {
    init.body = JSON.stringify(body);
  }
  const timeoutMs = resolveTimeoutMs(requestOptions);
  const request =
    configured?.transport && sameOrigin(url, configured.origin)
      ? configured.transport
      : fetch;
  const dispatchInit = nativeTransportInit(
    init,
    requestOptions,
    configured,
    assertAuthority,
  );
  const response =
    timeoutMs === undefined
      ? await request(url, dispatchInit)
      : await fetchWithDeadline(url, dispatchInit, timeoutMs, url, {
          request,
          ...(requestOptions?.readOnly !== undefined
            ? { readOnly: requestOptions.readOnly }
            : {}),
        });
  await settleCredentialResponse(
    url,
    response,
    configured,
    requestOptions,
    assertAuthority,
  );
  return needsAuthorityGuard(url, requestOptions, configured)
    ? guardResponseAuthority(response, assertAuthority)
    : response;
}

export interface FetchSseMessage {
  data: string;
  event: string;
  id?: string;
}

export interface FetchSseOptions extends ClientRequestOptions {
  signal?: AbortSignal;
  reconnect?: boolean;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxRetries?: number;
  /** Messages required before a connection resets consecutive failures. */
  retryResetAfterMessages?: number;
  /**
   * How long a connection must stay OPEN before it counts as healthy enough to
   * restart the backoff ladder — station#1848. Defaults to 30s.
   *
   * Delivered frames alone cannot answer that question on this runtime's own
   * endpoints. `/api/orchestration/events` writes a snapshot (or replay) and
   * an unconditional caught-up marker before it can ever stall, so EVERY
   * accepted connection delivers frames within milliseconds — including one a
   * proxy idle-closes, a restarting server drops, or a supervisor kills. A
   * message-count reset therefore fires on mere TCP acceptance and flattens
   * the ladder back to a fixed-rate poll for exactly the failure class that
   * looks healthy, which is the one that also replays the snapshot each time.
   *
   * 30s is derived, not chosen: it is the server's own SSE keepalive interval
   * (`SSE_KEEPALIVE_INTERVAL_MS`), so a connection that outlived it is one the
   * server was actively maintaining. A connection cut sooner leaves the ladder
   * climbing, which is the correct direction — something is wrong.
   */
  healthyConnectionMs?: number;
  onOpen?: (response: Response) => void;
  /** Return false when the frame was rejected and must not advance its checkpoint. */
  onMessage: (message: FetchSseMessage) => unknown;
  /** An accepted SSE checkpoint, after its frame was delivered to onMessage. */
  onCheckpoint?: (checkpoint: { id?: string; retry?: number }) => void;
  onError?: (error: unknown) => void;
  /**
   * Fires once when a failure is classified `terminal` (401/403 — station#1094)
   * and the stream has stopped retrying automatically. `onError` also fires
   * for this same failure (unchanged, so existing consumers keep whatever
   * generic "disconnected" handling they already had); `onTerminal` is the
   * additive signal a caller can use to render a truthful "credential
   * required / blocked" state instead of a perpetual reconnect indicator.
   * The stream stays open to `retry()` or a `notifyCredentialChanged()` call
   * (see below) — it does not need to be re-created.
   */
  onTerminal?: (error: unknown) => void;
  /**
   * station#3437 review (HIGH-2): fires once, synchronously, the moment a
   * terminal (401/403) stop resumes — `retry()` or `notifyCredentialChanged()`
   * woke it — right before the next connection attempt, regardless of what
   * that attempt does next. `onTerminal`'s own state has no clearing
   * counterpart: the loop's terminal condition ends at this wake, not at a
   * successful `onOpen`, so a caller that only clears its "stopped" flag in
   * `onOpen` stays stuck claiming a credential rejection through an attempt
   * that fails with a NETWORK-level failure on the resumed attempt (no
   * `Response` ever arrives — a rejected `fetch`, DNS failure, or timeout —
   * so `onError` fires but `onOpen` never does). station#3458 made this true
   * of EVERY transient failure, not just network-level ones: `onOpen` now
   * fires only for a response the transport actually consumes
   * (`response.ok`), so an HTTP-status failure such as a 500 fires `onError`
   * but not `onOpen` either. This is that signal — "automatic retries are
   * active again", not a promise the next attempt will succeed.
   */
  onRetry?: () => void;
}

export interface FetchSseConnection {
  close(): void;
  readonly signal: AbortSignal;
  readonly completed: Promise<void>;
  /**
   * Force-resume a stream that is currently waiting out a terminal (401/403)
   * stop — station#1094. A no-op when the stream is not currently blocked
   * (e.g. it is mid-backoff on a transient failure, which will retry on its
   * own schedule already).
   */
  retry(): void;
  /** Restarts only the current request while preserving Last-Event-ID. */
  restart(): void;
}

/**
 * Every `fetchSSE` stream currently waiting out a terminal (401/403) stop
 * registers its own wake callback here while blocked, keyed by the
 * *request's own origin* — never the whole process. `notifyCredentialChanged`
 * lets a host that owns credential changes (station's `ApiBaseContext`) wake
 * every stream for ONE origin at once when that origin's saved credential is
 * fixed, mirroring `@kontourai/station-connect`'s `useConnectionStatus`
 * equivalent wake for the health-poll path (station#1094 R3/R4).
 *
 * Origin-scoped deliberately (station#1094 review, HIGH): an unscoped
 * process-global wake would resume every blocked stream in the tab
 * regardless of which connection's credential actually changed, including
 * ones for a different Station entirely — surprising at best, and actively
 * wrong once a stream can outlive its owning consumer (see the
 * `ensureOrchestrationEventStream` orphan-close fix this same review round
 * added). This is also a natural building block toward station#1096's
 * per-environment supervisor registry, not a throwaway restriction.
 */
const credentialChangeListeners = new Map<string, Set<() => void>>();

function requestOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // A relative/malformed URL never legitimately reaches `fetch` here in
    // practice (every real caller passes an absolute `apiBase`-rooted URL)
    // — fall back to the raw string so a listener still registers and
    // un-registers under a consistent key instead of throwing.
    return url;
  }
}

function addCredentialChangeListener(
  origin: string,
  listener: () => void,
): void {
  let listeners = credentialChangeListeners.get(origin);
  if (!listeners) {
    listeners = new Set();
    credentialChangeListeners.set(origin, listeners);
  }
  listeners.add(listener);
}

function removeCredentialChangeListener(
  origin: string,
  listener: () => void,
): void {
  const listeners = credentialChangeListeners.get(origin);
  if (!listeners) return;
  listeners.delete(listener);
  if (listeners.size === 0) credentialChangeListeners.delete(origin);
}

/**
 * Wake every `fetchSSE` stream currently blocked on a terminal (401/403)
 * failure for `origin` so a freshly fixed credential resumes them
 * immediately instead of leaving the UI stuck on "credential required"
 * until a manual retry — station#1094. `origin` is normalized the same way
 * `fetchSSE` scopes its own listener registration, so passing either a bare
 * origin (`https://host:port`) or a full request URL on that origin works.
 */
export function notifyCredentialChanged(origin: string): void {
  const listeners = credentialChangeListeners.get(requestOrigin(origin));
  if (!listeners) return;
  for (const listener of listeners) listener();
}

/**
 * Host event targets, reached structurally rather than through the DOM lib.
 * This package is published and runs under Node (CLI, tests, SSR) as well as
 * in a browser, so its tsconfig deliberately omits `lib: dom` — referencing
 * `window`/`document` by name would not compile, and declaring the DOM lib to
 * get one optional wake signal would let genuinely browser-only APIs typecheck
 * everywhere else in the SDK.
 */
type HostEventTarget = {
  addEventListener(
    type: string,
    listener: (event?: { persisted?: boolean }) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event?: { persisted?: boolean }) => void,
  ): void;
};

function browserDocument():
  | (HostEventTarget & { hidden?: boolean })
  | undefined {
  return (
    globalThis as {
      document?: HostEventTarget & { hidden?: boolean };
    }
  ).document;
}

function browserWindow(): HostEventTarget | undefined {
  return (globalThis as { window?: HostEventTarget }).window;
}

/**
 * A backoff wait that a real recovery signal can cut short — station#1848.
 *
 * Nothing used to interrupt a transient backoff, so a `station upgrade` (which
 * restarts the server) left the stream asleep for up to the ceiling while the
 * connection-status poll and every react-query refetch had already recovered:
 * a frozen live feed beside freshly loaded lists. It wakes on the same signals
 * `packages/connect/src/core/pendingPairingCompletion.ts` uses — visibility,
 * focus, `online` — and on an explicit `wake()` (the stream's `retry()`).
 *
 * `minElapsedBeforeWake` bounds what a pathological wake source can do, and the
 * bound is worth stating precisely rather than generously: a page being focused
 * repeatedly, or a flapping network adapter, can at worst restore the BASE
 * interval — never faster — and only for as long as the host keeps emitting
 * recovery signals. That is the pre-fix flat rate, not an improvement on it; a
 * source firing every 2.5s measures ~24 reconnects/min against the pre-fix
 * ~30/min. What it is not is a regression: the ladder's own value keeps
 * doubling underneath, so the moment the signals stop the wait is already long.
 * An explicit `wake()` is a deliberate host action and is honored immediately.
 */
function interruptibleDelay(
  ms: number,
  signal: AbortSignal,
  minElapsedBeforeWake: number,
): { promise: Promise<void>; wake: () => void } {
  if (signal.aborted) return { promise: Promise.resolve(), wake: () => {} };
  const startedAt = Date.now();
  let settled = false;
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    const onWake = () => {
      // A hidden tab's `visibilitychange` is the tab LEAVING, not returning.
      if (browserDocument()?.hidden === true) return;
      if (Date.now() - startedAt < minElapsedBeforeWake) return;
      finish();
    };
    finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      browserDocument()?.removeEventListener('visibilitychange', onWake);
      const scope = browserWindow();
      scope?.removeEventListener('focus', onWake);
      scope?.removeEventListener('online', onWake);
      resolve();
    };
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener('abort', finish, { once: true });
    browserDocument()?.addEventListener('visibilitychange', onWake);
    const scope = browserWindow();
    scope?.addEventListener('focus', onWake);
    scope?.addEventListener('online', onWake);
  });
  return { promise, wake: () => finish() };
}

/** Resolves once, either when `signal` aborts or when `wake()` is invoked. */
function waitForWakeOrAbort(signal: AbortSignal): {
  promise: Promise<void>;
  wake: () => void;
} {
  let wakeResolve: (() => void) | undefined;
  const wakePromise = new Promise<void>((resolve) => {
    wakeResolve = resolve;
  });
  const abortPromise = new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  return {
    promise: Promise.race([wakePromise, abortPromise]),
    wake: () => wakeResolve?.(),
  };
}

/**
 * Classifies a `fetchSSE` attempt failure using the same transient/terminal
 * vocabulary as `@kontourai/station-connect`'s `ConnectionSupervisor`
 * (station#1094 R2). Only a `StationHttpError` carrying a terminal HTTP
 * status (401/403, via `isTerminalConnectionStatus`) is terminal — a network
 * error, a non-HTTP throw, or any other status stays transient and keeps
 * today's bounded exponential backoff.
 */
function classifySseFailure(error: unknown): ConnectionRetryClassification {
  if (
    error instanceof StationHttpError &&
    isTerminalConnectionStatus(error.status)
  ) {
    return 'terminal';
  }
  return 'transient';
}

function dispatchSseFrame(
  lines: string[],
  onMessage: (message: FetchSseMessage) => unknown,
): { accepted: boolean; id?: string; retry?: number } {
  let event = 'message';
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value || 'message';
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }
  const accepted =
    data.length === 0 ||
    onMessage({ data: data.join('\n'), event, id }) !== false;
  return { accepted, id, retry };
}

async function consumeSseResponse(
  response: Response,
  signal: AbortSignal,
  onMessage: (message: FetchSseMessage) => unknown,
  onCheckpoint: (checkpoint: { id?: string; retry?: number }) => void,
): Promise<void> {
  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    throw new StationHttpError(
      response.status,
      `SSE request failed with HTTP ${response.status}`,
      ...(retryAfterMs !== undefined ? [{ retryAfterMs }] : []),
    );
  }
  if (!response.body) throw new Error('SSE response body is unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancelReader = () => {
    void reader.cancel();
  };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const result = dispatchSseFrame(frame.split(/\r?\n/), onMessage);
        if (result.accepted) onCheckpoint(result);
      }
      if (chunk.done) break;
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }
}

/**
 * Connect to a protected Station SSE endpoint with origin-scoped Bearer auth.
 * The returned handle provides deterministic abort/cleanup and the transport
 * reconnects with bounded backoff while retaining Last-Event-ID.
 */
export function fetchSSE(
  url: string,
  opts: FetchSseOptions,
): FetchSseConnection {
  const controller = new AbortController();
  const abort = () => controller.abort();
  // Resolve this once per browser-owned stream. A non-persisted pagehide is
  // terminal for this document; keeping an SSE reader alive after navigation
  // can retain a stale UI tree and its credentials. BFCache entry is different:
  // the same page may resume, so it intentionally keeps the stream alive.
  const page = browserWindow();
  const abortOnPageHide = (event?: { persisted?: boolean }) => {
    if (!event?.persisted) abort();
  };
  page?.addEventListener('pagehide', abortOnPageHide);
  opts.signal?.addEventListener('abort', abort, { once: true });
  const origin = requestOrigin(url);
  const initialRetryDelay = opts.retryDelayMs ?? 1000;
  // Set while a stop is being waited out — a terminal (401/403) park, or a
  // transient backoff (station#1848) — so `retry()` cuts either one short.
  let wake: (() => void) | null = null;
  let activeAttempt: AbortController | null = null;
  let restartPending = false;
  const retry = () => wake?.();
  const restart = () => {
    if (controller.signal.aborted || restartPending) return;
    restartPending = true;
    activeAttempt?.abort();
    wake?.();
  };
  const completed = (async () => {
    // The delay a fresh ladder starts from, and the floor a restarted ladder
    // returns to. `initialRetryDelay` until the server advertises its own
    // `retry:` interval, which becomes the floor from then on. Note what this
    // does NOT do: a server-advertised interval is the STARTING delay, not a
    // fixed one — repeated failures still double from it, up to the ceiling.
    // Honoring it as an unconditional fixed interval is what a flat poll is,
    // and this endpoint's incident (station#1848) is what that costs.
    let baseRetryDelay = initialRetryDelay;
    let retryDelay = baseRetryDelay;
    const maxRetryDelay = opts.maxRetryDelayMs ?? 30_000;
    const healthyConnectionMs = opts.healthyConnectionMs ?? 30_000;
    let lastEventId: string | undefined;
    let retryCount = 0;
    const resetAfterMessages = Math.max(1, opts.retryResetAfterMessages ?? 1);
    while (!controller.signal.aborted) {
      if (restartPending) {
        restartPending = false;
        retryDelay = baseRetryDelay;
        retryCount = 0;
      }
      const attemptController = new AbortController();
      activeAttempt = attemptController;
      let attemptMessages = 0;
      let attemptOpenedAt: number | undefined;
      let classification: ConnectionRetryClassification | null = null;
      try {
        const headers = { ...(opts.headers ?? {}) };
        headers.Accept = 'text/event-stream';
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;
        const response = await getJson(url, {
          ...opts,
          headers,
          signal: AbortSignal.any([
            controller.signal,
            attemptController.signal,
          ]),
          // An event stream's body is open-ended by construction: a deadline
          // here would tear down a healthy connection on its first quiet
          // minute. Cancellation is `controller`'s job, not a timer's.
          timeoutMs: null,
        });
        if (controller.signal.aborted) break;
        attemptOpenedAt = Date.now();
        // station#3458: `onOpen` promises "this stream is now consuming a
        // response", not merely "a response arrived" — a rejected response
        // (401/403, or any other non-2xx) is about to be thrown as a
        // `StationHttpError` by `consumeSseResponse` below and never reaches
        // `onMessage`, so firing `onOpen` for it first told every caller the
        // stream was open when it was about to fail. Gate on the same
        // predicate `consumeSseResponse` uses to decide whether to consume
        // the body, so the callback's name is true for every caller.
        if (response.ok) opts.onOpen?.(response);
        await consumeSseResponse(
          response,
          controller.signal,
          (message) => {
            const accepted = opts.onMessage(message) !== false;
            if (accepted) attemptMessages++;
            return accepted;
          },
          (checkpoint) => {
            if (checkpoint.id !== undefined) {
              lastEventId = checkpoint.id;
            }
            if (checkpoint.retry !== undefined) {
              // Floor of 1ms: a hostile or buggy `retry: 0` would otherwise
              // set a sustained ~1ms reconnect loop that no ceiling catches,
              // because the doubling below starts from zero.
              baseRetryDelay = Math.max(1, checkpoint.retry);
              retryDelay = baseRetryDelay;
            }
            opts.onCheckpoint?.(checkpoint);
          },
        );
        if (!controller.signal.aborted) {
          throw new Error('SSE stream ended unexpectedly');
        }
      } catch (error) {
        if (!controller.signal.aborted && restartPending) {
          restartPending = false;
          retryDelay = baseRetryDelay;
          retryCount = 0;
          continue;
        }
        if (!controller.signal.aborted) {
          classification = classifySseFailure(error);
          if (classification === 'transient') {
            // station#1848: the DELAY has to restart with the budget, not just
            // the count — without it the ladder only ever climbs for the
            // process's lifetime, so a stream healthy for hours reconnects at
            // the ceiling after one blip, which is why every browser consumer
            // had pinned `maxRetryDelayMs` to `retryDelayMs` and handed a
            // failing server a flat permanent rate.
            //
            // But "delivered frames" is not the same question as "was this
            // connection healthy", and on this runtime's endpoints it is not
            // even correlated: the orchestration stream's connect burst
            // (snapshot + caught-up marker) arrives on every accepted
            // connection in milliseconds. Requiring the connection to have
            // STAYED OPEN is the derivation that actually distinguishes a
            // working stream from a socket that was accepted and dropped —
            // see `healthyConnectionMs`.
            const uptimeMs =
              attemptOpenedAt === undefined ? 0 : Date.now() - attemptOpenedAt;
            const deliveredFrames = attemptMessages >= resetAfterMessages;
            // The give-up budget (`maxRetries`) keeps its documented
            // message-count contract — `retryResetAfterMessages` means what it
            // has always meant, and this change does not redefine it.
            if (deliveredFrames) retryCount = 0;
            // The RATE ladder additionally requires the connection to have
            // stayed open. These are separate questions: the budget asks
            // "is this stream making progress at all", the ladder asks "how
            // hard may I hit a server that keeps dropping me".
            if (deliveredFrames && uptimeMs >= healthyConnectionMs) {
              retryDelay = baseRetryDelay;
            }
            retryCount++;
            // station#1848: when the server states when to come back, come
            // back then. Station's runtime sends `Retry-After` with every 429
            // from its auth-failure limiter; retrying inside that window
            // cannot clear faster (the limiter answers before recording the
            // failure and never extends its own window) but it does spend
            // requests that are guaranteed to be refused, on a server already
            // saying it has had too many. Never shorten the ladder, only
            // extend it.
            const requested =
              error instanceof StationHttpError
                ? error.retryAfterMs
                : undefined;
            if (requested !== undefined) {
              // Disclosed: the ceiling wins, so a wait longer than
              // `maxRetryDelayMs` is truncated — including Station's own
              // limiter window, which is 60s against a 30s default ceiling.
              // Deliberate: an unbounded honor would let any server (or an
              // attacker who can shape one response) park a stream for as
              // long as it likes. The truncated wait still decays the request
              // rate by an order of magnitude, which is the property that
              // matters here.
              retryDelay = Math.min(
                Math.max(retryDelay, requested),
                maxRetryDelay,
              );
            }
          }
          opts.onError?.(error);
          if (classification === 'terminal') opts.onTerminal?.(error);
        }
      } finally {
        if (activeAttempt === attemptController) activeAttempt = null;
      }
      if (controller.signal.aborted) break;
      if (restartPending) {
        restartPending = false;
        retryDelay = baseRetryDelay;
        retryCount = 0;
        continue;
      }
      if (classification === 'terminal') {
        // station#1094: a 401/403 will reject every retry identically —
        // stop the automatic ladder dead rather than backing off forever,
        // and wait for an explicit external wake (`retry()` or a
        // `notifyCredentialChanged()` call) instead of a timer. Recoverable:
        // once woken, the loop continues below with backoff state reset, as
        // if this were the stream's first attempt.
        const gate = waitForWakeOrAbort(controller.signal);
        wake = gate.wake;
        addCredentialChangeListener(origin, gate.wake);
        try {
          await gate.promise;
        } finally {
          removeCredentialChangeListener(origin, gate.wake);
          wake = null;
        }
        if (controller.signal.aborted) break;
        retryDelay = baseRetryDelay;
        retryCount = 0;
        opts.onRetry?.();
        continue;
      }
      if (
        opts.reconnect === false ||
        (opts.maxRetries !== undefined && retryCount > opts.maxRetries)
      ) {
        break;
      }
      // station#1848: interruptible, so a real recovery signal (the tab coming
      // back, the network returning, an explicit `retry()`) does not sit out a
      // backoff the server already recovered from — and `wake` is published
      // here, not only in the terminal gate above, so `retry()` reaches a
      // transient wait too.
      const backoff = interruptibleDelay(
        retryDelay,
        controller.signal,
        baseRetryDelay,
      );
      wake = backoff.wake;
      try {
        await backoff.promise;
      } finally {
        wake = null;
      }
      if (restartPending) {
        restartPending = false;
        retryDelay = baseRetryDelay;
        retryCount = 0;
        continue;
      }
      retryDelay = Math.min(Math.max(retryDelay * 2, 1), maxRetryDelay);
    }
  })().finally(() => {
    page?.removeEventListener('pagehide', abortOnPageHide);
    opts.signal?.removeEventListener('abort', abort);
  });
  return {
    close: abort,
    signal: controller.signal,
    completed,
    retry,
    restart,
  };
}

/**
 * Parses a `{ success, data?, error?, message? }` envelope response and
 * either returns `data` or throws, mirroring the CLI's `requestJson`
 * error precedence (`error || message || 'Request failed with HTTP <status>'`)
 * — used by canonical fetchers whose only pre-#167 consumer already applied
 * this exact contract (e.g. via `packages/cli/src/commands/core-api.ts`'s
 * `requestJson`). Fetchers whose only pre-#167 consumer forwards the raw
 * envelope untouched (station-control's `api()` helper) do their own
 * lighter-weight parsing instead — see the docblock on each such fetcher.
 */
export async function readEnvelopeOrThrow<T>(
  response: Response,
): Promise<T | undefined> {
  let payload: JsonEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as JsonEnvelope<T>;
  } catch {
    if (!response.ok) {
      throw new Error(`Request failed with HTTP ${response.status}`);
    }
    throw new Error('Expected JSON response');
  }

  if (!response.ok || !payload.success) {
    throw new Error(
      envelopeFailureMessage(payload.error) ??
        envelopeFailureMessage(payload.message) ??
        `Request failed with HTTP ${response.status}`,
    );
  }

  return payload.data;
}
