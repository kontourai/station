/**
 * `sqlite-vec` `KnowledgeIndexProvider` — the built-in K3 index (ADR-0009 Layer 2,
 * `docs/design/knowledge-foundation.md` "K3 — Index layer"). One `node:sqlite`
 * `DatabaseSync` file (default `{dataDir}/knowledge-index/index.db`), one `vec0`
 * loadable-extension virtual table (`vec_items`) with a `store` partition-key column
 * and `distance_metric=cosine` — the exact shape ADR-0009's Probe A proved out
 * (`docs/adr/0009-...md` lines 44-88). This index is derived-only: everything it holds
 * is regenerable from a `KnowledgeStoreProvider` root via `rebuildRoot`, and it is
 * never treated as a second source of truth.
 *
 * `node:sqlite` incantation (Probe A): `allowExtension: true` on the constructor,
 * `enableLoadExtension(true)`, `loadExtension(<vec0 loadable path>)`, then
 * `enableLoadExtension(false)` once loaded (least-privilege — no further loadable
 * extensions are expected). Vectors bind as `Uint8Array` over a `Float32Array` buffer.
 * `sqlite-vec`'s own `getLoadablePath()` resolves the platform-specific `vec0` binary
 * package (`sqlite-vec-<platform>-<arch>`) rather than hardcoding a path.
 *
 * vec0 quirk (empirically verified against `sqlite-vec@0.1.9` + Node 24's `node:sqlite`
 * in this session): vec0's own `xUpdate` type-checks bound values by their *actual*
 * SQLite fundamental type, not by column affinity-coercion the way an ordinary table
 * would. Node's `node:sqlite` binds a plain JS integer as `SQLITE_FLOAT`
 * (`sqlite3_bind_double`), which vec0 rejects for its INTEGER `rowid`/auxiliary
 * columns ("Auxiliary column type mismatch: ... but FLOAT was provided"). The fix is
 * to bind integer-typed values (`rowid`, `chunkOrdinal`) as JS `BigInt` on INSERT;
 * `rowid` is passed as `null` (auto-assign) since this provider never needs to address
 * a row by rowid directly (`store` + `recordId` + `chunkOrdinal` is the identity used
 * for delete/upsert). Ordinary `DELETE ... WHERE` comparisons are unaffected (SQLite's
 * normal affinity coercion applies there; only vec0's own insert-time check cares).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type {
  IEmbeddingProvider,
  KnowledgeIndexEntry,
  KnowledgeIndexHit,
  KnowledgeIndexProvider,
} from '@kontourai/station-contracts/knowledge-index';
import type {
  KitRecord,
  KitRecordType,
  KnowledgeStoreProvider,
} from '@kontourai/station-contracts/knowledge-store';
import { getLoadablePath } from 'sqlite-vec';
import { chunkKnowledgeText } from '../services/knowledge/knowledge-storage.js';
import {
  knowledgeIndexOps,
  knowledgeIndexRebuildDuration,
} from '../telemetry/metrics.js';
import { resolveHomeDir } from '../utils/paths.js';
import { applyWalJournalMode } from '../utils/sqlite-wal.js';
import { KeyedInFlightGuard } from './inflight-guard.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { allowExtension?: boolean; timeout?: number },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run: (...args: unknown[]) => unknown;
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
    enableLoadExtension(enabled: boolean): void;
    loadExtension(path: string): void;
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

/** All `KitRecordType`s — `rebuildRoot` walks `listByType` over every one of these. */
const ALL_KIT_RECORD_TYPES: KitRecordType[] = [
  'raw',
  'compiled',
  'concept',
  'snapshot',
  'person',
];

// Mirrors event-store.ts's busy budget for shared-home contention (archive#3321).
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const VEC_TABLE = 'vec_items';
const META_TABLE = 'index_meta';
const DIMENSION_KEY = 'dimension';
const REBUILT_AT_PREFIX = 'lastRebuiltAt:';

/** Global lock key (SEC-2) for the shared `vec0` table's dimension-change
 * drop+recreate — this action is shared across every root's partition, so it must
 * be serialized independently of any single root's `rebuildRoot` lock. Not a real
 * root id (a reserved, unjoinable value), so it can never collide with one. */
const DIMENSION_REBUILD_LOCK_KEY = '\u0000dimension-rebuild\u0000';

function toVectorBuffer(vector: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

export interface SqliteVecIndexProviderOptions {
  /** Override the db file path — used by tests; defaults to
   * `{resolveHomeDir()}/knowledge-index/index.db`, matching `lancedb-provider.ts`'s
   * `dataDir` convention (constructor-overridable, `resolveHomeDir()`-derived default). */
  dbPath?: string;
}

/**
 * Single-writer expectation (SEC-2 / code-review HIGH-1): this class holds one
 * long-lived `DatabaseSync` connection reused across every caller (routes, the
 * migration module, station-control tools) for the lifetime of the process.
 * `rebuildRoot` is guarded per-`rootId` and the shared `vec0` table's
 * dimension-change drop+recreate is guarded by a single global key — both via
 * `this.inFlight` (`KeyedInFlightGuard`, fail-fast: a racing second call throws
 * `RebuildInProgressError` rather than queueing). `upsert`/`removeByRecord`/
 * `removeRoot`/`search` are NOT individually guarded (they're the hot path, and
 * `node:sqlite`'s synchronous calls mean none of them yields mid-operation) — only
 * the two genuinely rare, explicit, multi-step admin actions are.
 */
export class SqliteVecIndexProvider implements KnowledgeIndexProvider {
  readonly id = 'sqlite-vec';
  readonly displayName = 'sqlite-vec (embedded semantic index)';

  private readonly dbPath: string;
  private db: Db | null = null;
  private readonly inFlight = new KeyedInFlightGuard();

  /**
   * `dbPath` (code-review LOW-6): when `options.dbPath` is omitted, it defaults to
   * `{resolveHomeDir()}/knowledge-index/index.db` — `resolveHomeDir()` resolves
   * `STATION_HOME` (or `~/.station`) independently of any `dataDir` a caller may
   * have already resolved elsewhere (e.g. `knowledge-index-routes.ts`'s injected
   * `dataDir`). These agree in production only because the CLI always sets
   * `STATION_HOME` before spawning the server. A caller constructing this provider
   * against a specific, non-`STATION_HOME`-derived `dataDir` MUST pass an explicit
   * `dbPath` (as every test in this repo already does) rather than relying on the
   * default.
   */
  constructor(options: SqliteVecIndexProviderOptions = {}) {
    this.dbPath =
      options.dbPath ?? join(resolveHomeDir(), 'knowledge-index', 'index.db');
  }

  /** Release the underlying db handle. Not part of the `KnowledgeIndexProvider`
   * contract — a test/lifecycle convenience so temp-dir fixtures can clean up. */
  close(): void {
    this.db?.close();
    this.db = null;
  }

  // ── Db lifecycle ─────────────────────────────────────────────────────────

  private open(): Db {
    if (this.db) return this.db;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    // archive#3321: this file lives under a shared STATION_HOME, so a second
    // Station process can hold a write lock at any moment (the archive#2895/#3304
    // class). Same treatment as event-store.ts: constructor timeout AND the
    // PRAGMA (the option does not consistently govern explicit BEGIN
    // IMMEDIATE across supported builds), plus best-effort WAL before the
    // first write below.
    const db = new DatabaseSync(this.dbPath, {
      allowExtension: true,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    db.enableLoadExtension(true);
    db.loadExtension(getLoadablePath());
    db.enableLoadExtension(false);
    try {
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    } catch {
      // Best-effort; a genuinely unreadable database fails truthfully below.
    }
    // archive#3661: bounded retry, because the conversion on a never-WAL
    // file does not wait out `busy_timeout`. Still advisory — the mode is
    // persistent in the file header, so a later uncontended open converts it.
    applyWalJournalMode(db, { store: 'knowledge index' });
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    this.db = db;
    return db;
  }

  private tableExists(name: string): boolean {
    const db = this.open();
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?`,
      )
      .get(name);
    return row !== undefined;
  }

  // ── Dimension config + forced-rebuild-on-mismatch (Stop-short risk) ────────

  private getConfiguredDimension(): number | null {
    const row = this.open()
      .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
      .get(DIMENSION_KEY) as { value: string } | undefined;
    return row ? Number(row.value) : null;
  }

  private setConfiguredDimension(dim: number): void {
    this.open()
      .prepare(
        `INSERT INTO ${META_TABLE}(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(DIMENSION_KEY, String(dim));
  }

  /** SEC-2: guarded by the global `DIMENSION_REBUILD_LOCK_KEY` — this drop+recreate
   * affects every root's partition at once, so two overlapping callers (e.g. two
   * different roots' `rebuildRoot` calls, both observing a stale dimension at the
   * same time) must not both run it; the second one fails fast with
   * `RebuildInProgressError` instead of racing the first's DROP/CREATE. */
  private createVecTable(dim: number): void {
    this.inFlight.acquireSync(DIMENSION_REBUILD_LOCK_KEY);
    try {
      const db = this.open();
      db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
      db.exec(`CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(
        store TEXT partition key,
        embedding float[${dim}] distance_metric=cosine,
        +recordId TEXT,
        +chunkOrdinal INTEGER,
        +text TEXT,
        +metadata TEXT
      )`);
      this.setConfiguredDimension(dim);
      // Every existing root's partition was just dropped along with the table — its
      // "last rebuilt" marker is no longer honest until that root calls rebuildRoot
      // again, so clear all of them rather than leaving stale timestamps behind.
      db.exec(
        `DELETE FROM ${META_TABLE} WHERE key LIKE '${REBUILT_AT_PREFIX}%'`,
      );
    } finally {
      this.inFlight.release(DIMENSION_REBUILD_LOCK_KEY);
    }
  }

  /**
   * Ensure `vec_items` exists and is sized for `dim`. A configured dimension that
   * differs from `dim` (the embedding connection changed) forces a full drop +
   * recreate of the *entire* table — sqlite-vec's `vec0` fixes a table's vector
   * width at creation time, and this table is shared across every root's partition,
   * so a dimension change is necessarily an all-roots event. This is the
   * documented, tested behavior for the "embedding dimension mismatch" Stop-short
   * risk: never silently reject or corrupt mismatched vectors. Other roots become
   * empty until they, too, call `rebuildRoot` — an accepted consequence of the
   * index being disposable/derived (ADR-0009), not a data-loss bug (nothing here
   * is authoritative).
   */
  private ensureDimension(dim: number): void {
    const configured = this.getConfiguredDimension();
    if (configured === null || !this.tableExists(VEC_TABLE)) {
      this.createVecTable(dim);
      return;
    }
    if (configured !== dim) {
      this.createVecTable(dim);
    }
  }

  // ── lastRebuiltAt bookkeeping ────────────────────────────────────────────

  private setLastRebuiltAt(rootId: string): void {
    this.open()
      .prepare(
        `INSERT INTO ${META_TABLE}(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(`${REBUILT_AT_PREFIX}${rootId}`, new Date().toISOString());
  }

  private getLastRebuiltAt(rootId: string): string | undefined {
    const row = this.open()
      .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
      .get(`${REBUILT_AT_PREFIX}${rootId}`) as { value: string } | undefined;
    return row?.value;
  }

  private clearLastRebuiltAt(rootId: string): void {
    this.open()
      .prepare(`DELETE FROM ${META_TABLE} WHERE key = ?`)
      .run(`${REBUILT_AT_PREFIX}${rootId}`);
  }

  private getMostRecentRebuiltAt(): string | undefined {
    const rows = this.open()
      .prepare(
        `SELECT value FROM ${META_TABLE} WHERE key LIKE '${REBUILT_AT_PREFIX}%'`,
      )
      .all() as Array<{ value: string }>;
    if (rows.length === 0) return undefined;
    return rows.map((r) => r.value).sort()[rows.length - 1];
  }

  // ── Row-level write helpers (shared by upsert() and rebuildRoot()) ──────

  /** Delete-then-insert semantics keyed on (store, recordId, chunkOrdinal) — the
   * entry's natural identity. Forces the table to the incoming dimension first
   * (see `ensureDimension`). */
  private writeEntries(entries: KnowledgeIndexEntry[]): void {
    if (entries.length === 0) return;
    this.ensureDimension(entries[0].vector.length);
    const db = this.open();
    const del = db.prepare(
      `DELETE FROM ${VEC_TABLE} WHERE store = ? AND recordId = ? AND chunkOrdinal = ?`,
    );
    const insert = db.prepare(
      `INSERT INTO ${VEC_TABLE}(rowid, store, embedding, recordId, chunkOrdinal, text, metadata) VALUES (null, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of entries) {
      del.run(entry.rootId, entry.recordId, entry.chunkOrdinal);
      insert.run(
        entry.rootId,
        toVectorBuffer(entry.vector),
        entry.recordId,
        BigInt(entry.chunkOrdinal),
        entry.text,
        JSON.stringify(entry.metadata ?? {}),
      );
    }
  }

  private deleteRootRows(rootId: string): void {
    if (!this.tableExists(VEC_TABLE)) return;
    this.open().prepare(`DELETE FROM ${VEC_TABLE} WHERE store = ?`).run(rootId);
  }

  // ── KnowledgeIndexProvider ───────────────────────────────────────────────

  async upsert(entries: KnowledgeIndexEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.writeEntries(entries);
    const rootIds = new Set(entries.map((e) => e.rootId));
    for (const rootId of rootIds) {
      knowledgeIndexOps.add(1, { op: 'upsert', rootId });
    }
  }

  async removeByRecord(rootId: string, recordIds: string[]): Promise<void> {
    if (recordIds.length > 0 && this.tableExists(VEC_TABLE)) {
      const placeholders = recordIds.map(() => '?').join(', ');
      this.open()
        .prepare(
          `DELETE FROM ${VEC_TABLE} WHERE store = ? AND recordId IN (${placeholders})`,
        )
        .run(rootId, ...recordIds);
    }
    knowledgeIndexOps.add(1, { op: 'removeByRecord', rootId });
  }

  async removeRoot(rootId: string): Promise<void> {
    this.deleteRootRows(rootId);
    this.clearLastRebuiltAt(rootId);
    knowledgeIndexOps.add(1, { op: 'removeRoot', rootId });
  }

  async search(
    query: number[],
    opts: {
      topK: number;
      rootIds?: string[];
      threshold?: number;
      filter?: Record<string, unknown>;
    },
  ): Promise<KnowledgeIndexHit[]> {
    knowledgeIndexOps.add(1, {
      op: 'search',
      rootId: opts.rootIds?.join(',') ?? 'all',
    });

    if (!this.tableExists(VEC_TABLE)) return [];

    const configured = this.getConfiguredDimension();
    if (configured !== null && configured !== query.length) {
      throw new Error(
        `sqlite-vec search: query vector has ${query.length} dimensions but the index is configured for ${configured} — the embedding connection likely changed; rebuildRoot() is required before searching with the new connection`,
      );
    }

    const conditions: string[] = ['embedding MATCH ?'];
    const params: unknown[] = [toVectorBuffer(query)];

    if (opts.rootIds && opts.rootIds.length > 0) {
      conditions.push(`store IN (${opts.rootIds.map(() => '?').join(', ')})`);
      params.push(...opts.rootIds);
    }

    if (opts.filter) {
      for (const [key, value] of Object.entries(opts.filter)) {
        conditions.push(`json_extract(metadata, ?) = ?`);
        params.push(`$.${key}`, value);
      }
    }

    // vec0 only prunes efficiently on the partition-key column; an arbitrary
    // metadata `json_extract` predicate is evaluated per-row after the KNN scan,
    // which can return fewer than `topK` matches for a small `k`. Over-fetch a
    // generous, fixed `k` and re-rank/truncate to `topK` in JS so threshold/filter
    // predicates never silently starve real results for a small corpus.
    const k = Math.max(opts.topK, 200);
    conditions.push('k = ?');
    params.push(k);

    const sql = `SELECT store, recordId, chunkOrdinal, text, metadata, distance FROM ${VEC_TABLE} WHERE ${conditions.join(' AND ')} ORDER BY distance`;
    const rows = this.open()
      .prepare(sql)
      .all(...params) as Array<{
      store: string;
      recordId: string;
      chunkOrdinal: number;
      text: string;
      metadata: string;
      distance: number;
    }>;

    const threshold = opts.threshold ?? 0;
    const hits: KnowledgeIndexHit[] = [];
    for (const row of rows) {
      // cosine distance -> similarity, matching lancedb-provider.ts's cosine-similarity
      // score convention (higher is better) so scores are comparable across providers.
      const score = 1 - row.distance;
      if (score < threshold) continue;
      hits.push({
        recordId: row.recordId,
        rootId: row.store,
        score,
        text: row.text,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      });
      if (hits.length >= opts.topK) break;
    }
    return hits;
  }

  /** SEC-2: guarded by a per-`rootId` key on `this.inFlight` — a second concurrent
   * `rebuildRoot` call for the SAME root fails fast with `RebuildInProgressError`
   * (surfaced by the route layer as HTTP 409) instead of racing this call's
   * embed-then-delete-then-write sequence. Concurrent `rebuildRoot` calls for
   * DIFFERENT roots are unaffected (different lock keys). */
  async rebuildRoot(
    rootId: string,
    deps: { store: KnowledgeStoreProvider; embedder: IEmbeddingProvider },
  ): Promise<{ records: number; chunks: number }> {
    return this.inFlight.run(rootId, () =>
      this.rebuildRootUnguarded(rootId, deps),
    );
  }

  private async rebuildRootUnguarded(
    rootId: string,
    deps: { store: KnowledgeStoreProvider; embedder: IEmbeddingProvider },
  ): Promise<{ records: number; chunks: number }> {
    const start = performance.now();

    const adapter = await deps.store.adapterFor(rootId);
    const records: KitRecord[] = [];
    for (const type of ALL_KIT_RECORD_TYPES) {
      const forType = await adapter.listByType(type, { includeRetired: true });
      records.push(...forType);
    }

    const pending: Array<{
      recordId: string;
      chunkOrdinal: number;
      text: string;
      metadata: Record<string, unknown>;
    }> = [];
    for (const record of records) {
      const chunks = chunkKnowledgeText(record.body);
      chunks.forEach((text, chunkOrdinal) => {
        pending.push({
          recordId: record.id,
          chunkOrdinal,
          text,
          metadata: {
            type: record.type,
            category: record.category,
            title: record.title,
            status: record.status ?? 'active',
          },
        });
      });
    }

    const vectors =
      pending.length > 0
        ? await deps.embedder.embed(pending.map((p) => p.text))
        : [];

    // Drop the root's existing partition only after the (possibly-failing) embed
    // call above has succeeded — an embedder error must never leave a root
    // half-deleted with nothing re-derived to replace it.
    this.deleteRootRows(rootId);

    if (pending.length > 0) {
      const entries: KnowledgeIndexEntry[] = pending.map((p, i) => ({
        recordId: p.recordId,
        rootId,
        chunkOrdinal: p.chunkOrdinal,
        text: p.text,
        vector: vectors[i],
        metadata: p.metadata,
      }));
      this.writeEntries(entries);
    }

    this.setLastRebuiltAt(rootId);

    const durationMs = performance.now() - start;
    knowledgeIndexRebuildDuration.record(durationMs, { rootId });
    knowledgeIndexOps.add(1, { op: 'rebuildRoot', rootId });

    return { records: records.length, chunks: pending.length };
  }

  async stats(rootId?: string): Promise<{
    chunks: number;
    lastRebuiltAt?: string;
  }> {
    if (!this.tableExists(VEC_TABLE)) {
      return {
        chunks: 0,
        lastRebuiltAt: rootId
          ? this.getLastRebuiltAt(rootId)
          : this.getMostRecentRebuiltAt(),
      };
    }
    const db = this.open();
    if (rootId) {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM ${VEC_TABLE} WHERE store = ?`)
        .get(rootId) as { c: number };
      return { chunks: row.c, lastRebuiltAt: this.getLastRebuiltAt(rootId) };
    }
    const row = db.prepare(`SELECT COUNT(*) as c FROM ${VEC_TABLE}`).get() as {
      c: number;
    };
    return { chunks: row.c, lastRebuiltAt: this.getMostRecentRebuiltAt() };
  }
}
