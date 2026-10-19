/**
 * K3 seam types — Knowledge index layer (ADR-0009 Layer 2).
 *
 * Transcribed from `docs/design/knowledge-foundation.md`'s K3 section, which is itself
 * normative against ADR-0009's Layer 2 design (Probe A: sqlite-vec, partition-scoped,
 * derived-only). Shaped like today's `IVectorDbProvider` + `IEmbeddingProvider` but
 * explicitly **derived — never authoritative**: nothing may be stored in the index that
 * cannot be regenerated from the K2 stores, and no read path may treat an index hit as
 * the record (always re-resolve via `adapterFor(rootId).get(recordId)`).
 *
 * `KnowledgeStoreProvider` is the K2 seam this layer builds on (`./knowledge-store.js`).
 */

import type { KnowledgeStoreProvider } from './knowledge-store.js';

// ── Embedding seam ──────────────────────────────────────────────────────────

/**
 * Structural mirror of `IEmbeddingProvider`
 * (`src-server/providers/llm/model-provider-types.ts:48-55`). Not imported directly — the
 * contracts package must stay server-independent (matching `knowledge-store.ts`'s
 * existing discipline of zero `src-server/**` imports) — so this interface is kept
 * structurally identical to the source of truth instead. Do not diverge the shape;
 * update both sides together if the source interface changes.
 */
export interface IEmbeddingProvider {
  readonly id: string;
  readonly displayName: string;
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
  healthCheck?(): Promise<boolean>;
  /**
   * The settings that decide what a vector means: provider kind and model.
   * Never credentials or endpoints. Two embedders that return the same value
   * must produce interchangeable vectors. Absent, an index can tell embedders
   * apart only by `id` and width, so a model change within one provider goes
   * undetected.
   */
  embeddingIdentity?(): string;
}

// ── Index entry/hit shapes ──────────────────────────────────────────────────

export interface KnowledgeIndexEntry {
  recordId: string; // Kit record id — the join key back to the canonical store
  rootId: string; // which store root the record came from
  chunkOrdinal: number; // records may index as multiple chunks
  text: string;
  vector: number[];
  metadata: Record<string, unknown>; // category, type, title, status, ...
  /** The embedding generation that produced `vector`; absent means unknown.
   * An unknown generation never matches an identity-scoped search. */
  embeddingIdentity?: string;
}

export interface KnowledgeIndexHit {
  recordId: string;
  rootId: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

/** How many indexed chunks one root holds under one embedding generation.
 * `embeddingIdentity: null` is an unknown generation (written without one, or
 * by an index format that predates generations). */
export interface KnowledgeIndexGeneration {
  rootId: string;
  embeddingIdentity: string | null;
  chunks: number;
}

// ── Index provider contract ─────────────────────────────────────────────────

export interface KnowledgeIndexProvider {
  readonly id: string; // built-in successor: 'sqlite-vec' (ADR-0009 appendix)
  readonly displayName: string;

  upsert(entries: KnowledgeIndexEntry[]): Promise<void>;
  removeByRecord(rootId: string, recordIds: string[]): Promise<void>;
  removeRoot(rootId: string): Promise<void>; // drop a root's partition — cheap, index-only

  search(
    query: number[],
    opts: {
      topK: number;
      rootIds?: string[]; // scope to a subset of roots; omitted = all registered roots
      threshold?: number;
      filter?: Record<string, unknown>; // metadata equality predicates
      /** Admit only chunks written under this embedding generation. Omitted
       * admits every generation, which is only safe for a single-generation
       * index. */
      embeddingIdentity?: string;
    },
  ): Promise<KnowledgeIndexHit[]>;

  /** Indexed chunk counts per root and embedding generation, so a caller can
   * report roots that need a rebuild for the current embedder. Optional:
   * an index without it cannot report stale generations. */
  generations?(rootIds?: string[]): Promise<KnowledgeIndexGeneration[]>;

  /**
   * THE rebuild contract: drop everything held for `rootId` and re-derive it by enumerating the
   * root's records through the K2 seam (listByType over all types → chunk → embed → upsert).
   * Property K3 must test: for a root with N records, a from-scratch rebuild produces recall
   * behavior equivalent to the incrementally-built index (index deleted → rebuilt → same results
   * for a fixture query set). Every re-derived chunk carries the embedder's generation.
   */
  rebuildRoot(
    rootId: string,
    deps: {
      store: KnowledgeStoreProvider;
      embedder: IEmbeddingProvider; // existing seam, model-provider-types.ts:48-55
    },
  ): Promise<{ records: number; chunks: number }>;

  stats(rootId?: string): Promise<{ chunks: number; lastRebuiltAt?: string }>;
}
