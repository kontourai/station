/**
 * AC2-lossless-rebuild: deleting the sqlite-vec index file entirely and calling
 * `rebuildRoot` from a K2 store root must reproduce identical top-K search results
 * (same ranked record ids, in order — not just non-empty, not just matching counts)
 * to an incrementally-built index over the same root
 * (`docs/design/knowledge-foundation.md` lines 180-193, the `rebuildRoot` contract).
 *
 * Self-contained: this file owns no shared fixtures with the other Wave 5 test files
 * (recall-parity's `__fixtures__/corpus.ts`, migration.test.ts, partition-scoping.test.ts)
 * and does not import them.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  IEmbeddingProvider,
  KnowledgeIndexEntry,
} from '@kontourai/station-contracts/knowledge-index';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import { chunkKnowledgeText } from '../../services/knowledge/knowledge-storage.js';
import { SqliteVecIndexProvider } from '../sqlite-vec-index-provider.js';

/**
 * In-memory fake mirroring the `FileStorageAdapter` root-persistence methods.
 * Deliberately re-implemented (not shared/imported) so this file has zero coupling
 * to `__fixtures__/corpus.ts` or any other concurrently-authored Wave 5 fixture.
 */
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

/**
 * A pure, deterministic function of the input text — no network call, no randomness.
 * The same text always produces the same unit-normalized vector, so an incrementally
 * built index and a from-scratch `rebuildRoot` over the same store content are
 * guaranteed to embed every chunk identically.
 */
function deterministicVector(text: string, dim: number): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i += 1) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }
  const raw: number[] = [];
  for (let i = 0; i < dim; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    raw.push((seed / 0xffffffff) * 2 - 1);
  }
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

class StubEmbedder implements IEmbeddingProvider {
  readonly id = 'stub-embedder';
  readonly displayName =
    'Deterministic stub embedder (lossless-rebuild fixture)';

  constructor(private readonly dim: number) {}

  dimensions(): number {
    return this.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => deterministicVector(t, this.dim));
  }
}

const DIM = 24;

interface RecordSpec {
  title: string;
  category: string;
  body: string;
}

// 10 records across 5 categories. "Vector index tradeoffs" is deliberately long
// (multiple paragraphs, well over chunkKnowledgeText's 500-char maxChunkSize) so at
// least one record chunks into more than one entry — the rebuild must reproduce
// every chunk, not just "a" chunk, per the plan's Stop-short risk about silently
// dropped chunks passing a shallow test.
const RECORD_SPECS: RecordSpec[] = [
  {
    title: 'Sourdough starter maintenance',
    category: 'cooking.baking',
    body: 'Feed your starter daily with equal parts flour and water by weight. Keep it at room temperature and discard half before each feeding to keep the culture healthy and active.',
  },
  {
    title: 'Baking bread at altitude',
    category: 'cooking.baking',
    body: 'At high altitude, reduce yeast slightly and increase hydration because water evaporates faster and dough rises quicker in thinner air.',
  },
  {
    title: 'Vector index tradeoffs',
    category: 'engineering.database',
    body:
      '## HNSW versus IVF\n\n' +
      'HNSW builds a multi-layer navigable small-world graph that trades extra memory for very fast approximate nearest-neighbor lookups, and it tends to degrade gracefully as the corpus grows because new nodes just get linked into the existing graph structure without a full rebuild. ' +
      'It is a strong default for read-heavy workloads where index build time is not the bottleneck and where the working set fits comfortably in RAM. ' +
      '\n\n' +
      '## IVF partitioning\n\n' +
      'IVF instead partitions the vector space into coarse clusters using k-means and only scans the nearest clusters for a query, trading recall for a smaller memory footprint and much faster bulk index construction. ' +
      'It suits very large corpora where a full graph structure would not fit in memory, at the cost of needing a periodic re-clustering pass as the underlying data distribution drifts over time.',
  },
  {
    title: 'sqlite-vec partition keys',
    category: 'engineering.database',
    body: 'A vec0 virtual table can declare a partition key column so a single physical table safely serves multiple logical stores without cross-store leakage during a KNN scan.',
  },
  {
    title: 'Writing fast unit tests',
    category: 'engineering.testing',
    body: 'Prefer small, deterministic fixtures over shared mutable global state so tests can run in parallel without flaking, and assert on concrete values instead of just checking that no exception was thrown.',
  },
  {
    title: 'Testing soil pH before planting',
    category: 'gardening.soil',
    body: 'Use a simple soil pH test kit before spring planting. Most vegetables prefer a slightly acidic to neutral pH between six and seven, and amending too aggressively in one pass can shock existing plants.',
  },
  {
    title: 'Composting kitchen scraps',
    category: 'gardening.soil',
    body: 'Balance nitrogen-rich greens like vegetable scraps with carbon-rich browns like dried leaves, and turn the pile every couple of weeks to keep decomposition aerobic and odor-free.',
  },
  {
    title: 'Quarterly estimated tax payments',
    category: 'finance.tax',
    body: 'Self-employed filers generally owe estimated tax four times a year; missing a quarterly deadline can trigger an underpayment penalty even if the full balance is paid by the annual filing date.',
  },
  {
    title: 'Deducting a home office',
    category: 'finance.tax',
    body: 'The simplified home office deduction uses a flat rate per square foot up to a cap, while the regular method requires tracking actual expenses proportional to the office share of the home.',
  },
  {
    title: 'Interval training basics',
    category: 'health.fitness',
    body: 'Alternating short bursts of high effort with longer recovery periods builds both aerobic base and anaerobic capacity, and is easier to sustain consistently than steady long runs for many beginners.',
  },
];

/**
 * Chunk + embed + upsert a single record — the exact per-record derivation
 * `rebuildRoot` performs in bulk (chunk body -> embed each chunk -> upsert), done
 * here one record at a time to build the index incrementally instead of via a
 * from-scratch rebuild. Returns the number of chunks written for this record.
 */
async function indexRecordIncrementally(
  index: SqliteVecIndexProvider,
  embedder: StubEmbedder,
  rootId: string,
  recordId: string,
  spec: RecordSpec,
): Promise<number> {
  const chunks = chunkKnowledgeText(spec.body);
  if (chunks.length === 0) return 0;
  const vectors = await embedder.embed(chunks);
  const entries: KnowledgeIndexEntry[] = chunks.map((text, chunkOrdinal) => ({
    recordId,
    rootId,
    chunkOrdinal,
    text,
    vector: vectors[chunkOrdinal],
    metadata: {
      type: 'raw',
      category: spec.category,
      title: spec.title,
      status: 'active',
    },
  }));
  await index.upsert(entries);
  return chunks.length;
}

// A fixed query set (4 queries, topK 3) run identically before and after the
// delete-and-rebuild — none of these strings are exact substrings of a record body,
// so ranking depends on the embedder's (deterministic) distance computation across
// several candidate chunks rather than trivially self-matching a single record.
const QUERIES = [
  'How often should I feed a sourdough starter?',
  'What are the tradeoffs between HNSW and IVF vector indexes?',
  'How do I test soil pH before spring planting?',
  'When are quarterly estimated tax payments due?',
];

describe('lossless rebuild: delete index file -> rebuildRoot -> identical ranked results', () => {
  let storeRoot: string;
  let indexDir: string;
  let dbPath: string;
  let storeProvider: KnowledgeStoreProvider;
  let embedder: StubEmbedder;
  let rootId: string;

  beforeEach(async () => {
    storeRoot = mkdtempSync(join(tmpdir(), 'lossless-rebuild-store-'));
    indexDir = mkdtempSync(join(tmpdir(), 'lossless-rebuild-index-'));
    dbPath = join(indexDir, 'index.db');
    embedder = new StubEmbedder(DIM);
    storeProvider = new KnowledgeStoreProvider(new FakeRootPersistence());
    const root = await storeProvider.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot,
      displayName: 'Lossless rebuild fixture root',
    });
    rootId = root.id;
  });

  afterEach(() => {
    rmSync(storeRoot, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  });

  test('rebuildRoot after full index-file deletion reproduces identical ranked ids and chunk counts', async () => {
    // ── Phase 1: seed the K2 store, build the index incrementally ──────────
    const adapter = await storeProvider.adapterFor(rootId);
    const recordIds: string[] = [];
    let expectedChunks = 0;

    const incrementalIndex = new SqliteVecIndexProvider({ dbPath });
    let incrementalChunkStats: number;
    const incrementalResults: string[][] = [];
    try {
      for (const spec of RECORD_SPECS) {
        const id = await adapter.create({
          type: 'raw',
          title: spec.title,
          body: spec.body,
          category: spec.category,
          provenance: { agent: 'lossless-rebuild-test' },
        });
        recordIds.push(id);
        expectedChunks += await indexRecordIncrementally(
          incrementalIndex,
          embedder,
          rootId,
          id,
          spec,
        );
      }

      expect(recordIds.length).toBe(RECORD_SPECS.length);
      // Sanity: the fixture actually forces at least one multi-chunk record. If this
      // ever regresses to 1:1 (one chunk per record), the "multiple chunks per
      // record" property this test exists to cover would go silently unexercised.
      expect(expectedChunks).toBeGreaterThan(RECORD_SPECS.length);

      const stats = await incrementalIndex.stats(rootId);
      expect(stats.chunks).toBe(expectedChunks);
      incrementalChunkStats = stats.chunks;

      for (const q of QUERIES) {
        const [qVec] = await embedder.embed([q]);
        const hits = await incrementalIndex.search(qVec, {
          topK: 3,
          rootIds: [rootId],
        });
        // Every query must actually return ranked hits — a rebuild/build path that
        // silently returns zero results must not pass this test (Stop-short risk).
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((h) => h.rootId === rootId)).toBe(true);
        incrementalResults.push(hits.map((h) => h.recordId));
      }
    } finally {
      incrementalIndex.close();
    }

    // ── Phase 2: delete the index db file entirely (and any -wal/-shm/-journal
    // siblings), then rebuild from scratch via the K2 store ────────────────────
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
    expect(existsSync(dbPath)).toBe(false);

    const rebuiltIndex = new SqliteVecIndexProvider({ dbPath });
    try {
      const rebuildResult = await rebuiltIndex.rebuildRoot(rootId, {
        store: storeProvider,
        embedder,
      });

      expect(rebuildResult.records).toBe(RECORD_SPECS.length);
      expect(rebuildResult.chunks).toBe(expectedChunks);

      const rebuiltStats = await rebuiltIndex.stats(rootId);
      expect(rebuiltStats.chunks).toBe(expectedChunks);
      expect(rebuiltStats.chunks).toBe(incrementalChunkStats);

      // The core AC2 property: ranked record-id lists (order-sensitive) must be
      // EXACTLY identical to the incrementally-built index's results, for every
      // query in the fixed query set — not just non-empty, not just set-equal.
      for (let i = 0; i < QUERIES.length; i += 1) {
        const [qVec] = await embedder.embed([QUERIES[i]]);
        const hits = await rebuiltIndex.search(qVec, {
          topK: 3,
          rootIds: [rootId],
        });
        expect(hits.map((h) => h.recordId)).toEqual(incrementalResults[i]);
      }
    } finally {
      rebuiltIndex.close();
    }
  });
});
