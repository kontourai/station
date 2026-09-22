/**
 * Lane D of #90 (archive#122): the ONE derivation of a station-control tool's
 * verified caller. Every entry point goes through
 * {@link resolveStationControlCallerFromToken}:
 *
 *  - the HTTP/SSE MCP route (`station-control-mcp-route.ts`) hands tool
 *    callbacks a resolver bound to the token it just verified;
 *  - Station's REST side ({@link resolveStationControlCallerForRequest})
 *    re-verifies the token a tool forwards in
 *    `STATION_CONTROL_CALLER_TOKEN_HEADER`;
 *  - a stdio child asks the REST projection
 *    (`station-control-caller-route.ts`), which is the REST side again.
 *
 * Authority comes only from the server-minted per-session token
 * (`station-control-mcp-token.ts`). The acting principal, project and
 * conversation come from the server's own session records for the token's
 * session. Nothing here reads a
 * session id from tool input or from any header other than the credential.
 */
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type {
  StationControlCaller,
  StationControlCallerPrincipal,
} from '../../tools/station-control-shared.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../tools/station-control-shared.js';
import { INTERNAL_TENANT_HEADER } from '../../utils/internal-api-token.js';
import { verifyStationControlMcpToken } from './station-control-mcp-token.js';

export interface StationControlCallerRecord {
  readonly principal?: StationControlCallerPrincipal;
  readonly projectSlug?: string;
  readonly conversationId?: string;
}

/** Reads the server's own records for a verified session. */
export type StationControlCallerRecordResolver = (
  sessionId: string,
) => StationControlCallerRecord | undefined;

/**
 * The caller a live token names, or `null` for a missing, unknown, revoked
 * or expired token. A record lookup that throws also yields `null`: a caller
 * with its project silently missing would read as "no project" to a tool
 * that scopes by project.
 */
export function resolveStationControlCallerFromToken(
  token: string | undefined | null,
  resolveRecord?: StationControlCallerRecordResolver,
): StationControlCaller | null {
  const verified = verifyStationControlMcpToken(token);
  if (!verified) return null;
  let record: StationControlCallerRecord | undefined;
  try {
    record = resolveRecord?.(verified.sessionId);
  } catch {
    return null;
  }
  return Object.freeze({
    sessionId: verified.sessionId,
    ...(record?.principal
      ? {
          principal: Object.freeze({
            id: record.principal.id,
            source: record.principal.source,
          }),
        }
      : {}),
    ...(typeof record?.projectSlug === 'string' && record.projectSlug
      ? { projectSlug: record.projectSlug }
      : {}),
    ...(typeof record?.conversationId === 'string' && record.conversationId
      ? { conversationId: record.conversationId }
      : {}),
    ...(verified.tenantExecutionContext
      ? { tenant: verified.tenantExecutionContext }
      : {}),
  });
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
 */
export function resolveStationControlCallerForRequest(
  request: Request,
  resolveRecord?: StationControlCallerRecordResolver,
): StationControlCaller | null {
  if (getRuntimeAuthenticatedRequestPrincipal(request)?.kind !== 'internal')
    return null;
  const token = request.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER);
  if (!token) return null;
  const caller = resolveStationControlCallerFromToken(token, resolveRecord);
  if (!caller) return null;
  const requestTenant =
    request.headers.get(INTERNAL_TENANT_HEADER) || undefined;
  if ((caller.tenant?.tenantId ?? undefined) !== requestTenant) return null;
  return caller;
}

/** The REST projection: tenant context is never a public payload field. */
export function stationControlCallerProjection(
  caller: StationControlCaller,
): Omit<StationControlCaller, 'tenant'> {
  return {
    sessionId: caller.sessionId,
    ...(caller.principal ? { principal: caller.principal } : {}),
    ...(caller.projectSlug ? { projectSlug: caller.projectSlug } : {}),
    ...(caller.conversationId ? { conversationId: caller.conversationId } : {}),
  };
}
