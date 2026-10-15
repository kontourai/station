import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IEmbeddingProvider } from '@kontourai/station-contracts/knowledge-index';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { getLoadablePath } from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { SqliteVecIndexProvider } from '../../../knowledge-index/sqlite-vec-index-provider.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { createKnowledgeIndexRoutes } from '../knowledge-index-routes.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { allowExtension?: boolean },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): { run: (...args: unknown[]) => unknown };
    loadExtension(path: string): void;
    close(): void;
  };
};

/** In-memory fake mirroring the FileStorageAdapter root-persistence methods —
 * same fixture shape used by `knowledge-store-provider.test.ts` and
 * `sqlite-vec-index-provider.test.ts`. */
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

/** A pure, deterministic function of the input text — no network, no
 * randomness. Copied from `sqlite-vec-index-provider.test.ts`'s own fixture. */
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

  /** `model` changes only the declared identity, never the vectors: a
   * same-width model swap must be caught by identity, not by vector drift. */
  constructor(
    private readonly dim: number = 4,
    private readonly model: string = 'stub-v1',
  ) {}

  dimensions(): number {
    return this.dim;
  }

  embeddingIdentity(): string {
    return `stub-embedder:model=${this.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => deterministicVector(t, this.dim));
  }
}

describe('knowledge-index routes', () => {
  let storeDir: string;
  let dataDir: string;
  let indexDbPath: string;
  let persistence: FakeRootPersistence;
  let store: KnowledgeStoreProvider;
  let indexProvider: SqliteVecIndexProvider;
  let embedder: StubEmbedder;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'knowledge-index-routes-store-'));
    dataDir = mkdtempSync(join(tmpdir(), 'knowledge-index-routes-data-'));
    indexDbPath = join(
      mkdtempSync(join(tmpdir(), 'knowledge-index-routes-db-')),
      'index.db',
    );
    persistence = new FakeRootPersistence();
    store = new KnowledgeStoreProvider(persistence);
    indexProvider = new SqliteVecIndexProvider({ dbPath: indexDbPath });
    embedder = new StubEmbedder(4);
  });

  afterEach(() => {
    indexProvider.close();
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  function routesApp(overrideEmbedder: IEmbeddingProvider | null = embedder) {
    return createKnowledgeIndexRoutes({
      store,
      indexProvider,
      dataDir,
      getEmbedder: () => overrideEmbedder,
    });
  }

  describe('POST /index/rebuild', () => {
    test('rebuilds a single named root and reports real record/chunk counts', async () => {
      const root = await store.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: storeDir,
        displayName: 'Personal knowledge',
      });
      const adapter = await store.adapterFor(root.id);
      await adapter.create({
        type: 'raw',
        title: 'Note one',
        body: 'first note body',
        category: 'personal',
        provenance: { agent: 'test' },
      });
      await adapter.create({
        type: 'raw',
        title: 'Note two',
        body: 'second note body',
        category: 'personal',
        provenance: { agent: 'test' },
      });

      const app = routesApp();
      const res = await app.request('/index/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootId: root.id }),
      });
      const body = await readJson<{
        success: boolean;
        data: {
          roots: Array<{
            rootId: string;
            status: string;
            records: number;
            chunks: number;
          }>;
        };
      }>(res);

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.roots).toEqual([
        { rootId: root.id, status: 'ok', records: 2, chunks: 2 },
      ]);

      const stats = await indexProvider.stats(root.id);
      expect(stats.chunks).toBe(2);
    });

    test('omitted rootId rebuilds every registered root', async () => {
      const rootA = await store.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: storeDir,
        displayName: 'Personal knowledge',
      });
      const projectDir = mkdtempSync(
        join(tmpdir(), 'knowledge-index-routes-project-'),
      );
      const rootB = await store.createRoot({
        scope: { kind: 'project', projectSlug: 'acme' },
        adapterId: 'kit-default-store',
        storeRoot: projectDir,
        displayName: 'Acme knowledge',
      });

      const adapterA = await store.adapterFor(rootA.id);
      await adapterA.create({
        type: 'raw',
        title: 'A note',
        body: 'a note body',
        category: 'personal',
        provenance: { agent: 'test' },
      });
      const adapterB = await store.adapterFor(rootB.id);
      await adapterB.create({
        type: 'raw',
        title: 'B note',
        body: 'b note body',
        category: 'project',
        provenance: { agent: 'test' },
      });

      const app = routesApp();
      const res = await app.request('/index/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await readJson<{
        success: boolean;
        data: {
          roots: Array<{
            rootId: string;
            status: string;
            records: number;
            chunks: number;
          }>;
        };
      }>(res);

      expect(body.success).toBe(true);
      expect(
        body.data.roots.sort((a, b) => a.rootId.localeCompare(b.rootId)),
      ).toEqual(
        [
          { rootId: rootA.id, status: 'ok', records: 1, chunks: 1 },
          { rootId: rootB.id, status: 'ok', records: 1, chunks: 1 },
        ].sort((a, b) => a.rootId.localeCompare(b.rootId)),
      );

      rmSync(projectDir, { recursive: true, force: true });
    });

    test('returns 400 with no embedder configured', async () => {
      const app = routesApp(null);
      const res = await app.request('/index/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/embedding provider/i);
    });

    test('returns 400 for an invalid rootId', async () => {
      const app = routesApp();
      const res = await app.request('/index/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootId: 'bad\u0000id' }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/rootId/i);
    });

    test('a per-root failure is reported alongside roots that succeed, not discarded (code-review MED-3)', async () => {
      const root = await store.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: storeDir,
        displayName: 'Personal knowledge',
      });
      const adapter = await store.adapterFor(root.id);
      await adapter.create({
        type: 'raw',
        title: 'Note one',
        body: 'first note body',
        category: 'personal',
        provenance: { agent: 'test' },
      });

      const app = routesApp();
      const res = await app.request('/index/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootId: 'root:does-not-exist' }),
      });
      const body = await readJson<{
        success: boolean;
        data?: {
          roots: Array<{
            rootId: string;
            status: string;
            error?: string;
          }>;
        };
      }>(res);

      // A single-root request targeting a nonexistent root is a wholly-failed
      // request (every targeted root errored) — a genuine 500, but the failure
      // is still reported per-root rather than as a bare, structureless message.
      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.data?.roots).toEqual([
        {
          rootId: 'root:does-not-exist',
          status: 'error',
          error: expect.any(String),
        },
      ]);
    });

    test('two concurrent rebuilds for the same root: one succeeds, the other gets 409 (SEC-2)', async () => {
      const root = await store.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: storeDir,
        displayName: 'Personal knowledge',
      });
      const adapter = await store.adapterFor(root.id);
      await adapter.create({
        type: 'raw',
        title: 'Note one',
        body: 'first note body',
        category: 'personal',
        provenance: { agent: 'test' },
      });

      const app = routesApp();
      const request = () =>
        app.request('/index/rebuild', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rootId: root.id }),
        });

      const [resA, resB] = await Promise.all([request(), request()]);
      const statuses = [resA.status, resB.status].sort();

      // Deterministic by design: `rebuildRoot`'s per-root lock is a fail-fast
      // Set-based guard (no queueing), so exactly one of the two concurrent calls
      // observes the key already taken.
      expect(statuses).toEqual([200, 409]);

      const failed = resA.status === 409 ? resA : resB;
      const failedBody = await readJson<{ success: boolean; error: string }>(
        failed,
      );
      expect(failedBody.success).toBe(false);
      expect(failedBody.error).toMatch(/already in progress/i);
    });
  });

  describe('POST /migrate', () => {
    function seedPreIndexNamespace(
      projectSlug: string,
      namespace: string,
      doc: { id: string; filename: string; body: string },
    ) {
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
        JSON.stringify([
          {
            id: doc.id,
            filename: doc.filename,
            namespace,
            path: doc.filename,
            source: 'upload',
            chunkCount: 1,
            createdAt: new Date().toISOString(),
          },
        ]),
      );
      writeFileSync(join(knowledgeDir, 'files', doc.filename), doc.body);
    }

    test('migrates a synthesized minimal pre-index namespace and reports real counts', async () => {
      seedPreIndexNamespace('acme', 'default', {
        id: 'pre-index-doc-1',
        filename: 'pre-index.md',
        body: 'pre-index migrated content',
      });

      const app = routesApp();
      const res = await app.request('/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectSlug: 'acme' }),
      });
      const body = await readJson<{
        success: boolean;
        data: {
          documentsMigrated: number;
          chunksIndexed: number;
          namespacesProcessed: string[];
          namespaceResults: Array<{
            projectSlug: string;
            namespace: string;
            status: string;
            documentsMigrated?: number;
            chunksIndexed?: number;
          }>;
        };
      }>(res);

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.documentsMigrated).toBe(1);
      expect(body.data.chunksIndexed).toBeGreaterThan(0);
      expect(body.data.namespacesProcessed).toEqual(['project-acme']);
      expect(body.data.namespaceResults).toEqual([
        {
          projectSlug: 'acme',
          namespace: 'default',
          status: 'ok',
          documentsMigrated: 1,
          chunksIndexed: body.data.chunksIndexed,
        },
      ]);

      // Non-destructive: the pre-index tree must still exist, untouched.
      expect(
        existsSync(
          join(
            dataDir,
            'projects',
            'acme',
            'knowledge',
            'default',
            'metadata.json',
          ),
        ),
      ).toBe(true);
    });

    test('no pre-index data is a zero-count no-op, not an error', async () => {
      const app = routesApp();
      const res = await app.request('/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await readJson<{
        success: boolean;
        data: {
          documentsMigrated: number;
          chunksIndexed: number;
          namespacesProcessed: string[];
          namespaceResults: unknown[];
        };
      }>(res);

      expect(body.success).toBe(true);
      expect(body.data).toEqual({
        documentsMigrated: 0,
        chunksIndexed: 0,
        namespacesProcessed: [],
        namespaceResults: [],
      });
    });

    test('returns 400 with no embedder configured', async () => {
      const app = routesApp(null);
      const res = await app.request('/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/embedding provider/i);
    });

    test('does not expose internal migration diagnostics', async () => {
      seedPreIndexNamespace('acme', 'default', {
        id: 'pre-index-doc-1',
        filename: 'pre-index.md',
        body: 'pre-index migrated content',
      });
      const app = routesApp({
        id: 'fault',
        displayName: 'Fault',
        dimensions: () => 4,
        embed: async () => {
          throw new Error('/private/station/knowledge/metadata.json');
        },
      });

      const res = await app.request('/migrate', { method: 'POST' });
      expect(res.status).toBe(500);
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(body).toEqual(
        expect.objectContaining({
          success: false,
          error: 'Pre-index knowledge migration failed',
        }),
      );
      expect(JSON.stringify(body)).not.toContain('/private/');
    });

    test('returns 400 for an invalid projectSlug', async () => {
      const app = routesApp();
      const res = await app.request('/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectSlug: '../../../evil' }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/projectSlug/i);
    });

    test('two concurrent migrate calls: one succeeds, the other gets 409 (SEC-2)', async () => {
      seedPreIndexNamespace('acme', 'default', {
        id: 'pre-index-doc-1',
        filename: 'pre-index.md',
        body: 'pre-index migrated content',
      });

      const app = routesApp();
      const request = () =>
        app.request('/migrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectSlug: 'acme' }),
        });

      const [resA, resB] = await Promise.all([request(), request()]);
      const statuses = [resA.status, resB.status].sort();

      expect(statuses).toEqual([200, 409]);

      const failed = resA.status === 409 ? resA : resB;
      const failedBody = await readJson<{ success: boolean; error: string }>(
        failed,
      );
      expect(failedBody.success).toBe(false);
      expect(failedBody.error).toMatch(/already in progress/i);
    });
  });

  describe('POST /index/search', () => {
    test('embeds the query, searches the index, and re-resolves each hit into its record fields', async () => {
      const root = await store.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: storeDir,
        displayName: 'Personal knowledge',
      });
      const adapter = await store.adapterFor(root.id);
      await adapter.create({
        type: 'raw',
        title: 'Q3 roadmap notes',
        body: 'roadmap discussion body',
        category: 'personal',
        provenance: { agent: 'test' },
      });

      const app = routesApp();
      await app.request('/index/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootId: root.id }),
      });

      const res = await app.request('/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'roadmap discussion body', topK: 5 }),
      });
      const body = await readJson<{
        success: boolean;
        data: Array<{
          recordId: string;
          rootId: string;
          score: number;
          title: string;
          excerpt: string;
          category: string;
        }>;
      }>(res);

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0]).toEqual(
        expect.objectContaining({
          rootId: root.id,
          title: 'Q3 roadmap notes',
          category: 'personal',
          excerpt: expect.any(String),
          score: expect.any(Number),
        }),
      );
    });

    test('returns 400 with no embedder configured (honest NO_EMBEDDER_ERROR, same as rebuild/migrate)', async () => {
      const app = routesApp(null);
      const res = await app.request('/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'anything' }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/embedding provider/i);
    });

    test('returns 400 for a missing/empty query', async () => {
      const app = routesApp();
      const res = await app.request('/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '' }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/query/i);
    });

    test('returns 400 for an out-of-range topK', async () => {
      const app = routesApp();
      const res = await app.request('/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'roadmap', topK: 0 }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/topK/i);
    });

    test('an empty index (no rebuild yet) returns an empty result list, not an error', async () => {
      await store.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: storeDir,
        displayName: 'Personal knowledge',
      });

      const app = routesApp();
      const res = await app.request('/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'anything at all' }),
      });
      const body = await readJson<{ success: boolean; data: unknown[] }>(res);
      expect(res.status).toBe(200);
      expect(body.data).toEqual([]);
    });

    test('rootIds scopes the search to only the named roots', async () => {
      const rootA = await store.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: storeDir,
        displayName: 'Personal knowledge',
      });
      const projectDir = mkdtempSync(
        join(tmpdir(), 'knowledge-index-routes-search-project-'),
      );
      const rootB = await store.createRoot({
        scope: { kind: 'project', projectSlug: 'acme' },
        adapterId: 'kit-default-store',
        storeRoot: projectDir,
        displayName: 'Acme knowledge',
      });

      const adapterA = await store.adapterFor(rootA.id);
      await adapterA.create({
        type: 'raw',
        title: 'Personal note',
        body: 'shared search text',
        category: 'personal',
        provenance: { agent: 'test' },
      });
      const adapterB = await store.adapterFor(rootB.id);
      await adapterB.create({
        type: 'raw',
        title: 'Acme note',
        body: 'shared search text',
        category: 'project',
        provenance: { agent: 'test' },
      });

      const app = routesApp();
      await app.request('/index/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await app.request('/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'shared search text',
          topK: 10,
          rootIds: [rootA.id],
        }),
      });
      const body = await readJson<{
        success: boolean;
        data: Array<{ rootId: string }>;
      }>(res);

      expect(res.status).toBe(200);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.every((hit) => hit.rootId === rootA.id)).toBe(true);

      rmSync(projectDir, { recursive: true, force: true });
    });
  });

  describe('POST /index/search currency (#2727, #2728) and refill', () => {
    interface SearchBody {
      success: boolean;
      data: Array<{
        recordId: string;
        rootId: string;
        title: string;
        excerpt: string;
      }>;
      index: {
        staleRoots: Array<{ rootId: string; reason: string }>;
        staleRecords: number;
        scanLimitReached: boolean;
      };
    }

    const makeRootDirectory = trackTempDirs();

    async function createRoot(displayName: string, projectSlug?: string) {
      const dir = makeRootDirectory('knowledge-index-currency-');
      return store.createRoot({
        scope: projectSlug
          ? { kind: 'project', projectSlug }
          : { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: dir,
        displayName,
      });
    }

    async function addRecord(rootId: string, title: string, body: string) {
      const adapter = await store.adapterFor(rootId);
      return adapter.create({
        type: 'raw',
        title,
        body,
        category: 'personal',
        provenance: { agent: 'test' },
      });
    }

    function appWith(
      activeEmbedder: IEmbeddingProvider,
      mayReadHitRoot?: (request: Request, root: KnowledgeStoreRoot) => boolean,
    ) {
      return createKnowledgeIndexRoutes({
        store,
        indexProvider,
        dataDir,
        getEmbedder: () => activeEmbedder,
        ...(mayReadHitRoot ? { mayReadHitRoot } : {}),
      });
    }

    async function rebuild(
      app: ReturnType<typeof appWith>,
      rootId?: string,
    ): Promise<void> {
      const res = await app.request('/index/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rootId ? { rootId } : {}),
      });
      expect(res.status).toBe(200);
    }

    async function search(
      app: ReturnType<typeof appWith>,
      query: string,
      topK = 10,
    ): Promise<SearchBody> {
      const res = await app.request('/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, topK }),
      });
      expect(res.status).toBe(200);
      return readJson<SearchBody>(res);
    }

    test('a same-width model change withholds the old generation and reports the root; the same identity still answers', async () => {
      const root = await createRoot('Personal knowledge');
      await addRecord(root.id, 'Roadmap', 'roadmap discussion body');
      const v1 = new StubEmbedder(4, 'model-a');
      const v2 = new StubEmbedder(4, 'model-b');
      await rebuild(appWith(v1), root.id);

      // Control: the generation that built the index still answers.
      const control = await search(appWith(v1), 'roadmap discussion body');
      expect(control.data.map((r) => r.title)).toEqual(['Roadmap']);
      expect(control.index.staleRoots).toEqual([]);

      // Same width, different model: the vectors are byte-identical here,
      // so only the identity can keep them out.
      const swapped = await search(appWith(v2), 'roadmap discussion body');
      expect(swapped.data).toEqual([]);
      expect(swapped.index.staleRoots).toEqual([
        { rootId: root.id, reason: 'embedding-changed' },
      ]);

      await rebuild(appWith(v2), root.id);
      const recovered = await search(appWith(v2), 'roadmap discussion body');
      expect(recovered.data.map((r) => r.title)).toEqual(['Roadmap']);
      expect(recovered.index.staleRoots).toEqual([]);
    });

    test('a partial rebuild never mixes generations, and the split survives a restart', async () => {
      const rootA = await createRoot('Personal knowledge');
      const rootB = await createRoot('Acme knowledge', 'acme');
      await addRecord(rootA.id, 'A note', 'shared search text');
      await addRecord(rootB.id, 'B note', 'shared search text');
      const v1 = new StubEmbedder(4, 'model-a');
      const v2 = new StubEmbedder(4, 'model-b');
      await rebuild(appWith(v1));
      await rebuild(appWith(v2), rootA.id);

      const assertSplit = async () => {
        const result = await search(appWith(v2), 'shared search text');
        expect(result.data.map((r) => r.rootId)).toEqual([rootA.id]);
        expect(result.index.staleRoots).toEqual([
          { rootId: rootB.id, reason: 'embedding-changed' },
        ]);
      };
      await assertSplit();

      indexProvider.close();
      indexProvider = new SqliteVecIndexProvider({ dbPath: indexDbPath });
      await assertSplit();
    });

    test('an index file from before embedding generations is reported unknown and replaced by the next rebuild', async () => {
      const root = await createRoot('Personal knowledge');
      await addRecord(root.id, 'Legacy', 'legacy indexed body');
      indexProvider.close();
      // The exact table and metadata the previous index format wrote.
      const legacy = new DatabaseSync(indexDbPath, { allowExtension: true });
      legacy.loadExtension(getLoadablePath());
      legacy.exec(
        'CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      );
      legacy.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(
        store TEXT partition key,
        embedding float[4] distance_metric=cosine,
        +recordId TEXT,
        +chunkOrdinal INTEGER,
        +text TEXT,
        +metadata TEXT
      )`);
      legacy
        .prepare("INSERT INTO index_meta(key, value) VALUES ('dimension', '4')")
        .run();
      const [vector] = await embedder.embed(['legacy indexed body']);
      const record = (
        await (await store.adapterFor(root.id)).listByType('raw')
      )[0];
      legacy
        .prepare(
          'INSERT INTO vec_items(rowid, store, embedding, recordId, chunkOrdinal, text, metadata) VALUES (null, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          root.id,
          new Uint8Array(new Float32Array(vector).buffer),
          record.id,
          0n,
          'legacy indexed body',
          '{}',
        );
      legacy.close();
      indexProvider = new SqliteVecIndexProvider({ dbPath: indexDbPath });

      const before = await search(appWith(embedder), 'legacy indexed body');
      expect(before.data).toEqual([]);
      expect(before.index.staleRoots).toEqual([
        { rootId: root.id, reason: 'unknown-generation' },
      ]);

      await rebuild(appWith(embedder), root.id);
      const after = await search(appWith(embedder), 'legacy indexed body');
      expect(after.data.map((r) => r.title)).toEqual(['Legacy']);
      expect(after.index.staleRoots).toEqual([]);
    });

    test('an edited body withholds the old excerpt until rebuild; a title edit stays current', async () => {
      const root = await createRoot('Personal knowledge');
      const id = await addRecord(root.id, 'Plan', 'original plan body');
      const app = appWith(embedder);
      await rebuild(app, root.id);
      const adapter = await store.adapterFor(root.id);

      await adapter.update(id, { title: 'Plan, renamed' }, { agent: 'test' });
      const renamed = await search(app, 'original plan body');
      expect(renamed.data).toEqual([
        expect.objectContaining({
          recordId: id,
          title: 'Plan, renamed',
          excerpt: 'original plan body',
        }),
      ]);
      expect(renamed.index.staleRecords).toBe(0);

      await adapter.update(
        id,
        { body: 'rewritten plan body' },
        { agent: 'test' },
      );
      const edited = await search(app, 'original plan body');
      expect(edited.data).toEqual([]);
      expect(edited.index.staleRecords).toBe(1);

      await rebuild(app, root.id);
      const rebuilt = await search(app, 'rewritten plan body');
      expect(rebuilt.data).toEqual([
        expect.objectContaining({
          recordId: id,
          excerpt: 'rewritten plan body',
        }),
      ]);
      expect(rebuilt.index.staleRecords).toBe(0);
    });

    test('unreadable hits ranked above readable ones are refilled: topK returns min(topK, readable)', async () => {
      const readable = await createRoot('Personal knowledge');
      const hidden = await createRoot('Hidden knowledge', 'hidden');
      // Five hidden records match the query exactly, so they hold the top
      // five ranks; the three readable ones rank below all of them.
      for (let i = 0; i < 5; i += 1) {
        await addRecord(hidden.id, `Hidden ${i}`, 'quarterly revenue forecast');
      }
      for (let i = 0; i < 3; i += 1) {
        await addRecord(readable.id, `Readable ${i}`, `readable note ${i}`);
      }
      // Explicit vectors: every readable note is similar to the query, but
      // less similar than the exact hidden matches.
      const ranked: IEmbeddingProvider = {
        id: 'ranked-stub',
        displayName: 'Ranked stub',
        dimensions: () => 4,
        embed: async (texts) =>
          texts.map((text) => {
            const match = /^readable note (\d)$/.exec(text);
            return match
              ? [1, 0.2 * (Number(match[1]) + 1), 0, 0]
              : [1, 0, 0, 0];
          }),
      };
      const app = appWith(ranked, (_request, root) => root.id !== hidden.id);
      await rebuild(app);

      const two = await search(app, 'quarterly revenue forecast', 2);
      expect(two.data).toHaveLength(2);
      expect(two.data.every((r) => r.rootId === readable.id)).toBe(true);

      const all = await search(app, 'quarterly revenue forecast', 10);
      expect(all.data).toHaveLength(3);
      expect(all.data.every((r) => r.rootId === readable.id)).toBe(true);
      expect(all.index.scanLimitReached).toBe(false);
      // Roots the caller cannot read are never named, stale or not.
      expect(JSON.stringify(all)).not.toContain(hidden.id);
    });
  });
});
