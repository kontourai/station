/**
 * K3 index-management routes — explicit, user/CLI-triggered rebuild + migration
 * verbs (`docs/design/knowledge-foundation.md`'s K3 section). These are the DRY
 * operation surface both the CLI (`station knowledge reindex`/`migrate`, Wave 4)
 * and station-control tool wiring (Wave 4) call through — never re-implemented
 * inline elsewhere. Neither route is ever invoked automatically on startup; both
 * require an explicit HTTP call.
 *
 * Dependency resolution mirrors `knowledge.ts`'s existing convention (services
 * passed in at route-creation time), with one deliberate deviation: the embedder
 * is injected as a `getEmbedder()` getter, not a resolved value, because the
 * active embedding *connection* can change after the server starts (a user may
 * add/enable/disable a provider connection at runtime) — capturing a snapshot at
 * route-construction time would silently go stale, echoing the
 * capture-by-value trap `configureRoutes` has hit before (archive#208/#210/#212).
 * `store` and `indexProvider`, by contrast, are long-lived instances constructed
 * once at startup and never reassigned afterward, so passing them directly (the
 * same way `providerService`/`projectService`/etc. are passed elsewhere in this
 * file family) is safe.
 *
 * Input validation (SEC-1): a caller-supplied `projectSlug` reaches
 * `migratePreIndexKnowledge`'s filesystem joins (both read and write side — see
 * `../knowledge-index/path-safety.ts`'s module doc), so it's validated here
 * BEFORE the module is called, returning 400 rather than letting an invalid
 * value reach a throw deeper in the stack. `rootId` never reaches a filesystem
 * path (the store resolves roots by registry id, not by joining `rootId` into a
 * path), but its shape is still validated defensively.
 *
 * Concurrency (SEC-2): both routes translate a `RebuildInProgressError` (thrown
 * by `SqliteVecIndexProvider.rebuildRoot`'s per-root lock or
 * `migratePreIndexKnowledge`'s global lock) into HTTP 409, distinct from the
 * generic 500 catch-all — a racing second caller gets a clear, actionable
 * "already in progress" response instead of an opaque failure.
 *
 * `s203-knowledge-meeting-notes` Wave 1 Task 2 adds a third verb, `POST
 * /index/search`, closing this plan's other flagged primitive gap: no HTTP route
 * exposed `KnowledgeIndexProvider.search` before this (the only pre-existing
 * `/api/knowledge/search` is the pre-index pre-K2 `KnowledgeService`/`lancedb-file`
 * route in `knowledge-cross-project.ts`, a different subsystem entirely). Same
 * honest-no-embedder 400 convention as `/index/rebuild`/`/migrate`. Every hit is
 * re-resolved against its `KnowledgeStoreAdapter` before it crosses the wire — K3's
 * own "never treat an index hit as the record" rule
 * (`packages/contracts/src/knowledge-index.ts`'s module doc) — a hit whose record no
 * longer resolves (deleted/retired since the index was last built) is dropped, not
 * returned bare.
 */

import type {
  IEmbeddingProvider,
  KnowledgeIndexProvider,
} from '@kontourai/station-contracts/knowledge-index';
import type { KnowledgeStoreProvider } from '@kontourai/station-contracts/knowledge-store';
import { Hono } from 'hono';
import { RebuildInProgressError } from '../../knowledge-index/inflight-guard.js';
import { migratePreIndexKnowledge } from '../../knowledge-index/migrate-pre-index-knowledge.js';
import { isSafePathSegment } from '../../knowledge-index/path-safety.js';
import { errorMessage } from '../schemas/schemas.js';
import { projectKnowledgePersistenceError } from './knowledge-persistence-errors.js';

export interface KnowledgeIndexRouteDeps {
  store: KnowledgeStoreProvider;
  indexProvider: KnowledgeIndexProvider;
  /** Station home dir — the root both pre-index trees and K2 store roots hang off
   * (`migratePreIndexKnowledge`'s `dataDir`). */
  dataDir: string;
  /** Resolved fresh on every request — see module doc. */
  getEmbedder: () => IEmbeddingProvider | null;
}

interface RebuildRootReport {
  rootId: string;
  status: 'ok' | 'error';
  records?: number;
  chunks?: number;
  error?: string;
}

const NO_EMBEDDER_ERROR =
  'No embedding provider connection is configured — enable one before rebuilding or migrating the knowledge index';

// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching control characters to reject them from rootId
const ROOT_ID_CONTROL_CHAR_PATTERN = /[\x00-\x1f]/;

/** A `rootId` never reaches a filesystem path (see module doc), but still must be a
 * plausible, non-empty identifier — reject control characters and absurd lengths. */
function isPlausibleRootId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 300 &&
    !ROOT_ID_CONTROL_CHAR_PATTERN.test(value)
  );
}

interface SearchIndexBody {
  query?: unknown;
  topK?: unknown;
  rootIds?: unknown;
  filter?: unknown;
}

/** `POST /index/search` response entry — always a re-resolved record's own fields
 * (title/category), never a bare `KnowledgeIndexHit` passthrough (module doc). */
interface KnowledgeSearchResult {
  recordId: string;
  rootId: string;
  score: number;
  title: string;
  excerpt: string;
  category: string;
}

const DEFAULT_SEARCH_TOP_K = 10;
const MAX_SEARCH_TOP_K = 50;

function isPlausibleRootIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => isPlausibleRootId(v));
}

function isPlainFilterObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createKnowledgeIndexRoutes(deps: KnowledgeIndexRouteDeps) {
  const app = new Hono();

  // POST /index/rebuild — body: { rootId?: string } (omitted = every registered root).
  // Drops and re-derives the index partition for each targeted root via
  // `indexProvider.rebuildRoot`, which walks the K2 store's records from scratch —
  // never a read from anything the index itself already holds.
  app.post('/index/rebuild', async (c) => {
    try {
      const embedder = deps.getEmbedder();
      if (!embedder) {
        return c.json({ success: false, error: NO_EMBEDDER_ERROR }, 400);
      }

      const body = (await c.req.json().catch(() => ({}))) as {
        rootId?: unknown;
      };
      if (body.rootId !== undefined && !isPlausibleRootId(body.rootId)) {
        return c.json({ success: false, error: 'Invalid rootId' }, 400);
      }
      const requestedRootId =
        typeof body.rootId === 'string' && body.rootId.length > 0
          ? body.rootId
          : undefined;
      const rootIds = requestedRootId
        ? [requestedRootId]
        : (await deps.store.listRoots()).map((root) => root.id);

      const roots: RebuildRootReport[] = [];
      for (const rootId of rootIds) {
        try {
          const result = await deps.indexProvider.rebuildRoot(rootId, {
            store: deps.store,
            embedder,
          });
          roots.push({
            rootId,
            status: 'ok',
            records: result.records,
            chunks: result.chunks,
          });
        } catch (e: unknown) {
          // A racing concurrent rebuild for this SAME root aborts the whole request
          // with 409 (caught by the outer catch below) rather than being downgraded
          // to a per-root error — the caller should retry the whole request, not
          // treat this root as merely "failed".
          if (e instanceof RebuildInProgressError) throw e;
          roots.push({ rootId, status: 'error', error: errorMessage(e) });
        }
      }

      // Partial-failure honesty (code-review MED-3): a per-root failure is reported
      // alongside every root that DID succeed with a 200, rather than discarding
      // completed work's report on the first failure. Only a wholly-failed request
      // (every targeted root errored) is a genuine 500.
      const whollyFailed =
        roots.length > 0 && roots.every((r) => r.status === 'error');
      if (whollyFailed) {
        return c.json(
          {
            success: false,
            error: 'All root rebuilds failed',
            data: { roots },
          },
          500,
        );
      }

      return c.json({ success: true, data: { roots } });
    } catch (e: unknown) {
      if (e instanceof RebuildInProgressError) {
        return c.json({ success: false, error: e.message }, 409);
      }
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  // POST /index/search — body: { query: string, topK?: number, rootIds?: string[],
  // filter?: Record<string, unknown> }. Embeds `query` via `deps.getEmbedder()`
  // (re-resolved fresh per request — module doc's capture-by-value trap), searches
  // the K3 index, then re-resolves each hit's `KitRecord` before returning it (see
  // module doc). A hit whose root/record no longer resolves is dropped from the
  // response individually — a resolution failure for one hit never fails the whole
  // search (same partial-failure honesty convention as `/index/rebuild`'s per-root
  // report, applied per-hit here).
  app.post('/index/search', async (c) => {
    try {
      const embedder = deps.getEmbedder();
      if (!embedder) {
        return c.json({ success: false, error: NO_EMBEDDER_ERROR }, 400);
      }

      const body = (await c.req.json().catch(() => ({}))) as SearchIndexBody;

      if (typeof body.query !== 'string' || body.query.trim().length === 0) {
        return c.json({ success: false, error: 'Invalid query' }, 400);
      }

      let topK = DEFAULT_SEARCH_TOP_K;
      if (body.topK !== undefined) {
        if (
          typeof body.topK !== 'number' ||
          !Number.isInteger(body.topK) ||
          body.topK <= 0 ||
          body.topK > MAX_SEARCH_TOP_K
        ) {
          return c.json({ success: false, error: 'Invalid topK' }, 400);
        }
        topK = body.topK;
      }

      let rootIds: string[] | undefined;
      if (body.rootIds !== undefined) {
        if (!isPlausibleRootIdArray(body.rootIds)) {
          return c.json({ success: false, error: 'Invalid rootIds' }, 400);
        }
        rootIds = body.rootIds;
      }

      let filter: Record<string, unknown> | undefined;
      if (body.filter !== undefined) {
        if (!isPlainFilterObject(body.filter)) {
          return c.json({ success: false, error: 'Invalid filter' }, 400);
        }
        filter = body.filter;
      }

      const [vector] = await embedder.embed([body.query]);
      const hits = await deps.indexProvider.search(vector, {
        topK,
        rootIds,
        filter,
      });

      const resolvedAdapters = new Map<
        string,
        Awaited<ReturnType<KnowledgeStoreProvider['adapterFor']>>
      >();
      const results: KnowledgeSearchResult[] = [];
      for (const hit of hits) {
        let adapter = resolvedAdapters.get(hit.rootId);
        if (!adapter) {
          try {
            adapter = await deps.store.adapterFor(hit.rootId);
          } catch {
            continue; // root no longer registered — drop this hit, not the whole search.
          }
          resolvedAdapters.set(hit.rootId, adapter);
        }

        const record = await adapter.get(hit.recordId);
        if (!record) continue; // K3's "never treat a hit as the record" rule — module doc.

        results.push({
          recordId: hit.recordId,
          rootId: hit.rootId,
          score: hit.score,
          title: record.title,
          excerpt: hit.text,
          category: record.category,
        });
      }

      return c.json({ success: true, data: results });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  // POST /migrate — body: { projectSlug?: string } (omitted = every pre-index
  // namespace found under `{dataDir}/projects`). Delegates entirely to the
  // non-destructive migration core (`migratePreIndexKnowledge`) — this route never
  // touches the pre-index vectordb/per-project-knowledge directory trees itself.
  app.post('/migrate', async (c) => {
    try {
      const embedder = deps.getEmbedder();
      if (!embedder) {
        return c.json({ success: false, error: NO_EMBEDDER_ERROR }, 400);
      }

      const body = (await c.req.json().catch(() => ({}))) as {
        projectSlug?: unknown;
      };
      if (
        body.projectSlug !== undefined &&
        !isSafePathSegment(body.projectSlug)
      ) {
        return c.json({ success: false, error: 'Invalid projectSlug' }, 400);
      }
      const projectSlug =
        typeof body.projectSlug === 'string' && body.projectSlug.length > 0
          ? body.projectSlug
          : undefined;

      const result = await migratePreIndexKnowledge(
        {
          dataDir: deps.dataDir,
          store: deps.store,
          indexProvider: deps.indexProvider,
          embedder,
        },
        { projectSlug },
      );

      // Partial-failure honesty (code-review MED-3): a wholly-failed migration (at
      // least one namespace was attempted and every attempted namespace errored) is
      // a genuine 500; any run with at least one successful namespace is a 200,
      // with the per-namespace breakdown available in `data.namespaceResults`.
      const whollyFailed =
        result.namespaceResults.length > 0 &&
        result.namespaceResults.every((r) => r.status === 'error');
      if (whollyFailed) {
        return c.json(
          {
            success: false,
            error: 'Pre-index knowledge migration failed',
            data: result,
          },
          500,
        );
      }

      return c.json({ success: true, data: result });
    } catch (e: unknown) {
      if (e instanceof RebuildInProgressError) {
        return c.json({ success: false, error: e.message }, 409);
      }
      const persistence = projectKnowledgePersistenceError(e);
      if (persistence) {
        return c.json(
          { success: false, error: persistence.error },
          persistence.status,
        );
      }
      return c.json(
        { success: false, error: 'Pre-index knowledge migration failed' },
        500,
      );
    }
  });

  return app;
}
