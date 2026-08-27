/**
 * K3 knowledge-index management fetchers (`s201-knowledge-retrieval` Wave 4) —
 * the DRY client for the two explicit, user/CLI-triggered index-management
 * verbs (`docs/design/knowledge-foundation.md`'s K3 section):
 * `POST /api/knowledge/index/rebuild` and `POST /api/knowledge/migrate`
 * (`src-server/routes/knowledge/knowledge-index-routes.ts`, Wave 3). Both the CLI
 * (`station knowledge reindex`/`migrate`, Wave 4) and station-control tool
 * wiring (`reindex_knowledge`/`migrate_knowledge`, Wave 4) call through these
 * two fetchers — the HTTP call is never re-implemented inline in either
 * caller, per this module family's own portability contract
 * (`./index.ts`'s header comment).
 */

import { apiErrorMessage } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

interface KnowledgeEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: 'knowledge_migration_failed';
}

/**
 * Mirrors `scheduler.ts`'s `unwrapSchedulerResponse`: parse the body first and
 * prefer its `{success:false, error}` text over a generic status message,
 * matching the exact `{success, error}` shape
 * `src-server/routes/knowledge/knowledge-index-routes.ts` returns on both the
 * no-embedder (400) and unexpected-failure (500) paths.
 */
async function unwrapKnowledgeResponse<T>(response: Response): Promise<T> {
  let result: KnowledgeEnvelope<T> | null = null;
  try {
    result = (await response.json()) as KnowledgeEnvelope<T>;
  } catch {
    throw new Error(`Knowledge API error: ${response.status}`);
  }
  if (!response.ok || !result.success) {
    throw new Error(
      apiErrorMessage(result, `Knowledge API error: ${response.status}`),
    );
  }
  return result.data as T;
}

export interface RebuildKnowledgeIndexOptions {
  /** Omitted = rebuild every registered root. */
  rootId?: string;
}

/**
 * Partial-failure honesty (code-review MED-3): `status` distinguishes a root that
 * actually rebuilt (`'ok'`, with real `records`/`chunks` counts) from one that
 * failed (`'error'`, with `error` set) WITHIN a single multi-root request — a
 * failure on one root no longer discards the report of roots that already
 * succeeded earlier in the same request.
 */
export interface RebuildKnowledgeIndexRootResult {
  rootId: string;
  status: 'ok' | 'error';
  records?: number;
  chunks?: number;
  error?: string;
}

export interface RebuildKnowledgeIndexResult {
  roots: RebuildKnowledgeIndexRootResult[];
}

export interface MigratePreIndexKnowledgeOptions {
  /** Omitted = every pre-index namespace found under every project. */
  projectSlug?: string;
}

/** Partial-failure honesty (code-review MED-3) — see `RebuildKnowledgeIndexRootResult`'s
 * doc comment for the same `status`/`error` convention, applied per pre-index namespace here. */
export interface MigratePreIndexKnowledgeNamespaceResult {
  projectSlug: string;
  namespace: string;
  status: 'ok' | 'error';
  documentsMigrated?: number;
  chunksIndexed?: number;
  error?: string;
}

export interface MigratePreIndexKnowledgeResult {
  documentsMigrated: number;
  chunksIndexed: number;
  namespacesProcessed: string[];
  namespaceResults: MigratePreIndexKnowledgeNamespaceResult[];
}

/**
 * `POST /api/knowledge/index/rebuild` — drops and re-derives the index
 * partition for the targeted root(s) (or every registered root, when
 * `opts.rootId` is omitted) from the K2 store, from scratch.
 */
export async function rebuildKnowledgeIndex(
  apiBase: string,
  opts?: RebuildKnowledgeIndexOptions,
  requestOpts?: ClientRequestOptions,
): Promise<RebuildKnowledgeIndexResult> {
  const response = await mutateJson(
    `${apiBase}/api/knowledge/index/rebuild`,
    'POST',
    requestOpts,
    { rootId: opts?.rootId },
  );
  return unwrapKnowledgeResponse<RebuildKnowledgeIndexResult>(response);
}

/**
 * `POST /api/knowledge/migrate` — non-destructively migrates pre-index
 * `vectordb/` / `projects/<slug>/knowledge/<namespace>` data into a K2 store
 * root plus the K3 index (or every pre-index namespace, when `opts.projectSlug`
 * is omitted). Never deletes or mutates the pre-index source trees.
 */
export async function migratePreIndexKnowledge(
  apiBase: string,
  opts?: MigratePreIndexKnowledgeOptions,
  requestOpts?: ClientRequestOptions,
): Promise<MigratePreIndexKnowledgeResult> {
  const response = await mutateJson(
    `${apiBase}/api/knowledge/migrate`,
    'POST',
    requestOpts,
    { projectSlug: opts?.projectSlug },
  );
  return unwrapKnowledgeResponse<MigratePreIndexKnowledgeResult>(response);
}

/**
 * K4 knowledge-store-root fetchers (`s202-knowledge-onboarding` Wave 1) —
 * thin delegations to the new `/api/knowledge/roots`, `/api/knowledge/roots/
 * validate`, and `/api/knowledge/adapters` routes
 * (`src-server/routes/knowledge/knowledge-store-routes.ts`), which themselves delegate
 * to K2's `KnowledgeStoreProvider` (`listRoots`/`createRoot`/`removeRoot`/
 * `listAdapters`/`validateRootForAdapter`). Same envelope shape and
 * `unwrapKnowledgeResponse` pattern as the K3 fetchers above — one module,
 * one unwrap helper, for every `/api/knowledge/*` route.
 */
import type {
  KnowledgeAdapterDescriptor,
  KnowledgeRootScope,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';

/** Body for `POST /api/knowledge/roots`. `storeRoot`/`displayName` are optional —
 * the server defaults `storeRoot` server-side (personal/project scope) when omitted. */
export interface CreateKnowledgeRootInput {
  scope: KnowledgeRootScope;
  adapterId: string;
  storeRoot?: string;
  displayName?: string;
}

/** Body for `POST /api/knowledge/roots/validate`. */
export interface ValidateKnowledgeRootInput {
  adapterId: string;
  storeRoot: string;
}

/** Verbatim `{ ok, reason? }` passthrough of the adapter's own honest
 * `validateRoot` result — never rewritten/generalized (dishonest-validation
 * stop-short risk). */
export interface ValidateKnowledgeRootResult {
  ok: boolean;
  reason?: string;
}

/** `GET /api/knowledge/adapters` response shape — id/displayName only, the
 * route never leaks adapter internals (no `create`/`validateRoot` functions
 * cross the wire). */
export type KnowledgeAdapterSummary = Pick<
  KnowledgeAdapterDescriptor,
  'id' | 'displayName'
>;

/** `GET /api/knowledge/roots` — list every registered knowledge-store root. */
export async function listKnowledgeRoots(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<KnowledgeStoreRoot[]> {
  const response = await getJson(`${apiBase}/api/knowledge/roots`, opts);
  return unwrapKnowledgeResponse<KnowledgeStoreRoot[]>(response);
}

/**
 * `POST /api/knowledge/roots` — register a new knowledge-store root. When
 * `input.storeRoot` is omitted the server applies its own default path
 * (personal: `{dataDir}/knowledge/personal`; project: `{dataDir}/projects/
 * <slug>/knowledge-store`) — this fetcher never invents a client-side default.
 */
export async function createKnowledgeRoot(
  apiBase: string,
  input: CreateKnowledgeRootInput,
  opts?: ClientRequestOptions,
): Promise<KnowledgeStoreRoot> {
  const response = await mutateJson(
    `${apiBase}/api/knowledge/roots`,
    'POST',
    opts,
    input,
  );
  return unwrapKnowledgeResponse<KnowledgeStoreRoot>(response);
}

/**
 * `POST /api/knowledge/roots/validate` — asks the named adapter to honestly
 * validate a candidate `storeRoot` path (e.g. `kit-obsidian-store` checking
 * for a `.obsidian/` vault marker) BEFORE any create call. Callers must
 * render `result.reason` verbatim on `ok:false`, never substitute a generic
 * message or silently fall back to another adapter.
 */
export async function validateKnowledgeRoot(
  apiBase: string,
  input: ValidateKnowledgeRootInput,
  opts?: ClientRequestOptions,
): Promise<ValidateKnowledgeRootResult> {
  const response = await mutateJson(
    `${apiBase}/api/knowledge/roots/validate`,
    'POST',
    opts,
    input,
  );
  return unwrapKnowledgeResponse<ValidateKnowledgeRootResult>(response);
}

/** `GET /api/knowledge/adapters` — list every registered adapter descriptor
 * (id/displayName only). */
export async function listKnowledgeAdapters(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<KnowledgeAdapterSummary[]> {
  const response = await getJson(`${apiBase}/api/knowledge/adapters`, opts);
  return unwrapKnowledgeResponse<KnowledgeAdapterSummary[]>(response);
}

/** `DELETE /api/knowledge/roots/:id` — deregister a root. K2's `removeRoot`
 * never deletes the underlying store files, only the registry entry. */
export async function deleteKnowledgeRoot(
  apiBase: string,
  rootId: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  const response = await mutateJson(
    `${apiBase}/api/knowledge/roots/${encodeURIComponent(rootId)}`,
    'DELETE',
    opts,
  );
  await unwrapKnowledgeResponse<void>(response);
}

/**
 * K5 knowledge-record + index-search fetchers (`s203-knowledge-meeting-notes`
 * Wave 1 Task 2) — the DRY client for the record-CRUD routes
 * (`src-server/routes/knowledge/knowledge-record-routes.ts`) and the K3 index-search route
 * (`POST /api/knowledge/index/search`, `src-server/routes/knowledge/knowledge-index-routes.ts`).
 * Same envelope shape and `unwrapKnowledgeResponse` pattern as every other
 * `/api/knowledge/*` fetcher in this file.
 *
 * Scope note (mirrors the route's own doc comment): only the operations K5's
 * capture+recall flow needs are exposed — create, get, listByType, link, the
 * bulk graph read, and index search. `update`/`propose`/`apply`/`reject`/
 * `supersede`/`retire` have no fetcher here because no route exposes them.
 */
import type {
  CreateInput,
  KitLink,
  KitRecord,
  KitRecordType,
} from '@kontourai/station-contracts/knowledge-store';

/** Body for `POST /api/knowledge/roots/:rootId/records`. */
export interface CreateKnowledgeRecordInput extends CreateInput {}

/** Body for `POST /api/knowledge/roots/:rootId/records/:id/links`. */
export interface LinkKnowledgeRecordInput {
  links: KitLink[];
  evidence: { agent: string; note?: string };
}

/** `POST /api/knowledge/roots/:rootId/records` — create a Kit record on the
 * named root's adapter. Returns the freshly re-read record (never a bare id). */
export async function createKnowledgeRecord(
  apiBase: string,
  rootId: string,
  input: CreateKnowledgeRecordInput,
  opts?: ClientRequestOptions,
): Promise<KitRecord> {
  const response = await mutateJson(
    `${apiBase}/api/knowledge/roots/${encodeURIComponent(rootId)}/records`,
    'POST',
    opts,
    input,
  );
  return unwrapKnowledgeResponse<KitRecord>(response);
}

/** `GET /api/knowledge/roots/:rootId/records/:id` — full-id lookup only (no
 * alias/prefix resolution over this HTTP surface — see the route's doc comment). */
export async function getKnowledgeRecord(
  apiBase: string,
  rootId: string,
  id: string,
  opts?: ClientRequestOptions,
): Promise<KitRecord> {
  const response = await getJson(
    `${apiBase}/api/knowledge/roots/${encodeURIComponent(rootId)}/records/${encodeURIComponent(id)}`,
    opts,
  );
  return unwrapKnowledgeResponse<KitRecord>(response);
}

/** `GET /api/knowledge/roots/:rootId/records?type=` — `listByType`. */
export async function listKnowledgeRecordsByType(
  apiBase: string,
  rootId: string,
  type: KitRecordType,
  options?: { includeRetired?: boolean },
  opts?: ClientRequestOptions,
): Promise<KitRecord[]> {
  const params = new URLSearchParams({ type });
  if (options?.includeRetired) params.set('includeRetired', 'true');
  const response = await getJson(
    `${apiBase}/api/knowledge/roots/${encodeURIComponent(rootId)}/records?${params.toString()}`,
    opts,
  );
  return unwrapKnowledgeResponse<KitRecord[]>(response);
}

/** `POST /api/knowledge/roots/:rootId/records/:id/links` — append links from
 * `id` to each `links[].target_id`. Returns the freshly re-read source record. */
export async function linkKnowledgeRecord(
  apiBase: string,
  rootId: string,
  id: string,
  input: LinkKnowledgeRecordInput,
  opts?: ClientRequestOptions,
): Promise<KitRecord> {
  const response = await mutateJson(
    `${apiBase}/api/knowledge/roots/${encodeURIComponent(rootId)}/records/${encodeURIComponent(id)}/links`,
    'POST',
    opts,
    input,
  );
  return unwrapKnowledgeResponse<KitRecord>(response);
}

/** A wikilink-graph node — one per Kit record (module doc: built from
 * `listByType`, not a bare `KnowledgeIndexEntry`). */
export interface KnowledgeGraphNode {
  id: string;
  type: KitRecordType;
  title: string;
  category: string;
}

/** A wikilink-graph edge — one per forward `KitLink` on some record in the root. */
export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  kind: string;
  label?: string;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

/** `GET /api/knowledge/roots/:rootId/graph` — bulk nodes/edges for the
 * wikilink graph pane. File-based-adapter roots only (see the route's doc
 * comment for the Neo4j-connected-root scope note). */
export async function getKnowledgeGraph(
  apiBase: string,
  rootId: string,
  opts?: ClientRequestOptions,
): Promise<KnowledgeGraph> {
  const response = await getJson(
    `${apiBase}/api/knowledge/roots/${encodeURIComponent(rootId)}/graph`,
    opts,
  );
  return unwrapKnowledgeResponse<KnowledgeGraph>(response);
}

export interface SearchKnowledgeIndexOptions {
  query: string;
  topK?: number;
  rootIds?: string[];
  filter?: Record<string, unknown>;
}

/** `POST /api/knowledge/index/search` response entry — always a re-resolved
 * record's own fields (title/category), never a bare index-hit passthrough
 * (K3's "never treat an index hit as the record" rule). */
export interface KnowledgeSearchResult {
  recordId: string;
  rootId: string;
  score: number;
  title: string;
  excerpt: string;
  category: string;
}

/** `POST /api/knowledge/index/search` — embeds `options.query` server-side and
 * searches the K3 index, scoped to `options.rootIds` when supplied. Returns the
 * `NO_EMBEDDER_ERROR` 400 convention (surfaced as a thrown Error, same as every
 * other fetcher in this file) when no embedding provider connection is configured. */
export async function searchKnowledgeIndex(
  apiBase: string,
  options: SearchKnowledgeIndexOptions,
  opts?: ClientRequestOptions,
): Promise<KnowledgeSearchResult[]> {
  const response = await mutateJson(
    `${apiBase}/api/knowledge/index/search`,
    'POST',
    // POST because the query travels in the body, not because anything is
    // written — the route only embeds the query and reads the index. Declared
    // so a deadline miss (embedding a query through a cold provider is exactly
    // the slow call that misses one) is not reported as a possible change to
    // the user's knowledge base.
    { ...opts, readOnly: true },
    options,
  );
  return unwrapKnowledgeResponse<KnowledgeSearchResult[]>(response);
}

/**
 * K5 Neo4j graph-view fetchers (`s203-knowledge-meeting-notes` Wave 3 cleanup,
 * plan item 1c) — the DRY client for the Neo4j-backed graph read/sync routes
 * (`src-server/routes/knowledge/neo4j-graph-routes.ts`, Wave 1 Task 1's Q1-ratified
 * "Graph view, synced" scope). Same envelope + `unwrapKnowledgeResponse`
 * convention as every other `/api/knowledge/*` fetcher in this file. Both
 * routes answer an honest `503` when no Neo4j graph-view connection is
 * registered (or the driver failed to load) — that surfaces here as a thrown
 * `Error` carrying the route's own reason text verbatim (never rewritten to a
 * generic message), so a caller can render it directly as the "not
 * configured" state.
 */

/** `GET /api/knowledge/roots/:rootId/graph/neo4j` — reads whatever the last
 * sync (`syncKnowledgeGraphNeo4j`, below) projected for `rootId` into Neo4j.
 * Shares `KnowledgeGraph`'s node/edge shape with the file-based `getKnowledgeGraph`
 * above — same fields, a different backend the caller opts into. */
export async function getKnowledgeGraphNeo4j(
  apiBase: string,
  rootId: string,
  opts?: ClientRequestOptions,
): Promise<KnowledgeGraph> {
  const response = await getJson(
    `${apiBase}/api/knowledge/roots/${encodeURIComponent(rootId)}/graph/neo4j`,
    opts,
  );
  return unwrapKnowledgeResponse<KnowledgeGraph>(response);
}

/** `POST /api/knowledge/roots/:rootId/graph/neo4j-sync` response — mirrors
 * `src-server/knowledge-store/neo4j-graph-sync.ts`'s `SyncStats` shape (kept as
 * a parallel SDK-owned type rather than importing a server module across the
 * plugin boundary). */
export interface KnowledgeGraphNeo4jSyncStats {
  rootId: string;
  recordsScanned: number;
  linksScanned: number;
  nodesWritten: number;
  nodesUnchanged: number;
  linksWritten: number;
  linksUnchanged: number;
  linksSkippedDangling: number;
}

/** `POST /api/knowledge/roots/:rootId/graph/neo4j-sync` — idempotent sync
 * trigger (content-hash guarded server-side); re-running against unchanged
 * data returns all-`*Unchanged` stats, never a throw for "nothing to do". */
export async function syncKnowledgeGraphNeo4j(
  apiBase: string,
  rootId: string,
  opts?: ClientRequestOptions,
): Promise<KnowledgeGraphNeo4jSyncStats> {
  const response = await mutateJson(
    `${apiBase}/api/knowledge/roots/${encodeURIComponent(rootId)}/graph/neo4j-sync`,
    'POST',
    opts,
  );
  return unwrapKnowledgeResponse<KnowledgeGraphNeo4jSyncStats>(response);
}
