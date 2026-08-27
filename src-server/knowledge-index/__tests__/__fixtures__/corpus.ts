/**
 * Shared fixture corpus for Wave 5's recall-parity/lossless-rebuild/migration/
 * partition-scoping test suites (s201-knowledge-retrieval plan, Wave 5). Mirrors
 * ADR-0009's own probe precedent: ~50 chunks spread across 5 topics, embedded with
 * a **deterministic, network-free stub embedder** so CI never needs a real model
 * connection (per the pickup-probe's accepted fallback).
 *
 * This file is OWNED by the "Fixture-corpus recall-parity test" task. Other Wave 5
 * tasks needing fixtures should add small additive exports here rather than forking
 * a second fixture module (flagged in the plan to avoid a merge collision).
 *
 * Embedding scheme: a bag-of-words hashing trick. Every distinct token gets its own
 * deterministic unit vector (seeded by an FNV-1a hash of the token, expanded via a
 * mulberry32 PRNG into `DIM` floats, then L2-normalized). A text's embedding is the
 * sum of its tokens' unit vectors, re-normalized to unit length. This is a *pure
 * function of the text* (no randomness, no network) with a useful property beyond
 * plain per-text hashing: texts that share vocabulary land closer together in cosine
 * space, so recall-parity queries can be constructed with a known-by-construction
 * nearest record (reuse a record's exact text for a guaranteed distance-0 match, or a
 * near-duplicate of a record's text for a guaranteed near match) instead of relying on
 * count-only assertions.
 *
 * Tie-avoidance note: every fixture sentence below uses distinct, topic-specific
 * vocabulary (only common stopwords overlap across topics), so no two corpus vectors
 * are exact cosine-distance ties — search ordering is well-defined. Do not add two
 * records with identical or near-identical wording without checking this property.
 */
import type { IEmbeddingProvider } from '@kontourai/station-contracts/knowledge-index';

/** Fixed embedding dimension for this fixture corpus. */
export const DIM = 64;

// ── Deterministic pure-function embedding (bag-of-words hashing trick) ─────

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 PRNG — deterministic, seeded, no external dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(vec: number[]): number[] {
  let normSq = 0;
  for (const v of vec) normSq += v * v;
  const norm = Math.sqrt(normSq);
  if (norm === 0) return vec.slice();
  return vec.map((v) => v / norm);
}

/** A deterministic unit vector for a single token — same token always produces
 * the same vector, distinct tokens produce (with overwhelming probability)
 * distinct vectors. */
function tokenVector(token: string, dim: number): number[] {
  const rand = mulberry32(fnv1a(token));
  const raw: number[] = [];
  for (let i = 0; i < dim; i += 1) raw.push(rand() * 2 - 1);
  return normalize(raw);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Pure, deterministic bag-of-words embedding — the `IEmbeddingProvider.embed`
 * implementation used by `stubEmbedder` below, exported separately so tests can
 * construct query vectors/text deterministically without going through the async
 * `embed()` wrapper when convenient.
 */
export function embedText(text: string, dim = DIM): number[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return tokenVector(text, dim);
  const sum = new Array(dim).fill(0);
  for (const token of tokens) {
    const tv = tokenVector(token, dim);
    for (let i = 0; i < dim; i += 1) sum[i] += tv[i];
  }
  return normalize(sum);
}

export class StubCorpusEmbedder implements IEmbeddingProvider {
  readonly id = 'stub-corpus-embedder';
  readonly displayName =
    'Deterministic bag-of-words stub embedder (fixture corpus)';

  constructor(private readonly dim: number = DIM) {}

  dimensions(): number {
    return this.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => embedText(t, this.dim));
  }
}

/** Singleton stub embedder instance shared by fixture consumers — same contract
 * shape (`IEmbeddingProvider`) the real Bedrock-backed embedder implements, so
 * provider code under test cannot tell the difference. */
export const stubEmbedder = new StubCorpusEmbedder(DIM);

// ── Multi-topic fixture corpus (5 topics x 10 records = 50 chunks) ─────────

export interface CorpusRecord {
  id: string;
  topic: string;
  text: string;
  vector: number[];
}

const TOPIC_TEXTS: Record<string, string[]> = {
  cooking: [
    'Simmer diced tomatoes with garlic and basil for twenty minutes.',
    'Whisk eggs with grated parmesan before folding into hot pasta.',
    'Marinate chicken thighs in lemon juice, thyme, and olive oil overnight.',
    'Caramelize sliced onions slowly in butter until deeply golden brown.',
    'Knead sourdough dough for ten minutes until it turns smooth and elastic.',
    'Roast root vegetables with rosemary at high heat until edges crisp.',
    'Fold whipped cream gently into the chilled chocolate mousse base.',
    'Sear scallops in a hot cast iron pan for ninety seconds per side.',
    'Braise short ribs in red wine and stock for three slow hours.',
    'Toast cumin seeds in a dry skillet until they become fragrant.',
  ],
  astronomy: [
    "Jupiter's Great Red Spot is a giant storm larger than Earth.",
    'Neutron stars form when massive stars collapse after a supernova.',
    "Saturn's rings are made mostly of ice particles and rocky debris.",
    'The Andromeda galaxy is on a slow collision course with the Milky Way.',
    'Black holes warp spacetime so strongly that light cannot escape.',
    'Mars has the largest volcano in the solar system, Olympus Mons.',
    'Comets develop long tails of gas and dust as they near the sun.',
    'Exoplanets are often detected by measuring the dimming of starlight.',
    'The cosmic microwave background is the afterglow of the Big Bang.',
    'Pulsars emit beams of radiation that sweep past Earth like a lighthouse.',
  ],
  finance: [
    'Diversifying a portfolio across asset classes reduces overall volatility.',
    'Compound interest grows a balance faster the longer it accrues.',
    'Bond yields typically rise when central banks raise interest rates.',
    'Dollar cost averaging smooths out the impact of market timing.',
    'A well funded emergency fund covers roughly six months of expenses.',
    'Index funds track a benchmark with low fees and broad exposure.',
    'Inflation erodes purchasing power if wages fail to keep pace.',
    'Credit scores weigh payment history more heavily than utilization.',
    'Dividend reinvestment compounds returns without manual intervention.',
    'A balance sheet lists assets, liabilities, and shareholder equity.',
  ],
  gardening: [
    'Mulching around tomato plants conserves moisture and suppresses weeds.',
    'Deadheading spent blooms encourages roses to keep flowering.',
    'Compost enriches clay soil with organic matter and nutrients.',
    'Companion planting basil near tomatoes can deter certain pests.',
    'Pruning fruit trees in late winter shapes healthy summer growth.',
    'Raised beds warm up faster in spring than in ground plots.',
    'Drip irrigation delivers water directly to roots, reducing waste.',
    'Crop rotation prevents soil borne diseases from building up.',
    'Overwintering dahlia tubers requires a cool, dry, dark space.',
    'Testing soil pH helps choose which acid loving plants will thrive.',
  ],
  software: [
    'Memoization caches expensive function results keyed by their arguments.',
    'A race condition occurs when threads access shared state unsynchronized.',
    'Garbage collection reclaims memory no longer reachable from any root.',
    'Idempotent API endpoints can be retried safely after a network timeout.',
    'A binary search halves the search space on every comparison.',
    'Database indexes speed up reads at the cost of slower writes.',
    'Feature flags let teams ship code paths behind a gradual rollout.',
    'Content hashing detects duplicate files without comparing byte streams.',
    'Circuit breakers stop cascading failures across dependent services.',
    'Immutable data structures avoid a whole class of aliasing bugs.',
  ],
};

function buildCorpus(): CorpusRecord[] {
  const records: CorpusRecord[] = [];
  for (const [topic, texts] of Object.entries(TOPIC_TEXTS)) {
    texts.forEach((text, i) => {
      records.push({
        id: `${topic}-${i}`,
        topic,
        text,
        vector: embedText(text, DIM),
      });
    });
  }
  return records;
}

/** The fixture corpus: 50 records across 5 topics, vectors precomputed once at
 * module load via the same pure `embedText` function `stubEmbedder.embed` wraps. */
export const corpus: CorpusRecord[] = buildCorpus();

export function findRecord(id: string): CorpusRecord {
  const record = corpus.find((r) => r.id === id);
  if (!record) throw new Error(`Fixture corpus has no record with id '${id}'`);
  return record;
}
