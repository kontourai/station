/**
 * archive#1195 (epic archive#1191 slice C): the built-in `station-control` MCP
 * server, ALSO reachable over streamable-HTTP — the wire-safe delivery
 * surface for an external engine that manages its own outbound MCP
 * connections (Codex's `codex app-server`; see `DeliveryChannel`'s doc
 * comment in `packages/contracts/src/engine-capability-matrix.ts`). Station
 * already runs station-control as a stdio child for its own engine and for
 * Claude (see `station-control-server.ts`, `mcp-manager.ts`,
 * `claude-mcp-passthrough.ts`) — this route reuses the EXACT SAME tool
 * registrations (`registerAgentTools`/`registerCatalogTools`/
 * `registerOperationsTools`/`registerPlatformTools`), just connected via a
 * different MCP transport, so there is exactly one implementation of every
 * station-control tool.
 *
 * Auth is a per-session, short-lived, station-control-scoped bearer token
 * (`station-control-mcp-token.ts`) presented in the URL's `token` query
 * parameter (or an `Authorization: Bearer` header) — NEVER the process-wide
 * `INTERNAL_API_TOKEN` (that stays a subprocess-only mechanism; see
 * `station-control-runtime-env.ts`'s header comment) and NEVER env. This
 * route is registered OUTSIDE `configureRuntimeHttp`'s general
 * CORS/pairing-credential security middleware (mirrors
 * `configureRuntimePublicRoutes`/`configureDevicePairingPublicRoutes`'s own
 * registration-order comment) — that middleware's `hasCredentialQuery`
 * guard actively REJECTS any request carrying a credential-shaped query
 * value, which would otherwise reject this endpoint's entire auth
 * mechanism outright. This route has its OWN bespoke auth (the token check
 * below) plus a loopback-only guard (defense in depth: the only legitimate
 * caller is Station's own spawned Codex child, always 127.0.0.1).
 *
 * The token is never logged: only the auth outcome (accepted/rejected) and
 * a loopback-denied count are recorded via OTel counters, never the
 * candidate value itself.
 *
 * Review fix (archive#1195 round 1, MEDIUM): the station-control tool
 * implementations resolve their own API base via
 * `resolveControlApiBase()` (station-control-shared.ts), which falls back
 * to `process.env.STATION_PORT || process.env.PORT || DEFAULT_SERVER_PORT`
 * when `STATION_API_BASE` isn't set. That fallback chain is correct for a
 * freshly-spawned stdio child (its env is set fresh, before spawn, from
 * THIS instance's real port — see `stationControlSpawnEnv`), but Station's
 * OWN process never sets `PORT`/`STATION_PORT` on itself — and on the
 * desktop-spawner's `PORT=0`/`STATION_PORT_MODE=auto` path (`index.ts`),
 * the actually-bound port is resolved into a local variable and likewise
 * never written back to `process.env.PORT`. Left alone, a tool call routed
 * through this in-process route would resolve against the wrong port
 * (`DEFAULT_SERVER_PORT`, 3141) whenever this instance isn't actually bound
 * to that port — fails closed (connection refused), not a security
 * bypass, but broken. Fixed by requiring the caller (`runtime-routes.ts`,
 * which already threads `context.port` — this instance's real bound port —
 * to every other route factory) to pass it here too, and setting
 * `process.env.STATION_API_BASE`/`STATION_PORT` explicitly and
 * deterministically from it before every request — `STATION_API_BASE` is
 * `resolveControlApiBase()`'s highest-priority branch, so this is
 * correct regardless of what `PORT`/`STATION_PORT` happen to hold. The
 * value is identical on every call (this instance's own port never
 * changes), so repeatedly setting it is race-free under concurrent
 * requests — this is deliberately NOT a request-scoped override.
 */

import { createHash } from 'node:crypto';
import {
  type HostedTenantRegistry,
  tenantExecutionContextFromSession,
} from '@kontourai/station-contracts/tenancy';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { stationControlSpawnEnv } from '../../runtime/bootstrap/station-control-runtime-env.js';
import {
  STATION_CONTROL_MCP_PATH,
  verifyStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import {
  stationControlMcpHttpAuth,
  tenantExecutionContextAttributes,
  tenantExecutionContextOutcomes,
} from '../../telemetry/metrics.js';
import { createStationControlMcpServer } from '../../tools/station-control-mcp-server.js';
import {
  withStationControlCallerBinding,
  withStationControlExecutionContext,
} from '../../tools/station-control-shared.js';

export { STATION_CONTROL_MCP_PATH };

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (typeof address !== 'string') return false;
  const normalized = address.trim().toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('::ffff:127.')
  );
}

function extractRemoteAddress(env: unknown): string | undefined {
  if (!env || typeof env !== 'object') return undefined;
  const incoming = (env as { incoming?: unknown }).incoming;
  if (!incoming || typeof incoming !== 'object') return undefined;
  const socket = (incoming as { socket?: unknown }).socket;
  if (!socket || typeof socket !== 'object') return undefined;
  const address = (socket as { remoteAddress?: unknown }).remoteAddress;
  return typeof address === 'string' ? address : undefined;
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match?.[1];
}

export interface StationControlMcpRouteOptions {
  /** THIS running instance's actually-bound HTTP port — never read from
   * `process.env.PORT`/`STATION_PORT` (see this module's header comment
   * for why those are unreliable). Required so the in-process tool calls
   * this route makes reach the right port even under `PORT=0`/
   * `STATION_PORT_MODE=auto`. */
  port: number;
  /** When configured, only registry-valid tenant-bound MCP tokens are accepted. */
  hostedTenantRegistry?: HostedTenantRegistry;
}

/** Build the isolated Hono sub-app. Exported for unit tests (`app.request`). */
export function createStationControlMcpRoutes(
  options: StationControlMcpRouteOptions,
): Hono {
  const app = new Hono();
  const handler = createMcpHandler(createStationControlMcpServer, {
    legacy: 'stateless',
    responseMode: 'auto',
  });

  app.all(STATION_CONTROL_MCP_PATH, async (c) => {
    if (!isLoopbackRemoteAddress(extractRemoteAddress(c.env))) {
      stationControlMcpHttpAuth.add(1, { result: 'loopback_denied' });
      return c.text('Not found', 404, SECURITY_HEADERS);
    }

    const url = new URL(c.req.url);
    const candidate =
      url.searchParams.get('token') ??
      extractBearerToken(c.req.header('authorization'));
    const verified = verifyStationControlMcpToken(candidate);
    if (!verified) {
      stationControlMcpHttpAuth.add(1, { result: 'rejected' });
      tenantExecutionContextOutcomes.add(
        1,
        tenantExecutionContextAttributes({
          operation: 'station_control',
          source: 'none',
          outcome: 'rejected',
          reason: 'missing',
        }),
      );
      return c.text('Unauthorized', 401, SECURITY_HEADERS);
    }
    const tenantExecutionContext = verified.tenantExecutionContext;
    if (
      options.hostedTenantRegistry &&
      (!tenantExecutionContext ||
        !options.hostedTenantRegistry.tenants.some(
          (tenant) => tenant.id === tenantExecutionContext.tenantId,
        ))
    ) {
      stationControlMcpHttpAuth.add(1, { result: 'tenant_context_rejected' });
      tenantExecutionContextOutcomes.add(
        1,
        tenantExecutionContextAttributes({
          operation: 'station_control',
          source: tenantExecutionContext ? 'session' : 'none',
          outcome: 'rejected',
          reason: tenantExecutionContext ? 'unknown' : 'missing',
        }),
      );
      return c.text('Tenant context required', 421, SECURITY_HEADERS);
    }
    stationControlMcpHttpAuth.add(1, { result: 'accepted' });
    tenantExecutionContextOutcomes.add(
      1,
      tenantExecutionContextAttributes({
        operation: 'station_control',
        source: tenantExecutionContext ? 'session' : 'none',
        outcome: 'accepted',
        reason: 'none',
      }),
    );

    // archive#1195 review fix (MEDIUM): deterministic, explicit override —
    // NOT a request-scoped toggle. Every request through this route sets
    // the SAME correct value (this instance's own port), so this can never
    // race a concurrent request the way a set-then-restore pattern would.
    const env = stationControlSpawnEnv(options.port);
    process.env.STATION_API_BASE = env.STATION_API_BASE;
    process.env.STATION_PORT = env.STATION_PORT;

    // The v2 handler classifies every request into the modern 2026-07-28
    // envelope path or the explicit stateless legacy path. Both construct
    // the same server factory, so the two eras cannot drift.
    const callerBinding = createHash('sha256')
      .update(candidate!)
      .digest('base64url');
    const response = await withStationControlExecutionContext(
      tenantExecutionContext
        ? tenantExecutionContextFromSession(tenantExecutionContext)
        : undefined,
      () =>
        withStationControlCallerBinding(
          callerBinding,
          () => handler.fetch(c.req.raw),
          () => {
            const current = verifyStationControlMcpToken(candidate);
            return (
              current !== undefined &&
              current.sessionId === verified.sessionId &&
              JSON.stringify(current.tenantExecutionContext) ===
                JSON.stringify(verified.tenantExecutionContext)
            );
          },
        ),
    );
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      if (!response.headers.has(key)) response.headers.set(key, value);
    }
    return response;
  });

  // No wildcard fallback here (unlike the dedicated, standalone MCP-UI
  // frame origin in mcp-ui-frame-server.ts): this sub-app is composed into
  // Station's shared main app (`context.app.route('/', ...)` in
  // runtime-routes.ts), so a `'*'` catch-all registered here would shadow
  // every other route mounted after it in the shared app's dispatch order.
  // An unmatched path here correctly falls through to the main app's own
  // routing/404 handling.

  return app;
}
