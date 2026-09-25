/**
 * K5 Neo4j graph-view routes — thin delegations onto
 * `../knowledge-store/neo4j-graph-sync.ts` (sync) and
 * `../knowledge-store/neo4j-graph-provider.ts` (`readGraph`/`shortestPath`),
 * completing `s203-knowledge-meeting-notes--plan.md`'s Wave 1 Task 1 (the Q1-
 * ratified "Graph view, synced" scope). A deliberate SIBLING file to
 * `knowledge-record-routes.ts` rather than an extension of it: that file's own
 * `GET /roots/:rootId/graph` doc comment explicitly defers "wiring a Neo4j-backed
 * root's graph read" to "whichever task lands `runtime-routes.ts`'s final wiring
 * decision" — this file is that wiring, kept file-disjoint from the already-landed
 * Task 2 route module rather than risking a diff against its existing (already
 * green) test suite. `knowledge-record-routes.ts`'s `/graph` route stays
 * file-adapter-only and unchanged; these routes are the explicit Neo4j-backed
 * equivalent, addressed at a distinct sub-path so a caller (a future recall-UI
 * task) chooses per-root which backend to query, rather than this route silently
 * guessing.
 *
 * Mounted at the same `/api/knowledge` base as every other knowledge route family
 * (`knowledge-store-routes.ts`/`knowledge-index-routes.ts`/
 * `knowledge-record-routes.ts`), at `/roots/:rootId/graph/neo4j*` — a sub-path of
 * the existing file-based `/roots/:rootId/graph`, so there is no collision with
 * any route mounted at that same base today.
 *
 * Configuration gating (per this module's remit — "follow how the K2 stub expected
 * configuration"): a single, global, opt-in connection
 * (`getNeo4jGraphViewConnection()` — `../knowledge-store/neo4j-connection.ts`), not
 * a per-root setting. When no connection is registered, or the lazy real-driver
 * load fails (package unavailable / construction failure), every route in this file
 * returns an honest `503` naming the reason — never a crash, never a silent empty
 * success (the same posture `neo4j-connection.ts`'s own stub already established).
 * An invalid request shape (`rootId`, `fromId`/`toId`) is a `400`, checked before
 * any connection/driver work.
 *
 * Path-safety (SEC-1, Wave 1 precedent — mirrors `knowledge-record-routes.ts`'s
 * `isSafePathSegment` guard on every id-shaped input): `rootId` gets the same
 * defensive shape/length check `knowledge-index-routes.ts`/
 * `knowledge-record-routes.ts` already apply (it never reaches a filesystem path —
 * the store resolves roots by registry id). `fromId`/`toId` are Kit record ids —
 * they reach Neo4j as Cypher query PARAMETERS (never string-interpolated into the
 * query text), so they carry no Cypher-injection risk the way a raw path join
 * would carry a traversal risk; they still get the same `isSafePathSegment` check
 * as a defense-in-depth consistency measure, matching every other route file's
 * treatment of an id-shaped value in this plan.
 */

import { Hono } from 'hono';
import { isSafePathSegment } from '../../knowledge-index/path-safety.js';
import type { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import {
  getNeo4jGraphViewConnection,
  type Neo4jGraphViewConnectionConfig,
} from '../../knowledge-store/neo4j-connection.js';
import {
  createNeo4jDriver,
  type Neo4jDriverLoadResult,
  type ReadGraphResult,
  readGraph,
  type ShortestPathResult,
  shortestPath,
} from '../../knowledge-store/neo4j-graph-provider.js';
import { syncRootToNeo4j } from '../../knowledge-store/neo4j-graph-sync.js';
import {
  KNOWLEDGE_ROOT_NOT_FOUND_ERROR,
  knowledgeRootReadKind,
  SESSION_BACKED_BUILD_FORBIDDEN_ERROR,
} from '../../knowledge-store/session-backed-roots.js';
import { errorMessage } from '../schemas/schemas.js';

interface Neo4jGraphRouteDeps {
  store: KnowledgeStoreProvider;
  /** Re-checked per request — never captured once at route-construction time —
   * same "connection may change after startup" discipline
   * `knowledge-index-routes.ts`'s `getEmbedder` already established. Defaults to
   * `getNeo4jGraphViewConnection`. */
  getConnection?: () => Neo4jGraphViewConnectionConfig | null;
  /** Defaults to the lazy real-driver loader (`createNeo4jDriver`); tests inject a
   * fake-driver-returning function instead. */
  resolveDriver?: (
    config: Neo4jGraphViewConnectionConfig,
  ) => Promise<Neo4jDriverLoadResult>;
  /**
   * Runs a sync as the Station's own background reader, never as the caller:
   * the projected graph is shared, and every read below re-checks each
   * session-backed node for its own caller. Defaults to running as-is.
   */
  runAsIndexer?: <T>(build: () => Promise<T>) => Promise<T>;
  /**
   * Whether this request may sync a session-backed (conversation-store)
   * root: only the local operator. Absent, no request may.
   */
  mayBuildSessionBackedRoot?: (request: Request) => boolean;
}

/** Most hops a shortest path may take; the same bound the Cypher query uses. */
const MAX_PATH_HOPS = 15;

/**
 * The part of a synced graph this request may see. A session-backed root's
 * projection was built by the Station indexer from ALL sessions, so each node
 * is re-checked for this caller before it is shown (as `/index/search`
 * re-reads every hit), and a node the caller cannot read is dropped along
 * with every edge touching it. The adapter answers readability cheaply when
 * it can (no transcript load); otherwise each node is read. Other roots'
 * records are not per-caller, so their graphs pass through unchanged.
 */
async function readableGraph(
  store: KnowledgeStoreProvider,
  rootId: string,
  kind: 'shared' | 'session-backed',
  graph: ReadGraphResult,
): Promise<ReadGraphResult> {
  if (kind === 'shared') return graph;
  const adapter = (await store.adapterFor(rootId)) as Awaited<
    ReturnType<KnowledgeStoreProvider['adapterFor']>
  > & { readableIds?: (ids: readonly string[]) => Promise<Set<string>> };
  const ids = graph.nodes.map((node) => node.id);
  let readable: Set<string>;
  if (adapter.readableIds) {
    readable = await adapter.readableIds(ids);
  } else {
    readable = new Set<string>();
    for (const id of ids) if (await adapter.get(id)) readable.add(id);
  }
  return {
    nodes: graph.nodes.filter((node) => readable.has(node.id)),
    edges: graph.edges.filter(
      (edge) => readable.has(edge.source) && readable.has(edge.target),
    ),
  };
}

/**
 * Breadth-first shortest path over an already reader-filtered graph, with
 * links followed in either direction like the Cypher query. Computed here so
 * a path can never route through, or reveal, a node the caller cannot read.
 */
function shortestReadablePath(
  graph: ReadGraphResult,
  fromId: string,
  toId: string,
): ShortestPathResult | null {
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (!ids.has(fromId) || !ids.has(toId)) return null;
  const neighbours = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const list = neighbours.get(from);
    if (list) list.push(to);
    else neighbours.set(from, [to]);
  };
  for (const edge of graph.edges) {
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  const previous = new Map<string, string | null>([[fromId, null]]);
  let frontier = [fromId];
  for (let hops = 0; frontier.length > 0 && hops <= MAX_PATH_HOPS; hops++) {
    if (previous.has(toId)) break;
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of neighbours.get(id) ?? []) {
        if (previous.has(neighbour)) continue;
        previous.set(neighbour, id);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  if (!previous.has(toId)) return null;
  const nodeIds: string[] = [];
  for (let id: string | null = toId; id !== null; id = previous.get(id)!) {
    nodeIds.unshift(id);
  }
  if (nodeIds.length - 1 > MAX_PATH_HOPS) return null;
  return { nodeIds, length: nodeIds.length - 1 };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching control characters to reject them from rootId (mirrors knowledge-record-routes.ts)
const ROOT_ID_CONTROL_CHAR_PATTERN = /[\x00-\x1f]/;

function isPlausibleRootId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 300 &&
    !ROOT_ID_CONTROL_CHAR_PATTERN.test(value)
  );
}

const NOT_CONFIGURED_ERROR =
  'Neo4j graph-view connection is not configured — register one before syncing or ' +
  'reading the graph view';

export function createNeo4jGraphRoutes(deps: Neo4jGraphRouteDeps) {
  const app = new Hono();
  const getConnection = deps.getConnection ?? getNeo4jGraphViewConnection;
  const resolveDriver = deps.resolveDriver ?? createNeo4jDriver;
  const runAsIndexer =
    deps.runAsIndexer ?? (<T>(build: () => Promise<T>) => build());

  // POST /roots/:rootId/graph/neo4j-sync — idempotent sync trigger.
  app.post('/roots/:rootId/graph/neo4j-sync', async (c) => {
    try {
      const rootId = c.req.param('rootId');
      if (!isPlausibleRootId(rootId)) {
        return c.json({ success: false, error: 'Invalid rootId' }, 400);
      }

      const config = getConnection();
      if (!config) {
        return c.json({ success: false, error: NOT_CONFIGURED_ERROR }, 503);
      }
      const driverResult = await resolveDriver(config);
      if (!driverResult.ok || !driverResult.driver) {
        return c.json(
          {
            success: false,
            error: driverResult.reason ?? 'Neo4j driver unavailable',
          },
          503,
        );
      }

      if (
        !(deps.mayBuildSessionBackedRoot?.(c.req.raw) ?? false) &&
        (await knowledgeRootReadKind(deps.store, rootId)) !== 'shared'
      ) {
        return c.json(
          { success: false, error: SESSION_BACKED_BUILD_FORBIDDEN_ERROR },
          403,
        );
      }
      const driver = driverResult.driver;
      const stats = await runAsIndexer(() =>
        syncRootToNeo4j({
          rootId,
          store: deps.store,
          driver,
          database: config.database,
        }),
      );
      return c.json({ success: true, data: stats });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  // GET /roots/:rootId/graph/neo4j — reads whatever the last sync projected.
  app.get('/roots/:rootId/graph/neo4j', async (c) => {
    try {
      const rootId = c.req.param('rootId');
      if (!isPlausibleRootId(rootId)) {
        return c.json({ success: false, error: 'Invalid rootId' }, 400);
      }

      const config = getConnection();
      if (!config) {
        return c.json({ success: false, error: NOT_CONFIGURED_ERROR }, 503);
      }
      const driverResult = await resolveDriver(config);
      if (!driverResult.ok || !driverResult.driver) {
        return c.json(
          {
            success: false,
            error: driverResult.reason ?? 'Neo4j driver unavailable',
          },
          503,
        );
      }

      // Fail closed: a projection whose root is not (or no longer)
      // registered cannot be checked per caller, so it is never returned.
      const kind = await knowledgeRootReadKind(deps.store, rootId);
      if (kind === 'unavailable') {
        return c.json(
          { success: false, error: KNOWLEDGE_ROOT_NOT_FOUND_ERROR },
          404,
        );
      }
      const graph = await readableGraph(
        deps.store,
        rootId,
        kind,
        await readGraph(driverResult.driver, rootId, {
          database: config.database,
        }),
      );
      return c.json({ success: true, data: graph });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  // GET /roots/:rootId/graph/neo4j/shortest-path?fromId=&toId= — the one
  // structural query this slice ships (Q1 verdict).
  app.get('/roots/:rootId/graph/neo4j/shortest-path', async (c) => {
    try {
      const rootId = c.req.param('rootId');
      if (!isPlausibleRootId(rootId)) {
        return c.json({ success: false, error: 'Invalid rootId' }, 400);
      }
      const fromId = c.req.query('fromId');
      const toId = c.req.query('toId');
      if (!isSafePathSegment(fromId)) {
        return c.json({ success: false, error: 'Invalid fromId' }, 400);
      }
      if (!isSafePathSegment(toId)) {
        return c.json({ success: false, error: 'Invalid toId' }, 400);
      }

      const config = getConnection();
      if (!config) {
        return c.json({ success: false, error: NOT_CONFIGURED_ERROR }, 503);
      }
      const driverResult = await resolveDriver(config);
      if (!driverResult.ok || !driverResult.driver) {
        return c.json(
          {
            success: false,
            error: driverResult.reason ?? 'Neo4j driver unavailable',
          },
          503,
        );
      }

      const kind = await knowledgeRootReadKind(deps.store, rootId);
      if (kind === 'unavailable') {
        return c.json(
          { success: false, error: KNOWLEDGE_ROOT_NOT_FOUND_ERROR },
          404,
        );
      }
      const path =
        kind === 'session-backed'
          ? shortestReadablePath(
              await readableGraph(
                deps.store,
                rootId,
                kind,
                await readGraph(driverResult.driver, rootId, {
                  database: config.database,
                }),
              ),
              fromId,
              toId,
            )
          : await shortestPath(driverResult.driver, rootId, fromId, toId, {
              database: config.database,
            });
      return c.json({ success: true, data: path });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  return app;
}
