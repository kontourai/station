/**
 * Station #90 lane D (station #122): the ONE derivation of a station-control
 * tool's verified caller. Every entry point goes through
 * {@link resolveVerifiedStationControlCaller}:
 *
 *  - the HTTP/SSE MCP route (`station-control-mcp-route.ts`) and the
 *    in-process Claude server (`station-control-in-process.ts`) hand tool
 *    callbacks a resolver bound to their session's token;
 *  - Station's REST side ({@link resolveStationControlCallerForRequest})
 *    re-verifies the token a tool forwards in
 *    `STATION_CONTROL_CALLER_TOKEN_HEADER`;
 *  - a stdio child asks the REST projection
 *    (`station-control-caller-route.ts`), which is the REST side again.
 *
 * Identity comes only from the server-minted per-session token
 * (`station-control-mcp-token.ts`); `assurance` comes from the channel that
 * token was minted for. The acting principal, project and conversation come
 * from the server's own session records for the token's session. Nothing
 * here reads a session id from tool input or from any header other than the
 * credential.
 */
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { SessionActingPrincipal } from '../../services/orchestration/session-authorization.js';
import {
  STATION_CONTROL_CALLER_TOKEN_HEADER,
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
  type StationControlCaller,
  stationControlCallerPrincipal,
} from '../../tools/station-control-shared.js';
import { INTERNAL_TENANT_HEADER } from '../../utils/internal-api-token.js';
import {
  stationControlTokenAssurance,
  verifyStationControlMcpTokenEntry,
} from './station-control-mcp-token.js';

export interface StationControlCallerRecord {
  readonly principal?: SessionActingPrincipal;
  readonly localProjectId?: string;
  readonly projectSlug?: string;
  readonly conversationId?: string;
}

/** Reads the server's own records for a verified session. */
export type StationControlCallerRecordResolver = (
  sessionId: string,
) => StationControlCallerRecord | undefined;

/**
 * The server records the caller resolver reads, as the production
 * composition supplies them. Exported (rather than an inline closure in
 * `runtime-routes.ts`) so a test can drive the real derivation.
 */
export interface StationControlCallerRecordSources {
  /** Ownership-record principal (`OrchestrationService.resolveSessionActingPrincipal`). */
  actingPrincipal(sessionId: string): SessionActingPrincipal | undefined;
  /** The session's own latest `session.configured`/`session.started` metadata. */
  startedMetadata(sessionId: string): Record<string, unknown> | undefined;
  /** `ProjectConfig.id` for a local slug, or undefined when there is none. */
  localProjectId(slug: string): string | undefined;
  conversationId(sessionId: string): string | undefined;
}

/**
 * Builds the production record resolver. It reads one session's own latest
 * start metadata (a keyed lookup, not a scan of every session) for its
 * project binding, preferring the delegation-scoped slug the way
 * `resolveSessionProjectSlug` does, then maps the slug to the local project
 * id.
 *
 * `localProjectId` is resolved from the recorded slug at read time: the slug
 * is the only project binding a session records today. A project whose slug
 * no longer exists resolves to no id, never to a different project.
 */
export function createStationControlCallerRecordResolver(
  sources: StationControlCallerRecordSources,
): StationControlCallerRecordResolver {
  return (sessionId) => {
    const principal = sources.actingPrincipal(sessionId);
    const metadata = sources.startedMetadata(sessionId);
    const delegation = metadata?.delegation as
      | { projectSlug?: unknown }
      | undefined;
    const rawSlug =
      typeof delegation?.projectSlug === 'string' && delegation.projectSlug
        ? delegation.projectSlug
        : metadata?.projectSlug;
    const projectSlug =
      typeof rawSlug === 'string' && rawSlug ? rawSlug : undefined;
    const localProjectId = projectSlug
      ? sources.localProjectId(projectSlug)
      : undefined;
    const conversationId = sources.conversationId(sessionId);
    return {
      ...(principal ? { principal } : {}),
      ...(localProjectId ? { localProjectId } : {}),
      ...(projectSlug ? { projectSlug } : {}),
      ...(conversationId ? { conversationId } : {}),
    };
  };
}

/**
 * The production record sources, from the runtime's own services. One
 * composition shared by `runtime-routes.ts` (REST + HTTP MCP) and
 * `station-runtime.ts` (in-process Claude), so the two cannot derive the
 * principal or project differently.
 */
export function stationControlCallerRecordSources(runtime: {
  orchestrationService: {
    resolveSessionActingPrincipal(
      threadId: string,
    ): SessionActingPrincipal | undefined;
    latestStartedMetadataOfThread(
      threadId: string,
    ): Record<string, unknown> | undefined;
  };
  eventStore?: {
    conversationForSession(
      sessionId: string,
    ): { readonly conversationId: string } | undefined;
  };
  getProject(slug: string): { readonly id: string };
}): StationControlCallerRecordSources {
  return {
    actingPrincipal: (sessionId) =>
      runtime.orchestrationService.resolveSessionActingPrincipal(sessionId),
    startedMetadata: (sessionId) =>
      runtime.orchestrationService.latestStartedMetadataOfThread(sessionId),
    localProjectId: (slug) => {
      try {
        const id = runtime.getProject(slug).id;
        return typeof id === 'string' && id ? id : undefined;
      } catch {
        // A slug with no project (renamed or deleted) has no local id.
        return undefined;
      }
    },
    conversationId: (sessionId) =>
      runtime.eventStore?.conversationForSession(sessionId)?.conversationId,
  };
}

/** Internal only: the public caller plus the token's tenant, for checks. */
export interface VerifiedStationControlCaller {
  readonly caller: StationControlCaller;
  readonly tenant?: TenantExecutionContext;
}

/**
 * The caller a live token names, or `null` for a missing, unknown, revoked
 * or expired token. A record lookup that throws also yields `null`: a caller
 * with its project silently missing would read as "no project" to a tool
 * that scopes by project.
 */
export function resolveVerifiedStationControlCaller(
  token: string | undefined | null,
  resolveRecord?: StationControlCallerRecordResolver,
): VerifiedStationControlCaller | null {
  const verified = verifyStationControlMcpTokenEntry(token);
  if (!verified) return null;
  let record: StationControlCallerRecord | undefined;
  try {
    record = resolveRecord?.(verified.sessionId);
  } catch {
    return null;
  }
  const caller: StationControlCaller = Object.freeze({
    sessionId: verified.sessionId,
    assurance: stationControlTokenAssurance(verified.channel),
    ...(record?.principal
      ? {
          principal: stationControlCallerPrincipal(
            record.principal.id,
            record.principal.source,
          ),
        }
      : {}),
    ...(typeof record?.localProjectId === 'string' && record.localProjectId
      ? { localProjectId: record.localProjectId }
      : {}),
    ...(typeof record?.projectSlug === 'string' && record.projectSlug
      ? { projectSlug: record.projectSlug }
      : {}),
    ...(typeof record?.conversationId === 'string' && record.conversationId
      ? { conversationId: record.conversationId }
      : {}),
  });
  return {
    caller,
    ...(verified.tenantExecutionContext
      ? { tenant: verified.tenantExecutionContext }
      : {}),
  };
}

/** The public caller for a token (in-process tool callbacks). */
export function resolveStationControlCallerFromToken(
  token: string | undefined | null,
  resolveRecord?: StationControlCallerRecordResolver,
): StationControlCaller | null {
  return (
    resolveVerifiedStationControlCaller(token, resolveRecord)?.caller ?? null
  );
}

/**
 * The verified caller of a REST request made by a station-control tool, or
 * `null`.
 *
 * Three conditions, all required:
 *  1. The runtime security boundary accepted the request as Station's own
 *     internal caller (per-boot internal token from a direct loopback peer).
 *     A paired device or operator credential never acquires a caller by
 *     adding the header.
 *  2. The forwarded credential verifies against the live token registry, so
 *     a forged, revoked or expired value yields nothing.
 *  3. The request's tenant header names the same tenant the token was
 *     minted for (both absent on a personal host).
 *
 * Check `caller.assurance` before trusting it as "this session": a
 * `bearer-exposed` credential may have been copied by another process.
 */
export function resolveStationControlCallerForRequest(
  request: Request,
  resolveRecord?: StationControlCallerRecordResolver,
): StationControlCaller | null {
  if (getRuntimeAuthenticatedRequestPrincipal(request)?.kind !== 'internal')
    return null;
  const token = request.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER);
  if (!token) return null;
  const verified = resolveVerifiedStationControlCaller(token, resolveRecord);
  if (!verified) return null;
  const requestTenant =
    request.headers.get(INTERNAL_TENANT_HEADER) || undefined;
  if ((verified.tenant?.tenantId ?? undefined) !== requestTenant) return null;
  return verified.caller;
}

/**
 * Whether a REST request declares itself a station-control agent tool call.
 * Personal-mode Station's UI and a station-control child both authenticate
 * as the same internal principal (`human:local:operator`), so the principal
 * cannot answer this.
 *
 * True when the request carries a caller credential (valid or not) or the
 * origin marker Station's tool code sets. Both are declarations: presence
 * may only RESTRICT (treat the request as an agent's). ABSENCE PROVES
 * NOTHING. An agent with a shell can read the internal token from a stdio
 * child's env or argv and call the API without either header, so `false`
 * is not "human", and this must never gate a human-only action.
 *
 * Use {@link resolveStationControlCallerForRequest} for WHO: an
 * agent-originated request with a `null` caller is an agent Station cannot
 * attribute to a session (a pooled child), and must be treated as such.
 */
export function isAgentOriginatedRequest(request: Request): boolean {
  return (
    request.headers.has(STATION_CONTROL_CALLER_TOKEN_HEADER) ||
    request.headers.get(STATION_CONTROL_ORIGIN_HEADER) ===
      STATION_CONTROL_ORIGIN_AGENT_TOOL
  );
}
