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
  readGraph,
  shortestPath,
} from '../../knowledge-store/neo4j-graph-provider.js';
import { syncRootToNeo4j } from '../../knowledge-store/neo4j-graph-sync.js';
import { errorMessage } from '../schemas/schemas.js';

export interface Neo4jGraphRouteDeps {
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

      const stats = await syncRootToNeo4j({
        rootId,
        store: deps.store,
        driver: driverResult.driver,
        database: config.database,
      });
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

      const graph = await readGraph(driverResult.driver, rootId, {
        database: config.database,
      });
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

      const path = await shortestPath(
        driverResult.driver,
        rootId,
        fromId,
        toId,
        {
          database: config.database,
        },
      );
      return c.json({ success: true, data: path });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  return app;
}
