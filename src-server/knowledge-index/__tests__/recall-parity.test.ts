/**
 * AC1-recall-parity (s201-knowledge-retrieval plan, Wave 5): on the shared fixture
 * corpus (`__fixtures__/corpus.ts`, 50 chunks / 5 topics, deterministic stub
 * embeddings), the new sqlite-vec `KnowledgeIndexProvider` must return the exact same
 * top-K ranked record ids, in order, as the pre-index brute-force-cosine
 * `LanceDBProvider` baseline (`src-server/providers/lancedb-provider.ts:81-98`) for
 * identical queries against identical embeddings.
 *
 * Per the plan's Stop-short risks, this suite asserts on actual ranked record ids —
 * never merely on hit counts — so a provider that "runs without throwing" but
 * silently drops/reorders recall fails loudly here.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { LanceDBProvider } from '../../providers/lancedb-provider.js';
import { SqliteVecIndexProvider } from '../sqlite-vec-index-provider.js';
import { corpus, findRecord, stubEmbedder } from './__fixtures__/corpus.js';

const NAMESPACE = 'recall-parity-corpus';
const ROOT_ID = 'root:recall-parity';
// -1 is below any possible cosine similarity (-1..1) — pass it explicitly to both
// providers so neither's default threshold filters candidates asymmetrically and
// topK truncation is the only thing under test.
const NO_THRESHOLD = -1;

interface RecallQuery {
  name: string;
  text: string;
  topK: number;
  /** The record id known-by-construction to rank first for this query — either an
   * exact reuse of a record's text (guaranteed distance 0) or a near-duplicate
   * dominated by one record's vocabulary. */
  expectedTop1: string;
}

function dropLastWord(text: string): string {
  const words = text.trim().split(/\s+/);
  return words.slice(0, -1).join(' ');
}

const queries: RecallQuery[] = [
  {
    // Exact reuse of a record's own text through the same embedder — guaranteed
    // distance 0 against itself, so it must rank first regardless of provider.
    name: 'exact-match reuse of cooking-3 text (topK=5)',
    text: findRecord('cooking-3').text,
    topK: 5,
    expectedTop1: 'cooking-3',
  },
  {
    // topK=1 edge case, still an exact-text reuse for a different topic.
    name: 'exact-match reuse of software-7 text (topK=1)',
    text: findRecord('software-7').text,
    topK: 1,
    expectedTop1: 'software-7',
  },
  {
    // Near-duplicate: the same sentence minus its final word. The bag-of-words
    // embedding still shares every remaining token with astronomy-2, so it must
    // still rank astronomy-2 first ahead of every other record/topic.
    name: 'near-match: astronomy-2 text minus last word (topK=3)',
    text: dropLastWord(findRecord('astronomy-2').text),
    topK: 3,
    expectedTop1: 'astronomy-2',
  },
  {
    // K>1 cross-topic mix: finance-1's text repeated 3x (dominant vocabulary
    // weight) plus gardening-4's text once. finance-1 must still rank first; the
    // real assertion under test is that both providers agree on the *entire*
    // ranked list, not just the top result.
    name: 'mixed cross-topic query weighted toward finance-1 (topK=5)',
    text: `${findRecord('finance-1').text} ${findRecord('finance-1').text} ${findRecord('finance-1').text} ${findRecord('gardening-4').text}`,
    topK: 5,
    expectedTop1: 'finance-1',
  },
];

describe('recall parity: sqlite-vec vs pre-index LanceDBProvider', () => {
  let lancedbDir: string;
  let sqliteDir: string;
  let lancedb: LanceDBProvider;
  let sqliteIndex: SqliteVecIndexProvider;

  beforeAll(async () => {
    expect(corpus.length).toBe(50);
    expect(new Set(corpus.map((r) => r.topic)).size).toBe(5);

    lancedbDir = mkdtempSync(join(tmpdir(), 'recall-parity-lancedb-'));
    sqliteDir = mkdtempSync(join(tmpdir(), 'recall-parity-sqlite-'));

    lancedb = new LanceDBProvider({ dataDir: lancedbDir });
    sqliteIndex = new SqliteVecIndexProvider({
      dbPath: join(sqliteDir, 'index.db'),
    });

    await lancedb.createNamespace(NAMESPACE);
    await lancedb.addDocuments(
      NAMESPACE,
      corpus.map((r) => ({
        id: r.id,
        vector: r.vector,
        text: r.text,
        metadata: { topic: r.topic },
      })),
    );

    await sqliteIndex.upsert(
      corpus.map((r) => ({
        recordId: r.id,
        rootId: ROOT_ID,
        chunkOrdinal: 0,
        text: r.text,
        vector: r.vector,
        metadata: { topic: r.topic },
      })),
    );

    const lancedbCount = await lancedb.count(NAMESPACE);
    const sqliteStats = await sqliteIndex.stats(ROOT_ID);
    expect(lancedbCount).toBe(50);
    expect(sqliteStats.chunks).toBe(50);
  });

  afterAll(() => {
    sqliteIndex.close();
    rmSync(lancedbDir, { recursive: true, force: true });
    rmSync(sqliteDir, { recursive: true, force: true });
  });

  function assertDescending(scores: number[]): void {
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  }

  test.each(queries)(
    '$name: ranked record ids match exactly between both providers',
    async ({ text, topK, expectedTop1 }) => {
      const [queryVector] = await stubEmbedder.embed([text]);

      const lancedbHits = await lancedb.search(
        NAMESPACE,
        queryVector,
        topK,
        NO_THRESHOLD,
      );
      const sqliteHits = await sqliteIndex.search(queryVector, {
        topK,
        rootIds: [ROOT_ID],
        threshold: NO_THRESHOLD,
      });

      const lancedbIds = lancedbHits.map((h) => h.id);
      const sqliteIds = sqliteHits.map((h) => h.recordId);

      // The core AC1 assertion: exact, in-order record-id parity — not just
      // matching counts (a shallow rebuild-but-empty bug would still fail here
      // because `expectedTop1` requires at least one real hit).
      expect(sqliteIds.length).toBeGreaterThan(0);
      expect(sqliteIds).toEqual(lancedbIds);
      expect(sqliteIds[0]).toBe(expectedTop1);
      expect(lancedbIds[0]).toBe(expectedTop1);
      expect(sqliteIds.length).toBeLessThanOrEqual(topK);

      assertDescending(lancedbHits.map((h) => h.score));
      assertDescending(sqliteHits.map((h) => h.score));
    },
  );

  test('unscoped sqlite-vec search over the whole corpus still matches the pre-index baseline for a topK>1 query', async () => {
    const query = queries[3];
    const [queryVector] = await stubEmbedder.embed([query.text]);

    const lancedbHits = await lancedb.search(
      NAMESPACE,
      queryVector,
      query.topK,
      NO_THRESHOLD,
    );
    const sqliteHits = await sqliteIndex.search(queryVector, {
      topK: query.topK,
      threshold: NO_THRESHOLD,
    });

    expect(sqliteHits.map((h) => h.recordId)).toEqual(
      lancedbHits.map((h) => h.id),
    );
  });
});
