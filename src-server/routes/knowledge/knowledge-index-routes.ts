/**
 * Explicit rebuild, migration, and search over Knowledge store roots.
 * Resolve the embedder per request so configuration changes are observed.
 * Rebuilds of session-backed roots require the local operator and run through
 * the Station indexer; searches recheck the caller before releasing records.
 *
 * Search admits only chunks embedded by the current embedder's generation
 * (#2727) and reports readable roots indexed under another one. It returns a
 * cached excerpt only while the re-read record still contains it as a chunk
 * (#2728); a withheld excerpt is counted, never shown. Hits the caller cannot
 * read are refilled from further down the ranking. Validate path-bearing
 * migration input before filesystem work; report an in-progress rebuild as
 * 409 and retain per-root partial failures.
 */
import type {
  IEmbeddingProvider,
  KnowledgeIndexProvider,
} from '@kontourai/station-contracts/knowledge-index';
import type {
  KitRecord,
  KnowledgeStoreProvider,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import { knowledgeRootIncarnationKey } from '@kontourai/station-shared/knowledge-root-identity';
import { Hono } from 'hono';
import { knowledgeEmbeddingIdentity } from '../../knowledge-index/embedding-identity.js';
import { RebuildInProgressError } from '../../knowledge-index/inflight-guard.js';
import { migratePreIndexKnowledge } from '../../knowledge-index/migrate-pre-index-knowledge.js';
import { isSafePathSegment } from '../../knowledge-index/path-safety.js';
import { MEMORY_ADAPTER_ID } from '../../knowledge-store/memory-root.js';
import {
  knowledgeRootReadKind,
  SESSION_BACKED_BUILD_FORBIDDEN_ERROR,
} from '../../knowledge-store/session-backed-roots.js';
import { chunkKnowledgeText } from '../../services/knowledge/knowledge-storage.js';
import { errorMessage } from '../schemas/schemas.js';
import { projectKnowledgePersistenceError } from './knowledge-persistence-errors.js';
import { MEMORY_PREVIEW_DISABLED } from './memory-routes.js';

interface KnowledgeIndexRouteDeps {
  store: KnowledgeStoreProvider;
  previewDisabledForRoot?: (rootId: string) => boolean;
  indexProvider: KnowledgeIndexProvider;
  /** Station home dir — the root both pre-index trees and K2 store roots hang off
   * (`migratePreIndexKnowledge`'s `dataDir`). */
  dataDir: string;
  /** Resolved fresh on every request — see module doc. */
  getEmbedder: () => IEmbeddingProvider | null;
  /**
   * Runs index building (rebuild, migration) as the Station's own background
   * reader, never as the caller. The index is shared: rebuilding a
   * session-backed root as a caller who reads only part of it would drop
   * everyone else's hits. Every search re-reads each hit as its own caller.
   * Defaults to running as-is.
   */
  runAsIndexer?: <T>(build: () => Promise<T>) => Promise<T>;
  /**
   * Whether this request may build a session-backed (conversation-store)
   * root's index: only the local operator. Absent, no request may. Other
   * roots are unaffected.
   */
  mayBuildSessionBackedRoot?: (request: Request) => boolean;
  mayBuildPrivateRoot?: (
    request: Request,
    root: KnowledgeStoreRoot,
  ) => boolean | Promise<boolean>;
  /**
   * #2377 slice B: whether this request may see a search hit from `root`,
   * decided BEFORE the record is read (a hit carries its title and excerpt).
   * The index is Station-wide; a conversation-backed root re-reads each
   * record as the caller, but a Project or personal root's records are not
   * per-caller, so a station-control agent needs its session owner's access
   * to the root's scope. Absent: every root passes, as before.
   */
  mayReadHitRoot?: (
    request: Request,
    root: KnowledgeStoreRoot,
  ) => boolean | Promise<boolean>;
  guardReadResponse?: (
    request: Request,
    roots: readonly KnowledgeStoreRoot[],
    response: Response,
    validateDelivery?: () => Promise<boolean>,
  ) => Promise<Response>;
  memoryRebuildFence?: (
    request: Request,
    root: KnowledgeStoreRoot,
  ) => Parameters<KnowledgeIndexProvider['rebuildRoot']>[1]['withRootRevision'];
  runAsReader?: <T>(
    request: Request,
    operation: () => Promise<T>,
  ) => Promise<T>;
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

/** `POST /index/search` sibling of `data`: what the index could not answer
 * for the current embedder. Only roots this caller may read are named. */
interface KnowledgeSearchIndexReport {
  /** Roots holding chunks from another, or an unknown, embedding generation.
   * Their chunks are never searched; rebuild the root to recover them. */
  staleRoots: Array<{
    rootId: string;
    reason: 'embedding-changed' | 'unknown-generation';
  }>;
  /** Readable records whose indexed excerpt is no longer in the record. */
  staleRecords: number;
  /** The scan stopped at `MAX_SEARCH_SCAN` before finding `topK` results. */
  scanLimitReached: boolean;
}

const DEFAULT_SEARCH_TOP_K = 10;
const MAX_SEARCH_TOP_K = 50;
/** How far down the ranking a search may read to refill hits it withheld. */
const MAX_SEARCH_SCAN = 1000;

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
  const runAsIndexer =
    deps.runAsIndexer ?? (<T>(build: () => Promise<T>) => build());
  app.post('/index/rebuild', async (c) => {
    try {
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
      if (requestedRootId && deps.previewDisabledForRoot?.(requestedRootId))
        return c.json(MEMORY_PREVIEW_DISABLED, 404);
      const embedder = deps.getEmbedder();
      if (!embedder)
        return c.json({ success: false, error: NO_EMBEDDER_ERROR }, 400);
      const rootIds = requestedRootId
        ? [requestedRootId]
        : (await deps.store.listRoots()).map((root) => root.id);

      const privateRoots = new Map<string, KnowledgeStoreRoot>();
      const snapshots = new Map<string, KnowledgeStoreRoot>();
      const selectedRootIds: string[] = [];
      const isOperator = deps.mayBuildSessionBackedRoot?.(c.req.raw) ?? false;
      for (const rootId of rootIds) {
        const kind = await knowledgeRootReadKind(deps.store, rootId);
        if (kind === 'session-backed' && !isOperator)
          return c.json(
            { success: false, error: SESSION_BACKED_BUILD_FORBIDDEN_ERROR },
            403,
          );
        if (kind === 'author-private') {
          const root = await deps.store.getRoot(rootId);
          if (
            !isOperator ||
            !root ||
            root.readPolicy?.kind !== 'author-private' ||
            !deps.mayBuildPrivateRoot ||
            !(await deps.mayBuildPrivateRoot(c.req.raw, root))
          ) {
            if (requestedRootId)
              return c.json(
                { success: false, error: 'Knowledge root access denied.' },
                403,
              );
            continue;
          }
          if (!deps.store.withRootRevision)
            return c.json(
              {
                success: false,
                error: 'Knowledge root revision is unavailable.',
              },
              503,
            );
          privateRoots.set(rootId, root);
          snapshots.set(rootId, root);
        } else {
          const root = await deps.store.getRoot(rootId);
          if (root?.readPolicy !== undefined) {
            if (requestedRootId)
              return c.json(
                { success: false, error: 'Knowledge root access denied.' },
                403,
              );
            continue;
          }
          if (root) snapshots.set(rootId, root);
        }
        selectedRootIds.push(rootId);
      }

      if (
        selectedRootIds.length > 0 &&
        deps.store.withRootRevision &&
        !deps.indexProvider.supportsRootRevision
      )
        return c.json(
          {
            success: false,
            error: 'Knowledge index revision support is unavailable.',
          },
          503,
        );

      const roots: RebuildRootReport[] = [];
      for (const rootId of selectedRootIds) {
        const expected = privateRoots.get(rootId);
        if (
          !expected &&
          (await knowledgeRootReadKind(deps.store, rootId)) === 'author-private'
        ) {
          if (requestedRootId)
            return c.json(
              { success: false, error: 'Knowledge root access denied.' },
              403,
            );
          continue;
        }
        if (expected) {
          const current = await deps.store.getRoot(rootId);
          if (
            !current ||
            knowledgeRootIncarnationKey(current) !==
              knowledgeRootIncarnationKey(expected) ||
            !deps.mayBuildPrivateRoot ||
            !(await deps.mayBuildPrivateRoot(c.req.raw, current))
          ) {
            if (requestedRootId)
              return c.json(
                { success: false, error: 'Knowledge root access denied.' },
                403,
              );
            privateRoots.delete(rootId);
            continue;
          }
        }
        try {
          const snapshot = snapshots.get(rootId);
          const memoryFence =
            expected?.adapterId === MEMORY_ADAPTER_ID
              ? deps.memoryRebuildFence?.(c.req.raw, expected)
              : undefined;
          if (expected?.adapterId === MEMORY_ADAPTER_ID && !memoryFence)
            throw new Error('Private memory rebuild fence is unavailable.');
          const withRootRevision: Parameters<
            KnowledgeIndexProvider['rebuildRoot']
          >[1]['withRootRevision'] = memoryFence
            ? (operation, phase) =>
                memoryFence(async (adapter) => {
                  if (
                    !deps.mayBuildPrivateRoot ||
                    !(await deps.mayBuildPrivateRoot(c.req.raw, expected!))
                  )
                    throw new Error('Knowledge root access ended.');
                  return operation(adapter);
                }, phase)
            : snapshot && deps.store.withRootRevision
              ? (operation) =>
                  deps.store.withRootRevision!(snapshot, async (adapter) => {
                    if (
                      expected &&
                      (!deps.mayBuildPrivateRoot ||
                        !(await deps.mayBuildPrivateRoot(c.req.raw, expected)))
                    )
                      throw new Error('Knowledge root access ended.');
                    return operation(adapter);
                  })
              : undefined;
          const result = await runAsIndexer(() =>
            deps.indexProvider.rebuildRoot(rootId, {
              store: deps.store,
              embedder,
              withRootRevision,
            }),
          );
          roots.push({
            rootId,
            status: 'ok',
            records: result.records,
            chunks: result.chunks,
          });
        } catch (e: unknown) {
          const current = await deps.store.getRoot(rootId);
          if (
            (expected || current?.readPolicy !== undefined) &&
            (!current ||
              !expected ||
              knowledgeRootIncarnationKey(current) !==
                knowledgeRootIncarnationKey(expected) ||
              !deps.mayBuildPrivateRoot ||
              !(await deps.mayBuildPrivateRoot(c.req.raw, current)))
          ) {
            if (requestedRootId)
              return c.json(
                { success: false, error: 'Knowledge root access denied.' },
                403,
              );
            privateRoots.delete(rootId);
            continue;
          }
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
      const response = whollyFailed
        ? c.json(
            {
              success: false,
              error: 'All root rebuilds failed',
              data: { roots },
            },
            500,
          )
        : c.json({ success: true, data: { roots } });
      return deps.guardReadResponse && privateRoots.size
        ? deps.guardReadResponse(
            c.req.raw,
            [...privateRoots.values()],
            response,
          )
        : response;
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

      if (rootIds?.some((id) => deps.previewDisabledForRoot?.(id)))
        return c.json(MEMORY_PREVIEW_DISABLED, 404);
      const embedder = deps.getEmbedder();
      if (!embedder)
        return c.json({ success: false, error: NO_EMBEDDER_ERROR }, 400);

      let filter: Record<string, unknown> | undefined;
      if (body.filter !== undefined) {
        if (!isPlainFilterObject(body.filter)) {
          return c.json({ success: false, error: 'Invalid filter' }, 400);
        }
        filter = body.filter;
      }

      const [vector] = await embedder.embed([body.query]);
      const embeddingIdentity = knowledgeEmbeddingIdentity(embedder);

      const rootReadable = new Map<string, boolean>();
      const visibleRoots = new Map<string, KnowledgeStoreRoot>();
      const mayReadRoot = async (rootId: string): Promise<boolean> => {
        if (!deps.mayReadHitRoot) return true;
        let readable = rootReadable.get(rootId);
        if (readable === undefined) {
          const root = await deps.store.getRoot(rootId);
          // An unregistered root decides nothing: fail closed.
          readable = !!root && (await deps.mayReadHitRoot(c.req.raw, root));
          if (readable && root) visibleRoots.set(rootId, root);
          rootReadable.set(rootId, readable);
        }
        return readable;
      };

      const staleRoots: KnowledgeSearchIndexReport['staleRoots'] = [];
      for (const generation of (await deps.indexProvider.generations?.(
        rootIds,
      )) ?? []) {
        if (generation.embeddingIdentity === embeddingIdentity) continue;
        if (staleRoots.some((stale) => stale.rootId === generation.rootId)) {
          continue;
        }
        // Leftover chunks of a removed root are not a rebuild the caller can do.
        if (!(await deps.store.getRoot(generation.rootId))) continue;
        if (!(await mayReadRoot(generation.rootId))) continue;
        staleRoots.push({
          rootId: generation.rootId,
          reason:
            generation.embeddingIdentity === null
              ? 'unknown-generation'
              : 'embedding-changed',
        });
      }

      const resolvedAdapters = new Map<
        string,
        Awaited<ReturnType<KnowledgeStoreProvider['adapterFor']>>
      >();
      // One read per record per request, however many of its chunks match.
      const currentRecords = new Map<
        string,
        { record: KitRecord; chunks: Set<string> } | null
      >();
      const staleRecordKeys = new Set<string>();
      const results: KnowledgeSearchResult[] = [];
      let scanned = 0;
      let fetchK = topK;
      let scanLimitReached = false;
      // Withheld hits (unreadable root, missing record, stale excerpt) must
      // not shrink the answer: read further down the ranking until topK
      // results are found, the index runs out, or the scan bound is hit.
      for (;;) {
        const hits = await deps.indexProvider.search(vector, {
          topK: fetchK,
          rootIds,
          filter,
          embeddingIdentity,
        });
        for (; scanned < hits.length && results.length < topK; scanned += 1) {
          const hit = hits[scanned];
          if (!(await mayReadRoot(hit.rootId))) continue;
          let adapter = resolvedAdapters.get(hit.rootId);
          if (!adapter) {
            try {
              adapter = await deps.store.adapterFor(hit.rootId);
            } catch {
              continue; // root no longer registered — drop this hit, not the whole search.
            }
            resolvedAdapters.set(hit.rootId, adapter);
          }

          const recordKey = JSON.stringify([hit.rootId, hit.recordId]);
          let current = currentRecords.get(recordKey);
          if (current === undefined) {
            const record = await adapter.get(hit.recordId);
            current = record
              ? { record, chunks: new Set(chunkKnowledgeText(record.body)) }
              : null;
            currentRecords.set(recordKey, current);
          }
          if (!current) continue; // K3's "never treat a hit as the record" rule — module doc.
          const { record } = current;
          // The excerpt is current only while the record still produces it.
          if (!current.chunks.has(hit.text)) {
            staleRecordKeys.add(recordKey);
            continue;
          }

          results.push({
            recordId: hit.recordId,
            rootId: hit.rootId,
            score: hit.score,
            title: record.title,
            excerpt: hit.text,
            category: record.category,
          });
        }
        if (results.length >= topK || hits.length < fetchK) break;
        if (fetchK >= MAX_SEARCH_SCAN) {
          scanLimitReached = true;
          break;
        }
        fetchK = Math.min(fetchK * 4, MAX_SEARCH_SCAN);
      }

      const index: KnowledgeSearchIndexReport = {
        staleRoots,
        staleRecords: staleRecordKeys.size,
        scanLimitReached,
      };
      let deliveredResults: KnowledgeSearchResult[] | undefined;
      const stillCurrent = (hit: KnowledgeSearchResult) => {
        const read = async () => {
          const root = await deps.store.getRoot(hit.rootId);
          if (
            !root ||
            deps.previewDisabledForRoot?.(hit.rootId) ||
            (deps.mayReadHitRoot &&
              !(await deps.mayReadHitRoot(c.req.raw, root)))
          )
            return null;
          const adapter = await deps.store.adapterFor(hit.rootId);
          const record = await adapter.get(hit.recordId);
          return record && chunkKnowledgeText(record.body).includes(hit.excerpt)
            ? record
            : null;
        };
        return deps.runAsReader ? deps.runAsReader(c.req.raw, read) : read();
      };
      // The response body can wait after assembly. Re-read each record when
      // the transport pulls it so an erased or changed excerpt is withheld.
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const currentResults: KnowledgeSearchResult[] = [];
                for (const hit of results) {
                  if (c.req.raw.signal.aborted)
                    throw new Error('Request ended.');
                  const record = await stillCurrent(hit);
                  if (!record) {
                    staleRecordKeys.add(
                      JSON.stringify([hit.rootId, hit.recordId]),
                    );
                    continue;
                  }
                  currentResults.push({
                    ...hit,
                    title: record.title,
                    category: record.category,
                  });
                }
                deliveredResults = currentResults;
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      success: true,
                      data: currentResults,
                      index: { ...index, staleRecords: staleRecordKeys.size },
                    }),
                  ),
                );
                controller.close();
              } catch {
                controller.error(
                  new Error('Knowledge results are unavailable.'),
                );
              }
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'Content-Type': 'application/json; charset=UTF-8' } },
      );
      return deps.guardReadResponse
        ? deps.guardReadResponse(
            c.req.raw,
            [...visibleRoots.values()],
            response,
            async () => {
              if (c.req.raw.signal.aborted) return false;
              if (!deliveredResults) return true;
              for (const hit of deliveredResults) {
                const record = await stillCurrent(hit);
                if (
                  !record ||
                  record.title !== hit.title ||
                  record.category !== hit.category
                )
                  return false;
              }
              return !c.req.raw.signal.aborted;
            },
          )
        : response;
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

      // Migration may reuse a root at its managed destination. Its owner
      // refuses a private registration and uses the registration lease when available.
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
