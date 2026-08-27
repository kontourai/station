/**
 * Neo4j opt-in GRAPH-VIEW connection — registration-only stub (K2 Wave 3).
 *
 * Per `docs/design/knowledge-foundation.md`'s K2 section: "The Kit's Neo4j provider is
 * NOT a `KnowledgeStoreAdapter` (it is a read-side materialized graph view synced
 * FROM stores... Surface it as an opt-in connection on the graph-query axis for K5's
 * dogfood, not as a root's adapter." This module therefore does NOT touch
 * `KnowledgeStoreAdapter`/`KnowledgeStoreProvider`/`registerAdapter` at all — it is a
 * standalone, additive connection-type registration mirroring
 * `resolveRuntimeVectorDbProvider`/`resolveRuntimeEmbeddingProvider`'s
 * `findRuntimeCapabilityConnection` shape (`runtime-provider-resolution.ts`), scaled
 * down to what K2 actually ships.
 *
 * **Deviation note (Wave 3 disposition):** the delegated task description for this
 * wave used `KnowledgeAdapterDescriptor`/`validateRoot` vocabulary when describing
 * this stub. That vocabulary is the shape used by `kit-default-store`/
 * `kit-obsidian-store` (both real store adapters — see `knowledge-store-provider.ts`),
 * and registering Neo4j through that exact mechanism would contradict the plan's own
 * explicit, researched design decision (`s200-knowledge-store--plan.md`'s Wave 3 task
 * + this file's own design-doc citation above: "Neo4j is not an adapter"). Following
 * the plan (the authoritative, cross-checked design artifact) over the task
 * description's shorthand: this module ships an equivalent-in-spirit but
 * connection-shaped surface — `registerNeo4jGraphViewConnection`/
 * `getNeo4jGraphViewConnection` (the "descriptor surfaces in the registry" ask, via a
 * connection registry rather than the adapter registry) and
 * `validateNeo4jGraphViewConnection` (the "validateRoot"-equivalent K4 onboarding
 * hook, named for what it actually validates — a connection, not a store root).
 *
 * K2 ships ONLY: the connection-config shape, this registration plumbing, a
 * best-effort TCP-reachability check (no Neo4j driver, no bolt handshake — see
 * `validateNeo4jGraphViewConnection`'s doc comment for exactly what it can and
 * cannot honestly verify), and an honest `{ok: false, reason}` stub for any query
 * call. No actual graph-sync client — that is K5's dual-adapter dogfood scope
 * (`docs/design/knowledge-foundation.md`'s "K5 hooks" section). No live Neo4j daemon
 * dependency exists anywhere in this module's unit tests; the one live-reachability
 * assertion lives behind an explicit env-guard
 * (`KNOWLEDGE_NEO4J_TEST_URL`) in `neo4j-connection.test.ts` and is skipped — not
 * silently passed — when unset, per this plan's own documented pattern for Kit-style
 * "Docker-based live integration, run locally" tests.
 *
 * **K5 landed (`s203-knowledge-meeting-notes--plan.md` Wave 1 Task 1, Q1 ratified
 * scope "Graph view, synced"):** the graph-sync client this doc comment names above
 * is now `./neo4j-graph-sync.ts` (idempotent MERGE-guarded projection of a root's
 * records+links into Neo4j) and `./neo4j-graph-provider.ts` (`readGraph`/
 * `shortestPath`, plus the lazy real-driver loader, `createNeo4jDriver`). Both
 * consume `getNeo4jGraphViewConnection()` for config and take a `Neo4jDriverLike`
 * (real `neo4j-driver` or a fake test double) for execution — this file's own
 * registration/reachability/`queryNeo4jGraphView` surface is otherwise unchanged;
 * `queryNeo4jGraphView`'s generic single-cypher-string stub is deliberately NOT
 * reused by the new modules (they issue their own small, fixed set of named
 * queries instead of routing through one generic entrypoint) and remains exactly
 * the honest no-op it always was.
 */
import { createConnection } from 'node:net';

export const NEO4J_GRAPH_VIEW_CONNECTION_TYPE = 'neo4j-graph-view' as const;

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

export interface Neo4jReachabilityResult {
  ok: boolean;
  reason: string;
}

export interface Neo4jGraphQueryResult {
  // K2 never returns `ok: true` for an actual query — it ships no query client.
  ok: false;
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

// ── Query stub ───────────────────────────────────────────────────────────────────

/**
 * Honest no-op query surface: K2 ships no graph-sync client, so every call returns
 * `{ok: false, reason}` naming exactly why — never throws, never silently returns
 * an empty success result (the "silently returning empty success" failure mode the
 * plan explicitly calls out and rejects).
 */
export async function queryNeo4jGraphView(
  config: Neo4jGraphViewConnectionConfig | null,
  _cypher: string,
): Promise<Neo4jGraphQueryResult> {
  if (!config?.uri) {
    return { ok: false, reason: 'not configured' };
  }
  return {
    ok: false,
    reason:
      'not implemented: K2 registers the Neo4j graph-view connection surface only ' +
      '(config shape + reachability check) — a real bolt-driver query client is ' +
      "K5's dual-adapter dogfood scope (docs/design/knowledge-foundation.md, " +
      '"K5 hooks")',
  };
}
