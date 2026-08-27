import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  IEmbeddingProvider,
  KnowledgeIndexEntry,
} from '@kontourai/station-contracts/knowledge-index';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import { RebuildInProgressError } from '../inflight-guard.js';
import { SqliteVecIndexProvider } from '../sqlite-vec-index-provider.js';

/** In-memory fake mirroring the FileStorageAdapter root-persistence methods —
 * copied from `knowledge-store-provider.test.ts`'s own fixture so this suite has no
 * dependency on the real storage adapter. */
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

/** A pure, deterministic function of the input text — no network, no randomness.
 * Same text always produces the same vector, so index-vs-query embeddings for the
 * same string are guaranteed identical (distance 0). */
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

function entry(
  rootId: string,
  recordId: string,
  chunkOrdinal: number,
  vector: number[],
  text = recordId,
  metadata: Record<string, unknown> = {},
): KnowledgeIndexEntry {
  return { rootId, recordId, chunkOrdinal, text, vector, metadata };
}

describe('SqliteVecIndexProvider', () => {
  let dir: string;
  let provider: SqliteVecIndexProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-vec-index-'));
    provider = new SqliteVecIndexProvider({ dbPath: join(dir, 'index.db') });
  });

  afterEach(() => {
    provider.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('exposes the contract-required id/displayName', () => {
    expect(provider.id).toBe('sqlite-vec');
    expect(typeof provider.displayName).toBe('string');
  });

  test('search against a never-created index returns empty results, not an error', async () => {
    const hits = await provider.search([1, 0, 0], { topK: 5 });
    expect(hits).toEqual([]);
  });

  test('upsert + search orders hits by cosine similarity, best first', async () => {
    await provider.upsert([
      entry('root:a', 'rec-close', 0, [1, 0, 0]),
      entry('root:a', 'rec-mid', 0, [0.7, 0.7, 0]),
      entry('root:a', 'rec-far', 0, [0, 1, 0]),
    ]);

    const hits = await provider.search([1, 0, 0], { topK: 3 });

    expect(hits.map((h) => h.recordId)).toEqual([
      'rec-close',
      'rec-mid',
      'rec-far',
    ]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[1].score).toBeGreaterThan(hits[2].score);
    // exact self-match: cosine distance 0 -> score 1
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  test('upsert is idempotent per (rootId, recordId, chunkOrdinal) — re-upserting replaces, not duplicates', async () => {
    await provider.upsert([
      entry('root:a', 'rec-1', 0, [1, 0, 0], 'first text'),
    ]);
    await provider.upsert([
      entry('root:a', 'rec-1', 0, [0, 1, 0], 'second text'),
    ]);

    expect((await provider.stats('root:a')).chunks).toBe(1);

    const hits = await provider.search([0, 1, 0], { topK: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('second text');
  });

  test('removeByRecord removes only the targeted record', async () => {
    await provider.upsert([
      entry('root:a', 'rec-1', 0, [1, 0, 0]),
      entry('root:a', 'rec-2', 0, [0, 1, 0]),
    ]);

    await provider.removeByRecord('root:a', ['rec-1']);

    expect((await provider.stats('root:a')).chunks).toBe(1);
    const hits = await provider.search([1, 0, 0], { topK: 5 });
    expect(hits.map((h) => h.recordId)).toEqual(['rec-2']);
  });

  test('removeRoot drops only that root partition — zero cross-store leakage', async () => {
    await provider.upsert([
      entry('root:a', 'rec-a', 0, [1, 0, 0]),
      entry('root:b', 'rec-b', 0, [1, 0, 0]),
    ]);

    await provider.removeRoot('root:a');

    expect((await provider.stats('root:a')).chunks).toBe(0);
    expect((await provider.stats('root:b')).chunks).toBe(1);

    const hits = await provider.search([1, 0, 0], { topK: 5 });
    expect(hits.map((h) => h.recordId)).toEqual(['rec-b']);
    expect(hits.every((h) => h.rootId === 'root:b')).toBe(true);
  });

  test('search rootIds scoping excludes other roots even when they rank higher', async () => {
    await provider.upsert([
      entry('root:a', 'rec-a', 0, [1, 0, 0]),
      entry('root:b', 'rec-b', 0, [1, 0, 0]),
    ]);

    const scoped = await provider.search([1, 0, 0], {
      topK: 5,
      rootIds: ['root:a'],
    });

    expect(scoped.map((h) => h.recordId)).toEqual(['rec-a']);
    expect(scoped.every((h) => h.rootId === 'root:a')).toBe(true);
  });

  test('threshold excludes low-similarity hits', async () => {
    await provider.upsert([
      entry('root:a', 'rec-close', 0, [1, 0, 0]),
      entry('root:a', 'rec-orthogonal', 0, [0, 1, 0]),
    ]);

    const hits = await provider.search([1, 0, 0], { topK: 5, threshold: 0.5 });
    expect(hits.map((h) => h.recordId)).toEqual(['rec-close']);
  });

  test('metadata filter applies an equality predicate', async () => {
    await provider.upsert([
      entry('root:a', 'rec-x', 0, [1, 0, 0], 'rec-x', { category: 'x' }),
      entry('root:a', 'rec-y', 0, [1, 0, 0], 'rec-y', { category: 'y' }),
    ]);

    const hits = await provider.search([1, 0, 0], {
      topK: 5,
      filter: { category: 'y' },
    });
    expect(hits.map((h) => h.recordId)).toEqual(['rec-y']);
  });

  test('dimension mismatch forces a full table rebuild instead of corrupting inserts', async () => {
    await provider.upsert([entry('root:a', 'rec-1', 0, [1, 0, 0, 0])]); // dim 4
    expect((await provider.stats('root:a')).chunks).toBe(1);

    // A different-dimension entry must not throw or silently corrupt the table —
    // it forces a full drop + recreate of the shared vec0 table at the new dim.
    await provider.upsert([entry('root:b', 'rec-2', 0, [1, 0])]); // dim 2

    // The old dim-4 root's partition is gone — an accepted, tested consequence
    // (the whole table is shared; a dimension change is an all-roots event) named
    // explicitly in the plan's Stop-short risks, not silent corruption.
    expect((await provider.stats('root:a')).chunks).toBe(0);

    // The new dim-2 data is present and searchable.
    const hits = await provider.search([1, 0], { topK: 5 });
    expect(hits.map((h) => h.recordId)).toEqual(['rec-2']);

    // Searching with a query still shaped for the OLD dimension fails loudly
    // instead of returning silently-wrong results.
    await expect(provider.search([1, 0, 0, 0], { topK: 5 })).rejects.toThrow(
      /dimension/i,
    );
  });

  test('rebuildRoot re-derives a root end-to-end from a real KnowledgeStoreProvider (real chunking, real listByType walk)', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'sqlite-vec-index-store-'));
    try {
      const storeProvider = new KnowledgeStoreProvider(
        new FakeRootPersistence(),
      );
      const root = await storeProvider.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot,
        displayName: 'Test personal store',
      });
      const adapter = await storeProvider.adapterFor(root.id);

      await adapter.create({
        type: 'raw',
        title: 'Sourdough starter maintenance',
        body: 'Feed your starter daily with equal parts flour and water.',
        category: 'cooking.baking',
        provenance: { agent: 'test-agent' },
      });
      await adapter.create({
        type: 'raw',
        title: 'Vector index tradeoffs',
        body: 'HNSW trades memory for speed versus IVF partitioning.',
        category: 'engineering.database',
        provenance: { agent: 'test-agent' },
      });

      const embedder = new StubEmbedder(16);
      const result = await provider.rebuildRoot(root.id, {
        store: storeProvider,
        embedder,
      });

      expect(result.records).toBe(2);
      expect(result.chunks).toBe(2); // one chunk per short body

      const stats = await provider.stats(root.id);
      expect(stats.chunks).toBe(2);
      expect(stats.lastRebuiltAt).toBeDefined();

      // Query with the exact embedding of the sourdough body — guaranteed distance
      // 0 against itself (deterministic embedder), so it must rank first.
      const [queryVector] = await embedder.embed([
        'Feed your starter daily with equal parts flour and water.',
      ]);
      const hits = await provider.search(queryVector, {
        topK: 2,
        rootIds: [root.id],
        threshold: -1,
      });
      expect(hits[0].recordId).toBeDefined();
      expect(hits[0].score).toBeCloseTo(1, 5);
      expect(hits.map((h) => h.rootId)).toEqual([root.id, root.id]);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  test('rebuildRoot only replaces the target root partition, leaving other roots untouched', async () => {
    await provider.upsert([entry('root:untouched', 'rec-u', 0, [0, 0, 1, 0])]);

    const storeRoot = mkdtempSync(join(tmpdir(), 'sqlite-vec-index-store-'));
    try {
      const storeProvider = new KnowledgeStoreProvider(
        new FakeRootPersistence(),
      );
      const root = await storeProvider.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot,
        displayName: 'Test personal store',
      });
      const adapter = await storeProvider.adapterFor(root.id);
      await adapter.create({
        type: 'raw',
        title: 'A note',
        body: 'Some short body text.',
        category: 'general',
        provenance: { agent: 'test-agent' },
      });

      const embedder = new StubEmbedder(4);
      await provider.upsert([entry(root.id, 'seed', 0, [1, 0, 0, 0])]);
      await provider.rebuildRoot(root.id, { store: storeProvider, embedder });

      expect((await provider.stats('root:untouched')).chunks).toBe(1);
      const untouchedHits = await provider.search([0, 0, 1, 0], {
        topK: 5,
        rootIds: ['root:untouched'],
      });
      expect(untouchedHits.map((h) => h.recordId)).toEqual(['rec-u']);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  // SEC-2 / code-review HIGH-1: concurrent rebuildRoot for the same root.
  test('two concurrent rebuildRoot calls for the SAME root: the second fails fast with RebuildInProgressError instead of racing the first', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'sqlite-vec-index-store-'));
    try {
      const storeProvider = new KnowledgeStoreProvider(
        new FakeRootPersistence(),
      );
      const root = await storeProvider.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot,
        displayName: 'Test personal store',
      });
      const adapter = await storeProvider.adapterFor(root.id);
      await adapter.create({
        type: 'raw',
        title: 'A note',
        body: 'Some short body text.',
        category: 'general',
        provenance: { agent: 'test-agent' },
      });

      // A slow embedder holds `rebuildRoot`'s awaited gap open long enough for a
      // second, overlapping call to observe the lock still held.
      class SlowEmbedder implements IEmbeddingProvider {
        readonly id = 'slow-embedder';
        readonly displayName = 'Slow deterministic stub embedder';
        dimensions(): number {
          return 4;
        }
        async embed(texts: string[]): Promise<number[][]> {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return texts.map((t) => deterministicVector(t, 4));
        }
      }
      const embedder = new SlowEmbedder();

      const [first, second] = await Promise.allSettled([
        provider.rebuildRoot(root.id, { store: storeProvider, embedder }),
        provider.rebuildRoot(root.id, { store: storeProvider, embedder }),
      ]);

      const outcomes = [first, second];
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      // Deterministic by design: the per-root lock is a fail-fast Set-based guard
      // (no queueing), so exactly one call proceeds and the other is rejected.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedReason).toBeInstanceOf(RebuildInProgressError);
      expect(rejectedReason.message).toMatch(/already in progress/i);
      expect(rejectedReason.key).toBe(root.id);

      // The one call that succeeded still rebuilt the root correctly.
      const stats = await provider.stats(root.id);
      expect(stats.chunks).toBe(1);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });
});
