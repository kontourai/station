/**
 * Migration tests — empty/no-op and data-carrying paths (AC3-nondestructive-migration).
 *
 * Self-contained fixtures only: this file deliberately does NOT import
 * `__tests__/__fixtures__/corpus.ts` (owned by a parallel Wave 5 task; sharing it here would
 * create a merge collision) — the small deterministic-embedder/fake-persistence helpers below
 * are copied from the same pattern already used by `sqlite-vec-index-provider.test.ts` and
 * `src-server/routes/knowledge/__tests__/knowledge-index.routes.test.ts`.
 *
 * Case (a) (empty/no-op) is the "real-home-copy proof" named in the plan: a temp
 * `~/.station`-shaped home with representative non-knowledge content and NO pre-index
 * `vectordb/`/`projects/*\/knowledge/` trees (matching the real home's actual current shape).
 * Case (b) (data-carrying) synthesizes a pre-index fixture matching `lancedb-provider.ts:24-40`'s
 * exact flat-JSON shape plus `knowledge-storage.ts`'s `metadata.json`/`files/` tree, and proves
 * vector reuse (not re-embedding) directly: `SqliteVecIndexProvider.search()` takes a raw query
 * vector (not text), so querying with one of the ORIGINAL pre-index vectors and getting the
 * migrated record back as a near-exact hit (score ~1) is direct evidence the stored vector *is*
 * the reused pre-index vector, not a re-embedding of the text (the stub embedder's own `embed()` of
 * that same text is asserted to produce a DIFFERENT vector, so a false-positive "reuse" reading
 * via re-embedding coincidence is ruled out).
 *
 * Every pre-index-file assertion in this suite checks BOTH content hash and mtime — per the plan's
 * Stop-short risk, a migration that "runs without throwing" but silently opens pre-index files in a
 * write mode (even without ever calling `write`) would still risk touching mtimes; asserting
 * mtimes unchanged (not just hashes) catches that class of bug that a hash-only check would miss.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IEmbeddingProvider } from '@kontourai/station-contracts/knowledge-index';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import { knowledgeMigrationOps } from '../../telemetry/metrics.js';
import { migratePreIndexKnowledge } from '../migrate-pre-index-knowledge.js';
import { SqliteVecIndexProvider } from '../sqlite-vec-index-provider.js';

// ── Self-contained fixtures (no shared __fixtures__ import — see module doc) ────────────────

/** In-memory fake mirroring the FileStorageAdapter root-persistence methods — same shape
 * used by `knowledge-index.routes.test.ts` and `sqlite-vec-index-provider.test.ts`. */
class FakeRootPersistence {
  private roots: KnowledgeStoreRoot[] = [];

  listKnowledgeStoreRoots(): KnowledgeStoreRoot[] {
    return this.roots.slice();
  }

  saveKnowledgeStoreRoot(root: KnowledgeStoreRoot): void {
    const idx = this.roots.findIndex((r) => r.id === root.id);
    if (idx >= 0) this.roots[idx] = root;
    else this.roots.push(root);
  }

  removeKnowledgeStoreRoot(id: string): void {
    const index = this.roots.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`Knowledge store root '${id}' not found`);
    this.roots.splice(index, 1);
  }
}

/** A pure, deterministic function of the input text — no network, no randomness. Used only to
 * PROVE the embedder was never invoked to reuse pre-index vectors (case b/c) or, when it should be
 * invoked, to actually drive a real re-embed (case d). */
function deterministicVector(text: string, dim: number): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i += 1) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }
  const vec: number[] = [];
  for (let i = 0; i < dim; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    vec.push((seed / 0xffffffff) * 2 - 1);
  }
  return vec;
}

class StubEmbedder implements IEmbeddingProvider {
  readonly id = 'stub-embedder';
  readonly displayName = 'Deterministic stub embedder';

  constructor(private readonly dim: number) {}

  dimensions(): number {
    return this.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => deterministicVector(t, this.dim));
  }
}

// ── File-tree fingerprinting: hash AND mtime, not just "no exception" ───────────────────────

interface FileFingerprint {
  sha256: string;
  mtimeMs: number;
  size: number;
}

/** Recursive file inventory keyed by path-relative-to-`root`: sha256 content hash + mtime +
 * size for every file under `root`. Sufficient to detect ANY add/remove/content/touch mutation
 * anywhere in the subtree — deliberately stronger than a record-count or "it didn't throw"
 * check (see the plan's Stop-short risk this task exists to close). */
function snapshotTree(root: string): Map<string, FileFingerprint> {
  const out = new Map<string, FileFingerprint>();
  if (!existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(full);
      const sha256 = createHash('sha256')
        .update(readFileSync(full))
        .digest('hex');
      out.set(full.slice(root.length + 1), {
        sha256,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  };
  walk(root);
  return out;
}

/** Wait past typical filesystem mtime-resolution granularity so a rewrite-with-identical-bytes
 * would still show up as a changed `mtimeMs` in a before/after `snapshotTree` diff. */
function waitPastMtimeResolution(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

interface PreIndexFixture {
  projectSlug: string;
  namespace: string;
  vectorNamespace: string;
  docs: Array<{ id: string; filename: string; body: string }>;
  preIndexVectorDocs: Array<{
    id: string;
    vector: number[];
    text: string;
    metadata: { docId: string; chunkIndex: number };
  }>;
}

/**
 * Synthesize a pre-index fixture tree matching `lancedb-provider.ts:24-40`'s exact flat-JSON
 * vector shape (`{id, vector, text, metadata}` per namespace, at
 * `{dataDir}/vectordb/<vectorNamespace>/vectors.json`) plus `knowledge-storage.ts`'s
 * `metadata.json`/`files/` document tree (`{dataDir}/projects/<slug>/knowledge/<namespace>/`).
 *
 * Pre-index vectors are one-hot (orthogonal across docs) so a nearest-neighbor query against one
 * doc's exact pre-index vector can never accidentally also match the other doc — a precise probe
 * for "did the index reuse THIS doc's vector," not just "did the index return something."
 */
function seedPreIndexFixture(
  dataDir: string,
  opts: { vectorDim: number },
): PreIndexFixture {
  const projectSlug = 'acme';
  const namespace = 'default';
  // knowledgeVectorNamespace(projectSlug, 'default') === `project-${projectSlug}` per
  // knowledge-storage.ts — transcribed literally here rather than imported, so this fixture
  // stays a pure structural mirror of the pre-index format (see migrate-pre-index-knowledge.ts's own
  // module doc for the same discipline).
  const vectorNamespace = `project-${projectSlug}`;

  const docs = [
    {
      id: 'pre-index-doc-1',
      filename: 'doc-1.md',
      body: 'Doc one body content about topic A.',
    },
    {
      id: 'pre-index-doc-2',
      filename: 'doc-2.md',
      body: 'Doc two body content about topic B.',
    },
  ];

  const knowledgeDir = join(
    dataDir,
    'projects',
    projectSlug,
    'knowledge',
    namespace,
  );
  mkdirSync(join(knowledgeDir, 'files'), { recursive: true });
  writeFileSync(
    join(knowledgeDir, 'metadata.json'),
    JSON.stringify(
      docs.map((doc) => ({
        id: doc.id,
        filename: doc.filename,
        namespace,
        path: doc.filename,
        source: 'upload',
        chunkCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
      null,
      2,
    ),
    'utf-8',
  );
  for (const doc of docs) {
    writeFileSync(join(knowledgeDir, 'files', doc.filename), doc.body, 'utf-8');
  }

  const vectorFor = (index: number): number[] =>
    Array.from({ length: opts.vectorDim }, (_, i) =>
      i === index % opts.vectorDim ? 1 : 0,
    );

  const preIndexVectorDocs = docs.map((doc, i) => ({
    id: `${doc.id}-chunk-0`,
    vector: vectorFor(i),
    text: doc.body,
    metadata: { docId: doc.id, chunkIndex: 0 },
  }));

  const vectorsDir = join(dataDir, 'vectordb', vectorNamespace);
  mkdirSync(vectorsDir, { recursive: true });
  writeFileSync(
    join(vectorsDir, 'vectors.json'),
    JSON.stringify(preIndexVectorDocs, null, 2),
    'utf-8',
  );

  return { projectSlug, namespace, vectorNamespace, docs, preIndexVectorDocs };
}

function snapshotPreIndexFiles(dataDir: string, projectSlug: string) {
  return {
    vectordb: snapshotTree(join(dataDir, 'vectordb')),
    knowledge: snapshotTree(
      join(dataDir, 'projects', projectSlug, 'knowledge'),
    ),
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────────────────────

describe('migratePreIndexKnowledge', () => {
  let homeDir: string;
  let indexDbDir: string;
  let persistence: FakeRootPersistence;
  let store: KnowledgeStoreProvider;
  let indexProvider: SqliteVecIndexProvider;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'migration-test-home-'));
    indexDbDir = mkdtempSync(join(tmpdir(), 'migration-test-index-'));
    persistence = new FakeRootPersistence();
    store = new KnowledgeStoreProvider(persistence);
    indexProvider = new SqliteVecIndexProvider({
      dbPath: join(indexDbDir, 'index.db'),
    });
  });

  afterEach(() => {
    indexProvider.close();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(indexDbDir, { recursive: true, force: true });
  });

  // ── (a) Empty/no-op — the real-home-copy proof ──────────────────────────────────────────

  test('empty/no-op: a representative ~/.station-shaped home with zero pre-index knowledge data is left byte-for-byte and mtime-for-mtime unchanged', async () => {
    // Representative non-knowledge home content mirroring the real home's actual shape
    // (config/, projects/<slug>/project.json + layouts/) — NO vectordb/ and NO
    // projects/*/knowledge/ anywhere, matching this session's pickup-Probe finding that the
    // real `~/.station` home currently carries zero pre-index knowledge data.
    mkdirSync(join(homeDir, 'config'), { recursive: true });
    writeFileSync(
      join(homeDir, 'config', 'settings.json'),
      JSON.stringify({ theme: 'dark' }, null, 2),
      'utf-8',
    );
    mkdirSync(join(homeDir, 'projects', 'acme', 'layouts'), {
      recursive: true,
    });
    writeFileSync(
      join(homeDir, 'projects', 'acme', 'project.json'),
      JSON.stringify({ slug: 'acme', name: 'Acme' }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(homeDir, 'projects', 'acme', 'layouts', 'default.json'),
      JSON.stringify({ slug: 'default', panes: [] }, null, 2),
      'utf-8',
    );

    await waitPastMtimeResolution();
    const before = snapshotTree(homeDir);
    expect(before.size).toBeGreaterThan(0);

    const embedder = new StubEmbedder(4);
    const result = await migratePreIndexKnowledge({
      dataDir: homeDir,
      store,
      indexProvider,
      embedder,
    });

    expect(result).toEqual({
      documentsMigrated: 0,
      chunksIndexed: 0,
      namespacesProcessed: [],
      namespaceResults: [],
    });

    // The ENTIRE tree is unchanged — every file's hash AND mtime, not merely "no exception".
    const after = snapshotTree(homeDir);
    expect(after).toEqual(before);

    // No new pre-index or K2-store directories were created anywhere under the home.
    expect(existsSync(join(homeDir, 'vectordb'))).toBe(false);
    expect(existsSync(join(homeDir, 'knowledge-stores'))).toBe(false);
    expect(await store.listRoots()).toEqual([]);
  });

  // ── (b) Data-carrying ────────────────────────────────────────────────────────────────────

  test('data-carrying: pre-index files stay untouched, the K2 store gets matching raw records, and the index proves vector reuse (not re-embedding)', async () => {
    const dim = 4;
    const embedder = new StubEmbedder(dim);
    const fixture = seedPreIndexFixture(homeDir, { vectorDim: dim });

    // Sanity precondition for the reuse assertion below: the stub embedder's real embed()
    // output for each doc's body must NOT equal the pre-index vector we seeded. If it did, a
    // "the index returns this doc for its pre-index vector" assertion could pass even if the
    // implementation silently re-embedded instead of reusing — this rules that out.
    for (const doc of fixture.docs) {
      const [embedded] = await embedder.embed([doc.body]);
      const preIndex = fixture.preIndexVectorDocs.find(
        (v) => v.metadata.docId === doc.id,
      )?.vector;
      expect(embedded).not.toEqual(preIndex);
    }

    await waitPastMtimeResolution();
    const beforePreIndex = snapshotPreIndexFiles(homeDir, fixture.projectSlug);
    expect(beforePreIndex.vectordb.size).toBeGreaterThan(0);
    expect(beforePreIndex.knowledge.size).toBeGreaterThan(0);

    const result = await migratePreIndexKnowledge(
      { dataDir: homeDir, store, indexProvider, embedder },
      { projectSlug: fixture.projectSlug },
    );

    expect(result.documentsMigrated).toBe(2);
    expect(result.chunksIndexed).toBe(2);
    expect(result.namespacesProcessed).toEqual([fixture.vectorNamespace]);
    expect(result.namespaceResults).toEqual([
      {
        projectSlug: fixture.projectSlug,
        namespace: fixture.namespace,
        status: 'ok',
        documentsMigrated: 2,
        chunksIndexed: 2,
      },
    ]);

    // (i) Pre-index files byte-identical AND mtime-identical after migration.
    const afterPreIndex = snapshotPreIndexFiles(homeDir, fixture.projectSlug);
    expect(afterPreIndex.vectordb).toEqual(beforePreIndex.vectordb);
    expect(afterPreIndex.knowledge).toEqual(beforePreIndex.knowledge);

    // (ii) A new K2 store root now contains matching Kit `raw` records: ids reused from the
    // pre-index doc ids, provenance mentions the migration.
    const roots = await store.listRoots();
    expect(roots).toHaveLength(1);
    const root = roots[0];
    expect(root.scope).toEqual({
      kind: 'project',
      projectSlug: fixture.projectSlug,
    });
    const adapter = await store.adapterFor(root.id);
    for (const doc of fixture.docs) {
      const record = await adapter.get(doc.id);
      expect(record).not.toBeNull();
      expect(record?.id).toBe(doc.id);
      expect(record?.type).toBe('raw');
      expect(record?.body).toBe(doc.body);
      expect(record?.provenance.note).toMatch(
        /migrated from pre-index vectordb namespace/,
      );
    }

    // (iii) Vector reuse, not re-embedding. `SqliteVecIndexProvider.search()` takes a raw
    // query VECTOR (not text) — so querying with one of the ORIGINAL pre-index vectors and
    // getting that doc's migrated record back as a near-exact hit (score ~1, i.e. cosine
    // distance ~0) is direct evidence the index stored the reused pre-index vector verbatim,
    // not a fresh embedding of the text (which the precondition above proved would differ).
    for (const doc of fixture.docs) {
      const preIndexVector = fixture.preIndexVectorDocs.find(
        (v) => v.metadata.docId === doc.id,
      )?.vector as number[];
      const hits = await indexProvider.search(preIndexVector, {
        topK: 1,
        rootIds: [root.id],
      });
      expect(hits).toHaveLength(1);
      expect(hits[0].recordId).toBe(doc.id);
      expect(hits[0].score).toBeCloseTo(1, 5);
    }
  });

  // ── (c) Idempotent re-run ────────────────────────────────────────────────────────────────

  test('idempotent re-run: second migration call is a zero-count no-op, the store record count is unchanged, and pre-index files remain untouched', async () => {
    const dim = 4;
    const embedder = new StubEmbedder(dim);
    const fixture = seedPreIndexFixture(homeDir, { vectorDim: dim });

    const first = await migratePreIndexKnowledge(
      { dataDir: homeDir, store, indexProvider, embedder },
      { projectSlug: fixture.projectSlug },
    );
    expect(first.documentsMigrated).toBe(2);

    const roots = await store.listRoots();
    expect(roots).toHaveLength(1);
    const adapter = await store.adapterFor(roots[0].id);
    const recordsAfterFirst = await adapter.listByType('raw', {
      includeRetired: true,
    });
    const chunksAfterFirst = (await indexProvider.stats(roots[0].id)).chunks;

    await waitPastMtimeResolution();
    const beforePreIndex = snapshotPreIndexFiles(homeDir, fixture.projectSlug);

    const second = await migratePreIndexKnowledge(
      { dataDir: homeDir, store, indexProvider, embedder },
      { projectSlug: fixture.projectSlug },
    );

    // No duplicate records are created. The derived index is deliberately re-upserted so a
    // prior record-create/index-failure boundary remains repairable on the next run.
    expect(second).toEqual({
      documentsMigrated: 0,
      chunksIndexed: 2,
      namespacesProcessed: [fixture.vectorNamespace],
      namespaceResults: [
        {
          projectSlug: fixture.projectSlug,
          namespace: fixture.namespace,
          status: 'ok',
          documentsMigrated: 0,
          chunksIndexed: 2,
        },
      ],
    });

    // Record count in the store is unchanged — no duplicate writes.
    const recordsAfterSecond = await adapter.listByType('raw', {
      includeRetired: true,
    });
    expect(recordsAfterSecond).toHaveLength(recordsAfterFirst.length);
    expect(new Set(recordsAfterSecond.map((r) => r.id))).toEqual(
      new Set(recordsAfterFirst.map((r) => r.id)),
    );

    // The index wasn't touched again either (no re-indexing on a no-op re-run).
    const chunksAfterSecond = (await indexProvider.stats(roots[0].id)).chunks;
    expect(chunksAfterSecond).toBe(chunksAfterFirst);

    // Pre-index files still untouched.
    const afterPreIndex = snapshotPreIndexFiles(homeDir, fixture.projectSlug);
    expect(afterPreIndex.vectordb).toEqual(beforePreIndex.vectordb);
    expect(afterPreIndex.knowledge).toEqual(beforePreIndex.knowledge);
  });

  // ── (d) Dimension-mismatch fallback ──────────────────────────────────────────────────────

  test('dimension mismatch rebuild: an embedder dimension different from the pre-index vectors forces re-embedding instead of reusing incompatible vectors', async () => {
    const preIndexDim = 4;
    const embedderDim = 6;
    const embedder = new StubEmbedder(embedderDim);
    const fixture = seedPreIndexFixture(homeDir, { vectorDim: preIndexDim });

    await waitPastMtimeResolution();
    const beforePreIndex = snapshotPreIndexFiles(homeDir, fixture.projectSlug);

    const result = await migratePreIndexKnowledge(
      { dataDir: homeDir, store, indexProvider, embedder },
      { projectSlug: fixture.projectSlug },
    );

    expect(result.documentsMigrated).toBe(2);
    // Both docs re-embedded into exactly one chunk each (short bodies, well under
    // chunkKnowledgeText's default chunk size) via the rebuildRoot path.
    expect(result.chunksIndexed).toBe(2);
    expect(result.namespacesProcessed).toEqual([fixture.vectorNamespace]);

    // Pre-index files untouched despite the dimension mismatch forcing a full re-embed.
    const afterPreIndex = snapshotPreIndexFiles(homeDir, fixture.projectSlug);
    expect(afterPreIndex.vectordb).toEqual(beforePreIndex.vectordb);
    expect(afterPreIndex.knowledge).toEqual(beforePreIndex.knowledge);

    const roots = await store.listRoots();
    const root = roots[0];

    // The index is searchable at the NEW (embedder) dimension: a query built from the
    // embedder's own output for one doc's body finds that doc.
    const [queryVector] = await embedder.embed([fixture.docs[0].body]);
    expect(queryVector).toHaveLength(embedderDim);
    const hits = await indexProvider.search(queryVector, {
      topK: 5,
      rootIds: [root.id],
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.recordId === fixture.docs[0].id)).toBe(true);

    // ...and NOT silently corrupted into accepting the old (pre-index-dimension) vectors: the
    // table was rebuilt at the new width, so a query at the OLD dimension is rejected
    // outright rather than matched against truncated/garbage data (see
    // `SqliteVecIndexProvider.search()`'s own configured-dimension guard).
    const preIndexDimVector = fixture.preIndexVectorDocs[0].vector;
    await expect(
      indexProvider.search(preIndexDimVector, { topK: 5, rootIds: [root.id] }),
    ).rejects.toThrow(/dimensions/);
  });

  test('retries derived indexing for an existing migrated record without exposing diagnostics', async () => {
    const dim = 4;
    const embedder = new StubEmbedder(dim);
    const fixture = seedPreIndexFixture(homeDir, { vectorDim: dim });
    const upsert = vi
      .spyOn(indexProvider, 'upsert')
      .mockRejectedValueOnce(
        new Error(`/private/${fixture.projectSlug}/secret`),
      );

    const first = await migratePreIndexKnowledge(
      { dataDir: homeDir, store, indexProvider, embedder },
      { projectSlug: fixture.projectSlug },
    );
    expect(first.namespaceResults).toEqual([
      {
        projectSlug: fixture.projectSlug,
        namespace: fixture.namespace,
        status: 'error',
        code: 'knowledge_migration_failed',
        error: 'Knowledge namespace migration failed.',
      },
    ]);
    expect(JSON.stringify(first)).not.toContain('/private/');

    const second = await migratePreIndexKnowledge(
      { dataDir: homeDir, store, indexProvider, embedder },
      { projectSlug: fixture.projectSlug },
    );
    expect(second.documentsMigrated).toBe(0);
    expect(second.chunksIndexed).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  test('metric observer failures cannot strand record creation before indexing', async () => {
    const dim = 4;
    const fixture = seedPreIndexFixture(homeDir, { vectorDim: dim });
    const originalAdd = knowledgeMigrationOps.add.bind(knowledgeMigrationOps);
    const metric = vi
      .spyOn(knowledgeMigrationOps, 'add')
      .mockImplementation((value, attributes) => {
        if (attributes?.outcome !== undefined) {
          throw new Error('observer unavailable');
        }
        originalAdd(value, attributes);
      });

    const result = await migratePreIndexKnowledge(
      {
        dataDir: homeDir,
        store,
        indexProvider,
        embedder: new StubEmbedder(dim),
      },
      { projectSlug: fixture.projectSlug },
    );

    expect(result.documentsMigrated).toBe(2);
    expect(result.chunksIndexed).toBe(2);
    metric.mockRestore();
  });
});
