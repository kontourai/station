/**
 * Process-local Neo4j graph-view configuration, separate from canonical stores.
 * Registration is not persisted and must be repeated after restart.
 * validateNeo4jGraphViewConnection checks TCP reachability, not authentication
 * or Cypher. There is no generic query function; fixed-query reads and sync
 * live in neo4j-graph-provider.ts and neo4j-graph-sync.ts.
 */
import { createConnection } from 'node:net';

/** Bolt default port (Neo4j's own documented default) — used when a URI omits one. */
const DEFAULT_BOLT_PORT = 7687;

/** Default TCP-probe timeout for `validateNeo4jGraphViewConnection`. */
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

export interface Neo4jGraphViewConnectionConfig {
  /** e.g. `neo4j://host:7687`, `bolt://host:7687`, `neo4j+s://host:7687`. */
  uri: string;
  database?: string;
  username?: string;
  /**
   * K5 evolution (`s203-knowledge-meeting-notes--plan.md` Wave 1 Task 1): K2's
   * original doc comment on this interface deliberately deferred credential
   * modeling — "belongs to whichever wave adds a real driver-backed client
   * (K5)". That wave is this one (`./neo4j-graph-sync.ts` /
   * `./neo4j-graph-provider.ts`'s `createNeo4jDriver`), so `password` is added
   * here, optional and only ever read by the real-driver factory — never by
   * this file's own registration/reachability/query-stub surface, which is
   * otherwise unchanged.
   */
  password?: string;
}

interface Neo4jReachabilityResult {
  ok: boolean;
  reason: string;
}

// ── Registration plumbing (module-level, mirrors connection-factories.ts's
//    registry shape) ─────────────────────────────────────────────────────────────

let registeredConnection: Neo4jGraphViewConnectionConfig | null = null;

/** Register (or replace) the active Neo4j graph-view connection config. */
export function registerNeo4jGraphViewConnection(
  config: Neo4jGraphViewConnectionConfig,
): void {
  registeredConnection = config;
}

/** The currently registered connection config, or `null` if none is configured. */
export function getNeo4jGraphViewConnection(): Neo4jGraphViewConnectionConfig | null {
  return registeredConnection;
}

/** Deregister the active connection (test/reset use). */
export function clearNeo4jGraphViewConnection(): void {
  registeredConnection = null;
}

// ── Reachability (K4 onboarding hook) ───────────────────────────────────────────

function parseBoltHostPort(uri: string): { host: string; port: number } {
  const parsed = new URL(uri);
  if (!parsed.hostname) {
    throw new Error(`missing host in URI: ${uri}`);
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : DEFAULT_BOLT_PORT,
  };
}

function tcpProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * K4's onboarding hook (this module's equivalent of an adapter's `validateRoot`,
 * named for what it actually checks — a connection, not a store root). Never
 * throws; always returns an honest `{ok, reason}` shape, including the
 * not-verifiable-without-a-driver case:
 *
 * - No config / empty `uri` → `{ok: false, reason: 'not configured'}`.
 * - Malformed `uri` → `{ok: false, reason: 'invalid Neo4j URI: ...'}`.
 * - No daemon accepts a TCP connection within `timeoutMs` → `{ok: false, reason:
 *   'not reachable: ...'}` — this is the expected, common result in K2 (no live
 *   Neo4j daemon dependency anywhere in this repo).
 * - A TCP connection succeeds → still `{ok: false, reason: 'TCP-reachable, but not
 *   verifiable...'}`, NOT `{ok: true}` — K2 ships no bolt driver, so a successful
 *   TCP handshake only proves *something* is listening on that host:port, not that
 *   it is actually a live Neo4j daemon speaking the bolt protocol. Overclaiming
 *   `ok: true` here would be exactly the "silently returning empty success" failure
 *   mode this plan explicitly rejects (see the plan's Wave 3 acceptance criteria).
 *   A real reachability/health verdict is K5's dual-adapter dogfood scope, once a
 *   real driver exists.
 */
export async function validateNeo4jGraphViewConnection(
  config: Neo4jGraphViewConnectionConfig | null,
  options?: { timeoutMs?: number },
): Promise<Neo4jReachabilityResult> {
  if (!config?.uri) {
    return { ok: false, reason: 'not configured' };
  }

  let host: string;
  let port: number;
  try {
    ({ host, port } = parseBoltHostPort(config.uri));
  } catch (err) {
    return {
      ok: false,
      reason: `invalid Neo4j URI: ${(err as Error).message}`,
    };
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const reachable = await tcpProbe(host, port, timeoutMs);
  if (!reachable) {
    return {
      ok: false,
      reason:
        `not reachable: no daemon accepted a TCP connection at ${host}:${port} ` +
        `within ${timeoutMs}ms (K2 is registration-only — this is expected when no ` +
        'live Neo4j daemon is running)',
    };
  }

  return {
    ok: false,
    reason:
      `TCP-reachable at ${host}:${port}, but not verifiable as a live Neo4j/bolt ` +
      'daemon without a driver — K2 ships registration only; a full bolt-protocol ' +
      'handshake/health-check is K5 dual-adapter dogfood scope',
  };
}
