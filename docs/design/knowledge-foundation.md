# Knowledge foundation — K2..K5 interface contract

Design contract for the Knowledge foundation program (milestone #4, issues archive#200–archive#203), implementing
[ADR-0009](../adr/0009-treat-knowledge-stores-as-canonical-and-index-as-derived.md): Kit-format,
adapter-backed stores are canonical; the retrieval index is derived and rebuildable. The successor
index is **sqlite-vec** (runner-up: real LanceDB as an optional adapter) — the evidence matrix,
probe transcripts, and license notes live in ADR-0009's appendix and are not restated here.

K2's and K3's planners should be able to implement directly from this document. Interface names are
normative; shapes are precise enough to paste into TypeScript with minimal translation.

## Today's seam (what is being extended/replaced)

- One globally-resolved vector connection: `resolveRuntimeVectorDbProvider` →
  `findRuntimeCapabilityConnection(providerService, 'vectordb')`
  (`src-server/runtime/plugins/runtime-provider-resolution.ts:91-99`); same pattern for `embedding`.
- `IVectorDbProvider` / `IEmbeddingProvider` (`src-server/providers/llm/model-provider-types.ts:48-91`):
  namespace-keyed `addDocuments`/`search`/`getByMetadata`/`count`.
- The built-in `vectordb` implementation is `lancedb-file`
  (`src-server/providers/lancedb-provider.ts:42-113`) — flat JSON per namespace, brute-force cosine.
- Providers are registered through the additive `registerConnectionFactory(type, factories)` pattern
  (`src-server/providers/connection-factories.ts:65-98`); the store and index seams below reuse it.

## K2 — Store layer: `KnowledgeStoreProvider`

Layer 1 of ADR-0009. Store roots are first-class entities; every record CRUD call delegates to the
Kit's published `KnowledgeStoreAdapter` contract (`kits/knowledge/docs/store-contract.md` §8 — inside the installed `@kontourai/flow-agents` package, not this repo, plus
`supersede` from Addendum A.6 and `retire` from Addendum B.5) — Station never parses or writes the
Kit's on-disk format itself and never imports Kit internals (ADR-0001; enforced by a zero-tolerance
grep gate, `scripts/knowledge-kit-import-gate.mjs`, wired into `verify:static` as of K2 Wave 3 —
issue archive#200's `k2-no-kit-internal-imports` AC).

> **Contract version (coordinator decision, 2026-07-05).** K2's adapters are written against
> `store-contract.md` **as of `@kontourai/flow-agents` 3.3.0** (the sibling `../flow-agents` dev-tree
> copy) — specifically Addendum H (stable-id/slug identity resolution), §8.1 (the
> `NOT_FOUND`/`AMBIGUOUS_ID`/`SLUG_CONFLICT` error codes beyond `MISSING_EVIDENCE`), and the
> `status`/`retire` lifecycle. Station's own `package.json` pins `"@kontourai/flow-agents": "^2.2.0"`
> for **sidecar tooling only** (the `workflow:sidecar` CLI) — that pin is independent of this
> contract target: the K2 adapters import nothing from the `@kontourai/flow-agents` package (ADR-0001;
> zero Kit-internal imports, confirmed by the K2 grep gate), so they cannot "use" whichever version is
> installed one way or the other. The installed `2.2.0` package's own `store-contract.md` predates
> Addendum H/§8.1 entirely (those sections were added upstream starting at `flow-agents` v3.0.0), so
> a Kit-CLI/flow actually running at `2.2.0` would not recognize (though also not necessarily reject)
> records K2 writes with `aliases`/`status`/those ops' mutation-log shapes — Kit-CLI interop claims in
> this document and the K2 deliverable are scoped to `3.x` tooling, not to whatever `^2.2.0` resolves
> to today. Bumping the sidecar dependency to `^3.x` (re-verifying AC1/AC5 against the newly-pinned
> version's actual `store-contract.md`) is tracked as a fast-follow: **archive#218**. This note does not
> change any dependency in `package.json` — it documents an existing, already-shipped gap.

> **Update (2026-07-07, archive#218 landed):** Station's sidecar pin is now exact `"@kontourai/flow-agents": "3.3.0"` (no caret) — the gap this note tracked is resolved; the installed package's `store-contract.md` now matches the version K2's adapters were written against. See `.kontourai/flow-agents/s218-flow-agents-3x/cli-audit-2.2.0-to-3.3.0.md` for the full sidecar-CLI behavior audit (a separate, unrelated concern from this store-contract note, since K2 imports nothing from the package).

```ts
/** Scope tier of a store root. Org tier is deferred (ADR-0009) — not in the union on purpose. */
export type KnowledgeRootScope =
  | { kind: 'personal' }                       // exactly one per user
  | { kind: 'project'; projectSlug: string };  // one or more per project

export interface KnowledgeStoreRoot {
  id: string;                 // stable id, e.g. 'root:personal', 'root:project-<slug>[:<name>]'
  scope: KnowledgeRootScope;
  adapterId: string;          // which registered adapter serves this root
  storeRoot: string;          // absolute path handed to the adapter constructor — the Kit's
                              // real published axis (store-contract.md §8: `{ storeRoot: string }`)
  displayName: string;
  createdAt: string;          // ISO-8601
}

/**
 * The Kit's adapter contract, §8 verbatim (+ A.6 supersede, B.5 retire).
 * Station TYPES this seam but the implementations are the Kit's own published adapter modules
 * (adapters/default-store, adapters/obsidian-store), loaded as ESM per the contract:
 * "a JavaScript module (ESM) exporting a default class or factory function" whose
 * constructor/factory accepts `{ storeRoot }`.
 */
export interface KnowledgeStoreAdapter {
  create(record: CreateInput): Promise<string>;
  update(id: string, fields: UpdateFields, evidence: UpdateEvidence): Promise<void>;
  link(sourceId: string, links: KitLink[], evidence: LinkEvidence): Promise<void>;
  propose(conceptId: string, proposerId: string, evidence: ProposeEvidence): Promise<void>;
  apply(conceptId: string, proposerId: string, evidence: ApplyEvidence): Promise<void>;
  reject(conceptId: string, proposerId: string, evidence: RejectEvidence): Promise<void>;
  supersede(newId: string, supersededIds: string[], evidence: SupersedeEvidence): Promise<void>; // A.6
  retire(id: string, targetStatus: 'implemented' | 'retired', evidence: RetireEvidence): Promise<void>; // B.5
  get(idOrHandle: string): Promise<KitRecord | null>;
  getLinks(idOrHandle: string): Promise<{ forward: KitLink[]; reverse: KitReverseLink[] }>;
  // B.5 also adds `includeRetired?: boolean` to both list methods' options (default: excludes retired).
  listByCategory(category: string, options?: { prefix?: boolean; includeRetired?: boolean }): Promise<KitRecord[]>;
  listByType(type: 'raw' | 'compiled' | 'concept' | 'snapshot' | 'person', options?: { includeRetired?: boolean }): Promise<KitRecord[]>;
}

/** Adapter registration — additive, mirroring registerConnectionFactory. */
export interface KnowledgeAdapterDescriptor {
  id: string;                        // 'kit-default-store' | 'kit-obsidian-store' | plugin-contributed
  displayName: string;
  create(options: { storeRoot: string }): Promise<KnowledgeStoreAdapter>;
  /** e.g. the Obsidian adapter validating an existing vault; optional. */
  validateRoot?(storeRoot: string): Promise<{ ok: boolean; reason?: string }>;
}

/** The K2 seam Station's services and routes consume. */
export interface KnowledgeStoreProvider {
  // Root registry
  listRoots(): Promise<KnowledgeStoreRoot[]>;
  getRoot(rootId: string): Promise<KnowledgeStoreRoot | null>;
  createRoot(input: Omit<KnowledgeStoreRoot, 'id' | 'createdAt'>): Promise<KnowledgeStoreRoot>;
  removeRoot(rootId: string): Promise<void>;   // deregisters only — NEVER deletes store files

  // Adapter registry (additive provider pattern; plugins may contribute)
  registerAdapter(descriptor: KnowledgeAdapterDescriptor): void;
  listAdapters(): KnowledgeAdapterDescriptor[];

  // Record access — thin delegation to the root's adapter instance
  adapterFor(rootId: string): Promise<KnowledgeStoreAdapter>;

  // Change signal for the derived index (K3 subscribes; see rebuild contract)
  onRecordsChanged(listener: (event: { rootId: string; recordIds: string[] }) => void): () => void;
}
```

Notes for K2's planner:

- `reverse` is `KitReverseLink[]` (`{ source_id, kind }`), not `KitLink[]` — store-contract.md §5.1's
  reverse graph-index schema names the *source* record, not a `target_id`, and carries no `label`
  (unlike a forward `KitLink`). This snippet previously collapsed the two shapes for brevity; the
  Wave 1 implementation (`packages/contracts/src/knowledge-store.ts`) follows §5.1 precisely — see
  the s200-knowledge-store code review's deviation adjudication for the record.
- The Kit's Neo4j provider is **not** a `KnowledgeStoreAdapter` (it is a read-side materialized
  graph view synced *from* stores — Kit README "Graph provider (opt-in)"). Surface it as an opt-in
  *connection* on the graph-query axis for K5's dogfood, not as a root's adapter. Only
  `default-store` and `obsidian-store` implement §8 today. K2 Wave 3 shipped the registration-only
  stub per this framing: `src-server/knowledge-store/neo4j-connection.ts` — a standalone
  connection-type registry (config shape, TCP-only reachability check, honest `{ok: false, reason}`
  query stub), never touching `KnowledgeStoreAdapter`/`KnowledgeStoreProvider`/the adapter registry.
  A real bolt-driver graph-sync client remains K5's dual-adapter dogfood scope.
- Root persistence rides Station's existing storage adapter (`~/.station`), not the store itself —
  the store directory must remain valid for non-Station consumers (Obsidian, the Kit CLI).
- Existing per-project namespaces re-expressed as project roots is K2's compat path
  (`ProjectConfig.knowledgeNamespaces` → named project roots); feature-flag if needed per the
  program's risk notes.
- OTel: `station.knowledge.root.*` and `station.knowledge.record.*` counters per CLAUDE.md.

### Transactional file publication (archive#2253)

The default and Obsidian adapters preserve the public `KnowledgeStoreAdapter` contract and Kit-compatible file layouts, but they no longer perform independent raw whole-file mutations. The older project-document service uses the same boundary for `files/` content and `metadata.json`. All three caller families compose the private `KnowledgeFileTransactions` Module, so one process-identity lock in Station's `STATION_HOME` coordination directory and one root-local rollback journal cover every authoritative file mutation.

Records and project-document files plus metadata are authoritative; vector entries remain derived. A transaction stages its complete write set, verifies the bytes, directory listings, and legacy-source snapshots it read, persists a prepared journal, publishes record/document content before metadata and derived indexes, and performs removals last. Each file replacement is durable temp-write + fsync + rename + parent-directory fsync. A prepared journal rolls back on the next locked open; a committed journal is cleanup-only. A current file matching neither the journal's before nor after hash is an external conflict and is never overwritten by recovery. Project-document update/delete commits file and metadata authority before best-effort vector derivation. Every derived vector carries the committed content hash, and search/injected context return it only when that hash matches transaction-gated metadata. Missing legacy hashes fail closed until authoritative content is hashed and the derived index rebuilt. A vector failure therefore cannot rewrite authority or expose uncommitted text and remains repairable from authoritative files.

Only `ENOENT` means missing. Invalid record/path metadata and an invalid transaction journal fail closed; graph and alias indexes may be rebuilt from validated records. The Obsidian relocation order is publish-new → publish-path-index → remove-old, so a title/category edit never deletes the only document copy before its replacement exists. `station.knowledge.store.transactions` records applied, rejected, conflict, unavailable, and recovery outcomes. See the canonical contributor contract and negative guidance in [the Module map](../architecture/module-map.md#knowledgefiletransactions).

## K3 — Index layer: `KnowledgeIndexProvider`

Layer 2 of ADR-0009. Shaped like today's `IVectorDbProvider` + `IEmbeddingProvider` but explicitly
**derived — never authoritative**: nothing may be stored in the index that cannot be regenerated
from the K2 stores, and no read path may treat an index hit as the record (always re-resolve via
`adapterFor(rootId).get(recordId)`).

> **K3 landed (`s201-knowledge-retrieval`, issue archive#201, 2026-07-06).** Contract:
> `packages/contracts/src/knowledge-index.ts` (transcribed verbatim from the block below). Built-in
> provider: `src-server/knowledge-index/sqlite-vec-index-provider.ts` (`SqliteVecIndexProvider`,
> `id: 'sqlite-vec'`), registered through `src-server/knowledge-index/index-adapter-registry.ts`
> (`KnowledgeIndexAdapterRegistry` — a small `Map`-based, additive registry mirroring the K2 store
> adapter registry, **not** `registerConnectionFactory`; see the deviation below). Non-destructive
> import core: `src-server/knowledge-index/migrate-pre-index-knowledge.ts`
> (`migratePreIndexKnowledge`). Routes: `src-server/routes/knowledge/knowledge-index-routes.ts`
> (`POST /api/knowledge/index/rebuild`, `POST /api/knowledge/migrate`), mounted in
> `src-server/runtime/routes/runtime-routes.ts` alongside the existing `/api/knowledge` routes. DRY client:
> `packages/sdk/src/client/knowledge.ts` (`rebuildKnowledgeIndex`/`migratePreIndexKnowledge`
> fetchers). CLI verbs: `packages/cli/src/commands/knowledge.ts`
> (`./station knowledge reindex [--root <id>]` / `./station knowledge migrate [--project <slug>]`).
> station-control tools: `reindex_knowledge`/`migrate_knowledge` in
> `src-server/tools/station-control-operations-tools.ts`. OTel:
> `station.knowledge.index.operations`/`station.knowledge.index.rebuild.duration`/
> `station.knowledge.migration.operations` in `src-server/telemetry/metrics.ts`. Tests:
> `src-server/knowledge-index/__tests__/{recall-parity,lossless-rebuild,migration,
> partition-scoping,sqlite-vec-index-provider}.test.ts` plus a shared
> `__fixtures__/corpus.ts` builder (AC1–AC3 evidence). `lancedb-provider.ts`'s `id: 'lancedb-file'`
> is unchanged; only its `displayName`/JSDoc were updated to state the deprecation honestly (never a
> destructive rename — see the Stop-short risk in the plan).
>
> **Deviations from this section's sketch, found during implementation:**
> - **vec0 rejects `INTEGER` aux columns bound as `SQLITE_FLOAT`.** `node:sqlite`'s `DatabaseSync`
>   binds a plain JS number as `SQLITE_FLOAT` (`sqlite3_bind_double`) regardless of the target
>   column's declared type. Ordinary SQLite tables coerce this via column affinity, but `vec0`'s own
>   `xUpdate` type-checks bound values against their *actual* fundamental type and rejects a FLOAT
>   for an INTEGER auxiliary column ("Auxiliary column type mismatch"). Fix: bind
>   `chunkOrdinal` (and any other INTEGER aux column) as a JS `BigInt` on insert; `rowid` is passed as
>   `null` (auto-assign) since identity is `(store, recordId, chunkOrdinal)`, never the raw rowid.
>   Ordinary `DELETE ... WHERE` comparisons are unaffected — only vec0's insert-time check cares.
> - **`distance_metric=cosine` attaches to the vector column's own type declaration**
>   (`embedding float[N] distance_metric=cosine`), not as a separate table-level option, in the
>   `CREATE VIRTUAL TABLE ... USING vec0(...)` DDL.
> - **Embedding dimension is tracked explicitly, not inferred.** A small `index_meta` key/value
>   table (not sketched above) records the table's configured vector width. `upsert`/`rebuildRoot`
>   compare the incoming vector's length against it; a mismatch forces a full `DROP`/recreate of the
>   *entire* `vec0` table (shared across every root's partition — `vec0` fixes width at creation
>   time) rather than silently rejecting or corrupting inserts, per the plan's Stop-short risk.
>   `search` similarly throws (rather than returning wrong-shaped results) when a query vector's
>   dimension doesn't match the configured one, naming the required fix (`rebuildRoot`) in the error.
>   User-facing consequence: this makes an embedding-connection change an
>   all-roots event, not a single-root one — every already-indexed root other than the one that
>   happens to trigger the drop/recreate goes searchably empty until it's rebuilt too; recovery is
>   `./station knowledge reindex` with no `--root` (see `docs/guides/knowledge.md`'s
>   rebuildability section).
> - **`rebuildRoot` embeds before deleting.** The old partition's rows are dropped only *after* the
>   (possibly-failing) embed call for the newly-listed records has already succeeded, so an embedder
>   error never leaves a root's index half-deleted with nothing re-derived to replace it.
> - **Registration mechanism**: the index-provider registry is a small dedicated
>   `KnowledgeIndexAdapterRegistry` class (`Map`-based, keyed by provider `id`, pre-registering
>   `sqlite-vec` in its constructor), mirroring the K2 store-adapter registry pattern directly rather
>   than reusing `registerConnectionFactory` — the connection-factory seam is oriented around
>   user-configured provider *connections* (API keys, endpoints), not an in-process index
>   implementation lookup, so a parallel, purpose-built registry was the closer fit.

> **Derived read-only roots (`s1879-conversation-knowledge-root`, archive#1879, landed).** A
> `KnowledgeAdapterDescriptor` need not read/write a Kit-format file tree at all: `conversation-store`
> (`src-server/knowledge-store/adapters/conversation-store.ts`) projects Station's own conversation
> history — the orchestration session read-model union the per-agent file memory store — into the
> `root:conversations` root (`CONVERSATION_ROOT_ID`), so the K3 index and the `station knowledge
> search`/`search_knowledge` surfaces (`s1886-knowledge-search`, issue archive#1886) cover past conversations
> exactly like any other root. Two disclosed deviations from the sketch above:
> - **Non-Kit-file canonical source.** Every other adapter's canonical source is a Kit-format file
>   tree at `storeRoot`. This adapter's canonical source is `<STATION_HOME>/data/orchestration.sqlite`
>   (`getOrchestrationDatabasePath`) plus each agent's file memory store — `storeRoot` is recorded on
>   the registered root purely as a documentary location string for Settings/CLI listings; the
>   adapter's `create()` never reads it. The K2/K3 authority ranking is otherwise unchanged: the
>   orchestration event store and file memory stores remain canonical for conversation transcripts,
>   the derived root is a read-only PROJECTION of them (not a copy), and the K3 index over that root
>   is, as always, itself further derived and disposable.
> - **`READ_ONLY` — a Station extension beyond store-contract §8.1.** `KnowledgeStoreErrorCode` gained
>   a fifth code (`packages/contracts/src/knowledge-store.ts`) with no upstream Kit contract
>   equivalent, thrown by every one of `conversation-store`'s eight mutation verbs
>   (`ReadOnlyStoreError`, `src-server/knowledge-store/errors.ts`) and mapped to HTTP 405 in
>   `knowledge-record-routes.ts`. A conformant, non-Station reader of the same contract never
>   encounters this code. Root-ensure (`src-server/knowledge-store/conversation-root-bootstrap.ts`'s
>   `ensureConversationKnowledgeRoot`, wired at `station-runtime.ts`'s `onRouteServicesReady`) is
>   gated on `AppConfig.knowledgeStores === true` — this flag's first real enforcement point; adapter
>   *registration* is unconditional and zero-I/O regardless of the flag. See
>   [`docs/design/plugin-knowledge-store-contributions.md`](./plugin-knowledge-store-contributions.md)
>   for the broader (still-proposed) shape of declarative, read-only root projections this adapter is
>   one concrete, Station-owned instance of — that proposal's boundary rationale (why a read-only
>   projection needs its own trust/lifecycle contract) applies here too, even though this landing
>   predates any plugin-facing version of it.

```ts
export interface KnowledgeIndexEntry {
  recordId: string;           // Kit record id — the join key back to the canonical store
  rootId: string;             // which store root the record came from
  chunkOrdinal: number;       // records may index as multiple chunks
  text: string;
  vector: number[];
  metadata: Record<string, unknown>;  // category, type, title, status, ...
}

export interface KnowledgeIndexHit {
  recordId: string;
  rootId: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeIndexProvider {
  readonly id: string;              // built-in successor: 'sqlite-vec' (ADR-0009 appendix)
  readonly displayName: string;

  upsert(entries: KnowledgeIndexEntry[]): Promise<void>;
  removeByRecord(rootId: string, recordIds: string[]): Promise<void>;
  removeRoot(rootId: string): Promise<void>;   // drop a root's partition — cheap, index-only

  search(query: number[], opts: {
    topK: number;
    rootIds?: string[];             // scope to a subset of roots; omitted = all registered roots
    threshold?: number;
    filter?: Record<string, unknown>;  // metadata equality predicates
  }): Promise<KnowledgeIndexHit[]>;

  /**
   * THE rebuild contract: drop everything held for `rootId` and re-derive it by enumerating the
   * root's records through the K2 seam (listByType over all types → chunk → embed → upsert).
   * Property K3 must test: for a root with N records, a from-scratch rebuild produces recall
   * behavior equivalent to the incrementally-built index (index deleted → rebuilt → same results
   * for a fixture query set).
   */
  rebuildRoot(rootId: string, deps: {
    store: KnowledgeStoreProvider;
    embedder: IEmbeddingProvider;   // existing seam, model-provider-types.ts:48-55
  }): Promise<{ records: number; chunks: number }>;

  stats(rootId?: string): Promise<{ chunks: number; lastRebuiltAt?: string }>;
}
```

Notes for K3's planner:

- Built-in implementation: sqlite-vec loaded into `node:sqlite`, one database file (default:
  `{dataDir}/knowledge-index/index.db`, constructor-overridable — landed exactly as suggested), one
  `vec0` virtual table with `store TEXT partition key` — the probe demonstrated per-root partition
  scoping with zero leakage (ADR-0009, Probe A), confirmed by the landed
  `partition-scoping.test.ts` suite.
- **Landed as a dedicated `KnowledgeIndexAdapterRegistry`** (small `Map`-based registry mirroring
  the K2 store-adapter registry), not `registerConnectionFactory` — see the deviation note above;
  real LanceDB may still later register alongside `sqlite-vec` as an optional second index adapter
  (runner-up) through the same registry's additive `register()`.
- **Landed as explicit-only, not automatic-incremental.** `KnowledgeStoreProvider.onRecordsChanged`
  is emitted by K2 (`knowledge-store-provider.ts`) but this slice does not wire an automatic
  listener from it into the index — the only way the index picks up new/changed records today is an
  explicit `rebuildRoot` call, surfaced as `./station knowledge reindex [--root <id>]` (CLI →
  `packages/sdk/src/client/knowledge.ts` → `POST /api/knowledge/index/rebuild`). Wiring
  `onRecordsChanged` to a cheap incremental `upsert` (rather than a full `rebuildRoot`) remains
  open for a fast-follow; nothing about the derived/rebuildable design prevents it later.
- Embeddings keep the existing `IEmbeddingProvider` seam and connection resolution — this program
  does not change how embedders are chosen.

## Migration — non-destructive, explicit, reversible until cutover

Actual current on-disk layout (verified in source, 2026-07-05):

- **Vectors:** `{dataDir}/vectordb/<namespace>/vectors.json` — flat JSON array of
  `{id, vector, text, metadata}` (`lancedb-provider.ts:24-40`; default dataDir
  `join(resolveHomeDir(), 'vectordb')`, line 48). Namespace = `project-<slug>` or
  `project-<slug>:<namespace>` (`knowledgeVectorNamespace()`,
  `src-server/services/knowledge/knowledge-storage.ts:246-253`).
- **Documents:** `{dataDir}/projects/<projectSlug>/knowledge/<namespace>/{metadata.json, files/}`
  (`defaultKnowledgeStorageDir()`, `knowledge-storage.ts:131-137`).
  Transaction-gated document reads also support the earlier document metadata
  directory at `projects/<slug>/documents/` when the namespace metadata file is
  absent.

Migration path (K3, one-time, **explicit command — never automatic on startup**):

1. `./station knowledge migrate [--project <slug>]` reads, per project namespace: the document
   metadata + `files/` content (canonical text) and the old `vectors.json` (reusable vectors when
   the embedding connection is unchanged; re-embed otherwise).
2. Each project's namespace is re-expressed as a project-scoped K2 store root: documents become Kit
   `raw` records (provenance noting the migration) via the root's adapter — written only through
   the §8 contract.
3. The new index is built by `rebuildRoot` from that store root.
4. **The old directories are never touched**: `{dataDir}/vectordb/<namespace>/` and
   `{dataDir}/projects/<slug>/knowledge/<namespace>/` are preserved as-is, and the old read path
   keeps working, until the user explicitly confirms cutover. Cutover flips the read path to the
   new seams; even then, deletion of old directories is a separate user-initiated cleanup, not part
   of the migration. Rollback before cutover = do nothing (old path still live); the new root and
   index are additive.

This satisfies the program risk note ("K3 migration is the data-risk center: never destructive")
and issue archive#201's AC ("migration verified on a copy of a real home").

Migration observations are non-authoritative: telemetry and logging failures cannot interrupt
record creation or derived indexing. A retry skips an existing record but still idempotently
upserts its derived index, closing a prior create/index-failure boundary. Public namespace failure
results carry only a stable `knowledge_migration_failed` code and copy; filesystem and provider
diagnostics remain internal.

## K4 — Onboarding sketch (screens and decision points only; K4 is its own slice)

Settings owns the optional "knowledge setup" flow. It follows the glossary's noun discipline
(Skills/Registry/Models/Engines — no new nouns; "store root" surfaces to users as
**"knowledge store"**):

1. **Create or pick your personal store** — default: create at `<STATION_HOME>/knowledge/personal`
   with the Kit default adapter; alternative: **"Connect an existing Obsidian vault"** (path picker
   → `validateRoot` from the Obsidian adapter descriptor; surfaces the Kit's vault layout honestly).
2. **Adapter choice per store** — default file store vs Obsidian vault; additional adapters appear
   as they are registered (Registry page is the browse/install surface). Neo4j graph view is
   offered as an opt-in *connection* (K5), clearly labeled as graph queries, not storage.
3. **Project defaults** — per-project store auto-created on first knowledge write (opt-out);
   existing projects with pre-index namespaces get a "migrate this project" affordance that runs the
   K3 migration command with its non-destructive guarantee stated in the UI copy.
4. **Empty/error states** — honest states per UX S3 primitives when available (no silent
   substitution; an unreachable Obsidian vault or missing embedding connection is named, with the fix
   linked).

Decision points K4's planner owns: copy for the cutover confirmation; whether first-run blocks on
knowledge setup or defers to a rescue banner (coordinate with archive#191); where "knowledge store"
management lives in Settings vs the Connections page.

> **K4 landed (`s202-knowledge-onboarding`, issue archive#202, 2026-07-07).** Additive contract method:
> `KnowledgeStoreProvider.validateRootForAdapter(adapterId, storeRoot)`
> (`packages/contracts/src/knowledge-store.ts`), implemented in
> `src-server/knowledge-store/knowledge-store-provider.ts` (delegates to the target adapter's own
> `validateRoot`, `{ ok: true }` when the adapter declares none, unknown `adapterId` → named
> `{ ok: false, reason }` — never a thrown error the route would have to translate). Routes:
> `src-server/routes/knowledge/knowledge-store-routes.ts` (`GET /api/knowledge/roots`,
> `POST /api/knowledge/roots`, `POST /api/knowledge/roots/validate`, `GET /api/knowledge/adapters`,
> `DELETE /api/knowledge/roots/:id`), mounted in `src-server/runtime/routes/runtime-routes.ts` on the same
> `/api/knowledge` base K3's routes already use (distinct sub-paths, no collision). DRY client:
> `packages/sdk/src/client/knowledge.ts` (`listKnowledgeRoots`/`createKnowledgeRoot`/
> `validateKnowledgeRoot`/`listKnowledgeAdapters`/`deleteKnowledgeRoot`). React Query hooks:
> `packages/sdk/src/query-domains/knowledgeStores.ts` (`useKnowledgeRootsQuery`,
> `useKnowledgeAdaptersQuery`, `useCreateKnowledgeRootMutation`, `useValidateKnowledgeRootMutation`,
> `useDeleteKnowledgeRootMutation`, plus `useMigratePreIndexKnowledgeMutation` — the first React hook
> over K3's pre-index import fetcher, which shipped hookless in K3 Wave 4),
> re-exported from `packages/sdk/src/queries.ts`. UI: global Settings "Knowledge Store" section
> (`src-ui/src/views/settings/KnowledgeStoreSection.tsx` + `.css`, wired into
> `src-ui/src/views/SettingsView.tsx` at `#section-knowledge`); project-settings "Knowledge store"
> subsection (`src-ui/src/views/project-settings/KnowledgeSection.tsx`'s `KnowledgeStoreSubsection`);
> optional personal setup and discovery remain owned by Settings. Every empty/error surface in the
> UI goes through `Empty`/`ErrorState`/`Skeleton`
> (`src-ui/src/components/state`) per R3; `docs/guides/knowledge.md`'s "Optional setup in Settings"
> section is the user-facing doc this callout cross-references.
>
> **Deviations from this section's sketch, found during implementation:**
> - **Optional discovery lives only in Settings.** Provider/chat readiness and reconnect recovery
>   remain separate because they represent blocking operational conditions.
> - **Safe personal-store redefinition remains a contract gap.** Existing create/remove operations
>   cannot switch atomically: delete-before-create can leave no active root and create-before-delete
>   can register two. The UI does not expose either sequence. Add an atomic validate-and-replace
>   contract before offering "Change knowledge store"; preserve the old files, and do not call a
>   registry target change "migration" unless records are copied and verified.
> - **The project-scope default path (`{dataDir}/projects/<slug>/knowledge-store`) landed in Wave 1,
>   not Wave 2.** This section's sketch and the plan's Wave 2 task description describe the
>   project-store server default as something Wave 2 "extends the Wave 1 server default logic" to
>   cover — in the landed code, `src-server/routes/knowledge/knowledge-store-routes.ts`'s `defaultStoreRoot()`
>   already branches on `scope.kind` and covers both the personal and project cases in the same
>   Wave 1 commit, so no follow-up server change was needed when Wave 2's project-settings UI started
>   calling `POST /roots` with an omitted `storeRoot` for `scope.kind === 'project'`.
>
> **`knowledgeStores` config flag status, unchanged by this work.** `AppConfig.knowledgeStores`
> (`packages/contracts/src/config.ts`) still reads as "default off" in its own doc comment, and this
> plan — like K2 and K3 before it — does not add any conditional on it: every route in
> `knowledge-store-routes.ts`, every new SDK hook, and every new UI surface (Settings section,
> project-settings subsection) is unconditionally reachable regardless of the
> flag's value. Verified by repo-wide grep during this work: the only non-comment, non-type-decl
> reference to the string `knowledgeStores` anywhere in `src-server/`, `src-ui/`, or `packages/` is
> the config type declaration itself (`packages/contracts/src/config.ts`) plus one explanatory
> comment (`src-server/runtime/bootstrap/runtime-service-bootstrap.ts`) — zero code paths branch on it. This
> is flagged for the user at PR review, not silently decided: confirm this unconditional rollout is
> intended, or decide separately whether the flag should become load-bearing (a larger, distinct
> change this plan does not make).

## K5 — Meeting notes app (issue archive#203)

K5 consumes only the seams above: capture writes `raw` → `compiled` records through
`KnowledgeStoreProvider` (right-root choice is manual UI in K5; K6 automates later — parked), and
recall reads `KnowledgeIndexProvider.search` across `rootIds: [personal, project]` plus the graph
view for the wikilink pane. Dual-adapter dogfood (Obsidian AND Neo4j personal roots) is K5's
explicit validation AC.

> **K5 landed (`s203-knowledge-meeting-notes`, issue archive#203, 2026-07-07).** The meeting-notes app:
> `examples/meeting-notes/` (`plugin.json`, `layout.json`, `src/index.tsx`) — three tabs, **Capture**
> (`src/CaptureModal.tsx` + `src/compile.ts`, a plugin-contributed `compile` agent at
> `agents/compile/agent.json`), **Library** (`src/GraphPane.tsx`, the wikilink graph pane), **Ask**
> (`src/AskPane.tsx`, retrieval-grounded Q&A). Two flagged core route additions close the primitive
> gaps this plan named: `src-server/routes/knowledge/knowledge-record-routes.ts` (record create/get/listByType/
> link + a file-adapter `GET /roots/:rootId/graph`) and `knowledge-index-routes.ts`'s new
> `POST /index/search` (embeds the query, calls `KnowledgeIndexProvider.search`, re-resolves every hit
> against its `KnowledgeStoreAdapter` before it crosses the wire — K3's "never treat an index hit as
> the record" rule, applied at the route layer too). Both mounted in
> `src-server/runtime/routes/runtime-routes.ts` on the existing `/api/knowledge` base. DRY client + hooks:
> `packages/sdk/src/client/knowledge.ts` (`createKnowledgeRecord`/`getKnowledgeRecord`/
> `linkKnowledgeRecord`/`listKnowledgeRecordsByType`/`getKnowledgeGraph`/`searchKnowledgeIndex`),
> `packages/sdk/src/query-domains/knowledgeStores.ts` (matching React Query hooks), re-exported from
> `packages/sdk/src/queries.ts` + `packages/sdk/src/index.ts`. Tests:
> `src-server/routes/knowledge/__tests__/knowledge-record.routes.test.ts`, the extended
> `knowledge-index.routes.test.ts`, the extended `packages/sdk/src/__tests__/knowledge.test.ts`, and
> `examples/meeting-notes/src/__tests__/*` (Capture/RootPicker/GraphPane/AskPane/compile — the
> `api` test file was deleted along with `api.ts` itself; see the deviation note below).
>
> **Q1 OWNER DECISION (ratified 2026-07-07, via interactive ratification — see
> `s203-knowledge-meeting-notes--pull-work.md`'s "Q1 RATIFIED" record):** the issue's literal "Neo4j
> personal root" wording is **superseded**, not silently reinterpreted. The user selected "Graph view,
> synced": a second personal root's storage stays on a real file adapter (`kit-default-store`), and
> Neo4j is completed as this section's own K2 framing already prescribed — an opt-in, read-side
> graph-query connection synced *from* a store, never a write-target adapter of its own. Landed:
> `src-server/knowledge-store/neo4j-graph-sync.ts` (`syncRootToNeo4j` — idempotent, content-hash
> guarded MERGE of a root's records+links into Neo4j; never mutates the file store) and
> `src-server/knowledge-store/neo4j-graph-provider.ts` (`readGraph(rootId)`, `shortestPath(rootId,
> fromId, toId)`, plus `createNeo4jDriver`'s lazy-guarded real-driver loader). `neo4j-connection.ts`'s
> K2 registration/reachability/query-stub surface is unchanged; the new modules consume
> `getNeo4jGraphViewConnection()` for config and a driver-injectable `Neo4jDriverLike` (real
> `neo4j-driver` or `__tests__/fake-neo4j-driver.ts`'s in-memory double) for execution. `neo4j-driver`
> is now an explicit direct dependency (`package.json`, pinned `^5.28.0`; previously present in
> `package-lock.json` only transitively, via `@kontourai/flow-agents`'s own optional dependency).
> Tests: `neo4j-graph-sync.test.ts`, `neo4j-graph-provider.test.ts`, `neo4j-graph.routes.test.ts`, plus
> an env-guarded (`KNOWLEDGE_NEO4J_TEST_URL`) live-integration extension of
> `neo4j-connection.test.ts` exercising sync/readGraph/shortestPath against a real local Docker Neo4j
> (see `docs/guides/knowledge.md`'s "Meeting notes: capture and recall" section for the `docker run`
> quickstart) — skipped, not silently passed, when that variable is unset (the default in CI).
>
> **Deviations from this section's sketch, found during implementation:**
> - **Sibling Neo4j route file, not an extension.** `src-server/routes/knowledge/neo4j-graph-routes.ts` is a
>   deliberate sibling of `knowledge-record-routes.ts` (mounted at the sub-path
>   `/roots/:rootId/graph/neo4j*`) rather than a change to that already-landed, already-tested file —
>   keeps the Neo4j-backed graph read file-disjoint from the file-adapter graph read, and a caller
>   (a future recall-UI change) chooses per-root which backend to query rather than either route
>   silently guessing. Every route in this file degrades to an honest `503` naming the reason
>   (no connection registered, or the lazy real-driver load failed) — never a crash, never a silent
>   empty success.
> - **Record-id traversal hardening at the route layer.** Discovered while landing
>   `knowledge-record-routes.ts`: `kit-default-store`'s `recordPath(id)` joins a caller-supplied id
>   straight into `records/<id>.md` with no validation of its own, so the new HTTP boundary is a real
>   traversal vector for any id-shaped input reaching that join (`create`'s optional `id`, `link`'s
>   `target_id`s, `get`'s `:id`). Every such value is validated with `isSafePathSegment` before it
>   reaches the adapter, rejecting with 400 rather than letting an invalid value reach a throw deeper
>   in the stack. `neo4j-graph-routes.ts`'s `fromId`/`toId` get the same check as defense-in-depth
>   even though they reach Neo4j only as Cypher query parameters (not string-interpolated), so they
>   carry no actual injection risk the way a raw path join would.
> - **Recurring SDK barrel-export gap (3rd occurrence of this class in this program).** A new
>   `packages/sdk` query-domain hook must be re-exported by hand from BOTH `packages/sdk/src/queries.ts` and `packages/sdk/src/index.ts` — there is still no lint/build check that catches a
>   missing re-export automatically. Landing the Ask-pane task hit this again for
>   `useSearchKnowledgeIndexMutation` (alongside the other new K5 hooks); fixed in this landing, but
>   the pattern itself remains an unaddressed fast-follow, named here rather than fixed silently a
>   fourth time with nothing recorded.
> - **`api.ts` → SDK swap, completed in a Wave 3 cleanup pass.** `examples/meeting-notes/src/api.ts`
>   was written (Wave 1 Task 3) before `knowledge-record-routes.ts`'s SDK client/hooks landed, coding
>   directly against this plan's documented HTTP envelope shape — its own module doc named this
>   explicitly as a temporary integration point. A Wave 3 cleanup deleted `api.ts` (and its test file)
>   entirely: `CaptureModal.tsx` now calls `createKnowledgeRecord` straight from
>   `@kontourai/station-sdk/client`, matching `GraphPane.tsx`/`AskPane.tsx`'s existing use of the real
>   SDK hooks. The same pass also deduplicated `RootPicker.tsx`'s and `AskPane.tsx`'s independently-
>   written `isRelevantRoot` personal/project-scope filter into one shared module,
>   `examples/meeting-notes/src/roots.ts`. No plugin file still depends on the temporary local client.
>
> **Named-deferred scope (not silently dropped):**
> - **The other four Neo4j structural queries** — `transitiveBlockers`, `contradictionCandidates`,
>   `orphans`, `duplicateCandidates` — are explicitly not built. `neo4j-graph-provider.ts`'s own doc
>   comment names them as K6+/follow-up scope; only `shortestPath` ships this slice.
> - **Node/edge deletion on record removal is not implemented.** `syncRootToNeo4j` is additive-only:
>   if a record is removed from the file store after a prior sync, its projected Neo4j node (and any
>   edges touching it) are never pruned — a dangling `target_id` not among the root's own enumerated
>   records is skipped and counted (`linksSkippedDangling`), never written as an edge to a
>   non-existent node, but an already-synced-then-deleted record's own stale node is left in place.
>   Named here as an accepted gap of the sync's "additive projection only" scope, not a silent one.
> - **K6 routing/recall policy remains parked** — no issue exists yet; K5 does not attempt automatic
>   root selection (capture and Ask both require a manual root choice per R3) or any ranking/routing
>   logic beyond the K3 index's own similarity search.
