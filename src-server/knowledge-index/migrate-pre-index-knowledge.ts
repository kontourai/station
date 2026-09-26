/**
 * Copies pre-index documents into Kit-format roots without cutting over or
 * cleaning up the source corpus. Source snapshots enter transaction recovery,
 * which can repair an interrupted prior write. Existing record IDs are skipped;
 * index writes can repair a prior record-create/index-failure boundary. Vector
 * reuse checks width, not model identity. See docs/guides/knowledge.md.
 *
 * Preserve path validation, the source snapshot, and the global migration
 * lock. A failed namespace must not erase the outcomes of successful ones.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeDocumentMeta } from '@kontourai/station-contracts/knowledge';
import type {
  IEmbeddingProvider,
  KnowledgeIndexEntry,
  KnowledgeIndexProvider,
} from '@kontourai/station-contracts/knowledge-index';
import type {
  KnowledgeStoreProvider,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import { knowledgeStoreRootPathForNamespace } from '../knowledge-store/namespace-compat.js';
import {
  defaultKnowledgeStorageDir,
  knowledgeVectorNamespace,
  readKnowledgeDocuments,
} from '../services/knowledge/knowledge-storage.js';
import { knowledgeMigrationOps } from '../telemetry/metrics.js';
import { createLogger } from '../utils/logger.js';
import { KeyedInFlightGuard } from './inflight-guard.js';
import { assertSafePathSegment, isSafePathSegment } from './path-safety.js';

/** Structural mirror of `lancedb-provider.ts:24-40`'s flat pre-index vector-doc shape — parsed
 * directly from `vectors.json` here, never via the `LanceDBProvider` class. */
interface PreIndexVectorDoc {
  id: string;
  vector: number[];
  text: string;
  metadata: Record<string, unknown>;
}

interface MigratePreIndexKnowledgeDeps {
  /** Station home dir (`resolveHomeDir()`'s caller-resolved value) — the root both pre-index
   * trees (the `vectordb` directory and each project's `knowledge` directory) and the new K2
   * store roots hang off. */
  dataDir: string;
  store: KnowledgeStoreProvider;
  indexProvider: KnowledgeIndexProvider;
  embedder: IEmbeddingProvider;
}

export interface MigratePreIndexKnowledgeOptions {
  /** Omitted = every pre-index project namespace found under `{dataDir}/projects`. Must be a
   * single safe path segment (see `./path-safety.ts`) — an invalid value throws rather than
   * silently no-op-ing or reaching a filesystem call. */
  projectSlug?: string;
}

/** Per-namespace migration outcome (code-review MED-3) — one entry per pre-index namespace this
 * run attempted, whether it succeeded or failed, so a failure partway through a multi-namespace
 * migration never discards the report of namespaces that already completed. */
export interface MigratePreIndexKnowledgeNamespaceResult {
  projectSlug: string;
  namespace: string;
  status: 'ok' | 'error';
  documentsMigrated?: number;
  chunksIndexed?: number;
  error?: string;
  code?: 'knowledge_migration_failed';
}

export interface MigratePreIndexKnowledgeResult {
  documentsMigrated: number;
  chunksIndexed: number;
  namespacesProcessed: string[];
  /** One entry per discovered namespace this run attempted (code-review MED-3) — present even
   * when every namespace succeeds, so callers can always distinguish "ran and did nothing"
   * (empty array) from "ran, and here's what happened per namespace". */
  namespaceResults: MigratePreIndexKnowledgeNamespaceResult[];
}

interface PreIndexNamespaceRef {
  projectSlug: string;
  namespace: string;
}

/** Global lock (SEC-2) — the whole migration run is one unit of work; see module doc. */
const MIGRATE_LOCK_KEY = 'pre-index-knowledge-migration';
const migrateGuard = new KeyedInFlightGuard();
const logger = createLogger({ name: 'pre-index-knowledge-migration' });

function observeMigration(op: string, outcome: string): void {
  try {
    knowledgeMigrationOps.add(1, { op, outcome });
  } catch (error) {
    try {
      logger.warn('Knowledge migration metrics observer failed', {
        op,
        outcome,
        error,
      });
    } catch {
      // Logging is also an observer.
    }
  }
}

/** Read-only directory listing — discovers which (projectSlug, namespace) pairs have a pre-index
 * knowledge tree at all. No writes; `readdirSync` never mutates.
 *
 * Path safety (SEC-1): a caller-supplied `projectSlug` is validated and throws on failure (a
 * caller passing a malicious value gets a clear, immediate error). A `projectSlug`/namespace
 * discovered via `readdirSync` is validated too, but an invalid discovered name is *skipped*
 * (counted as a `noop`) rather than thrown — a stray or crafted directory entry on disk must
 * not abort discovery for every other, legitimate namespace. */
function discoverPreIndexNamespaces(
  dataDir: string,
  projectSlug?: string,
): PreIndexNamespaceRef[] {
  if (projectSlug !== undefined) {
    assertSafePathSegment('projectSlug', projectSlug);
  }

  const projectsDir = join(dataDir, 'projects');
  if (!existsSync(projectsDir)) return [];

  const projectSlugs = projectSlug
    ? [projectSlug]
    : readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => {
          if (isSafePathSegment(name)) return true;
          observeMigration('noop', 'invalid-project-slug-skipped');
          return false;
        });

  const refs: PreIndexNamespaceRef[] = [];
  for (const slug of projectSlugs) {
    const knowledgeDir = join(projectsDir, slug, 'knowledge');
    if (!existsSync(knowledgeDir)) continue;
    const namespaces = readdirSync(knowledgeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        if (isSafePathSegment(name)) return true;
        observeMigration('noop', 'invalid-namespace-skipped');
        return false;
      });
    for (const namespace of namespaces) {
      refs.push({ projectSlug: slug, namespace });
    }
  }
  return refs;
}

function preIndexVectorsFile(dataDir: string, vectorNamespace: string): string {
  return join(dataDir, 'vectordb', vectorNamespace, 'vectors.json');
}

/** Read-only parse of the pre-index `vectors.json` flat file — never via `LanceDBProvider`. */
function readPreIndexVectorDocs(
  dataDir: string,
  vectorNamespace: string,
): PreIndexVectorDoc[] {
  const file = preIndexVectorsFile(dataDir, vectorNamespace);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as PreIndexVectorDoc[];
  } catch {
    return [];
  }
}

/** Reconstruct a pre-index document's full text: prefer the on-disk file (`files/<path>`), then
 * re-join its ordered pre-index chunk vectors' `text` as the secondary source (matching
 * `knowledge-documents.ts`'s `getKnowledgeDocumentContent` reconstruction). Read-only. */
function resolvePreIndexDocBody(
  fileContent: string | null,
  doc: KnowledgeDocumentMeta,
  preIndexVectorDocs: PreIndexVectorDoc[],
): string {
  if (fileContent !== null && fileContent.trim() !== '') return fileContent;

  const chunks = preIndexVectorDocs
    .filter((v) => v.metadata?.docId === doc.id)
    .sort(
      (a, b) =>
        Number(a.metadata?.chunkIndex ?? 0) -
        Number(b.metadata?.chunkIndex ?? 0),
    );
  return chunks.map((c) => c.text).join('\n\n');
}

/** Idempotent: a project-scoped K2 root's `storeRoot` is a pure function of
 * (dataDir, projectSlug, namespace) via the K2-landed `knowledgeStoreRootPathForNamespace`
 * helper, so re-running the migration finds the same root by `storeRoot` instead of minting a
 * second one. */
async function ensureMigrationRoot(
  store: KnowledgeStoreProvider,
  dataDir: string,
  projectSlug: string,
  namespace: string,
  vectorNamespace: string,
): Promise<KnowledgeStoreRoot> {
  const storeRoot = knowledgeStoreRootPathForNamespace(
    dataDir,
    projectSlug,
    namespace,
  );
  const existing = (await store.listRoots()).find(
    (root) => root.storeRoot === storeRoot,
  );
  if (existing) return existing;

  return store.createRoot({
    scope: { kind: 'project', projectSlug },
    adapterId: 'kit-default-store',
    storeRoot,
    displayName: `${projectSlug} (migrated from pre-index vectordb namespace ${vectorNamespace})`,
  });
}

/**
 * Migrate one pre-index (projectSlug, namespace) pair into a K2 store root + K3 index (extracted
 * from `migratePreIndexKnowledge`'s per-namespace orchestration body — code-review HIGH-2).
 * Returns `null` when the namespace has no `metadata.json`, no documents, or every document was
 * already migrated on a prior run (a genuine no-op, not a failure) — the caller doesn't count
 * this as an error or an entry in `namespacesProcessed`. Throws on a real failure (a store/index
 * error partway through); the caller catches this per-namespace so one namespace's failure never
 * discards another's already-completed result (code-review MED-3).
 */
async function migrateNamespace(
  deps: MigratePreIndexKnowledgeDeps,
  ref: PreIndexNamespaceRef,
  embedderDimensions: number,
): Promise<{
  documentsMigrated: number;
  chunksIndexed: number;
  vectorNamespace: string;
} | null> {
  const { dataDir, store, indexProvider, embedder } = deps;
  const { projectSlug, namespace } = ref;

  const storageDir = defaultKnowledgeStorageDir(
    dataDir,
    projectSlug,
    namespace,
  );
  const metadataFile = join(storageDir, 'metadata.json');
  if (!existsSync(metadataFile)) {
    // No current-format metadata authority exists for this namespace, so this
    // explicit migration has nothing it can safely snapshot.
    observeMigration('noop', 'no-metadata-file');
    return null;
  }

  observeMigration('read', 'namespace-found');
  const snapshot = await readKnowledgeDocuments(
    { storageDir, dataDir, projectSlug, namespace },
    (transaction) => {
      const docs = transaction.metadata();
      return {
        docs,
        contentById: new Map(
          docs.map((doc) => [
            doc.id,
            transaction.readDocument(doc.path || doc.filename),
          ]),
        ),
      };
    },
  );
  const { docs } = snapshot;
  if (docs.length === 0) {
    observeMigration('noop', 'empty-namespace');
    return null;
  }

  const vectorNamespace = knowledgeVectorNamespace(projectSlug, namespace);
  const preIndexVectorDocs = readPreIndexVectorDocs(dataDir, vectorNamespace);

  const root = await ensureMigrationRoot(
    store,
    dataDir,
    projectSlug,
    namespace,
    vectorNamespace,
  );
  const adapter = await store.adapterFor(root.id);

  let namespaceDocsMigrated = 0;
  let allChunksReusable = preIndexVectorDocs.length > 0;

  for (const doc of docs) {
    const docVectors = preIndexVectorDocs.filter(
      (v) => v.metadata?.docId === doc.id,
    );
    if (
      docVectors.length === 0 ||
      docVectors.some(
        (v) =>
          !Array.isArray(v.vector) || v.vector.length !== embedderDimensions,
      )
    ) {
      allChunksReusable = false;
    }
    const existingRecord = await adapter.get(doc.id);
    if (existingRecord) {
      observeMigration('noop', 'already-migrated');
      continue;
    }

    const body = resolvePreIndexDocBody(
      snapshot.contentById.get(doc.id) ?? null,
      doc,
      preIndexVectorDocs,
    );
    if (!body.trim()) {
      observeMigration('noop', 'no-content');
      continue;
    }

    await adapter.create({
      id: doc.id,
      type: 'raw',
      title: doc.filename || doc.path || doc.id,
      body,
      category: 'migrated-knowledge',
      tags: ['pre-index-import'],
      provenance: {
        agent: 'import:pre-index-knowledge',
        note: `migrated from pre-index vectordb namespace ${vectorNamespace}`,
      },
    });
    namespaceDocsMigrated += 1;
    observeMigration('write', 'created');
  }

  let chunksIndexed = 0;
  if (allChunksReusable) {
    // Compatible widths permit reuse; the source model identity is not recorded.
    const entries: KnowledgeIndexEntry[] = [];
    for (const doc of docs) {
      const docVectors = preIndexVectorDocs
        .filter((v) => v.metadata?.docId === doc.id)
        .sort(
          (a, b) =>
            Number(a.metadata?.chunkIndex ?? 0) -
            Number(b.metadata?.chunkIndex ?? 0),
        );
      docVectors.forEach((v, chunkOrdinal) => {
        entries.push({
          recordId: doc.id,
          rootId: root.id,
          chunkOrdinal: Number(v.metadata?.chunkIndex ?? chunkOrdinal),
          text: v.text,
          vector: v.vector,
          metadata: v.metadata ?? {},
        });
      });
    }
    if (entries.length > 0) {
      await indexProvider.upsert(entries);
      chunksIndexed = entries.length;
    }
  } else {
    // Missing or incompatible vectors require rebuilding the whole root.
    const rebuildResult = await indexProvider.rebuildRoot(root.id, {
      store,
      embedder,
    });
    chunksIndexed = rebuildResult.chunks;
  }

  return {
    documentsMigrated: namespaceDocsMigrated,
    chunksIndexed,
    vectorNamespace,
  };
}

/**
 * Migrate pre-index per-project knowledge (LanceDB-file vectors + on-disk document trees) into a
 * K2 store root + K3 index. No source cutover or cleanup is performed; source
 * snapshot acquisition can recover an interrupted prior transaction.
 *
 * Concurrency (SEC-2): the whole call is serialized by a single global lock — a second,
 * overlapping call throws `RebuildInProgressError` immediately rather than running.
 */
export async function migratePreIndexKnowledge(
  deps: MigratePreIndexKnowledgeDeps,
  options: MigratePreIndexKnowledgeOptions = {},
): Promise<MigratePreIndexKnowledgeResult> {
  return migrateGuard.run(MIGRATE_LOCK_KEY, () =>
    migratePreIndexKnowledgeUnguarded(deps, options),
  );
}

async function migratePreIndexKnowledgeUnguarded(
  deps: MigratePreIndexKnowledgeDeps,
  options: MigratePreIndexKnowledgeOptions,
): Promise<MigratePreIndexKnowledgeResult> {
  const { dataDir, embedder } = deps;
  const preIndexRefs = discoverPreIndexNamespaces(dataDir, options.projectSlug);

  if (preIndexRefs.length === 0) {
    observeMigration('noop', 'no-source-data');
    return {
      documentsMigrated: 0,
      chunksIndexed: 0,
      namespacesProcessed: [],
      namespaceResults: [],
    };
  }

  let documentsMigrated = 0;
  let chunksIndexed = 0;
  const namespacesProcessed: string[] = [];
  const namespaceResults: MigratePreIndexKnowledgeNamespaceResult[] = [];
  const embedderDimensions = embedder.dimensions();

  for (const ref of preIndexRefs) {
    try {
      const outcome = await migrateNamespace(deps, ref, embedderDimensions);
      if (outcome === null) continue;

      documentsMigrated += outcome.documentsMigrated;
      chunksIndexed += outcome.chunksIndexed;
      namespacesProcessed.push(outcome.vectorNamespace);
      namespaceResults.push({
        projectSlug: ref.projectSlug,
        namespace: ref.namespace,
        status: 'ok',
        documentsMigrated: outcome.documentsMigrated,
        chunksIndexed: outcome.chunksIndexed,
      });
    } catch (error) {
      // Per-namespace try/catch (code-review MED-3): one namespace's failure must not
      // discard the report of namespaces that already migrated successfully earlier in
      // this same run.
      try {
        logger.error('Knowledge namespace migration failed', {
          projectSlug: ref.projectSlug,
          namespace: ref.namespace,
          error,
        });
      } catch {
        // Logging is also an observer.
      }
      namespaceResults.push({
        projectSlug: ref.projectSlug,
        namespace: ref.namespace,
        status: 'error',
        code: 'knowledge_migration_failed',
        error: 'Knowledge namespace migration failed.',
      });
    }
  }

  return {
    documentsMigrated,
    chunksIndexed,
    namespacesProcessed,
    namespaceResults,
  };
}
