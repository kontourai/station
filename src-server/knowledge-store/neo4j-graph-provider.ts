/**
 * Neo4j read surface — `readGraph(rootId)` + `shortestPath(rootId, fromId, toId)`,
 * the ONLY two structural queries this slice ships. Per the Q1-ratified scope
 * recorded in `s203-knowledge-meeting-notes--pull-work.md` ("Graph view, synced")
 * and `s203-knowledge-meeting-notes--plan.md`'s Wave 1 Task 1: `transitiveBlockers`/
 * `contradictionCandidates`/`orphans`/`duplicateCandidates` are named-deferred, K6+
 * follow-up scope — intentionally NOT built here, not silently dropped.
 *
 * These functions read whatever `./neo4j-graph-sync.ts`'s `syncRootToNeo4j` last
 * projected into Neo4j for a root; this module never touches the file-adapter store
 * itself and never imports `neo4j-driver`'s real client eagerly (see
 * `createNeo4jDriver`, below).
 *
 * Driver-injectable: every function takes a `Neo4jDriverLike` — either a real
 * `neo4j-driver` driver (`createNeo4jDriver`) or `__tests__/fake-neo4j-driver.ts`'s
 * in-memory double. Both shapes satisfy the same minimal `session().run(cypher,
 * params)` contract a real `neo4j-driver` session already exposes, so no adapter
 * layer is needed between the fake and this module's query functions.
 *
 * Lazy, guarded real-driver loading: `createNeo4jDriver` is the ONLY place in this
 * module (or `./neo4j-graph-sync.ts`) that ever imports the real `neo4j-driver`
 * package, and it does so via a dynamic `import('neo4j-driver')` inside a
 * try/catch — a Station install where that package fails to resolve (or any future
 * environment where its native/optional pieces don't load) degrades to an honest
 * `{ok: false, reason}` result instead of crashing the server at module-load time.
 * This mirrors `./neo4j-connection.ts`'s own documented degrade posture (K2's
 * "TCP-reachable, but not verifiable" stance — never overclaim, never throw for an
 * absent/unreachable dependency).
 */
import type { Neo4jGraphViewConnectionConfig } from './neo4j-connection.js';

// ── Driver contract (never the Kit's own driver/session types — Station-owned,
//    minimal, structurally compatible with both `neo4j-driver`'s real session
//    and the fake test double) ────────────────────────────────────────────────

export interface Neo4jRunResult {
  records: Array<{ get(key: string): unknown }>;
}

export interface Neo4jSessionLike {
  run(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<Neo4jRunResult>;
  close(): Promise<void>;
}

export interface Neo4jDriverLike {
  session(config?: { database?: string }): Neo4jSessionLike;
  close(): Promise<void>;
}

// ── Named queries (fixed set — no dynamic Cypher construction from user input) ──

export const NEO4J_GRAPH_QUERIES = {
  readNodes:
    'MATCH (n:KitRecord {rootId: $rootId}) ' +
    'RETURN n.recordId AS id, n.type AS type, n.title AS title, n.category AS category',
  readEdges:
    'MATCH (s:KitRecord {rootId: $rootId})-[r:LINKS_TO]->(t:KitRecord {rootId: $rootId}) ' +
    'RETURN s.recordId AS source, t.recordId AS target, r.kind AS kind, r.label AS label',
  // Bounded to 15 hops so a pathological graph can't make this query run away —
  // generous for a demo-scale knowledge graph, and an honest `null` (not a throw)
  // is still returned when no path exists within that bound.
  shortestPath:
    'MATCH (from:KitRecord {rootId: $rootId, recordId: $fromId}), ' +
    '(to:KitRecord {rootId: $rootId, recordId: $toId}) ' +
    'MATCH p = shortestPath((from)-[:LINKS_TO*..15]-(to)) ' +
    'RETURN [node IN nodes(p) | node.recordId] AS nodeIds, length(p) AS pathLength',
} as const;

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  category: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  label?: string;
}

export interface ReadGraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ShortestPathResult {
  nodeIds: string[];
  length: number;
}

export interface Neo4jQueryOptions {
  database?: string;
}

/** `{nodes, edges}` for a root's synced graph — enough for the wikilink pane.
 * An empty/never-synced root returns `{nodes: [], edges: []}`, never a throw. */
export async function readGraph(
  driver: Neo4jDriverLike,
  rootId: string,
  options?: Neo4jQueryOptions,
): Promise<ReadGraphResult> {
  const session = driver.session({ database: options?.database });
  try {
    const nodeResult = await session.run(NEO4J_GRAPH_QUERIES.readNodes, {
      rootId,
    });
    const edgeResult = await session.run(NEO4J_GRAPH_QUERIES.readEdges, {
      rootId,
    });
    const nodes: GraphNode[] = nodeResult.records.map((r) => ({
      id: r.get('id') as string,
      type: r.get('type') as string,
      title: r.get('title') as string,
      category: r.get('category') as string,
    }));
    const edges: GraphEdge[] = edgeResult.records.map((r) => ({
      source: r.get('source') as string,
      target: r.get('target') as string,
      kind: r.get('kind') as string,
      label: (r.get('label') as string | null | undefined) ?? undefined,
    }));
    return { nodes, edges };
  } finally {
    await session.close();
  }
}

/**
 * The provenance-chain query (raw transcript -> compiled note, and the general
 * case). Returns `null` — never throws — when either endpoint is missing from the
 * synced graph or no path connects them within the bound above; this is the
 * expected, common "no path" outcome, not an error.
 */
export async function shortestPath(
  driver: Neo4jDriverLike,
  rootId: string,
  fromId: string,
  toId: string,
  options?: Neo4jQueryOptions,
): Promise<ShortestPathResult | null> {
  const session = driver.session({ database: options?.database });
  try {
    const result = await session.run(NEO4J_GRAPH_QUERIES.shortestPath, {
      rootId,
      fromId,
      toId,
    });
    if (result.records.length === 0) return null;
    const nodeIds = result.records[0].get('nodeIds') as string[];
    const length = result.records[0].get('pathLength') as number;
    return { nodeIds, length };
  } finally {
    await session.close();
  }
}

// ── Lazy, guarded real-driver loading ────────────────────────────────────────

export interface Neo4jDriverLoadResult {
  ok: boolean;
  driver?: Neo4jDriverLike;
  reason?: string;
}

/**
 * Constructs a real `neo4j-driver` driver for `config`, never throwing: an absent
 * `uri`, a failed dynamic import (package missing/broken), or a driver-construction
 * failure all resolve to `{ok: false, reason}` — the honest "neo4j unavailable"
 * degrade state this module's doc comment promises, mirroring
 * `./neo4j-connection.ts`'s `validateNeo4jGraphViewConnection` posture.
 *
 * `neo4j-driver` is imported dynamically (not at module top-level) specifically so
 * that importing this module — e.g. from the fake-driver contract-suite tests,
 * which never call this function — never requires the real package to be
 * resolvable, and so that a real package's own module-load side effects (socket/
 * native bindings) never run unless a caller actually asks for a live driver.
 */
export async function createNeo4jDriver(
  config: Neo4jGraphViewConnectionConfig,
): Promise<Neo4jDriverLoadResult> {
  if (!config.uri) {
    return { ok: false, reason: 'not configured' };
  }

  let neo4jModule: typeof import('neo4j-driver');
  try {
    neo4jModule = await import('neo4j-driver');
  } catch (err) {
    return {
      ok: false,
      reason: `neo4j-driver package unavailable: ${(err as Error).message}`,
    };
  }

  try {
    const auth = config.username
      ? neo4jModule.auth.basic(config.username, config.password ?? '')
      : undefined;
    const driver = neo4jModule.driver(config.uri, auth);
    // A real `neo4j-driver` `Driver` satisfies `Neo4jDriverLike` structurally:
    // `.session()` returns an object whose `.run(cypher, params)` resolves
    // `{records}`, where each record exposes `.get(key)` — unchanged across
    // neo4j-driver 5 and 6, which is the range this module supports.
    return { ok: true, driver: driver as unknown as Neo4jDriverLike };
  } catch (err) {
    return {
      ok: false,
      reason: `failed to construct Neo4j driver: ${(err as Error).message}`,
    };
  }
}
