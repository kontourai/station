import { randomUUID } from 'node:crypto';
import { CLIENT_ORIGIN_HEADER } from '@kontourai/station-contracts/client-origin';
import { pairingScopeIncludes } from '@kontourai/station-contracts/environment-security';
import { STATION_PLUGIN_HEADER } from '@kontourai/station-contracts/http';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { sanitizeError } from '@kontourai/station-shared/redaction';
import { type HonoServerConfig } from '@voltagent/server-hono';
import { cors } from 'hono/cors';
import {
  INTERACTIVE_WORKSPACE_TIMING_MODE,
  INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER,
} from '../../../src-shared/interactive-workspace-performance-timing.js';
import {
  type ExternalSurfaceCapabilityRule,
  type PairingScopeContextStore,
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
  getBudgetPrincipal,
  getDirectSocketAddress,
  getRuntimeAuthenticatedRequestPrincipal,
  parseStrictBearer,
  RUNTIME_CREDENTIAL_AUTHORITY_VAR,
  RuntimeAuthFailureLimiter,
  type RuntimeHttpSecurityOptions,
  RuntimeMutationBudget,
  type RuntimeSecurityAuditRecord,
  setBudgetPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../security/runtime-request-security.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
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

interface RuntimeHttpContext {
  app: RuntimeApp;
  logger: Logger;
  eventBus: EventBus;
  security?: RuntimeHttpSecurityOptions;
}

export function configureRuntimeHttp({
  app,
  logger,
  eventBus,
  security,
}: RuntimeHttpContext): void {
  app.onError((err, c) => {
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
    // station#1848: a streaming handler returns its Response as soon as the
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
    logger.info(
      `${c.req.method} ${c.req.path} ${c.res.status} ${
        streaming ? `stream-open-after=${elapsedMs}ms` : `${elapsedMs}ms`
      } origin=${c.req.header('origin') ? 'present' : 'none'}`,
    );
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
      }),
    );
  }

  app.use('*', async (c, next) => {
    await next();

    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.req.method)) {
      return;
    }

    const keys = getInvalidationKeysForPath(c.req.path);
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

/**
 * The code the AUTH-failure limiter answers with, distinct from the mutation
 * budget's `rate_limited` (station#3903).
 *
 * Both used to say `rate_limited`, and they are not the same fact. This one is
 * only ever reached after `maxFailures` REJECTED CREDENTIALS from one peer
 * inside the window — it is this Station saying no to this device's access,
 * throttled — while the budget's is an already-authorised principal writing
 * too fast. One code for both left no way for a client to tell them apart, so
 * `packages/connect`'s classifier could only fall through to
 * `unexpected-response`, whose copy reads "answered, but not as a Station.
 * Something else may be answering at that address." A revoked phone was told
 * to go looking for a wrong server while the right one was refusing it by
 * name.
 *
 * The name is not new: `src-server/security/websocket-auth.ts` already closes
 * a throttled socket with `authentication_rate_limited`, and the pairing
 * routes already audit `station.pairing.authentication_rate_limited`. This is
 * the HTTP boundary joining a vocabulary the rest of the runtime has.
 */
export const AUTH_RATE_LIMITED_ERROR_CODE = 'authentication_rate_limited';

function configureRuntimeSecurity(
  app: RuntimeApp,
  security: RuntimeHttpSecurityOptions,
  routeLabeler: RuntimeRouteLabeler,
): void {
  const allowedOrigins = new Set(security.allowedOrigins ?? []);
  const limiter = new RuntimeAuthFailureLimiter(security);
  const budget = new RuntimeMutationBudget(security);

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins.has(origin)) {
      return c.json({ error: { code: 'origin_forbidden' } }, 403);
    }

    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Credentials', 'true');
    }
    if (c.req.method === 'OPTIONS') {
      if (!origin) {
        return c.json({ error: { code: 'origin_forbidden' } }, 403);
      }
      c.header(
        'Access-Control-Allow-Headers',
        `Authorization, Content-Type, X-Station-Client-Session, ${CLIENT_ORIGIN_HEADER}, ${STATION_PLUGIN_HEADER}${
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

    // station#2051: TCP loopback is a transport position, not authority. In
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
      const authority = security.resolveCredentialAuthority?.(credential!);
      const deviceId = security.resolveCredentialDeviceId?.(credential!);
      const pairingSource = security.resolvePairingSource?.(credential!);
      const locality = security.resolveCredentialLocality?.(credential!);
      const mintKind = security.resolveCredentialMintKind?.(credential!);
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'credential',
        credential: credential!,
        authority,
        ...(deviceId ? { deviceId } : {}),
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
      // Scoped pairing (station#1098) is not optional: `resolveGrantedScope`
      // is a required field on `RuntimeHttpSecurityOptions` precisely so
      // this check always runs for a valid credential — no call site can
      // silently revert to pre-scoping auth by omitting the resolver.
      const grantedScope = await security.resolveGrantedScope(credential!);
      const permitted =
        requiredCapability.capability === 'pairing-scope' &&
        requiredCapability.scope !== undefined &&
        grantedScope !== undefined &&
        pairingScopeIncludes(grantedScope, requiredCapability.scope);
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
      // (station#1398 §5.4's fleet-contribution guard on `PUT /config/app`).
      // The cast is the one seam between Hono's per-router `Variables` typing
      // and a middleware that runs above every router;
      // `setGrantedPairingScope` is the only writer.
      setGrantedPairingScope(
        c as unknown as PairingScopeContextStore,
        grantedScope,
      );
      // station#514: derive the budget principal from the server-verified
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

  // ── station#514: authenticated mutation budget ──
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
      const authenticated = getRuntimeAuthenticatedRequestPrincipal(raw);
      c.req.raw = new Request(raw.url, {
        method: raw.method,
        headers: raw.headers,
        signal: raw.signal,
        body: bodyResult,
        duplex: 'half',
      });
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
  if (!value || value.length > 4_096) return undefined;
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

function getInvalidationKeysForPath(path: string): string[] {
  const keys: string[] = [];

  if (path.startsWith('/agents')) keys.push('agents');
  if (path.startsWith('/integrations')) keys.push('integrations');
  if (path.includes('/skills')) keys.push('skills');
  if (path.includes('/providers')) keys.push('providers');
  if (path.includes('/scheduler') || path.includes('/jobs')) {
    keys.push('scheduler-jobs');
  }
  if (path.includes('/projects')) keys.push('projects');
  if (path.includes('/knowledge')) keys.push('knowledge');
  if (path.includes('/registry')) keys.push('skills', 'integrations', 'agents');

  return [...new Set(keys)];
}
