import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IEmbeddingProvider } from '@kontourai/station-contracts/knowledge-index';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { SqliteVecIndexProvider } from '../../../knowledge-index/sqlite-vec-index-provider.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { createKnowledgeIndexRoutes } from '../knowledge-index-routes.js';

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

  constructor(private readonly dim: number = 4) {}

  dimensions(): number {
    return this.dim;
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
        dimensions: () => {
          throw new Error('/private/station/knowledge/metadata.json');
        },
        embed: async () => [],
      });

      const res = await app.request('/migrate', { method: 'POST' });
      expect(res.status).toBe(500);
      expect(await readJson(res)).toEqual({
        success: false,
        error: 'Pre-index knowledge migration failed',
      });
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
});
