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
 * - a caller-less request may reach only read-only routes whose answers
 *   belong to no person (decision 4, read with decision 2);
 * - assurance, the operator role, a recorded owner for principal-scoped
 *   actions, and person-only actions follow the table.
 *
 * Slice B (decision 2): it also records who each internal request acts for
 * (`station-control-request-authority.ts`) and withdraws the internal
 * token's home-possession from every tool call except a bound operator's
 * (`withdrawInternalHomePossession`). The orchestration principal resolver
 * then answers with the calling session's recorded owner, so every session,
 * conversation, Project and plugin read reads as that person, and no
 * locality-keyed operator gate (unredacted logs, the Project operator check)
 * reads an agent as the operator in person.
 *
 * Who it never sees: the operator's UI and every paired device authenticate
 * with their own credential and are stamped `kind:'credential'` (the CLI's UI
 * proxy strips any client-sent internal token and marks its hop `remote`), so
 * this guard passes them through untouched.
 *
 * Two classes of internal request are not station-control tool calls and are
 * let through before the table:
 *
 * 1. Station's own server code calling its own API from inside an explicit
 *    server scope (`runAsStationServer`), identified by the in-memory
 *    server-self attestation (`INTERNAL_SERVER_SELF_HEADER`), which no child
 *    process or stolen token holds. Slice C: dispatch route handlers run in
 *    that scope, so their loopback hops (SSH connect, peer credential, Agent
 *    and Connection reads) pass here; dispatch must be enforced at the
 *    dispatch route, not at those leaves.
 * 2. {@link STATION_CONTROL_GUARD_CARVE_OUTS}, by exact method and path.
 */
import type { MiddlewareHandler } from 'hono';
import { PrincipalUnresolvedError } from '../services/identity/principal-resolver.js';
import {
  authorizeStationControlRequest,
  matchStationControlRoute,
  type StationControlRefusal,
  stationControlRefusal,
  stationControlRefusalBody,
} from '../tools/station-control-policy.js';
import type { StationControlCaller } from '../tools/station-control-shared.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  withdrawInternalHomePossession,
} from './runtime-request-security.js';
import { bindStationControlRequestAuthority } from './station-control-request-authority.js';
import {
  enableStationServerSelfAttestation,
  INTERNAL_SERVER_SELF_HEADER,
  isStationServerSelfAttestation,
} from './station-server-scope.js';

/**
 * Internal requests that reach Station without a station-control caller and
 * are not Station's server code, carved out by exact method and path.
 *
 * Why a path carve-out is acceptable, and only for these: `GET
 * /api/system/identity` and `GET /api/system/instance` are the CLI's
 * readiness probes (`packages/cli/src/commands/lifecycle.ts`: the start-up
 * wait, the UI server's live-ready probe, the consent-listener report). They
 * run in another process (the CLI, the UI server) before any session exists,
 * so they can hold neither a caller nor the server-self attestation, and both
 * are reads that return this instance's own identity and listener state.
 *
 * The Station agent relay (`POST /api/agents/:id/chat`) is NOT carved out: it
 * is in-process server code and carries the server-self attestation
 * (`station-agent-adapter.ts`), so a bare internal token on that path is
 * refused.
 *
 * A carve-out is a hole the internal token opens for anyone holding it, so the
 * list is exact (no prefixes) and pinned by test.
 */
export const STATION_CONTROL_GUARD_CARVE_OUTS: readonly {
  readonly method: 'GET';
  readonly pattern: RegExp;
  readonly reason: string;
}[] = [
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
  /**
   * Whether editing `jobName` with `changes` would change what a job that
   * holds unattended grants runs. Absent: assume it would (fail closed).
   * Must fail closed itself when the grant store cannot be read.
   */
  retargetsGrantedJob?(
    jobName: string,
    changes: Record<string, unknown>,
  ): boolean | Promise<boolean>;
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
  const match = matchStationControlRoute(method, path);
  return (
    !!match &&
    (match.rules.length > 0 ||
      match.policies.some(
        (policy) => policy.personOnly === 'when-trust-all-tools',
      ))
  );
}

/**
 * Job fields that decide what a scheduled job runs. `monitor` counts: its
 * `agentId`, `projectId` and `target` choose the work a monitor dispatch runs
 * under the job's scheduled-job principal (and so the job's grants).
 */
const JOB_TARGET_FIELDS = ['prompt', 'agent', 'provider', 'monitor'] as const;

/**
 * The fields of an edit body that could change what a job runs; the grant
 * check compares them with the job itself.
 */
function jobTargetChanges(
  body: unknown,
): Partial<Record<(typeof JOB_TARGET_FIELDS)[number], unknown>> {
  if (!body || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  return Object.fromEntries(
    JOB_TARGET_FIELDS.filter((field) => record[field] !== undefined).map(
      (field) => [field, record[field]],
    ),
  );
}

async function retargetsGrantedJob(
  options: StationControlAuthorityGuardOptions,
  method: string,
  path: string,
  body: unknown,
): Promise<boolean> {
  if (
    !matchStationControlRoute(method, path)?.rules.includes(
      'retarget-of-granted-job-is-person-only',
    )
  )
    return false;
  const changes = jobTargetChanges(body);
  if (Object.keys(changes).length === 0) return false;
  // The leaf is `PUT /scheduler/jobs/:target`.
  const jobName = decodeURIComponent(path.split('/').filter(Boolean)[2] ?? '');
  if (!options.retargetsGrantedJob) return true;
  try {
    return await options.retargetsGrantedJob(jobName, changes);
  } catch {
    return true;
  }
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
    const method = c.req.method;
    const path = c.req.path;
    if (
      isStationServerSelfAttestation(
        request.headers.get(INTERNAL_SERVER_SELF_HEADER),
      ) ||
      isCarvedOut(method, path)
    ) {
      bindStationControlRequestAuthority(request, { kind: 'server' });
      return next();
    }
    const caller = options.resolveCaller(request);
    const boundOperator =
      caller?.assurance === 'bound' &&
      caller.principal?.elevationEligible === true &&
      options.isOperatorPrincipal(caller.principal.id);
    // Slice B: a tool call reads as its session's owner. Record who that is
    // for the principal resolver and the read routes, and withdraw the
    // internal token's home-possession unless the caller is a bound operator,
    // so no locality-keyed operator gate (unredacted logs, Project operator
    // checks) reads an agent as the operator in person.
    bindStationControlRequestAuthority(
      request,
      caller
        ? { kind: 'caller', caller, boundOperator }
        : { kind: 'caller-less' },
    );
    if (!boundOperator) withdrawInternalHomePossession(request);
    const body = needsBody(method, path)
      ? await requestBody(request)
      : undefined;
    const refusal = authorizeStationControlRequest(method, path, {
      caller,
      isOperatorPrincipal: options.isOperatorPrincipal,
      body,
      retargetsGrantedJob: await retargetsGrantedJob(
        options,
        method,
        path,
        body,
      ),
    });
    if (!refusal) {
      await next();
      // Slice B: a request that acts for no principal (caller-less, or a
      // session with no recorded owner) may still reach a leaf whose route
      // resolves the request principal (a dispatch read such as
      // `GET /api/orchestration/sessions/read-model`). That resolution
      // throws `PrincipalUnresolvedError`, which the app's error handler
      // would answer as an internal error. Answer it with the typed refusal
      // instead: it is a statement about the caller, not a server fault.
      if (c.error instanceof PrincipalUnresolvedError) {
        const typed = stationControlRefusal(
          caller
            ? 'station_control_role_required'
            : 'station_control_caller_required',
        );
        options.onRefusal?.(typed, method, path);
        c.res = new Response(JSON.stringify(stationControlRefusalBody(typed)), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return;
    }
    options.onRefusal?.(refusal, method, path);
    return c.json(stationControlRefusalBody(refusal), 403);
  };
}
