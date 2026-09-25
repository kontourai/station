/**
 * #2377 slice A: the central station-control authority guard.
 *
 * Every request the runtime auth boundary (`runtime-http.ts`) stamped
 * `kind:'internal'` — the per-boot internal token, presented from a direct
 * loopback socket with the `local` proxy marker — resolved to the Station
 * operator, whoever sent it. That is every station-control tool call (stdio
 * child, pooled child, in-process HTTP MCP, in-process Claude), so every
 * agent reached Station as the operator. This guard runs right after that
 * boundary and before any route, and decides internal requests from the
 * station-control authority table (`tools/station-control-policy.ts`) and the
 * VERIFIED caller the request forwards (`resolveStationControlCallerForRequest`):
 *
 * - a route no tool reaches is refused (`station_control_route_unmapped`),
 *   so a new route cannot become agent-reachable by default;
 * - a caller-less request may reach only read-only routes (decision 4);
 * - assurance, the operator role and person-only actions follow the table.
 *
 * Who it never sees: the operator's UI and every paired device authenticate
 * with their own credential and are stamped `kind:'credential'` (the CLI's UI
 * proxy strips any client-sent internal token and marks its hop `remote`), so
 * this guard passes them through untouched.
 *
 * Two classes of internal request are not station-control tool calls and are
 * let through before the table:
 *
 * 1. Station's own server code calling its own API, identified by the
 *    in-memory server-self attestation (`INTERNAL_SERVER_SELF_HEADER`), which
 *    no child process or stolen token holds.
 * 2. {@link STATION_CONTROL_GUARD_CARVE_OUTS}, by exact method and path.
 */
import type { MiddlewareHandler } from 'hono';
import {
  authorizeStationControlRequest,
  matchStationControlRoute,
  type StationControlRefusal,
  stationControlRefusalBody,
} from '../tools/station-control-policy.js';
import type { StationControlCaller } from '../tools/station-control-shared.js';
import {
  enableStationServerSelfAttestation,
  INTERNAL_SERVER_SELF_HEADER,
  isStationServerSelfAttestation,
} from '../utils/internal-api-token.js';
import { getRuntimeAuthenticatedRequestPrincipal } from './runtime-request-security.js';

/**
 * Internal requests that reach Station without a station-control caller and
 * are not Station's server code, carved out by exact method and path.
 *
 * Why a path carve-out is acceptable for slice A, and only for these:
 *
 * - `POST /api/agents/:id/chat` is the Station agent relay
 *   (`providers/adapters/station-agent-adapter.ts`): the built-in engine
 *   driving its own turn. It has no session identity to present yet — giving
 *   the built-in engine one is slice D — and refusing it would stop every
 *   Station-engine chat. No station-control tool reaches this path.
 * - `GET /api/system/identity` and `GET /api/system/instance` are the CLI's
 *   readiness probes (`packages/cli/src/commands/lifecycle.ts`: the start-up
 *   wait, the UI server's live-ready probe, the consent-listener report).
 *   They run before any session exists, and both are reads that return this
 *   instance's own identity and listener state.
 *
 * A carve-out is a hole the internal token opens for anyone holding it, so the
 * list is exact (no prefixes) and pinned by test; slice D removes the relay.
 */
export const STATION_CONTROL_GUARD_CARVE_OUTS: readonly {
  readonly method: 'GET' | 'POST';
  readonly pattern: RegExp;
  readonly reason: string;
}[] = [
  {
    method: 'POST',
    pattern: /^\/api\/agents\/[^/]+\/chat$/,
    reason: 'Station agent relay (built-in engine turn); slice D',
  },
  {
    method: 'GET',
    pattern: /^\/api\/system\/identity$/,
    reason: 'CLI and UI-server readiness probe',
  },
  {
    method: 'GET',
    pattern: /^\/api\/system\/instance$/,
    reason: 'CLI consent-listener readiness report',
  },
];

function isCarvedOut(method: string, path: string): boolean {
  const normalized = method.toUpperCase() === 'HEAD' ? 'GET' : method;
  return STATION_CONTROL_GUARD_CARVE_OUTS.some(
    (carveOut) => carveOut.method === normalized && carveOut.pattern.test(path),
  );
}

export interface StationControlAuthorityGuardOptions {
  /** Re-derives the verified caller from the forwarded credential. */
  resolveCaller(request: Request): StationControlCaller | null;
  /** Whether a principal is the Station operator (personal host). */
  isOperatorPrincipal(principalId: string): boolean;
  /** Called once per refusal, for the operator's logs. */
  onRefusal?(
    refusal: StationControlRefusal,
    method: string,
    path: string,
  ): void;
}

async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    // An unreadable body cannot ask for anything; the route's own validation
    // answers it.
    return undefined;
  }
}

function needsBody(method: string, path: string): boolean {
  return (
    matchStationControlRoute(method, path)?.policies.some(
      (policy) => policy.personOnly === 'when-trust-all-tools',
    ) ?? false
  );
}

/**
 * The guard middleware. Register it immediately after `configureRuntimeHttp`
 * (and before any route), so it sees the principal the boundary bound and
 * every route sits behind it. Creating it also mints the server-self
 * attestation for this process.
 */
export function createStationControlAuthorityGuard(
  options: StationControlAuthorityGuardOptions,
): MiddlewareHandler {
  enableStationServerSelfAttestation();
  return async (c, next) => {
    const request = c.req.raw;
    if (getRuntimeAuthenticatedRequestPrincipal(request)?.kind !== 'internal')
      return next();
    if (
      isStationServerSelfAttestation(
        request.headers.get(INTERNAL_SERVER_SELF_HEADER),
      )
    )
      return next();
    const method = c.req.method;
    const path = c.req.path;
    if (isCarvedOut(method, path)) return next();
    const refusal = authorizeStationControlRequest(method, path, {
      caller: options.resolveCaller(request),
      isOperatorPrincipal: options.isOperatorPrincipal,
      ...(needsBody(method, path) ? { body: await requestBody(request) } : {}),
    });
    if (!refusal) return next();
    options.onRefusal?.(refusal, method, path);
    return c.json(stationControlRefusalBody(refusal), 403);
  };
}
