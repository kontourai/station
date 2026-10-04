import { createHash, randomUUID } from 'node:crypto';
import {
  ACCOUNT_AUTHENTICATION_FAILURE_HEADER,
  APPLICATION_SESSION_BASE_PATH,
  APPLICATION_SESSION_HEADER,
  APPLICATION_SESSION_NATIVE_HEADER,
  APPLICATION_SESSION_NATIVE_PROOF_HEADER,
  APPLICATION_SESSION_PROOF_HEADER,
} from '@kontourai/station-contracts/application-session';
import { CLIENT_ORIGIN_HEADER } from '@kontourai/station-contracts/client-origin';
import { DEPLOYMENT_AUTHENTICATION_BASE_PATH } from '@kontourai/station-contracts/deployment-authentication';
import {
  CLIENT_PROTOCOL_HEADER,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import {
  AUTH_RATE_LIMITED_ERROR_CODE,
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
  STATION_PLUGIN_HEADER,
} from '@kontourai/station-contracts/http';
import { NATIVE_DEVICE_PROOF_HEADER } from '@kontourai/station-contracts/native-device-proof';
import { NATIVE_RELAY_ENROLLMENT_PATHS } from '@kontourai/station-contracts/native-relay-enrollment';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { KNOWLEDGE_ROOT_IDENTITY_HEADER } from '@kontourai/station-shared/knowledge-root-identity';
import {
  redactDeep,
  sanitizeError,
  sanitizeFreeText,
} from '@kontourai/station-shared/redaction';
import { type HonoServerConfig } from '@voltagent/server-hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import {
  INTERACTIVE_WORKSPACE_TIMING_MODE,
  INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER,
} from '../../../src-shared/interactive-workspace-performance-timing.js';
import {
  clientProtocolApplies,
  evaluateClientProtocol,
} from '../../security/client-protocol-admission.js';
import {
  NativeDeviceRequestRefusedError,
  nativeDeviceOnlyObservationRoute,
  nativeDeviceProofPilotRoute,
} from '../../security/native-device-request-authority.js';
import {
  type ExternalSurfaceCapabilityRule,
  type PairingScopeContextStore,
  pairingScopeSatisfiesHttpRoute,
  requiredExternalSurfaceCapability,
  setGrantedPairingScope,
} from '../../security/pairing-route-scopes.js';
import {
  attestedProxyPeerAddress,
  bindRuntimeLocalOperator,
  classifyAttestedProxyCaller,
  classifyMutationRoute,
  classifyRuntimeCallerPeerClass,
  classifyRuntimePeer,
  classifyRuntimeRoute,
  deriveBudgetPrincipal,
  deriveNativeDeviceBudgetPrincipal,
  getBudgetPrincipal,
  getDirectSocketAddress,
  getRuntimeAuthenticatedRequestPrincipal,
  parseStrictBearer,
  RUNTIME_CREDENTIAL_AUTHORITY_VAR,
  RuntimeAuthFailureLimiter,
  type RuntimeHttpSecurityOptions,
  RuntimeMutationBudget,
  type RuntimePeerClass,
  type RuntimeSecurityAuditRecord,
  setBudgetPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../security/runtime-request-security.js';
import {
  readVerifiedNativeVirtualApplicationRequest,
  transferVerifiedNativeVirtualApplicationRequest,
} from '../../services/connections/virtual-application.js';
import { guardAccountResponse } from '../../services/identity/account-response-guard.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { RELAYED_RESPONSE_HEADER } from '../../services/remote-stations/remote-station-forwarder.js';
import { HOST_STATION_COMPATIBILITY } from '../../services/ssh/environment-security-service.js';
import {
  deviceSessionAuthorizations,
  requestBudgetOutcomes,
} from '../../telemetry/metrics.js';
import { isAuthError } from '../../utils/auth-errors.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { outwardTransportError } from '../../utils/outward-error.js';
import { isRouteError, type RouteError } from '../../utils/route-error.js';
import {
  buildRuntimeRouteVocabulary,
  labelRuntimeRoutePath,
} from './runtime-route-label.js';
import { getTenantRequestContext } from './runtime-tenant-context.js';

type RuntimeApp = Parameters<NonNullable<HonoServerConfig['configureApp']>>[0];

export const SECURE_DEVICE_SESSION_COOKIE = '__Host-station-device';
export const LOOPBACK_DEVICE_SESSION_COOKIE = 'station-device';
const DEVICE_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALIAS_SESSION_CONTROL_PATHS = new Set([
  `${APPLICATION_SESSION_BASE_PATH}/challenge`,
  `${APPLICATION_SESSION_BASE_PATH}/exchange`,
  `${APPLICATION_SESSION_BASE_PATH}/login`,
]);
const RUNTIME_ROUTE_CAPABILITY_VAR = 'stationRuntimeRouteCapability';

type RuntimeRouteLabeler = (path: string) => string;

const SAFE_AUTH_CLIENT_MESSAGES = new Map<string, string>([
  ['authentication failed', 'Authentication failed'],
  ['unauthorized', 'Unauthorized'],
]);

function allowlistedAuthClientMessage(error: unknown): string | undefined {
  if (!isAuthError(error) || !(error instanceof Error)) return undefined;
  return SAFE_AUTH_CLIENT_MESSAGES.get(error.message);
}

type RuntimeErrorResponseContext = {
  json: (body: unknown, status: 500) => Response;
};

type RouteErrorResponseContext = {
  json: (body: unknown, status: RouteError['status']) => Response;
};

function unexpectedRuntimeErrorResponse(
  c: RuntimeErrorResponseContext,
  logger: Logger,
  error: unknown,
): Response {
  const correlationId = randomUUID();
  if (!(error instanceof Error)) {
    // Never coerce a foreign thrown value: its getters or primitive conversion
    // can themselves disclose provider output or throw again.
    logger.error('Unhandled runtime HTTP non-Error throw', { correlationId });
  } else {
    try {
      logger.error('Unhandled runtime HTTP error', {
        correlationId,
        error: sanitizeError(error),
      });
    } catch {
      logger.fatal('Runtime error sanitizer rejected an error shape', {
        correlationId,
      });
    }
  }
  return c.json(
    {
      success: false,
      error: { code: 'internal_error', correlationId },
    },
    500,
  );
}

/**
 * Answers a route's own typed refusal.
 *
 * `RouteError` is the reviewed exception to the generic envelope
 * {@link unexpectedRuntimeErrorResponse} answers with: the
 * route has said this text is safe to show the caller and named the status it
 * deserves. The message is still run through `sanitizeFreeText` here, because
 * a reviewed literal is routinely built by interpolating a filename, a slug,
 * or a service's own text — the sanitizer covers the interpolated half.
 *
 * `error` stays a **string** and `code`/`details`/`correlationId` stay
 * top-level: that is exactly where every existing client reader already
 * looks, so a route moving onto this contract changes no reader.
 *
 * A 4xx is the caller's fault and logs at `warn` with no payload beyond what
 * the caller was already told. A 5xx is ours: it logs at `error` with the
 * sanitized `cause`, so the operator keeps the underlying failure the caller
 * never sees.
 */
function routeErrorResponse(
  c: RouteErrorResponseContext,
  logger: Logger,
  error: RouteError,
): Response {
  const correlationId = randomUUID();
  const clientMessage = sanitizeFreeText(error.clientMessage);
  const context = {
    correlationId,
    status: error.status,
    ...(error.code === undefined ? {} : { code: error.code }),
    clientMessage,
  };
  if (error.status >= 500) {
    const cause = error.cause;
    try {
      logger.error('Route error', {
        ...context,
        error: sanitizeError(cause instanceof Error ? cause : error),
      });
    } catch {
      // Mirrors the guard in {@link unexpectedRuntimeErrorResponse} above:
      // a cause whose shape the sanitizer rejects must not turn a chosen
      // status into an unhandled throw out of `onError`, which is where the
      // response would be lost.
      logger.fatal('Route error sanitizer rejected an error shape', context);
    }
  } else {
    logger.warn('Route error', context);
  }
  return c.json(
    {
      success: false,
      error: clientMessage,
      ...(error.code === undefined ? {} : { code: error.code }),
      // `details` is structure, not a sentence, so `sanitizeFreeText` cannot
      // walk it. `redactDeep` applies the same redaction to every string it
      // contains, at any depth. A route is supposed to put its own literals
      // and ids here and never error-derived data -- this is the line for
      // when it does anyway, and `scripts/route-error-egress-gate.mjs` now
      // reviews these constructor arguments so the rule has a gate too.
      ...(error.details === undefined
        ? {}
        : { details: redactDeep(error.details) }),
      correlationId,
    },
    error.status,
  );
}

interface RuntimeHttpContext {
  app: RuntimeApp;
  logger: Logger;
  eventBus: EventBus;
  security?: RuntimeHttpSecurityOptions;
}

const envelopeMarkedApps = new WeakSet<object>();

/**
 * #2842: the one place a response is marked as this Station's own answer.
 *
 * Every JSON response the app answers gets `STATION_ENVELOPE_HEADER`,
 * whichever handler, middleware or error boundary wrote it, so a client can
 * tell Station's refusal from an intermediary's JSON of the same shape. A
 * response relayed from another Station (`RELAYED_RESPONSE_HEADER`, set by
 * `fetchRemoteStation`) is the exception: it leaves without this Station's
 * marker and without the peer's.
 *
 * It must wrap every writer, so it is installed before any other middleware.
 * `configureRuntimeHttp` installs it; runtime composition calls it earlier
 * still, ahead of the hosted tenant gate, and the second call is a no-op.
 */
export function installStationEnvelopeMarker(app: RuntimeApp): void {
  if (envelopeMarkedApps.has(app)) return;
  envelopeMarkedApps.add(app);
  app.use('*', async (c, next) => {
    await next();
    if (c.res.headers.has(RELAYED_RESPONSE_HEADER)) {
      c.header(RELAYED_RESPONSE_HEADER, undefined);
      c.header(STATION_ENVELOPE_HEADER, undefined);
      return;
    }
    const contentType = c.res.headers.get('content-type') ?? '';
    if (/^application\/json\s*(;|$)/i.test(contentType)) {
      c.header(STATION_ENVELOPE_HEADER, STATION_ENVELOPE_HEADER_VALUE);
    }
  });
}

export function configureRuntimeHttp({
  app,
  logger,
  eventBus,
  security,
}: RuntimeHttpContext): void {
  installStationEnvelopeMarker(app);
  app.use('*', async (c, next) => {
    await next();
    const authentication = security?.deploymentAuthentication;
    const initial = authentication?.admittedPrincipalSnapshot(c.req.raw);
    if (authentication && initial && c.res.status < 400) {
      c.res = await guardAccountResponse(c.res, async () => {
        const latest = await authentication.authenticate(c.req.raw);
        if (latest.kind === 'unavailable') return 'unavailable';
        return latest.kind === 'authenticated' &&
          latest.principal.id === initial.id
          ? 'current'
          : 'invalid';
      });
    }
  });
  app.onError((err, c) => {
    // Before the auth allow-list, deliberately. The allow-list matches on
    // message text (`isAuthError` substring-matches "unauthorized", "401",
    // "authentication failed"), so a route that threw a typed 403 whose
    // reviewed message happens to contain one of those words would otherwise
    // be rewritten into a 401 that discards its code, details, and status.
    // A route that named its own answer outranks a text match on ours.
    if (isRouteError(err)) {
      return routeErrorResponse(c, logger, err);
    }
    const authMessage = allowlistedAuthClientMessage(err);
    if (authMessage) {
      return c.json({ success: false, error: authMessage }, 401);
    }
    return unexpectedRuntimeErrorResponse(c, logger, err);
  });

  // Register before every other runtime middleware and all later route mounts.
  // Hono's `onError` only accepts `Error`, but JavaScript permits throwing any
  // value. This is the outermost containment boundary for those foreign throws.
  app.use('*', async (c, next) => {
    try {
      await next();
    } catch (error) {
      return unexpectedRuntimeErrorResponse(c, logger, error);
    }
  });

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    // archive#1848: a streaming handler returns its Response as soon as the
    // headers and the body stream exist — the body then writes for however
    // long the connection lives. `Date.now() - start` is therefore
    // time-to-headers here, not request duration, and printing it in the same
    // position as a completed request's duration reads as "this endpoint
    // answered and closed in 1ms". A connection held open for 15 minutes logs
    // the same single-digit number, which is how the SSE stream came to be
    // reported as not streaming at all. Say which quantity this is instead;
    // the connection's real lifetime is
    // `station.orchestration.stream_duration`, recorded at disconnect.
    const elapsedMs = Date.now() - start;
    const streaming = (c.res.headers.get('content-type') ?? '').startsWith(
      'text/event-stream',
    );
    const method = c.req.method;
    const status = c.res.status;
    // A successful read is the one request shape that carries no information
    // once it is over: nothing changed, nothing failed, and the connection is
    // closed. An idle desktop still produced ~70k of these a day, each one a
    // synchronous `writeSync` into the NDJSON store, and they buried the
    // lines an operator opens the log FOR.
    //
    // Be exact about what demoting them to `debug` does. The logger seam
    // gates on `isLevelEnabled` BEFORE it writes the durable store line
    // (`utils/logger.ts`), and the resolved level defaults to `info`, so at
    // the default these lines are not written anywhere — they are dropped,
    // not filed one level down. The Developer Logs level filter is a
    // READ-side floor over what the store already holds and cannot bring
    // back a line that was never written. Retaining them is a WRITE-side
    // setting chosen before the fact: `STATION_LOG_LEVEL=debug`, or
    // `logLevel` in `app.json`. That is the trade — a successful read stops
    // being free-standing history and becomes something an operator opts
    // into while reproducing.
    //
    // Everything else stays at `info`: any non-2xx/304, every mutation
    // whether or not it succeeded, and every streaming response — an SSE
    // connection opening is the start of something long-lived, not a
    // completed read.
    const routineRead =
      !streaming &&
      (method === 'GET' || method === 'HEAD') &&
      (status === 304 || (status >= 200 && status < 300));
    // One line, one shape, whichever level carries it: a reader filtering by
    // level must never also have to parse two formats.
    const line = `${method} ${c.req.path} ${status} ${
      streaming ? `stream-open-after=${elapsedMs}ms` : `${elapsedMs}ms`
    } origin=${c.req.header('origin') ? 'present' : 'none'}`;
    if (routineRead) {
      logger.debug(line);
    } else {
      logger.info(line);
    }
  });

  if (security) {
    // Routes mount progressively after this boundary. Capture app.routes only
    // when the first audit record needs a label, after startup registration.
    let routeVocabulary: ReadonlySet<string> | undefined;
    const routeLabeler: RuntimeRouteLabeler = (path) => {
      routeVocabulary ??= buildRuntimeRouteVocabulary(app.routes);
      return labelRuntimeRoutePath(path, routeVocabulary);
    };
    configureRuntimeRouteClassificationGate(app, security, routeLabeler);
    configureRuntimeSecurity(app, security, routeLabeler);
  } else {
    app.use(
      '*',
      cors({
        origin: resolveRuntimeCorsOrigin,
        credentials: true,
        // #2842: a cross-origin client must be able to read the marker.
        exposeHeaders: [STATION_ENVELOPE_HEADER],
      }),
    );
  }

  // Framework handlers catch provider exceptions themselves, bypassing onError.
  app.use('/agents/:slug/chat', async (c, next) => {
    await next();
    if (c.req.method !== 'POST' || c.res.status < 500) return;
    const correlationId = randomUUID();
    logger.error('Framework chat request failed', {
      correlationId,
      status: c.res.status,
    });
    const message = outwardTransportError('sse');
    c.res = new Response(
      JSON.stringify({ error: message, message, correlationId }),
      {
        status: c.res.status,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

  app.use('*', async (c, next) => {
    await next();

    const keys = getInvalidationKeysForRequest(c.req.method, c.req.path);
    if (keys.length > 0) {
      eventBus.emit(SERVER_EVENTS.DATA_CHANGED, { keys });
    }
  });
}

/**
 * Registers the table-backed gate ahead of every public or bespoke handler.
 * It checks the actual request method, or a CORS preflight's requested
 * method, so implicit HEAD and OPTIONS dispatch cannot bypass the central
 * external-surface declaration.
 */
export function configureRuntimeRouteClassificationGate(
  app: RuntimeApp,
  security: Pick<
    RuntimeHttpSecurityOptions,
    'allowedOrigins' | 'audit' | 'now'
  >,
  routeLabeler: RuntimeRouteLabeler,
): void {
  const allowedOrigins = new Set(security.allowedOrigins ?? []);
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins.has(origin)) {
      return c.json({ error: { code: 'origin_forbidden' } }, 403);
    }

    const requestedMethod =
      c.req.method === 'OPTIONS'
        ? c.req.header('access-control-request-method')?.toUpperCase()
        : c.req.method;
    const capability = requestedMethod
      ? requiredExternalSurfaceCapability('http', requestedMethod, c.req.path)
      : undefined;
    if (capability?.capability !== 'middleware') {
      if (capability) {
        (c as unknown as PairingScopeContextStore).set(
          RUNTIME_ROUTE_CAPABILITY_VAR,
          capability,
        );
        return next();
      }
    }

    emitSecurityAudit(security, c, routeLabeler, {
      event: 'station.auth.failure',
      outcome: 'denied',
      reason: 'route_scope_unmapped',
      routeClass: classifyRuntimeRoute(
        requestedMethod ?? c.req.method,
        c.req.path,
      ),
      peerClass: classifyRuntimeCallerPeerClass({
        environment: c.env,
        header: (name) => c.req.header(name),
      }),
      transport: 'http',
      timestamp: security.now?.() ?? Date.now(),
    });
    return c.json({ error: { code: 'insufficient_scope' } }, 403);
  });
}

function runtimeRouteCapability(
  context: PairingScopeContextStore,
): ExternalSurfaceCapabilityRule | undefined {
  const value = context.get(RUNTIME_ROUTE_CAPABILITY_VAR);
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ExternalSurfaceCapabilityRule>;
  return typeof candidate.capability === 'string'
    ? (value as ExternalSurfaceCapabilityRule)
    : undefined;
}

function isInteractiveWorkspacePerformanceDiagnostic(c: {
  req: {
    method: string;
    path: string;
    header(name: string): string | undefined;
  };
}): boolean {
  return (
    process.env.STATION_PERFORMANCE_REFERENCE === '1' &&
    c.req.method === 'POST' &&
    /^\/api\/tasks\/[^/]+\/room\/(?:live|edit-plan|batches)$/.test(
      c.req.path,
    ) &&
    c.req.header(INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER) ===
      INTERACTIVE_WORKSPACE_TIMING_MODE
  );
}

/** #2893 pilot body bound; identical to the verifier's channel bound. */
const NATIVE_DEVICE_PROOF_BODY_LIMIT_BYTES = 16 * 1024;

interface NativeDeviceProofAdmissionCall {
  c: Context;
  security: RuntimeHttpSecurityOptions;
  limiter: RuntimeAuthFailureLimiter;
  requiredCapability: ExternalSurfaceCapabilityRule;
  routeClass: 'public' | 'protected';
  effectivePeerClass: RuntimePeerClass;
  routeLabeler: RuntimeRouteLabeler;
  next: () => Promise<void>;
}

/**
 * The one native-proof admission path. Ordering (source-reviewed): cheap
 * private peer/route/rate checks, then a bounded exact-body read and final
 * Request built from those bytes with ONLY the private peer provenance
 * copied at this byte-copy owner, then Device JWS/JTI admission and minted
 * principal on that final Request, then Device scope, then native account
 * continuation (challenge/exchange) or account authentication. Any refusal
 * is canonical and terminal: no credential fallback.
 */
async function admitNativeDeviceProofRequest(
  call: NativeDeviceProofAdmissionCall,
): Promise<Response> {
  const { c, security, limiter, requiredCapability } = call;
  const refused = (
    status: 401 | 403 | 413 | 429 | 503,
    code: string,
    reason: string,
  ): Response => {
    emitSecurityAudit(security, c, call.routeLabeler, {
      event: 'station.auth.failure',
      outcome: 'denied',
      reason,
      routeClass: call.routeClass,
      peerClass: call.effectivePeerClass,
      transport: 'http',
      timestamp: security.now?.() ?? Date.now(),
    });
    return c.json({ error: { code } }, status);
  };
  if (!security.nativeDeviceProof)
    return refused(403, 'native_device_proof_unsupported', 'proof_unsupported');
  // Private provenance must already be carried by the native Pion peer; a
  // header alone is never authority.
  const nativeFacts = readVerifiedNativeVirtualApplicationRequest(c.req.raw);
  if (!nativeFacts)
    return refused(
      403,
      'virtual_pion_provenance_invalid',
      'provenance_invalid',
    );
  // A Device bearer or session cookie conflicts with proof authority and is
  // refused with no credential fallback.
  if (
    c.req.raw.headers.has('authorization') ||
    parseDeviceSessionCookie(c.req.raw.headers.get('cookie') ?? undefined) !==
      undefined
  )
    return refused(
      403,
      'native_device_proof_credential_conflict',
      'credential_conflict',
    );
  const url = new URL(c.req.raw.url);
  const proofPath = url.pathname + url.search;
  const method = c.req.method.toUpperCase();
  if (!nativeDeviceProofPilotRoute(method, url.pathname))
    return refused(
      403,
      'native_device_proof_route_forbidden',
      'route_not_pilot',
    );
  // Only admitted installation provenance contributes before signature verification.
  // A proof's unverified Device selector never chooses a budget bucket.
  const installationKey = `native-install:${createHash('sha256')
    .update(
      JSON.stringify([
        nativeFacts.stationId,
        nativeFacts.surface.kind,
        nativeFacts.surface.appIdentifier,
        nativeFacts.surface.channel,
        nativeFacts.surface.clientInstanceId,
      ]),
    )
    .digest('hex')}`;
  const cheapRetryAfter = limiter.retryAfterSeconds(installationKey);
  if (cheapRetryAfter !== undefined) {
    c.header('Retry-After', String(cheapRetryAfter));
    return refused(429, AUTH_RATE_LIMITED_ERROR_CODE, 'too_many_failures');
  }
  // Reserve before any await so parallel failures cannot all pass the same window.
  limiter.recordFailure(installationKey);
  // Read the exact bounded body and build the final raw Request from those
  // bytes; peer provenance is copied here and nowhere else.
  const bodyResult = await readBoundedBody(
    c.req.raw,
    NATIVE_DEVICE_PROOF_BODY_LIMIT_BYTES,
  );
  if (bodyResult === 'too-large')
    return refused(413, 'request_too_large', 'proof_body_oversized');
  let finalRequest = c.req.raw;
  const body = bodyResult === 'no-stream' ? new Uint8Array(0) : bodyResult;
  if (bodyResult !== 'no-stream') {
    const previous = c.req.raw;
    const replacement = new Request(previous.url, {
      method: previous.method,
      headers: previous.headers,
      signal: previous.signal,
      body: bodyResult,
      duplex: 'half',
    });
    if (!transferVerifiedNativeVirtualApplicationRequest(previous, replacement))
      return refused(
        403,
        'virtual_pion_provenance_invalid',
        'provenance_invalid',
      );
    security.deploymentAuthentication?.transferRequest(previous, replacement);
    c.req.raw = replacement;
    finalRequest = replacement;
  }
  // Device JWS/JTI admission on the final Request; the credential-free
  // principal is minted on exactly that Request by the authority owner.
  let admission: { deviceId: string; bindingId: string; scope: string };
  try {
    admission = await security.nativeDeviceProof.admit(finalRequest, {
      proof: c.req.raw.headers.get(NATIVE_DEVICE_PROOF_HEADER)!,
      method,
      path: proofPath,
      body,
    });
  } catch (error) {
    if (!(error instanceof NativeDeviceRequestRefusedError))
      return refused(503, 'authentication_unavailable', 'proof_unavailable');
    return refused(
      403,
      error.code === 'proof_replayed' || error.code === 'proof_invalid'
        ? 'native_device_proof_invalid'
        : error.code === 'provenance_invalid'
          ? 'virtual_pion_provenance_invalid'
          : error.code === 'account_binding_required'
            ? 'native_device_proof_account_required'
            : 'native_device_proof_device_not_current',
      error.code,
    );
  }
  limiter.clear(installationKey);
  const verifiedDeviceBudget = deriveNativeDeviceBudgetPrincipal(
    nativeFacts.stationId,
    admission.deviceId,
  );
  const deviceAttemptKey = verifiedDeviceBudget.key;
  const verifiedRetryAfter = limiter.retryAfterSeconds(deviceAttemptKey);
  if (verifiedRetryAfter !== undefined) {
    c.header('Retry-After', String(verifiedRetryAfter));
    return refused(429, AUTH_RATE_LIMITED_ERROR_CODE, 'too_many_failures');
  }
  limiter.recordFailure(deviceAttemptKey);
  // Current Device scope against the central route declaration. A
  // pairing-scope route requires the proven Device's grant to include the
  // route scope; every other declared capability passes through.
  const grantedScope = admission.scope;
  const permitted =
    requiredCapability.capability !== 'pairing-scope' ||
    (requiredCapability.scope !== undefined &&
      pairingScopeIncludes(grantedScope, requiredCapability.scope));
  if (!permitted) {
    return refused(403, 'insufficient_scope', 'insufficient_scope');
  }
  setGrantedPairingScope(c, grantedScope);
  setBudgetPrincipal(c, verifiedDeviceBudget);
  const accountOperation =
    url.pathname === DEPLOYMENT_AUTHENTICATION_BASE_PATH ||
    url.pathname.startsWith(`${DEPLOYMENT_AUTHENTICATION_BASE_PATH}/`);
  const deviceOnly =
    nativeDeviceOnlyObservationRoute(method, url.pathname) &&
    !finalRequest.headers.has(APPLICATION_SESSION_NATIVE_HEADER) &&
    !finalRequest.headers.has(APPLICATION_SESSION_NATIVE_PROOF_HEADER);
  if (security.deploymentAuthentication && !accountOperation && !deviceOnly) {
    // The pilot requires a current, matching account session; a native
    // attempt never falls back to a bearer or cookie credential.
    const account =
      await security.deploymentAuthentication.authenticate(finalRequest);
    if (account.kind === 'unavailable')
      return refused(503, 'authentication_unavailable', 'account_unavailable');
    if (account.kind !== 'authenticated') {
      c.header(ACCOUNT_AUTHENTICATION_FAILURE_HEADER, 'account');
      return refused(
        401,
        'account_authentication_required',
        'account_authentication_required',
      );
    }
  }

  try {
    await call.next();
  } finally {
    // Bound repeated failed attempts by the VERIFIED Device identity, not
    // the absent-Authorization socket bucket.
    if (c.res && c.res.status < 400) limiter.clear(deviceAttemptKey);
  }
  return c.res;
}

function configureRuntimeSecurity(
  app: RuntimeApp,
  security: RuntimeHttpSecurityOptions,
  routeLabeler: RuntimeRouteLabeler,
): void {
  const allowedOrigins = new Set(security.allowedOrigins ?? []);
  const limiter = new RuntimeAuthFailureLimiter(security);
  const protocolAuditLimiter = new RuntimeAuthFailureLimiter(security);
  const budget = new RuntimeMutationBudget(security);
  const clientProtocolPolicy =
    security.clientCompatibility ?? HOST_STATION_COMPATIBILITY;

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins.has(origin)) {
      return c.json({ error: { code: 'origin_forbidden' } }, 403);
    }

    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header(
        'Access-Control-Expose-Headers',
        `${ACCOUNT_AUTHENTICATION_FAILURE_HEADER}, Retry-After, ${STATION_ENVELOPE_HEADER}`,
      );
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Credentials', 'true');
    }
    if (c.req.method === 'OPTIONS') {
      if (!origin) {
        return c.json({ error: { code: 'origin_forbidden' } }, 403);
      }
      c.header(
        'Access-Control-Allow-Headers',
        // Last-Event-ID: set by the SDK's fetchSSE reconnect loop and consumed
        // by the orchestration resume cursor — omitting it preflight-blocks
        // every cross-origin SSE reconnect (#169).
        `Authorization, Content-Type, Last-Event-ID, X-Station-Client-Session, ${CLIENT_ORIGIN_HEADER}, ${CLIENT_PROTOCOL_HEADER}, ${STATION_PLUGIN_HEADER}, ${KNOWLEDGE_ROOT_IDENTITY_HEADER}, ${APPLICATION_SESSION_HEADER}, ${APPLICATION_SESSION_PROOF_HEADER}${
          process.env.STATION_PERFORMANCE_REFERENCE === '1'
            ? `, ${INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER}`
            : ''
        }`,
      );
      c.header(
        'Access-Control-Allow-Methods',
        'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      );
      return c.body(null, 204);
    }

    const routeClass = classifyRuntimeRoute(c.req.method, c.req.path);
    // Resolve the central declaration before every local-position shortcut.
    // A route absent from the table is never eligible for loopback or
    // attested-proxy compatibility handling.
    const requiredCapability = runtimeRouteCapability(c);
    const socketAddress = getDirectSocketAddress(c.env);
    const peer = classifyRuntimePeer(socketAddress);
    const proxyCaller = classifyAttestedProxyCaller(c.env, {
      caller: c.req.header(INTERNAL_PROXY_CALLER_HEADER),
      token: c.req.header(INTERNAL_API_TOKEN_HEADER),
    });
    const effectivePeerClass = classifyRuntimeCallerPeerClass({
      environment: c.env,
      header: (name) => c.req.header(name),
    });
    const limiterKey = peer.address ?? '<absent>';
    if (!requiredCapability) {
      emitSecurityAudit(security, c, routeLabeler, {
        event: 'station.auth.failure',
        outcome: 'denied',
        reason: 'route_scope_unmapped',
        routeClass,
        peerClass: effectivePeerClass,
        transport: 'http',
        timestamp: security.now?.() ?? Date.now(),
      });
      return c.json({ error: { code: 'insufficient_scope' } }, 403);
    }
    // ── #2962 client API protocol admission ──
    // Before any credential check, so an outdated client is told to update
    // rather than handed an authentication failure it cannot fix. CORS
    // headers are already set above, so a browser can read the refusal.
    if (clientProtocolApplies(requiredCapability, proxyCaller === 'loopback')) {
      const refusal = evaluateClientProtocol(
        c.req.header(CLIENT_PROTOCOL_HEADER),
        clientProtocolPolicy,
      );
      if (refusal) {
        // Bound audit emission without consuming the authentication budget.
        // Keep answering protocol refusals after the audit budget is exhausted.
        if (protocolAuditLimiter.retryAfterSeconds(limiterKey) === undefined) {
          protocolAuditLimiter.recordFailure(limiterKey);
          emitSecurityAudit(security, c, routeLabeler, {
            event: 'station.auth.failure',
            outcome: 'denied',
            reason: refusal.body.error.code,
            routeClass,
            peerClass: effectivePeerClass,
            transport: 'http',
            timestamp: security.now?.() ?? Date.now(),
            ...(refusal.body.error.clientProtocol === undefined
              ? {}
              : { clientProtocol: refusal.body.error.clientProtocol }),
          });
        }
        return c.json(refusal.body, refusal.status);
      }
    }
    const accountOperation =
      c.req.path === DEPLOYMENT_AUTHENTICATION_BASE_PATH ||
      c.req.path.startsWith(`${DEPLOYMENT_AUTHENTICATION_BASE_PATH}/`);
    if (
      (NATIVE_RELAY_ENROLLMENT_PATHS as readonly string[]).includes(c.req.path)
    ) {
      if (!security.nativeEnrollment)
        return c.json(
          { error: { code: 'native_enrollment_unsupported' } },
          403,
        );
      try {
        const capability = security.nativeEnrollment.capability(c.req.raw);
        capability.assertCurrent();
        const installationKey = capability.installationBudgetKey();
        const retryAfter = limiter.retryAfterSeconds(installationKey);
        if (retryAfter !== undefined) {
          c.header('Retry-After', String(retryAfter));
          return c.json({ error: { code: AUTH_RATE_LIMITED_ERROR_CODE } }, 429);
        }
        limiter.recordFailure(installationKey);
        await next();
        capability.assertCurrent();
        if (c.res.status < 400) limiter.clear(installationKey);
        return c.res;
      } catch {
        return c.json({ error: { code: 'native_enrollment_invalid' } }, 403);
      }
    }
    if (
      !security.deploymentAuthentication &&
      !accountOperation &&
      (c.req.raw.headers.has(APPLICATION_SESSION_HEADER) ||
        c.req.raw.headers.has(APPLICATION_SESSION_PROOF_HEADER) ||
        c.req.raw.headers.has(APPLICATION_SESSION_NATIVE_HEADER) ||
        c.req.raw.headers.has(APPLICATION_SESSION_NATIVE_PROOF_HEADER))
    ) {
      c.header(ACCOUNT_AUTHENTICATION_FAILURE_HEADER, 'account');
      return c.json(
        { error: { code: 'application_sessions_unsupported' } },
        401,
      );
    }
    // ── #2893 native Device request-proof admission ──
    // Admitted BEFORE deployment-account authentication. A presented proof
    // header never falls through to bearer/cookie: proven native authority
    // or a canonical refusal, nothing else.
    if (c.req.raw.headers.has(NATIVE_DEVICE_PROOF_HEADER)) {
      return await admitNativeDeviceProofRequest({
        c,
        security,
        limiter,
        requiredCapability,
        routeClass,
        effectivePeerClass,
        routeLabeler,
        next,
      });
    }
    if (security.deploymentAuthentication && !accountOperation) {
      const hasAccount = security.deploymentAuthentication.hasCredential(
        c.req.raw,
      );
      if (hasAccount) {
        const retryAfter = limiter.retryAfterSeconds(limiterKey);
        if (retryAfter !== undefined) {
          c.header('Retry-After', String(retryAfter));
          return c.json({ error: { code: AUTH_RATE_LIMITED_ERROR_CODE } }, 429);
        }
        // Reserve before asynchronous verification; parallel attempts cannot
        // all enter the adapter before the first failure has been counted.
        limiter.recordFailure(limiterKey);
      }
      const account = await security.deploymentAuthentication.authenticate(
        c.req.raw,
      );
      if (account.kind === 'authenticated') limiter.clear(limiterKey);
      if (account.kind === 'invalid') {
        c.header(ACCOUNT_AUTHENTICATION_FAILURE_HEADER, 'account');
        return c.json(
          {
            error: {
              code: 'account_authentication_invalid',
              reason: account.reason,
            },
          },
          401,
        );
      }
      if (account.kind === 'unavailable')
        return c.json({ error: { code: 'authentication_unavailable' } }, 503);
    }
    if (
      requiredCapability.capability === 'public' ||
      requiredCapability.capability === 'mcp-token' ||
      requiredCapability.capability === 'webhook-token' ||
      requiredCapability.capability === 'stage-grant'
    ) {
      return next();
    }
    const hasQueryCredential = hasCredentialQuery(c.req.url);
    if (hasQueryCredential) {
      const retryAfter = limiter.retryAfterSeconds(limiterKey);
      if (retryAfter !== undefined) {
        emitSecurityAudit(security, c, routeLabeler, {
          event: 'station.auth.rate_limited',
          outcome: 'denied',
          reason: 'too_many_failures',
          routeClass,
          peerClass: effectivePeerClass,
          transport: 'http',
          timestamp: security.now?.() ?? Date.now(),
        });
        c.header('Retry-After', String(retryAfter));
        return c.json({ error: { code: AUTH_RATE_LIMITED_ERROR_CODE } }, 429);
      }
      limiter.recordFailure(limiterKey);
      emitSecurityAudit(security, c, routeLabeler, {
        event: 'station.auth.failure',
        outcome: 'denied',
        reason: 'query_credential_rejected',
        routeClass,
        peerClass: effectivePeerClass,
        transport: 'http',
        timestamp: security.now?.() ?? Date.now(),
      });
      return c.json({ error: { code: 'authentication_required' } }, 401);
    }
    const authorization = c.req.header('authorization');
    const bearerCredential = parseStrictBearer(authorization);
    const cookieCredential =
      authorization === undefined
        ? parseDeviceSessionCookie(c.req.header('cookie'))
        : undefined;
    const credential = bearerCredential ?? cookieCredential;

    // archive#2051: TCP loopback is a transport position, not authority. In
    // particular, an SSH local forward is indistinguishable from an operator
    // browser at this layer. The sole no-bearer/device-session exception is
    // the exact Station-owned internal/MCP attestation: it requires the per-boot internal
    // token, `local` caller marker, and a direct loopback socket (all checked
    // by `classifyAttestedProxyCaller`). Every other caller must present a
    // valid bearer or device-session credential below; absent and malformed
    // Authorization headers both fail with `authentication_required`.
    if (proxyCaller === 'loopback' && credential === undefined) {
      // The attested internal token is a process-local credential rather than
      // a compatibility floor. Keep its existing bounded mutation budget
      // identity without treating arbitrary loopback callers as principals.
      // The token itself was minted at boot for this process; record that
      // mint-time home-possession on the request principal so the one
      // local-operator predicate can read it (never the proxy stamp).
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'internal',
        credential: 'internal-token',
        authority: undefined,
        source: 'bearer',
        locality: 'home-possession',
      });
      bindRuntimeLocalOperator(c.req.raw);
      setBudgetPrincipal(
        c as unknown as PairingScopeContextStore,
        deriveBudgetPrincipal('loopback'),
      );
      return next();
    }

    if (
      cookieCredential &&
      !SAFE_HTTP_METHODS.has(c.req.method.toUpperCase()) &&
      !origin
    ) {
      deviceSessionAuthorizations.add(1, {
        outcome: 'denied',
        reason: 'origin_required',
      });
      return c.json({ error: { code: 'origin_required' } }, 403);
    }
    const valid =
      credential !== undefined &&
      (await security.verifyCredential(credential, {
        method: c.req.method,
        path: c.req.path,
        tenant: getTenantRequestContext(c.req.raw),
        activity: (() => {
          const runtimeRequest = {
            environment: c.env,
            header: (name: string) => c.req.header(name),
          };
          return {
            lastSeenFrom: security.classifyPairedDeviceActivity?.({
              ...runtimeRequest,
              directSocketAddress: getDirectSocketAddress(c.env),
              attestedProxyPeerAddress:
                attestedProxyPeerAddress(runtimeRequest),
            }),
          };
        })(),
      }));
    if (valid) {
      const aliasId = security.resolveCredentialAliasId?.(credential!);
      const proofBoundContinuation =
        c.req.raw.headers.has(APPLICATION_SESSION_HEADER) &&
        c.req.raw.headers.has(APPLICATION_SESSION_PROOF_HEADER);
      const aliasAccountControl =
        accountOperation &&
        c.req.method === 'POST' &&
        ALIAS_SESSION_CONTROL_PATHS.has(c.req.path);
      if (
        aliasId !== undefined &&
        !aliasAccountControl &&
        (!proofBoundContinuation ||
          (!accountOperation &&
            security.deploymentAuthentication?.current(c.req.raw)?.kind !==
              'authenticated'))
      ) {
        c.header(ACCOUNT_AUTHENTICATION_FAILURE_HEADER, 'account');
        return c.json(
          { error: { code: 'account_authentication_required' } },
          401,
        );
      }
      const authority = security.resolveCredentialAuthority?.(credential!);
      const deviceId = security.resolveCredentialDeviceId?.(credential!);
      const deviceKind = deviceId
        ? security.resolveCredentialDeviceKind?.(credential!)
        : undefined;
      const pairingSource = security.resolvePairingSource?.(credential!);
      const locality = security.resolveCredentialLocality?.(credential!);
      const mintKind = security.resolveCredentialMintKind?.(credential!);
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'credential',
        credential: credential!,
        authority,
        ...(deviceId ? { deviceId } : {}),
        ...(deviceId && deviceKind ? { deviceKind } : {}),
        source: cookieCredential !== undefined ? 'session' : 'bearer',
        ...(pairingSource ? { pairingSource } : {}),
        ...(locality ? { locality } : {}),
        // Kind without locality would be a mint-path claim with no
        // possession proof behind it; the store never resolves that
        // combination, and this site refuses to construct it either.
        ...(locality && mintKind ? { mintKind } : {}),
      });
      bindRuntimeLocalOperator(c.req.raw);
      if (authority !== undefined) {
        (c as unknown as { set: (key: string, value: unknown) => void }).set(
          RUNTIME_CREDENTIAL_AUTHORITY_VAR,
          authority,
        );
      }
      // Scoped pairing (archive#1098) is not optional: `resolveGrantedScope`
      // is a required field on `RuntimeHttpSecurityOptions` precisely so
      // this check always runs for a valid credential — no call site can
      // silently revert to pre-scoping auth by omitting the resolver.
      const grantedScope = await security.resolveGrantedScope(credential!);
      const permitted =
        requiredCapability.capability === 'pairing-scope' &&
        requiredCapability.scope !== undefined &&
        grantedScope !== undefined &&
        pairingScopeSatisfiesHttpRoute(
          grantedScope,
          requiredCapability.scope,
          {
            method: c.req.method,
            path: c.req.path,
          },
          authority === 'operator-credential',
        );
      if (!permitted) {
        if (cookieCredential) {
          deviceSessionAuthorizations.add(1, {
            outcome: 'denied',
            reason: 'insufficient_scope',
          });
        }
        // A route with no table entry (`requiredScope === undefined`) is a
        // fail-closed bug signal, not a routine denial — distinguished by
        // reason so the production audit sink (configureRuntimeRoutes)
        // logs it loudly instead of at the ordinary warn volume of a
        // legitimately under-scoped credential.
        emitSecurityAudit(security, c, routeLabeler, {
          event: 'station.auth.failure',
          outcome: 'denied',
          reason:
            requiredCapability.capability !== 'pairing-scope'
              ? 'route_scope_unmapped'
              : 'insufficient_scope',
          routeClass,
          peerClass: effectivePeerClass,
          transport: 'http',
          timestamp: security.now?.() ?? Date.now(),
        });
        limiter.clear(limiterKey);
        return c.json({ error: { code: 'insufficient_scope' } }, 403);
      }
      if (cookieCredential) {
        deviceSessionAuthorizations.add(1, { outcome: 'allowed' });
      }
      limiter.clear(limiterKey);
      // Published for the narrow class of rule this table cannot express —
      // one that depends on the request BODY as well as the caller's scope
      // (archive#1398 §5.4's fleet-contribution guard on `PUT /config/app`).
      // The cast is the one seam between Hono's per-router `Variables` typing
      // and a middleware that runs above every router;
      // `setGrantedPairingScope` is the only writer.
      setGrantedPairingScope(
        c as unknown as PairingScopeContextStore,
        grantedScope,
      );
      // archive#514: derive the budget principal from the server-verified
      // credential, never from a caller-supplied header. The budget key
      // follows the credential VALUE, so the same secret is the same budget
      // whether it arrived as a bearer token or a device-session cookie — a
      // holder of one credential cannot double its quota by choosing a
      // transport. `source` is passed through for telemetry only and does
      // not participate in the key (see `deriveBudgetPrincipal`).
      setBudgetPrincipal(
        c as unknown as PairingScopeContextStore,
        cookieCredential !== undefined
          ? deriveBudgetPrincipal('session', cookieCredential)
          : deriveBudgetPrincipal('bearer', bearerCredential),
      );
      return next();
    }

    // Admission refused a credential the server still recognizes. A 401
    // tells the browser the device session is dead: it drops the cookie,
    // remounts the protected tree, and asks again. Settings does that on a
    // loop because notification delivery reads `/api/pairing/devices` on
    // desktop and mobile, and an ordinary device credential is not admitted
    // to that inventory. Answer 403, the same status an authenticated caller
    // already receives when a route will not serve them.
    if (
      credential !== undefined &&
      (await security.recognizeCredential?.(credential))
    ) {
      if (cookieCredential) {
        deviceSessionAuthorizations.add(1, {
          outcome: 'denied',
          reason: 'insufficient_scope',
        });
      }
      emitSecurityAudit(security, c, routeLabeler, {
        event: 'station.auth.failure',
        outcome: 'denied',
        reason: 'insufficient_scope',
        routeClass,
        peerClass: effectivePeerClass,
        transport: 'http',
        timestamp: security.now?.() ?? Date.now(),
      });
      limiter.clear(limiterKey);
      return c.json({ error: { code: 'insufficient_scope' } }, 403);
    }

    if (cookieCredential) {
      deviceSessionAuthorizations.add(1, {
        outcome: 'denied',
        reason: 'invalid_or_revoked',
      });
    }

    const retryAfter = limiter.retryAfterSeconds(limiterKey);
    if (retryAfter !== undefined) {
      emitSecurityAudit(security, c, routeLabeler, {
        event: 'station.auth.rate_limited',
        outcome: 'denied',
        reason: 'too_many_failures',
        routeClass,
        peerClass: effectivePeerClass,
        transport: 'http',
        timestamp: security.now?.() ?? Date.now(),
      });
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: { code: AUTH_RATE_LIMITED_ERROR_CODE } }, 429);
    }

    limiter.recordFailure(limiterKey);
    emitSecurityAudit(security, c, routeLabeler, {
      event: 'station.auth.failure',
      outcome: 'denied',
      reason: credential ? 'credential_invalid' : 'credential_missing',
      routeClass,
      peerClass: effectivePeerClass,
      transport: 'http',
      timestamp: security.now?.() ?? Date.now(),
    });
    return c.json({ error: { code: 'authentication_required' } }, 401);
  });

  // ── archive#514: authenticated mutation budget ──
  // Runs AFTER the auth middleware (which publishes the budget principal) and
  // BEFORE any route handler. Rejects oversized bodies (413) and rate-limited
  // principals (429) before the handler can parse the body or persist state.
  // The key is the principal, not the route — one principal cannot evade by
  // spreading across protected routes.
  app.use('*', async (c, next) => {
    const mutationClass = isInteractiveWorkspacePerformanceDiagnostic(c)
      ? ('performance-diagnostic' as const)
      : classifyMutationRoute(c.req.method, c.req.path);
    if (mutationClass === 'unbudgeted') return next();

    const principal = getBudgetPrincipal(
      c as unknown as PairingScopeContextStore,
    );
    // No principal means the request was public (no auth) or this middleware
    // ran outside the security boundary. Either way, skip — the auth
    // middleware already handled denial for unauthenticated protected routes.
    if (!principal) return next();

    // 1. Rate check FIRST — no body work if the principal is already over
    //    budget. recordMutation runs before body-size so a flood of oversized
    //    POSTs still trips the limiter rather than bypassing it.
    const retryAfter = budget.retryAfterSeconds(principal.key, mutationClass);
    if (retryAfter !== undefined) {
      requestBudgetOutcomes.add(1, {
        outcome: 'rate_limited',
        class: mutationClass,
        source: principal.source,
      });
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: { code: 'rate_limited' } }, 429);
    }
    budget.recordMutation(principal.key, mutationClass);

    // #2893: a native-admitted request already carries the exact verified
    // buffered bytes (≤16 KiB) in the final Request the admission owner
    // built; never replace that Request again.
    if (principal.source === 'native-device') {
      requestBudgetOutcomes.add(1, {
        outcome: 'allowed',
        class: mutationClass,
        source: principal.source,
      });
      return next();
    }

    // 2. Body-size check. Content-Length first (reject before any read); then a
    //    bounded byte-counting read that catches a lying or absent
    //    Content-Length. The body is re-buffered into a new Request so the
    //    handler's `c.req.json()` reads the bounded copy — this is the same
    //    buffering `c.req.json()` would do, just with a ceiling.
    const ceiling = budget.bodyByteCeiling(mutationClass);
    const contentLength = c.req.raw.headers.get('content-length');
    if (contentLength !== null) {
      if (!/^\d+$/.test(contentLength) || Number(contentLength) > ceiling) {
        requestBudgetOutcomes.add(1, {
          outcome: 'oversized',
          class: mutationClass,
          source: principal.source,
        });
        return c.json(
          {
            error: {
              code: 'request_too_large',
              limit_bytes: ceiling,
            },
          },
          413,
        );
      }
    }

    const bodyResult = await readBoundedBody(c.req.raw, ceiling);
    if (bodyResult === 'too-large') {
      requestBudgetOutcomes.add(1, {
        outcome: 'oversized',
        class: mutationClass,
        source: principal.source,
      });
      return c.json(
        {
          error: {
            code: 'request_too_large',
            limit_bytes: ceiling,
          },
        },
        413,
      );
    }

    // Replace the raw request so the handler reads the bounded body. The
    // stream was consumed by the bounded read above, so even a zero-length
    // body must be re-wrapped. Only a truly absent body stream ('no-stream')
    // needs no replacement. The replacement is built from the request's own
    // fields, never by passing `c.req.raw` itself into the `Request`
    // constructor: the server adapter hands us a lightweight proxy whose
    // prototype chain satisfies `instanceof Request` but which never ran the
    // Request constructor, so undici's cross-construction reads the missing
    // `#state` private slot and throws on every body-bearing request when the
    // adapter and the middleware resolve to different module copies.
    if (bodyResult !== 'no-stream') {
      const raw = c.req.raw;
      const nativePeer = readVerifiedNativeVirtualApplicationRequest(raw);
      const authenticated = getRuntimeAuthenticatedRequestPrincipal(raw);
      c.req.raw = new Request(raw.url, {
        method: raw.method,
        headers: raw.headers,
        signal: raw.signal,
        body: bodyResult,
        duplex: 'half',
      });
      if (
        nativePeer &&
        !transferVerifiedNativeVirtualApplicationRequest(raw, c.req.raw)
      )
        return c.json(
          { error: { code: 'virtual_pion_provenance_invalid' } },
          403,
        );
      security.deploymentAuthentication?.transferRequest(raw, c.req.raw);
      // The request was deliberately rewrapped after bounded body buffering.
      // Carry the already middleware-verified principal to that replacement;
      // route handlers must never fall back to reparsing bearer/cookie input.
      if (authenticated) {
        setRuntimeAuthenticatedRequestPrincipal(c.req.raw, authenticated);
        bindRuntimeLocalOperator(c.req.raw, authenticated);
      }
    }

    requestBudgetOutcomes.add(1, {
      outcome: 'allowed',
      class: mutationClass,
      source: principal.source,
    });
    return next();
  });
}

type BoundedBodyResult = Uint8Array | 'too-large' | 'no-stream';

/**
 * Reads at most `maxBytes + 1` bytes from a request body, returning the
 * buffered bytes (within the limit, possibly zero-length for an empty body
 * stream), `'too-large'` (exceeded the limit), or `'no-stream'` (no body
 * stream at all). This is the honest enforcement behind Content-Length: a
 * lying or absent Content-Length is caught by the byte counter, not trusted.
 * The caller re-wraps the bytes into a new Request so the handler reads the
 * bounded copy.
 */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const stream = request.body;
  if (!stream) return 'no-stream';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return 'too-large';
      }
      chunks.push(result.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return 'no-stream';
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function parseDeviceSessionCookie(
  value: string | undefined,
): string | undefined {
  // Cookie jars are shared across ports. Other localhost applications can
  // legitimately contribute several KiB; bound the header at the Node HTTP
  // default while still validating only one exact Station credential below.
  if (!value || value.length > 16 * 1024) return undefined;
  const matches: string[] = [];
  for (const segment of value.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    if (
      name !== SECURE_DEVICE_SESSION_COOKIE &&
      name !== LOOPBACK_DEVICE_SESSION_COOKIE
    ) {
      continue;
    }
    const candidate = segment.slice(separator + 1).trim();
    if (!DEVICE_CREDENTIAL_PATTERN.test(candidate)) return undefined;
    matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Cookie-adoption is an HTTPS browser ceremony; reject loopback's cleartext cookie name. */
export function parseSecureDeviceSessionCookie(
  value: string | undefined,
): string | undefined {
  if (!value || value.length > 16 * 1024) return undefined;
  const hasSecureName = value.split(';').some((segment) => {
    const separator = segment.indexOf('=');
    return (
      separator > 0 &&
      segment.slice(0, separator).trim() === SECURE_DEVICE_SESSION_COOKIE
    );
  });
  return hasSecureName ? parseDeviceSessionCookie(value) : undefined;
}

function hasCredentialQuery(url: string): boolean {
  try {
    const query = new URL(url).searchParams;
    return ['credential', 'token', 'access_token', 'auth'].some((key) =>
      query.has(key),
    );
  } catch {
    return true;
  }
}

function emitSecurityAudit(
  security: Pick<RuntimeHttpSecurityOptions, 'audit'>,
  request: { req: { method: string; path: string } },
  routeLabeler: RuntimeRouteLabeler,
  record: Pick<
    RuntimeSecurityAuditRecord,
    | 'event'
    | 'outcome'
    | 'reason'
    | 'routeClass'
    | 'peerClass'
    | 'transport'
    | 'timestamp'
  >,
): void {
  security.audit?.({
    ...record,
    // Hono's path deliberately excludes the query string. Do not use url:
    // credential-bearing queries and request headers are outside the audit
    // record's redaction posture.
    method: request.req.method,
    path: request.req.path,
    routeLabel: routeLabeler(request.req.path),
  });
}

export function resolveRuntimeCorsOrigin(
  origin?: string,
): string | null | undefined {
  if (!origin) {
    return origin;
  }

  if (
    origin.startsWith('http://localhost:') ||
    origin.startsWith('https://localhost:') ||
    origin === 'tauri://localhost' ||
    origin === 'https://tauri.localhost' ||
    // Android's Tauri WebView origin uses the plain-http scheme.
    origin === 'http://tauri.localhost'
  ) {
    return origin;
  }

  try {
    const host = new URL(origin).hostname;
    if (
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return origin;
    }
  } catch {}

  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
  return allowedOrigins.includes(origin) ? origin : null;
}

// These handlers use POST to carry query input, not to change resource data.
// Broadcasting their own cache key makes an active query refetch itself until
// it exhausts the request quota. Keep exact read leaves separate from writes;
// authentication and request budgets still apply unchanged.
const READ_ONLY_DATA_POST_ROUTES = [
  /^\/api\/projects\/[^/]+\/file-preview(?:\/download|\/exists)?\/?$/,
  /^\/api\/projects\/[^/]+\/knowledge\/(?:ns\/[^/]+\/)?search\/?$/,
  /^\/api\/knowledge\/(?:search|index\/search|roots\/validate)\/?$/,
  // The receiver-side contribution query is a POST-carried read: it changes
  // nothing, so broadcasting a key would make the asking client's own
  // contribution query refetch itself.
  /^\/api\/project-contributions\/query\/?$/,
];

function getInvalidationKeysForRequest(method: string, path: string): string[] {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return [];
  if (
    method === 'POST' &&
    READ_ONLY_DATA_POST_ROUTES.some((route) => route.test(path))
  )
    return [];
  const keys: string[] = [];

  if (path.startsWith('/agents')) keys.push('agents');
  if (path.startsWith('/integrations')) keys.push('integrations');
  if (path.includes('/skills')) keys.push('skills');
  if (path.includes('/providers')) keys.push('providers');
  if (path.includes('/scheduler') || path.includes('/jobs')) {
    keys.push('scheduler-jobs');
  }
  // An execution offer lives in AppConfig.contribution; the settings surface
  // (and any other reader of ['config']) must see the change.
  if (path.startsWith('/api/project-contributions/')) keys.push('config');
  if (path.includes('/projects')) keys.push('projects');
  if (path.includes('/knowledge')) keys.push('knowledge');
  if (path.includes('/registry')) keys.push('skills', 'integrations', 'agents');

  return [...new Set(keys)];
}
